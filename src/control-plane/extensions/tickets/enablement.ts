import { resolve } from "node:path";

import {
  HACK_PROJECT_DIR_LEGACY,
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_CONFIG_FILENAME,
} from "../../../constants.ts";
import { pathExists } from "../../../lib/fs.ts";
import { readControlPlaneConfig } from "../../sdk/config.ts";

/**
 * Extension id for the optional git-backed tickets extension.
 *
 * Kept here (instead of importing `extension.ts`) so enablement checks stay
 * lightweight and do not pull the full tickets command surface into the
 * module graph of callers like `setup sync` and the integration guard.
 */
export const TICKETS_EXTENSION_ID = "dance.hack.tickets" as const;

export type TicketsIntegrationEnablement = {
  /** Enabled for the project (global config merged with project overrides). */
  readonly project: boolean;
  /** Enabled in the global (user) config layer only. */
  readonly global: boolean;
};

/**
 * Resolve whether the tickets extension is enabled per scope.
 *
 * Tickets is optional/legacy: agent integrations (codex skill, agent-doc
 * snippets) are only installed/checked when the extension is explicitly
 * enabled — project scope uses the merged global+project config, global
 * scope uses the global config alone.
 *
 * @param opts.projectRoot - Project root for the project-scope answer; when
 * omitted the project answer falls back to the global answer.
 */
export async function resolveTicketsIntegrationEnablement(opts: {
  readonly projectRoot?: string;
}): Promise<TicketsIntegrationEnablement> {
  const projectDir = opts.projectRoot
    ? await resolveProjectConfigDir({ projectRoot: opts.projectRoot })
    : null;

  const [globalResult, projectResult] = await Promise.all([
    readControlPlaneConfig({}),
    projectDir ? readControlPlaneConfig({ projectDir }) : Promise.resolve(null),
  ]);

  const globalEnabled =
    globalResult.config.extensions[TICKETS_EXTENSION_ID]?.enabled === true;
  const projectEnabled = projectResult
    ? projectResult.config.extensions[TICKETS_EXTENSION_ID]?.enabled === true
    : globalEnabled;

  return { project: projectEnabled, global: globalEnabled };
}

/**
 * Resolve the project config dir (`.hack`, legacy `.dev`) under a repo root.
 * Falls back to the primary dir when neither carries a config file so the
 * merged read degrades to global-only defaults.
 */
async function resolveProjectConfigDir(opts: {
  readonly projectRoot: string;
}): Promise<string> {
  const primary = resolve(opts.projectRoot, HACK_PROJECT_DIR_PRIMARY);
  if (await pathExists(resolve(primary, PROJECT_CONFIG_FILENAME))) {
    return primary;
  }
  const legacy = resolve(opts.projectRoot, HACK_PROJECT_DIR_LEGACY);
  if (await pathExists(resolve(legacy, PROJECT_CONFIG_FILENAME))) {
    return legacy;
  }
  return primary;
}
