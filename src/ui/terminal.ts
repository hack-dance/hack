function isTruthyEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isTty(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * Whether color output is disabled by environment convention, independent of
 * TTY state. Honors the informal NO_COLOR standard (any non-empty value) and
 * the legacy HACK_NO_COLOR toggle.
 */
export function isColorDisabledByEnv(): boolean {
  if ((process.env.NO_COLOR ?? "").trim().length > 0) {
    return true;
  }
  return isTruthyEnv(process.env.HACK_NO_COLOR);
}

export function isColorEnabled(): boolean {
  if (!isTty()) {
    return false;
  }
  return !isColorDisabledByEnv();
}
