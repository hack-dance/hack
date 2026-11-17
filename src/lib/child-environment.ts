/** Hack credentials must stay in Hack, never in a tool, hook or service. */
export const HACK_KEY_MATERIAL_VARIABLES: ReadonlySet<string> = new Set([
  "HACK_ENV_SECRET_KEY",
  "HACK_SECRETS_FILE_KEY",
  "HACK_GATEWAY_TOKEN",
  "HACK_GATEWAY_STATIC_TOKEN",
  "HACK_TAILSCALE_AUTH_KEY",
]);

/**
 * Build an explicit child environment, stripping Hack key material even from
 * overrides. Supplying a base replaces inheritance; unset keys apply before
 * overrides, matching the shell runners' contract.
 */
export function childEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
  overrides?: Readonly<Record<string, string | undefined>>,
  unsetKeys: readonly string[] = []
): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(base)) {
    if (
      typeof value === "string" &&
      !unsetKeys.includes(key) &&
      key !== "HACK_AUTOSTART_LOGIN" &&
      key !== "HACK_AUTOSTART_PROJECT_ID" &&
      key !== "HACK_DAEMON_LOGIN_SERVICE"
    ) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === "string") {
      env[key] = value;
    } else {
      delete env[key];
    }
  }
  for (const key of HACK_KEY_MATERIAL_VARIABLES) {
    delete env[key];
  }
  if (base.HACK_AUTOSTART_LOGIN === "1") {
    // Login's Git calls observe identity, tracking and ignore state only. Do
    // not load global/system config or execute repository monitor/hook code.
    for (const key of Object.keys(env)) {
      if (key.startsWith("GIT_CONFIG_")) {
        delete env[key];
      }
    }
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
    });
  }
  return env;
}

/** Only for a deliberate re-exec of Hack itself, which may decrypt env layers. */
export function hackReexecEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const env = childEnvironment(base);
  if (base.HACK_AUTOSTART_LOGIN === "1") {
    env.HACK_AUTOSTART_LOGIN = "1";
    if (base.HACK_AUTOSTART_PROJECT_ID) {
      env.HACK_AUTOSTART_PROJECT_ID = base.HACK_AUTOSTART_PROJECT_ID;
    }
  }
  for (const key of HACK_KEY_MATERIAL_VARIABLES) {
    const value = base[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}
