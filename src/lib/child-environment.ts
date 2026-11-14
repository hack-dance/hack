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
      key !== "HACK_AUTOSTART_LOGIN"
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
  return env;
}

/** Only for a deliberate re-exec of Hack itself, which may decrypt env layers. */
export function hackReexecEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const env = childEnvironment(base);
  if (base.HACK_AUTOSTART_LOGIN === "1") {
    env.HACK_AUTOSTART_LOGIN = "1";
  }
  for (const key of HACK_KEY_MATERIAL_VARIABLES) {
    const value = base[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}
