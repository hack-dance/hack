export type OpenHostPreference = "auto" | "alias" | "dev";

export type PreferredOpenHostResult =
  | {
      readonly ok: true;
      readonly host: string;
      readonly preference: OpenHostPreference;
    }
  | {
      readonly ok: false;
      readonly preference: "alias";
      readonly reason: "alias-unavailable";
    };

export function parseOpenHostPreference(
  value: unknown
): OpenHostPreference | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "alias" || normalized === "dev") {
    return normalized;
  }
  return null;
}

/**
 * Selects the browser-facing project host without changing the underlying
 * primary routing identity. Auto prefers the OAuth alias when one exists.
 */
export function resolvePreferredOpenHost(opts: {
  readonly devHost: string;
  readonly aliasHost: string | null;
  readonly configPreference?: OpenHostPreference;
  readonly optionPreference?: OpenHostPreference;
}): PreferredOpenHostResult {
  const preference = opts.optionPreference ?? opts.configPreference ?? "auto";
  if (preference === "dev") {
    return { ok: true, host: opts.devHost, preference };
  }
  if (opts.aliasHost) {
    return { ok: true, host: opts.aliasHost, preference };
  }
  if (preference === "alias") {
    return { ok: false, preference, reason: "alias-unavailable" };
  }
  return { ok: true, host: opts.devHost, preference };
}
