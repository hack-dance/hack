const SESSION_DELIMITER = "--" as const;

export function buildSessionName(opts: {
  readonly base: string;
  readonly suffix?: string;
}): string {
  const base = opts.base.trim();
  const suffix = (opts.suffix ?? "").trim();
  if (suffix.length === 0) {
    return base;
  }
  return `${base}${SESSION_DELIMITER}${suffix}`;
}

export function parseSessionBase(opts: { readonly name: string }): string {
  const name = opts.name.trim();
  const idx = name.indexOf(SESSION_DELIMITER);
  if (idx === -1) {
    return name;
  }
  return name.slice(0, idx);
}

export function getNextNumericSessionSuffix(opts: {
  readonly sessions: readonly { readonly name: string }[];
  readonly base: string;
}): number {
  const base = opts.base.trim();
  if (base.length === 0) {
    return 2;
  }

  const names = new Set(opts.sessions.map((s) => s.name));
  let n = 2;
  while (names.has(buildSessionName({ base, suffix: String(n) }))) {
    n += 1;
  }
  return n;
}
