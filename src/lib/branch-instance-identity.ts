import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_PROJECT_TLD,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { applyBranchToHost, applyBranchToHosts } from "./branch-hosts.ts";
import { readBranchUsage } from "./branch-usage.ts";
import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import {
  type OpenHostPreference,
  resolvePreferredOpenHost,
} from "./open-host.ts";
import {
  defaultProjectSlugFromPath,
  type ProjectContext,
  readProjectConfig,
  readProjectDevHost,
  resolveProjectOauthAliasHost,
  resolveProjectRouteBaseHosts,
  sanitizeBranchSlug,
} from "./project.ts";
import type { RegisteredProject } from "./projects-registry.ts";
import { extractCaddyLabelHosts } from "./runtime-host-metadata.ts";
import type { RuntimeProject } from "./runtime-projects.ts";

/**
 * Explicit identity of one branch instance in `/v1/projects` (HACK-2281,
 * desktop requests R19 and R20), so the app never derives it from Compose
 * names, labels or paths.
 *
 * Cost: file reads only (the owning checkout's config and
 * `.internal/branch-usage.json`, plus a directory listing for native run
 * records). Nothing here spawns a process or contacts Docker.
 */
export type BranchInstanceCheckout = {
  /** Checkout root (the registered checkout or one of its linked worktrees). */
  readonly root: string;
  readonly projectDir: string;
  readonly kind: "primary" | "worktree";
};

export type BranchInstanceIdentity = {
  /**
   * The branch name as given to `hack up --branch` (or the worktree's git
   * branch), when it was recorded at up time. `nameSource` says where it came
   * from; null when neither a record nor a matching worktree registration
   * exists (for example an instance started by an older Hack).
   */
  readonly name: string | null;
  readonly nameSource: "recorded" | "worktree_registration" | null;
  /** The checkout that owns the instance, by the CLI's ownership rule. */
  readonly checkout: BranchInstanceCheckout | null;
  /** Hosts per service. */
  readonly serviceHosts: Readonly<Record<string, readonly string[]>>;
  /**
   * `runtime_labels`: the running containers' routes; `config`: from the
   * owning checkout's Compose file; `unavailable`: not known without the
   * native routing store (authored native projects).
   */
  readonly hostsSource: "runtime_labels" | "config" | "unavailable";
  /** The URL `hack open --branch <slug>` opens with no target. */
  readonly url: string | null;
  /** Which project host the URL uses: the dev host or the OAuth alias. */
  readonly urlHost: "dev" | "alias" | null;
};

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The checkout that owns a runtime directory, by the same rule `hack projects
 * prune` enforces: the registered project dir, or `<root>` /
 * `<root>/<projectDirName>` for the registered checkout and each linked
 * worktree. Null when the directory belongs to none of them.
 */
export function resolveOwningCheckout(opts: {
  readonly registration: RegisteredProject;
  readonly workingDir: string | null;
}): BranchInstanceCheckout | null {
  if (!opts.workingDir) {
    return null;
  }
  const target = canonicalPath(opts.workingDir);
  const projectDirName = opts.registration.projectDirName;
  if (target === canonicalPath(opts.registration.projectDir)) {
    return {
      root: opts.registration.repoRoot,
      projectDir: opts.registration.projectDir,
      kind: "primary",
    };
  }
  const roots: { root: string; kind: "primary" | "worktree" }[] = [
    { root: opts.registration.repoRoot, kind: "primary" },
    ...(opts.registration.worktrees ?? []).map((entry) => ({
      root: entry.path,
      kind: "worktree" as const,
    })),
  ];
  for (const { root, kind } of roots) {
    const projectDir = resolve(root, projectDirName);
    if (
      target === canonicalPath(root) ||
      target === canonicalPath(projectDir)
    ) {
      return {
        root,
        projectDir:
          kind === "primary" ? opts.registration.projectDir : projectDir,
        kind,
      };
    }
  }
  return null;
}

/** Every checkout of a registration: the registered one, then its worktrees. */
export function listRegistrationCheckouts(
  registration: RegisteredProject
): readonly BranchInstanceCheckout[] {
  return [
    {
      root: registration.repoRoot,
      projectDir: registration.projectDir,
      kind: "primary",
    },
    ...(registration.worktrees ?? []).map((entry) => ({
      root: entry.path,
      projectDir: resolve(entry.path, registration.projectDirName),
      kind: "worktree" as const,
    })),
  ];
}

export function checkoutContext(opts: {
  readonly registration: Pick<RegisteredProject, "projectDirName">;
  readonly checkout: BranchInstanceCheckout;
}): ProjectContext {
  return {
    projectRoot: opts.checkout.root,
    projectDirName: opts.registration.projectDirName,
    projectDir: opts.checkout.projectDir,
    composeFile: resolve(opts.checkout.projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: resolve(opts.checkout.projectDir, PROJECT_ENV_FILENAME),
    configFile: resolve(opts.checkout.projectDir, PROJECT_CONFIG_FILENAME),
  };
}

/** What `hack open` needs from a checkout to pick its host. */
export type CheckoutOpenSettings = {
  readonly devHost: string;
  readonly aliasHost: string | null;
  readonly openPrefer: OpenHostPreference | undefined;
};

/**
 * The dev host, OAuth alias and open preference `hack open` reads in this
 * checkout: `dev_host` (or the legacy `.hack/.env` `DEV_HOST`), else
 * `<checkout slug>.hack`; `oauth` and `open.prefer` from its config.
 */
export async function readCheckoutOpenSettings(opts: {
  readonly registration: RegisteredProject;
  readonly checkout: BranchInstanceCheckout;
}): Promise<CheckoutOpenSettings> {
  const context = checkoutContext(opts);
  const cfg = await readProjectConfig(context);
  const devHost =
    (await readProjectDevHost(context)) ??
    `${defaultProjectSlugFromPath(opts.checkout.root)}.${DEFAULT_PROJECT_TLD}`;
  return {
    devHost,
    aliasHost: resolveProjectOauthAliasHost({ devHost, oauth: cfg.oauth }),
    openPrefer: cfg.open?.prefer,
  };
}

/**
 * The URL `hack open [--branch <slug>]` opens with no target, from the same
 * host functions: preference (`open.prefer`, default auto, which prefers the
 * OAuth alias), then the branch qualification of the chosen base host.
 * Null when the project prefers an alias it cannot serve, where `hack open`
 * refuses.
 */
export function resolvePrimaryOpenUrl(opts: {
  readonly settings: CheckoutOpenSettings;
  readonly branch: string | null;
}): { readonly url: string; readonly host: "dev" | "alias" } | null {
  const preferred = resolvePreferredOpenHost({
    devHost: opts.settings.devHost,
    aliasHost: opts.settings.aliasHost,
    configPreference: opts.settings.openPrefer,
  });
  if (!preferred.ok) {
    return null;
  }
  const host = opts.branch
    ? applyBranchToHost({
        host: preferred.host,
        branch: opts.branch,
        baseHosts: resolveProjectRouteBaseHosts({
          devHost: opts.settings.devHost,
          aliasHost: opts.settings.aliasHost,
        }),
      })
    : preferred.host;
  return {
    url: `https://${host}`,
    host:
      opts.settings.aliasHost !== null &&
      preferred.host === opts.settings.aliasHost
        ? "alias"
        : "dev",
  };
}

const CADDY_SITE_LABEL = /^caddy(?:_\d+)?$/;
const CADDY_SITE_SEPARATORS = /[\s,]+/;

/**
 * Concrete hosts of one site label value. Caddy and native branch routing
 * (`branchServiceLabels`) accept whitespace as well as commas between sites.
 */
function siteLabelHosts(value: string): readonly string[] {
  // A templated site address may contain spaces; it names no concrete host.
  if (value.includes("{{")) {
    return [];
  }
  return value
    .split(CADDY_SITE_SEPARATORS)
    .filter(Boolean)
    .flatMap((site) => extractCaddyLabelHosts({ value: site }));
}

/**
 * Hosts per service from the running containers' Caddy site labels
 * (`caddy`, `caddy_<n>`), parsed as the CLI parses them. Services without a
 * site label are left out.
 */
export function runtimeServiceHosts(
  runtime: RuntimeProject
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [service, entry] of runtime.services) {
    const hosts = new Set<string>();
    for (const container of entry.containers) {
      for (const [key, value] of Object.entries(container.labels ?? {})) {
        if (!CADDY_SITE_LABEL.test(key)) {
          continue;
        }
        for (const host of siteLabelHosts(value)) {
          hosts.add(host.toLowerCase());
        }
      }
    }
    if (hosts.size > 0) {
      out[service] = [...hosts].sort((a, b) => a.localeCompare(b));
    }
  }
  return out;
}

/** Branch hosts from the base instance's configured hosts, as `up` rewrites them. */
export function configBranchServiceHosts(opts: {
  readonly baseServiceHosts: Readonly<Record<string, readonly string[]>> | null;
  readonly settings: CheckoutOpenSettings;
  readonly branch: string;
}): Record<string, readonly string[]> {
  const baseHosts = resolveProjectRouteBaseHosts({
    devHost: opts.settings.devHost,
    aliasHost: opts.settings.aliasHost,
  });
  const out: Record<string, readonly string[]> = {};
  for (const [service, hosts] of Object.entries(opts.baseServiceHosts ?? {})) {
    const next = applyBranchToHosts({
      hosts: hosts.flatMap((value) => siteLabelHosts(value)),
      branch: opts.branch,
      baseHosts,
    });
    if (next.length > 0) {
      // Sorted like runtimeServiceHosts, so the order does not depend on the source.
      out[service] = [...next].sort((a, b) => a.localeCompare(b));
    }
  }
  return out;
}

/**
 * The recorded original name of a branch instance: `hack up` writes it to the
 * owning checkout's `.internal/branch-usage.json`. Falls back to the linked
 * worktree's registered git branch when it sanitizes to the same slug.
 */
export async function resolveBranchInstanceName(opts: {
  readonly registration: RegisteredProject;
  readonly checkout: BranchInstanceCheckout | null;
  readonly slug: string;
}): Promise<{
  readonly name: string | null;
  readonly source: BranchInstanceIdentity["nameSource"];
}> {
  if (opts.checkout) {
    const usage = await readBranchUsage({
      projectDir: opts.checkout.projectDir,
    });
    const recorded = usage.get(opts.slug)?.name;
    if (recorded) {
      return { name: recorded, source: "recorded" };
    }
    if (opts.checkout.kind === "worktree") {
      const root = canonicalPath(opts.checkout.root);
      const worktree = (opts.registration.worktrees ?? []).find(
        (entry) => canonicalPath(entry.path) === root
      );
      if (
        worktree?.branch &&
        sanitizeBranchSlug(worktree.branch) === opts.slug
      ) {
        return { name: worktree.branch, source: "worktree_registration" };
      }
    }
  }
  return { name: null, source: null };
}

/** One native branch instance found from its saved run mapping (R19). */
export type NativeBranchRecord = {
  /**
   * The instance as the mapping keys it: the branch slug for the native
   * runtime store, the `--branch` value as given for the authored store.
   */
  readonly slug: string;
  readonly checkout: BranchInstanceCheckout;
  /** `runtime`: `.internal/native-runs`; `authored`: `.internal/native-authored-runs`. */
  readonly store: "runtime" | "authored";
};

const AUTHORED_START_RECORD = /^[a-f0-9]{64}\.start\.json$/;
const NATIVE_RUN_RECORD = /^[a-f0-9]{64}\.json$/;

/**
 * Native branch instances a checkout has saved a run mapping for. A mapping
 * is what `hack up --branch` leaves for `hack down`; it is not proof that the
 * runtime is alive (`hack ps --branch` observes that, at the cost of a
 * native status read). Only regular `<digest>.json` mappings are read; the
 * base instance (`branch: null`), restart/hook siblings, temporary files and
 * unreadable records are skipped. Directory listings and small JSON reads
 * only.
 */
export async function listNativeBranchRecords(opts: {
  readonly checkout: BranchInstanceCheckout;
  readonly store: NativeBranchRecord["store"];
}): Promise<readonly NativeBranchRecord[]> {
  const { checkout, store } = opts;
  const instances = await listNativeCopyInstances(opts);
  return instances.flatMap((slug) =>
    slug === null ? [] : [{ slug, checkout, store }]
  );
}

/** Discover base and branch scopes without opening a runtime. */
export async function listNativeCopyInstances(opts: {
  readonly checkout: BranchInstanceCheckout;
  readonly store: NativeBranchRecord["store"];
  readonly includePending?: boolean;
}): Promise<readonly (string | null)[]> {
  const root = join(
    opts.checkout.projectDir,
    ".internal",
    opts.store === "runtime" ? "native-runs" : "native-authored-runs"
  );
  const instances: (string | null)[] = [];
  for (const name of await listNativeRunRecordNames(
    root,
    opts.store === "authored" && opts.includePending === true
  )) {
    const instance = await readNativeRunRecordBranch(join(root, name));
    if (instance !== undefined) {
      instances.push(instance);
    }
  }
  return instances;
}

/** `<digest>.json` mappings in a native run store; none when it is unlistable. */
async function listNativeRunRecordNames(
  root: string,
  includePending: boolean
): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          (NATIVE_RUN_RECORD.test(entry.name) ||
            (includePending && AUTHORED_START_RECORD.test(entry.name)))
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Null identifies the base scope; undefined means unreadable. */
async function readNativeRunRecordBranch(
  path: string
): Promise<string | null | undefined> {
  const text = await readTextFile(path).catch(() => null);
  if (text === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const scope = isRecord(parsed) ? parsed.scope : null;
  const branch = isRecord(scope) ? scope.branch : undefined;
  return branch === null || (typeof branch === "string" && branch.length > 0)
    ? branch
    : undefined;
}
