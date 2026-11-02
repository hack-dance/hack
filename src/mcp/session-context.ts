import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { GLOBAL_PROJECTS_REGISTRY_FILENAME } from "../constants.ts";
import type { McpCommandAdmission } from "./command-admission.ts";

export type McpSessionContext = {
  readonly admission?: McpCommandAdmission;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly hackHome: string;
  readonly registryPath: string;
};

/** Capture caller state once. Shared servers must never switch process.cwd/env
 * while another session is resolving a project or spawning its command.
 */
export function captureMcpSessionContext(opts: {
  readonly admission?: McpCommandAdmission;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): McpSessionContext {
  const cwd = resolve(opts.cwd);
  const env = Object.freeze(
    Object.fromEntries(
      Object.entries(opts.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    )
  );
  const override = env.HACK_HOME?.trim();
  const hackHome = override
    ? resolve(cwd, override)
    : resolve(cwd, (env.HOME ?? userInfo().homedir).trim(), ".hack");
  const configOverride = env.HACK_GLOBAL_CONFIG_PATH?.trim();
  const registryRoot = configOverride
    ? dirname(resolve(cwd, configOverride))
    : hackHome;
  return Object.freeze({
    ...(opts.admission ? { admission: opts.admission } : {}),
    cwd,
    env,
    hackHome,
    registryPath: resolve(registryRoot, GLOBAL_PROJECTS_REGISTRY_FILENAME),
  });
}
