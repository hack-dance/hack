/**
 * A Caddy site label that a branch instance cannot use (HACK-2284): every host
 * it lists is outside the project's own route namespaces, so qualifying none of
 * them, and dropping all of them, would leave the label without a site. Hosts
 * are configuration, not secrets; they are named so the label can be fixed.
 */
export class BranchCaddyHostsError extends Error {
  constructor(opts: {
    readonly service: string;
    readonly label: string;
    readonly hosts: readonly string[];
    readonly branch: string;
  }) {
    super(
      `Service ${opts.service} label ${opts.label} lists only hosts outside this project's route namespaces (${opts.hosts.join(", ")}); branch ${opts.branch} cannot get its own copy of them. Add a host under the project's .hack name to that label so each branch can get its own copy.`
    );
    this.name = "BranchCaddyHostsError";
  }
}

/**
 * One service's labels for a branch instance: every Caddy site label
 * rewritten by {@link rewriteCaddyLabelForBranch}. Undefined when nothing
 * changes. Throws {@link BranchCaddyHostsError} when a label would be left
 * with no site; `onDropped` hears about each dropped site.
 */
export function branchServiceCaddyLabels<T>(opts: {
  readonly service: string;
  readonly labels: Readonly<Record<string, T | string>>;
  readonly branch: string;
  readonly baseHosts: readonly string[];
  readonly onDropped?: (notice: string) => void;
}): Record<string, T | string> | undefined {
  const next: Record<string, T | string> = { ...opts.labels };
  let changed = false;
  for (const [key, value] of Object.entries(opts.labels)) {
    if (!isCaddySiteLabel(key) || typeof value !== "string") {
      continue;
    }
    if (value.trim().length === 0) {
      continue;
    }
    const rewritten = rewriteCaddyLabelForBranch({
      value,
      branch: opts.branch,
      baseHosts: opts.baseHosts,
    });
    if (rewritten.value.length === 0) {
      throw new BranchCaddyHostsError({
        service: opts.service,
        label: key,
        hosts: rewritten.dropped,
        branch: opts.branch,
      });
    }
    if (rewritten.dropped.length > 0) {
      opts.onDropped?.(
        `Branch ${opts.branch}: service ${opts.service} label ${key} drops ${rewritten.dropped.join(", ")}, which is outside this project's route namespaces and stays with the base instance.`
      );
    }
    if (rewritten.changed) {
      next[key] = rewritten.value;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

/** Root Caddy site labels: `caddy` and `caddy_<n>` (caddy-docker-proxy). */
export function isCaddySiteLabel(key: string): boolean {
  return key === "caddy" || NUMBERED_SITE_LABEL.test(key);
}

const NUMBERED_SITE_LABEL = /^caddy_\d+$/;
const SITE_SEPARATOR = /[\s,]+/;
const SITE = /^(?<scheme>https?:\/\/)?(?<host>[^\s/:]+)(?<port>:\d{1,5})?$/i;

/**
 * Rewrite one Caddy site label for a branch instance. A host in the project's
 * route namespaces (see `resolveProjectRouteBaseHosts`) is branch-qualified;
 * any other site is dropped, so a branch instance never claims the base
 * instance's hosts. A scheme and port are kept. `dropped` lists the removed
 * sites; an empty `value` means nothing was left.
 */
export function rewriteCaddyLabelForBranch(opts: {
  readonly value: string;
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): {
  readonly value: string;
  readonly changed: boolean;
  readonly dropped: readonly string[];
} {
  const parts = opts.value
    .split(SITE_SEPARATOR)
    .map((site) => site.trim())
    .filter((site) => site.length > 0);

  if (parts.length === 0) {
    return { value: opts.value, changed: false, dropped: [] };
  }

  const out: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const site of parts) {
    const match = SITE.exec(site);
    const host = match?.groups?.host;
    const next =
      host === undefined
        ? undefined
        : branchQualifiedHost({
            host: host.toLowerCase(),
            branch: opts.branch,
            baseHosts: opts.baseHosts,
          });
    if (next === undefined) {
      dropped.push(site);
      changed = true;
      continue;
    }
    const rewritten = `${match?.groups?.scheme ?? ""}${next}${match?.groups?.port ?? ""}`;
    if (rewritten !== site) {
      changed = true;
    }
    if (seen.has(rewritten)) {
      continue;
    }
    seen.add(rewritten);
    out.push(rewritten);
  }

  return { value: out.join(", "), changed, dropped };
}

/**
 * The branch instance's copy of `host`, or undefined when `host` is outside
 * every base host (so it cannot be branch-qualified). A host already
 * qualified for this branch is returned unchanged.
 */
function branchQualifiedHost(opts: {
  readonly host: string;
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): string | undefined {
  for (const baseHost of opts.baseHosts) {
    const rewritten = rewriteHostForBranch({
      host: opts.host.toLowerCase(),
      branch: opts.branch,
      baseHost: baseHost.toLowerCase(),
    });
    if (rewritten.matched) {
      return rewritten.host;
    }
  }
  return;
}

export function applyBranchToHost(opts: {
  readonly host: string;
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): string {
  return branchQualifiedHost(opts) ?? opts.host;
}

/**
 * A branch instance's hosts from its base instance's label hosts: qualified
 * when in the project's route namespaces, dropped otherwise, as the label
 * rewrite does (HACK-2284).
 */
export function applyBranchToHosts(opts: {
  readonly hosts: readonly string[];
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const host of opts.hosts) {
    const next = branchQualifiedHost({
      host: host.toLowerCase(),
      branch: opts.branch,
      baseHosts: opts.baseHosts,
    });
    if (next === undefined || seen.has(next)) {
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
}): { readonly host: string; readonly matched: boolean } {
  if (opts.host === opts.baseHost) {
    return { host: `${opts.branch}.${opts.baseHost}`, matched: true };
  }

  const suffix = `.${opts.baseHost}`;
  if (!opts.host.endsWith(suffix)) {
    return { host: opts.host, matched: false };
  }

  const prefix = opts.host.slice(0, opts.host.length - suffix.length);
  if (prefix.endsWith(`.${opts.branch}`)) {
    return { host: opts.host, matched: true };
  }
  return { host: `${prefix}.${opts.branch}.${opts.baseHost}`, matched: true };
}
