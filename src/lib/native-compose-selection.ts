import { resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import { HackCliError } from "./cli-result.ts";
import {
  discoverProjectInputs,
  inspectProjectInputsAtRoot,
  ProjectInputSelectionError,
} from "./project-input-selection.ts";
import { normalizeProjectName } from "./project-name.ts";
import {
  readProjectsRegistry,
  selectRegisteredProjectByName,
} from "./projects-registry.ts";

export type NativeComposeSelection = {
  readonly kind: "native";
  readonly projectRoot: string;
};

/**
 * Select the authored family before any legacy context, registration touch or
 * runtime operation. Registered roots are exact; an unavailable registration
 * never enables ancestor discovery. Null leaves the existing legacy path intact.
 */
export async function selectNativeComposeProject(opts: {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
}): Promise<NativeComposeSelection | null> {
  if (opts.path && opts.project !== undefined) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }
  const selected =
    opts.project === undefined
      ? await discoverProjectInputs({
          startDir: opts.path ? resolve(opts.cwd, opts.path) : opts.cwd,
        })
      : await selectRegisteredNativeInputs({ project: opts.project });
  if (selected?.kind === "conflict") {
    throw new ProjectInputSelectionError("conflict");
  }
  return selected?.kind === "native"
    ? { kind: "native", projectRoot: selected.projectRoot }
    : null;
}

async function selectRegisteredNativeInputs(opts: {
  readonly project: string;
}) {
  const name = normalizeProjectName(opts.project);
  if (!name) {
    throw new CliUsageError("Invalid --project value.");
  }
  const registry = await readProjectsRegistry();
  const registered = selectRegisteredProjectByName({
    projects: registry.projects,
    name,
  });
  if (!registered) {
    throw new HackCliError({
      code: "E_PROJECT_NOT_FOUND",
      message: "The selected project is not registered.",
    });
  }
  return await inspectProjectInputsAtRoot({
    projectRoot: registered.repoRoot,
  });
}

/** Authored format and runtime selection are independent; no implicit fallback. */
export function requireNativeComposeBackend(opts: {
  readonly backend: string | undefined;
}): void {
  if (opts.backend !== undefined && opts.backend !== "compose") {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "Native project configuration currently requires the Compose backend. The selected runtime was not changed.",
    });
  }
}
