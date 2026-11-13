import { resolve } from "node:path";

import { isCancel, password, text } from "@clack/prompts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import {
  canPrompt,
  confirmSafe,
  requireInteractive,
} from "../lib/interactivity.ts";
import { keychain } from "../lib/keychain.ts";
import { findProjectContext, readProjectConfig } from "../lib/project.ts";
import { retireSecretStore } from "../lib/secret-store-retire.ts";
import { logger } from "../ui/logger.ts";

const DEFAULT_SECRETS_SERVICE = "hack-cli" as const;

const optService = defineOption({
  name: "service",
  type: "string",
  long: "--service",
  valueHint: "<service>",
  description: "Override Bun.secrets service name",
  defaultValue: DEFAULT_SECRETS_SERVICE,
} as const);

const optYes = defineOption({
  name: "yes",
  type: "boolean",
  long: "--yes",
  description:
    "Confirm the deletion without prompting (required without a TTY or with HACK_NO_INTERACTIVE)",
} as const);

const optRetireYes = defineOption({
  name: "yes",
  type: "boolean",
  long: "--yes",
  description:
    "Confirm moving the store aside without prompting (required without a TTY or with HACK_NO_INTERACTIVE)",
} as const);

const secretsOptions = [optService] as const;
const deleteOptions = [optService, optYes] as const;
const retireStoreOptions = [optPath, optRetireYes] as const;
type RetireStoreArgs = CommandArgs<typeof retireStoreOptions, readonly []>;
const secretsPositionals = [{ name: "name", required: false }] as const;

type SecretsArgs = CommandArgs<
  typeof secretsOptions,
  typeof secretsPositionals
>;
type SecretsDeleteArgs = CommandArgs<
  typeof deleteOptions,
  typeof secretsPositionals
>;

const setSpec = defineCommand({
  name: "set",
  summary: "Store a secret",
  group: "Secrets",
  options: secretsOptions,
  positionals: secretsPositionals,
  subcommands: [],
} as const);

const getSpec = defineCommand({
  name: "get",
  summary: "Print a secret (exit 1 if missing)",
  group: "Secrets",
  options: secretsOptions,
  positionals: secretsPositionals,
  subcommands: [],
} as const);

const deleteSpec = defineCommand({
  name: "delete",
  summary: "Delete a stored secret",
  group: "Secrets",
  description: [
    "Asks for confirmation before deleting. Without a TTY (or with HACK_NO_INTERACTIVE / --no-interactive)",
    "the deletion is refused with E_INTERACTIVE_REQUIRED unless --yes is passed.",
  ].join("\n"),
  options: deleteOptions,
  positionals: secretsPositionals,
  subcommands: [],
} as const);

const retireStoreSpec = defineCommand({
  name: "retire-store",
  summary:
    "Move an encrypted secret store whose key is gone aside (reversible)",
  group: "Secrets",
  description: [
    "For an encrypted_file (or cloud shim) store that hack doctor reports with a missing or wrong key.",
    "Renames the store to <store>.retired-<UTC time> in the same directory: nothing is deleted, read or printed,",
    "and the key file is left alone. It prints how to put the store back. The store is the one this project",
    "selects (--path or the current directory), or the global one outside a project. Refused for a store that",
    "opens with the key in use, or that is unreadable for another reason. Without a TTY (or with",
    "HACK_NO_INTERACTIVE / --no-interactive) it is refused with E_INTERACTIVE_REQUIRED unless --yes is passed.",
  ].join("\n"),
  options: retireStoreOptions,
  positionals: [],
  subcommands: [],
} as const);

export const secretsCommand = defineCommand({
  name: "secrets",
  summary: "Manage secrets in OS keychain (Bun.secrets)",
  group: "Secrets",
  expandInRootHelp: true,
  options: secretsOptions,
  positionals: [],
  subcommands: [
    withHandler(setSpec, handleSecretsSet),
    withHandler(getSpec, handleSecretsGet),
    withHandler(deleteSpec, handleSecretsDelete),
    withHandler(retireStoreSpec, handleSecretsRetireStore),
  ],
} as const);

function resolveService(args: SecretsArgs | SecretsDeleteArgs): string {
  return args.options.service ?? DEFAULT_SECRETS_SERVICE;
}

async function resolveName(positionals: readonly string[]): Promise<string> {
  const fromPos = (positionals[0] ?? "").trim();
  if (fromPos.length > 0) {
    return fromPos;
  }

  if (!canPrompt()) {
    requireInteractive({
      what: "a secret name is required",
      hint: "Pass the name as an argument (e.g. `hack secrets get <name>`).",
    });
  }

  const name = await text({
    message: "Secret name:",
    validate: (value) => {
      const v = value?.trim();
      if (!v) {
        return "Required";
      }
      return undefined;
    },
  });
  if (isCancel(name)) {
    throw new Error("Canceled");
  }
  return name.trim();
}

async function handleSecretsSet({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SecretsArgs;
}): Promise<number> {
  const service = resolveService(args);
  const name = await resolveName(
    [args.positionals.name].filter((v) => typeof v === "string")
  );

  if (!canPrompt()) {
    requireInteractive({
      what: `a value for secret "${name}" is required`,
      hint: "Run `hack secrets set <name>` in a terminal; the value is read from a hidden prompt and never from an argument.",
    });
  }

  const value = await password({
    message: `Value for "${name}" (${service}):`,
    validate: (v) => (!v || v.length === 0 ? "Required" : undefined),
  });
  if (isCancel(value)) {
    return 1;
  }

  await keychain.set({ service, name, value });
  logger.success({
    message: `Stored secret "${name}" under service "${service}"`,
  });
  return 0;
}

async function handleSecretsGet({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SecretsArgs;
}): Promise<number> {
  const service = resolveService(args);
  const name = await resolveName(
    [args.positionals.name].filter((v) => typeof v === "string")
  );

  const value = await keychain.get({ service, name });
  if (value === null) {
    logger.warn({ message: `No secret found for "${name}" (${service})` });
    return 1;
  }

  // Print raw to stdout for piping (avoid extra formatting)
  process.stdout.write(`${value}\n`);
  return 0;
}

/**
 * `hack secrets delete <name>`.
 *
 * `--yes` is the explicit confirmation that makes the deletion scriptable; it
 * skips the prompt in every mode. Without it, a TTY run asks (default no) and
 * a run that cannot prompt refuses closed with `E_INTERACTIVE_REQUIRED`
 * before the keychain is touched.
 */
async function handleSecretsDelete({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SecretsDeleteArgs;
}): Promise<number> {
  const service = resolveService(args);
  const name = await resolveName(
    [args.positionals.name].filter((v) => typeof v === "string")
  );

  const ok =
    args.options.yes === true ||
    (await confirmSafe({
      message: `Delete secret "${name}" (${service})?`,
      initialValue: false,
      nonInteractive: "fail",
      hint: "Pass --yes to confirm the deletion (`hack secrets delete <name> --yes`), or run it in a terminal.",
    }));
  if (!ok) {
    return 0;
  }

  const deleted = await keychain.delete({ service, name });
  if (!deleted) {
    logger.warn({
      message: `No secret found to delete for "${name}" (${service})`,
    });
    return 1;
  }

  logger.success({ message: `Deleted secret "${name}" (${service})` });
  return 0;
}

/**
 * `hack secrets retire-store` (HACK-2177): the reversible way forward for an
 * encrypted secret store whose key is gone. Confirmation works as for
 * `delete`: `--yes`, a prompt (default no), or a closed refusal when the run
 * cannot prompt, before anything is moved.
 */
async function handleSecretsRetireStore({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RetireStoreArgs;
}): Promise<number> {
  const startDir = args.options.path
    ? resolve(process.cwd(), args.options.path)
    : process.cwd();
  const project = await findProjectContext(startDir);
  let projectName = "project";
  if (project) {
    const cfg = await readProjectConfig(project);
    projectName = (
      cfg.name ??
      project.projectRoot.split("/").at(-1) ??
      "project"
    ).trim();
  }
  const ok =
    args.options.yes === true ||
    (await confirmSafe({
      message:
        "Move the encrypted secret store aside? Its entries stay in the moved file, which can be put back.",
      initialValue: false,
      nonInteractive: "fail",
      hint: "Pass --yes to confirm (`hack secrets retire-store --yes`), or run it in a terminal.",
    }));
  if (!ok) {
    return 0;
  }
  const outcome = await retireSecretStore({
    projectName,
    projectDir: project?.projectDir,
  });
  if (outcome.kind === "refused") {
    logger.error({ message: outcome.message });
    return 1;
  }
  logger.success({
    message: [
      `Moved the encrypted secret store ${outcome.from} to ${outcome.to}.`,
      "Nothing was deleted, and no entry was read or printed. The key file was left alone.",
      `To put it back (while no store is at ${outcome.from}): mv '${outcome.to}' '${outcome.from}'`,
    ].join("\n"),
  });
  return 0;
}
