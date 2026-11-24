import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { HackCliError } from "./cli-result.ts";
import {
  readAtomicWriteTargetText,
  writeTextFileAtomicIfChanged,
} from "./fs.ts";
import { ensureHackGitInfoExclude } from "./git-info-exclude.ts";
import { isRecord } from "./guards.ts";
import { canPrompt } from "./interactivity.ts";
import { formatProjectRemoteAddress } from "./project-remote-status.ts";
import type { SelectedProjectRemote } from "./project-remotes-config.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

import { CONTAINER_ONLY_HOSTS, HOST_LOOPBACK } from "./vetted-env.ts";

const SELECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

type Choices = Readonly<Record<string, string>>;
export type EffectiveRemote = SelectedProjectRemote & {
  readonly source: "--use" | "checkout" | "default";
};

export function parseRemoteChoices(input: string | undefined): Choices {
  const choices: Record<string, string> = Object.create(null);
  if (input === undefined) {
    return choices;
  }
  for (const pair of input.split(",")) {
    const [name, target, extra] = pair.split("=");
    if (
      !(
        name &&
        target &&
        SELECTION_NAME.test(name) &&
        SELECTION_NAME.test(target)
      ) ||
      extra !== undefined ||
      Object.hasOwn(choices, name)
    ) {
      throw new HackCliError({
        code: "E_USAGE",
        message: "Expected unique remote=target selections.",
      });
    }
    choices[name] = target;
  }
  return choices;
}

export function resolveRemoteChoices(
  defaults: readonly SelectedProjectRemote[],
  saved: Choices,
  explicit: Choices
): readonly EffectiveRemote[] {
  const names = new Set(defaults.map(({ remote }) => remote));
  if (Object.keys(explicit).some((key) => !names.has(key))) {
    throw new HackCliError({
      code: "E_UNKNOWN_REMOTE_TARGET",
      message: "A selection names an undeclared remote.",
    });
  }
  return defaults.map((entry) => {
    const flag = Object.hasOwn(explicit, entry.remote)
      ? explicit[entry.remote]
      : undefined;
    const preference = Object.hasOwn(saved, entry.remote)
      ? saved[entry.remote]
      : undefined;
    const target = flag ?? preference ?? entry.target;
    const selected = entry.targets.get(target);
    if (!selected) {
      throw new HackCliError({
        code: "E_UNKNOWN_REMOTE_TARGET",
        message: `Remote ${entry.remote} has no target named ${target}.`,
      });
    }
    const savedSource = preference === undefined ? "default" : "checkout";
    return {
      ...entry,
      ...selected,
      via: selected.via,
      target,
      source: flag === undefined ? savedSource : "--use",
    };
  });
}

async function confirmChoice(choice: EffectiveRemote): Promise<void> {
  if (!(canPrompt() && process.stderr.isTTY)) {
    if (choice.source === "--use") {
      return;
    }
    throw new HackCliError({
      code: "E_INTERACTIVE_REQUIRED",
      message: `Name ${choice.remote}=${choice.target} with --use on this command.`,
    });
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `? ${choice.remote} → ${choice.target}  this target asks first. continue? `,
  });
  try {
    terminal.prompt();
    for await (const line of terminal) {
      if (["y", "yes"].includes(line.trim().toLowerCase())) {
        return;
      }
      break;
    }
  } finally {
    terminal.close();
  }
  throw new HackCliError({
    code: "E_CANCELLED",
    message: "Remote selection cancelled.",
  });
}

export function refuseRemoteStart(
  declared: readonly SelectedProjectRemote[] | undefined,
  command: string
): void {
  if (declared?.length) {
    throw new HackCliError({
      code: "E_REMOTE_START_UNSUPPORTED",
      message: `${command} cannot start a project that declares remotes. Run ${command === "hack restart" ? "hack down, then " : ""}hack up --detach for the whole project.`,
    });
  }
}

/** Resolve and disclose the names for this invocation before effects. */
export async function prepareRemoteChoices(opts: {
  readonly projectDir: string;
  readonly defaults: readonly SelectedProjectRemote[];
  readonly use?: string;
  readonly services: readonly string[];
}): Promise<readonly EffectiveRemote[]> {
  if (opts.services.length) {
    refuseRemoteStart(opts.defaults, "Service-scoped hack up");
    if (opts.use !== undefined) {
      throw new HackCliError({
        code: "E_USAGE",
        message: "--use requires whole-project up.",
      });
    }
    return [];
  }
  const explicit = parseRemoteChoices(opts.use);
  if (opts.defaults.length === 0) {
    return resolveRemoteChoices(opts.defaults, {}, explicit);
  }
  const choices = resolveRemoteChoices(
    opts.defaults,
    await readRemoteChoices(opts.projectDir),
    explicit
  );
  for (const choice of choices) {
    process.stderr.write(
      `${choice.remote} → ${choice.target} · ${formatProjectRemoteAddress({ ...choice.address, port: choice.port })} · ${choice.source}${choice.via ? " · tunnel not started by this version" : ""}\n`
    );
    if (choice.confirm) {
      await confirmChoice(choice);
    }
  }
  return choices;
}

function selectionPath(projectDir: string): string {
  return join(projectDir, ".internal", "use.json");
}

async function assertSelectionPath(path: string): Promise<void> {
  const folder = await lstat(dirname(path)).catch(missingOnly);
  const file = await lstat(path).catch(missingOnly);
  if ((folder && !folder.isDirectory()) || (file && !file.isFile())) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message: "Unsafe checkout remote selection path.",
    });
  }
}

function missingOnly(error: unknown): null {
  if (isRecord(error) && error.code === "ENOENT") {
    return null;
  }
  throw error;
}

function readChoices(text: string | null): Choices {
  if (text === null) {
    return Object.create(null);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const choices: Record<string, string> = Object.create(null);
      for (const [name, target] of Object.entries(parsed)) {
        if (
          !SELECTION_NAME.test(name) ||
          typeof target !== "string" ||
          !SELECTION_NAME.test(target)
        ) {
          throw new Error("Invalid selection entry");
        }
        choices[name] = target;
      }
      return choices;
    }
  } catch {
    // Do not expose the contents of a malformed state file.
  }
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message: "Checkout remote selection is invalid.",
  });
}

export async function readRemoteChoices(projectDir: string): Promise<Choices> {
  const path = selectionPath(projectDir);
  await assertSelectionPath(path);
  return readChoices(await readAtomicWriteTargetText(path));
}

/** Publish the stopped preference only while the caller's stopped check holds. */
export async function saveRemoteChoices(opts: {
  readonly projectDir: string;
  readonly defaults: readonly SelectedProjectRemote[];
  readonly changes: Choices;
  readonly assertStopped: () => Promise<void>;
}): Promise<void> {
  const path = selectionPath(opts.projectDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSelectionPath(path);
  await withProjectsRegistryLock({
    lockPath: `${path}.lock`,
    label: "Checkout remote selection",
    run: async () => {
      await assertSelectionPath(path);
      const previous = await readAtomicWriteTargetText(path);
      const saved = { ...readChoices(previous), ...opts.changes };
      resolveRemoteChoices(opts.defaults, saved, {});
      await opts.assertStopped();
      await ensureHackGitInfoExclude({ projectDir: opts.projectDir });
      await writeTextFileAtomicIfChanged(
        path,
        `${JSON.stringify(saved, null, 2)}\n`,
        {
          expectedExisting: previous,
          createMode: 0o600,
          tightenExisting: true,
          noFollowTarget: true,
          validatePath: assertSelectionPath,
        }
      );
    },
  });
}

export function applyRemoteEnv(
  env: Readonly<Record<string, string>>,
  choices: readonly SelectedProjectRemote[] = [],
  options?: {
    readonly bindingsOnly?: boolean;
    readonly host?: boolean;
    readonly missing?: (remote: string, name: string) => void;
  }
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (!options?.bindingsOnly) {
    Object.assign(result, env);
  }
  for (const { remote, address, bindings, port } of choices) {
    let host: string;
    if (address.kind === "env_ref") {
      const value = Object.hasOwn(env, address.name)
        ? env[address.name]
        : undefined;
      if (!value) {
        if (options?.missing) {
          options.missing(remote, address.name);
          continue;
        }
        throw new HackCliError({
          code: "E_CONFIG_INVALID",
          message: `Missing managed environment value for ${address.name}.`,
        });
      }
      host = value;
    } else if (address.kind === "service") {
      host = address.service;
    } else {
      host = address.hostname;
    }
    if (
      options?.host &&
      (address.kind === "service" || CONTAINER_ONLY_HOSTS.has(host))
    ) {
      host = HOST_LOOPBACK;
    }
    for (const [name, template] of Object.entries(bindings)) {
      result[name] = template.replaceAll(/\{(host|port)\}/g, (_, key) =>
        key === "host" ? host : String(port)
      );
    }
  }
  return result;
}

function backingServices(choices: readonly EffectiveRemote[]) {
  const selected = new Set<string>();
  const declared = new Set<string>();
  for (const choice of choices) {
    for (const target of choice.targets.values()) {
      if (target.address.kind === "service") {
        declared.add(target.address.service);
      }
    }
    if (choice.address.kind === "service") {
      selected.add(choice.address.service);
    }
  }
  return {
    selected,
    inactive: [...declared].filter((service) => !selected.has(service)),
  };
}

export function remoteServiceTargets(
  choices: readonly EffectiveRemote[],
  services: readonly string[]
) {
  const { selected, inactive } = backingServices(choices);
  const targets = [
    ...new Set([
      ...services.filter((service) => !inactive.includes(service)),
      ...selected,
    ]),
  ];
  if (!targets.length) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "No Compose service is available with this remote selection.",
    });
  }
  return { targets, inactive };
}

/** Hash authored descriptors only. An env reference contributes its name, never its value. */
export function remoteTargetIdentity({
  target,
  address,
  port,
  bindings,
}: SelectedProjectRemote): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([address, port, Object.entries(bindings).sort()]))
    .digest("hex");
  return `${target}:${digest}`;
}

export function remoteSelectionLabels(
  choices: readonly EffectiveRemote[]
): Record<string, string> {
  return Object.fromEntries(
    choices.map((choice) => [
      `dev.hack.remote.${choice.remote}`,
      remoteTargetIdentity(choice),
    ])
  );
}

/** Undefined means no observed label; null means observations disagree. */
export function runningRemoteIdentity(
  entries: readonly Record<string, unknown>[],
  remote: string
): string | null | undefined {
  const prefix = `dev.hack.remote.${remote}=`;
  const observed = new Set<string>();
  const inactive = new Set<string>();
  let active = false;
  for (const { State, Labels } of entries) {
    if (typeof Labels !== "string") {
      continue;
    }
    const fields = Labels.split(",");
    if (
      fields.some(
        (label) => label.toLowerCase() === "com.docker.compose.oneoff=true"
      )
    ) {
      continue;
    }
    const stopped =
      State === "exited" || State === "dead" || State === "created";
    active ||= !stopped;
    const target = fields
      .find((label) => label.startsWith(prefix))
      ?.slice(prefix.length);
    if (target) {
      (stopped ? inactive : observed).add(target);
    }
  }
  const targets = active ? observed : inactive;
  if (targets.size > 1) {
    return active ? null : undefined;
  }
  return [...targets][0];
}
