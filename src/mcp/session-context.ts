import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { GLOBAL_PROJECTS_REGISTRY_FILENAME } from "../constants.ts";
import { normalizeHomeDir, readAbsolutePathOverride } from "../lib/home-dir.ts";
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
  // The env reaches child commands unchanged and they refuse a relative
  // HACK_HOME, so the session applies the same rule instead of disagreeing.
  const hackHome =
    readAbsolutePathOverride({ name: "HACK_HOME", value: env.HACK_HOME }) ??
    resolve(
      // An empty or relative HOME must not put global state under the checkout.
      normalizeHomeDir(env.HOME) ?? resolve(userInfo().homedir),
      ".hack"
    );
  const configOverride = readAbsolutePathOverride({
    name: "HACK_GLOBAL_CONFIG_PATH",
    value: env.HACK_GLOBAL_CONFIG_PATH,
  });
  const registryRoot = configOverride ? dirname(configOverride) : hackHome;
  return Object.freeze({
    ...(opts.admission ? { admission: opts.admission } : {}),
    cwd,
    env,
    hackHome,
    registryPath: resolve(registryRoot, GLOBAL_PROJECTS_REGISTRY_FILENAME),
  });
}
