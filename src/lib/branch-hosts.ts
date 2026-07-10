export function rewriteCaddyLabelForBranch(opts: {
  readonly value: string;
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): { readonly value: string; readonly changed: boolean } {
  const parts = opts.value
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  if (parts.length === 0) {
    return { value: opts.value, changed: false };
  }

  const out: string[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const host of parts) {
    const next = applyBranchToHost({
      host,
      branch: opts.branch,
      baseHosts: opts.baseHosts,
    });
    if (next !== host) {
      changed = true;
    }
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    out.push(next);
  }

  return { value: out.join(", "), changed };
}

export function applyBranchToHost(opts: {
  readonly host: string;
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): string {
  for (const baseHost of opts.baseHosts) {
    const rewritten = rewriteHostForBranch({
      host: opts.host,
      branch: opts.branch,
      baseHost,
    });
    if (rewritten.changed) {
      return rewritten.host;
    }
  }
  return opts.host;
}

export function applyBranchToHosts(opts: {
  readonly hosts: readonly string[];
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const host of opts.hosts) {
    const next = applyBranchToHost({
      host,
      branch: opts.branch,
      baseHosts: opts.baseHosts,
    });
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    out.push(next);
  }
  return out;
}

function rewriteHostForBranch(opts: {
  readonly host: string;
  readonly branch: string;
  readonly baseHost: string;
}): { readonly host: string; readonly changed: boolean } {
  if (opts.host === opts.baseHost) {
    const next = `${opts.branch}.${opts.baseHost}`;
    return { host: next, changed: next !== opts.host };
  }

  const suffix = `.${opts.baseHost}`;
  if (!opts.host.endsWith(suffix)) {
    return { host: opts.host, changed: false };
  }

  const prefix = opts.host.slice(0, opts.host.length - suffix.length);
  if (prefix === opts.branch || prefix.endsWith(`.${opts.branch}`)) {
    return { host: opts.host, changed: false };
  }

  return { host: `${prefix}.${opts.branch}.${opts.baseHost}`, changed: true };
}
