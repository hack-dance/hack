import { fstatSync } from "node:fs";
import { resolve } from "node:path";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { resolveRequestedEnvName } from "../cli/env-selection.ts";
import { optBranch, optEnv, optJson, optPath } from "../cli/options.ts";
import {
  emitCliResult,
  errorResult,
  HackCliError,
  okResult,
} from "../lib/cli-result.ts";
import {
  CONFIG_EDITOR_SCHEMA,
  readConfigEditor,
  showConfigEditor,
} from "../lib/config-editor-model.ts";
import {
  applyConfigPatch,
  assessConfigPatch,
  readConfigPatch,
} from "../lib/config-editor-patch.ts";

const options = [optPath, optBranch, optEnv, optJson] as const;
const base = {
  group: "Project",
  options,
  positionals: [],
  subcommands: [],
} as const;
const show = defineCommand({
  ...base,
  name: "show",
  summary: "Show Compose project config, layers, routes and env provenance",
} as const);
const apply = defineCommand({
  ...base,
  name: "apply",
  summary: "Apply a validated Compose project config patch from stdin",
} as const);
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

type Selection = {
  readonly cwd: string;
  readonly path?: string;
  readonly env?: string;
  readonly branch?: string;
};

function readSelection(selection: Selection) {
  return readConfigEditor({
    start: resolve(selection.cwd, selection.path ?? "."),
    branch: selection.branch,
    overlay: resolveRequestedEnvName({ envOption: selection.env }),
  });
}

async function readPatchSelection(selection: Selection) {
  const snapshot = await readSelection(selection).catch((error: unknown) => {
    if (
      error instanceof HackCliError &&
      (error.code === "E_PROJECT_NOT_FOUND" || error.code === "E_PATH_CONFLICT")
    ) {
      return null;
    }
    throw error;
  });
  if (snapshot === null) {
    throw new HackCliError({
      code: "E_CONFLICT",
      message:
        "The selected checkout is no longer available. Reload before saving.",
    });
  }
  return snapshot;
}

async function runConfigEditor(work: () => Promise<unknown>): Promise<number> {
  try {
    emitCliResult({ result: okResult({ data: await work() }) });
    return 0;
  } catch (error) {
    const result =
      error instanceof HackCliError
        ? errorResult({
            code: error.code,
            message: error.message,
            detail: error.detail,
          })
        : errorResult({
            code: "E_CONFIG_INVALID",
            message: "Could not read or update the selected config.",
          });
    emitCliResult({ result });
    return 1;
  }
}

export const configShowCommand = withHandler(show, async ({ ctx, args }) => {
  if (!args.options.json) {
    throw new CliUsageError("Use hack config show --json.");
  }
  return await runConfigEditor(async () =>
    showConfigEditor(await readSelection({ cwd: ctx.cwd, ...args.options }))
  );
});

export const configApplyCommand = withHandler(apply, async ({ ctx, args }) => {
  if (!args.options.json) {
    throw new CliUsageError(
      "Use hack config apply --json with a patch on stdin."
    );
  }
  return await runConfigEditor(async () => {
    const patch = readConfigPatch((await readConfigPatchStdin()) ?? "");
    const snapshot = await readPatchSelection({
      cwd: ctx.cwd,
      ...args.options,
    });
    return await applyConfigPatch(snapshot, patch);
  });
});

/** Keep existing no-patch validation usable with a terminal or /dev/null. */
export async function readConfigPatchStdin(): Promise<string | null> {
  const descriptor = fstatSync(0, { throwIfNoEntry: false });
  if (
    !(
      descriptor &&
      (descriptor.isFIFO() || descriptor.isFile() || descriptor.isSocket())
    )
  ) {
    return null;
  }
  const decoder = new TextDecoder();
  let size = 0;
  let input = "";
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) {
      break;
    }
    size += chunk.byteLength;
    if (size > MAX_PATCH_BYTES) {
      await reader.cancel();
      throw new HackCliError({
        code: "E_USAGE",
        message: "Config patch exceeds the 2 MiB limit.",
      });
    }
    input += decoder.decode(chunk, { stream: true });
  }
  return (input + decoder.decode()).trim() || null;
}

/** Return null only when the invocation is the established compiler command. */
export async function validateConfigEditorStdin(
  selection: Selection
): Promise<number | null> {
  let input: string | null;
  try {
    input = await readConfigPatchStdin();
  } catch (error) {
    return await runConfigEditor(() => Promise.reject(error));
  }
  if (input === null && selection.branch === undefined) {
    return null;
  }
  return await runConfigEditor(async () => {
    const patch = readConfigPatch(input ?? "");
    const snapshot = await readPatchSelection(selection);
    const { issues, previews } = await assessConfigPatch(snapshot, patch);
    return {
      schema: CONFIG_EDITOR_SCHEMA,
      valid: issues.length === 0,
      issues,
      previews,
    };
  });
}
