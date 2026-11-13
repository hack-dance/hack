import { join, resolve } from "node:path";

import { isCandidateRun } from "../daemon/client.ts";
import { quoteShellWord } from "./logs.ts";
import {
  readProjectsRegistryStrict,
  resolveProjectsRegistryPath,
} from "./projects-registry.ts";
import {
  inspectStoreKeyState,
  listRetiredEncryptedStores,
  resolveFileSecretStorePaths,
} from "./secret-store.ts";
import {
  listSecretStoreReaders,
  secretStoreSelectionProblem,
} from "./secret-store-retire.ts";
import type { UpgradeCheckProbes } from "./upgrade-check-probes.ts";
import {
  classifyRegistryEntry,
  inspectUpgradeProject,
  type RegisteredCheckout,
  type RegistryEntryState,
  registeredCheckouts,
  type UpgradeFinding,
  type UpgradeFindingStatus,
} from "./upgrade-check-project.ts";

export type {
  UpgradeFinding,
  UpgradeFindingStatus,
} from "./upgrade-check-project.ts";

/**
 * `hack upgrade check` (HACK-2189, the upgrade assistant HACK-2188): a
 * read-only report on the machine and every registered checkout, ending in
 * an ordered plan and the next command.
 *
 * Contract:
 * - Changes nothing: no file, registry, service, container or key is
 *   written, started or provisioned, and nothing prompts (the OS keychain is
 *   never asked). Host probes are injected ({@link UpgradeCheckProbes}).
 * - One deadline covers the whole check (registry discovery, classification,
 *   probes and checkout checks); what it cuts short is `incomplete`.
 * - No value in the report: names, paths, counts, states and codes only.
 * - Dead registry entries (the checkout or its config is gone) are counted
 *   apart from live entries that cannot be read.
 * - `ready` only when nothing blocks and every required check ran: a
 *   `blocker` (continuing would fail or lose data) or an `incomplete` check
 *   (safety not established) makes it false, and the command exit non-zero.
 * - A plan step carries either an executable command (built from the
 *   running CLI and quoted arguments, never rewritten text) or a manual
 *   action, never prose labelled as a command.
 */

export const UPGRADE_CHECK_REPORT_VERSION = 1;

/** How printed commands run the CLI that produced the report. */
export type UpgradeCommandPrefix = {
  /** Environment assignments placed before the command. */
  readonly env: Readonly<Record<string, string>>;
  /** The executable (and any fixed leading arguments). */
  readonly argv: readonly string[];
};

/**
 * During the prerelease, v5 runs through a candidate launcher while stable
 * v4 stays `hack` on PATH, so a bare `hack` would run the old CLI. The
 * `hack-next` launcher lives at `~/.hack-next/bin/hack-next` (not on PATH);
 * a Compose candidate run also needs `HACK_RUNTIME_BACKEND=compose`.
 */
export function upgradeCommandPrefix(opts: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}): UpgradeCommandPrefix {
  const entry = (opts.env.HACK_CANDIDATE_ENTRYPOINT ?? "").trim();
  if (entry === "") {
    return { env: {}, argv: ["hack"] };
  }
  const launcher =
    entry === "hack-next"
      ? join(opts.homeDir, ".hack-next", "bin", "hack-next")
      : entry;
  return {
    env:
      (opts.env.HACK_RUNTIME_BACKEND ?? "").trim() === "compose"
        ? { HACK_RUNTIME_BACKEND: "compose" }
        : {},
    argv: [launcher],
  };
}

/** A shell command line: every word quoted on its own. */
export function renderUpgradeCommand(
  prefix: UpgradeCommandPrefix,
  args: readonly string[]
): string {
  return [
    ...Object.entries(prefix.env).map(
      ([key, value]) => `${key}=${quoteShellWord(value)}`
    ),
    ...[...prefix.argv, ...args].map((word) => quoteShellWord(word)),
  ].join(" ");
}

/** A finding as reported: its command rendered for the running CLI. */
export type UpgradeReportFinding = UpgradeFinding & {
  /** The command line for `args`; null when only `action` applies. */
  readonly command: string | null;
};

export type UpgradePlanStep = {
  readonly order: number;
  /** The finding this step resolves, or `snapshot`. */
  readonly id: string;
  /** `machine`, or the checkout's registered name. */
  readonly scope: string;
  readonly status: UpgradeFindingStatus | "step";
  /** An executable command line; null for a manual step. */
  readonly command: string | null;
  /** Its Hack CLI arguments (after `cli.command`); null for a manual step. */
  readonly args: readonly string[] | null;
  /** A manual action: what to do when there is no command, or instead of it. */
  readonly action: string | null;
  readonly why: string;
  readonly blocker: boolean;
};

export type UpgradeProjectReport = {
  readonly name: string;
  readonly root: string;
  readonly state: "live" | "unreadable";
  readonly reason: string | null;
  readonly findings: readonly UpgradeReportFinding[];
};

type ScopedFinding = {
  readonly scope: string;
  readonly id: string;
  readonly summary: string;
};

export type UpgradeCheckReport = {
  readonly report_version: typeof UPGRADE_CHECK_REPORT_VERSION;
  readonly generated_at: string;
  readonly duration_ms: number;
  readonly cli: {
    readonly version: string;
    readonly channel: "stable" | "next";
    readonly candidate_run: boolean;
    /** How printed commands run this CLI, as a command-line prefix. */
    readonly command: string;
  };
  /** `disabled` when HACK_HOST_PROBES_DISABLE=1 refused every host probe. */
  readonly host_probes: "enabled" | "disabled";
  readonly machine: readonly UpgradeReportFinding[];
  readonly registry: {
    readonly state: "valid" | "absent" | "invalid" | "unreadable";
    /** Registered projects. */
    readonly projects: number;
    /** Checkouts: each project's primary checkout and linked worktrees. */
    readonly total: number;
    readonly live: number;
    /** Dead entries: the checkout or its config is gone. */
    readonly missing: readonly RegistryEntrySummary[];
    /** Entries that exist but cannot be read. */
    readonly unreadable: readonly RegistryEntrySummary[];
    /** Entries the deadline cut short. */
    readonly unchecked: readonly RegistryEntrySummary[];
    /** Registry records that are not valid project entries. */
    readonly rejected: number;
  };
  readonly projects: readonly UpgradeProjectReport[];
  readonly blockers: readonly ScopedFinding[];
  /** Required checks that could not be performed. */
  readonly incomplete: readonly ScopedFinding[];
  readonly plan: readonly UpgradePlanStep[];
  /** The first plan step's command; null when it is manual or there is nothing to do. */
  readonly next_command: string | null;
  /** The first plan step's manual action when it has no command. */
  readonly next_action: string | null;
  readonly ready: boolean;
};

type RegistryEntrySummary = {
  readonly name: string;
  readonly root: string;
  readonly reason: string;
};

const PROJECT_CONCURRENCY = 8;
const CLASSIFY_CONCURRENCY = 16;
const PROBE_TIMEOUT_MS = 12_000;
/** The whole check's budget: nothing starts after it, so it ends under 30 s. */
const CHECK_BUDGET_MS = 25_000;

/** Runs every check and builds the plan. */
export async function runUpgradeCheck(opts: {
  readonly cliVersion: string;
  readonly homeDir: string;
  readonly probes: UpgradeCheckProbes;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  /** Test seams: the whole budget and the per-check limit. */
  readonly budgetMs?: number;
  readonly checkTimeoutMs?: number;
}): Promise<UpgradeCheckReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = Date.now() + (opts.budgetMs ?? CHECK_BUDGET_MS);
  const env = opts.env ?? process.env;
  const prefix = upgradeCommandPrefix({ env, homeDir: opts.homeDir });
  const render = (finding: UpgradeFinding): UpgradeReportFinding => ({
    ...finding,
    command:
      finding.args === null ? null : renderUpgradeCommand(prefix, finding.args),
  });
  const [registry, machine] = await Promise.all([
    inspectRegistry({ deadline }),
    inspectMachine({
      probes: opts.probes,
      cliVersion: opts.cliVersion,
      env,
      deadline,
    }),
  ]);
  const projects = await mapLimit(
    registry.live,
    PROJECT_CONCURRENCY,
    async (project): Promise<UpgradeProjectReport> => ({
      name: project.name,
      root: project.repoRoot,
      state: "live",
      reason: null,
      findings: (
        await inspectUpgradeProject({
          project,
          homeDir: opts.homeDir,
          nativePreflight: opts.probes.nativePreflight,
          deadline,
          checkTimeoutMs: opts.checkTimeoutMs,
        })
      ).map(render),
    })
  );
  const unreadableProjects: UpgradeProjectReport[] =
    registry.report.unreadable.map((entry) => ({
      name: entry.name,
      root: entry.root,
      state: "unreadable",
      reason: entry.reason,
      findings: [
        render({
          id: "project-config",
          status: "blocker",
          summary: `This live checkout cannot be read (${entry.reason}), so it cannot be upgraded safely.`,
          args: ["doctor", "--path", entry.root],
          action:
            "Fix its permissions or its config file, then rerun the upgrade check.",
        }),
      ],
    }));
  const allProjects = [...projects, ...unreadableProjects].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const machineFindings = [...machine, ...registry.findings].map(render);
  const scoped = (status: UpgradeFindingStatus): ScopedFinding[] => [
    ...machineFindings
      .filter((finding) => finding.status === status)
      .map((finding) => ({
        scope: "machine",
        id: finding.id,
        summary: finding.summary,
      })),
    ...allProjects.flatMap((project) =>
      project.findings
        .filter((finding) => finding.status === status)
        .map((finding) => ({
          scope: project.name,
          id: finding.id,
          summary: finding.summary,
        }))
    ),
  ];
  const blockers = scoped("blocker");
  const incomplete = scoped("incomplete");
  const plan = buildPlan({
    machine: machineFindings,
    projects: allProjects,
    prefix,
  });
  const first = plan[0];
  const version = opts.cliVersion;
  return {
    report_version: UPGRADE_CHECK_REPORT_VERSION,
    generated_at: new Date(started).toISOString(),
    duration_ms: Math.max(0, now() - started),
    cli: {
      version,
      channel: version.includes("-next.") ? "next" : "stable",
      candidate_run: isCandidateRun(env),
      command: renderUpgradeCommand(prefix, []),
    },
    host_probes: opts.probes.disabled === true ? "disabled" : "enabled",
    machine: machineFindings,
    registry: registry.report,
    projects: allProjects,
    blockers,
    incomplete,
    plan,
    next_command: first?.command ?? null,
    next_action:
      first !== undefined && first.command === null ? first.action : null,
    ready: blockers.length === 0 && incomplete.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

async function inspectRegistry(opts: { readonly deadline: number }): Promise<{
  readonly report: UpgradeCheckReport["registry"];
  readonly live: readonly RegisteredCheckout[];
  readonly findings: readonly UpgradeFinding[];
}> {
  const registryPath = resolveProjectsRegistryPath();
  const empty = {
    projects: 0,
    total: 0,
    live: 0,
    missing: [],
    unreadable: [],
    unchecked: [],
    rejected: 0,
  } as const;
  const read = await withDeadline(
    readProjectsRegistryStrict().catch(() => "error" as const),
    opts.deadline
  );
  if (read === "timeout" || read === "error" || read.kind !== "valid") {
    return {
      report: { state: registryFailureState(read), ...empty },
      live: [],
      findings: [registryReadFinding({ read, registryPath })],
    };
  }
  const entries = read.registry.projects;
  // Every registered checkout: each project's primary and linked worktrees.
  const checkouts = entries.flatMap(registeredCheckouts);
  const states = await mapLimit(
    checkouts,
    CLASSIFY_CONCURRENCY,
    async (checkout) => {
      const state = await withDeadline(
        classifyRegistryEntry(checkout).catch(
          (): RegistryEntryState => ({
            state: "unreadable",
            reason: "it could not be read",
          })
        ),
        opts.deadline
      );
      return { checkout, state };
    }
  );
  const summary = (checkout: RegisteredCheckout, reason: string) => ({
    name: checkout.name,
    root: checkout.repoRoot,
    reason,
  });
  const live: RegisteredCheckout[] = [];
  const missing: RegistryEntrySummary[] = [];
  const unreadable: RegistryEntrySummary[] = [];
  const unchecked: RegistryEntrySummary[] = [];
  for (const { checkout, state } of states) {
    if (state === "timeout") {
      unchecked.push(summary(checkout, "not read before the check's deadline"));
    } else if (state.state === "live") {
      live.push(checkout);
    } else if (state.state === "missing") {
      missing.push(summary(checkout, state.reason));
    } else {
      unreadable.push(summary(checkout, state.reason));
    }
  }
  const findings = registryFindings({
    projects: entries.length,
    checkouts: checkouts.length,
    live: live.length,
    missing: missing.length,
    unchecked: unchecked.length,
    unreadable: unreadable.length,
    rejected: read.rejected,
  });
  return {
    report: {
      state: "valid",
      projects: entries.length,
      total: checkouts.length,
      live: live.length,
      missing,
      unreadable,
      unchecked,
      rejected: read.rejected,
    },
    live,
    findings,
  };
}

/** The registry's own findings: its counts, dead entries, cut-short and rejected records. */
function registryFindings(counts: {
  readonly projects: number;
  readonly checkouts: number;
  readonly live: number;
  readonly missing: number;
  readonly unchecked: number;
  readonly unreadable: number;
  readonly rejected: number;
}): UpgradeFinding[] {
  const findings: UpgradeFinding[] = [
    {
      id: "registry",
      status: "ok",
      summary: `${counts.projects} registered project(s), ${counts.checkouts} checkout(s) with worktrees: ${counts.live} live, ${counts.missing} dead, ${counts.unreadable} unreadable.`,
      args: null,
      action: null,
    },
  ];
  if (counts.missing > 0) {
    findings.push({
      id: "registry-dead",
      status: "warn",
      summary: `${counts.missing} registry entr${counts.missing === 1 ? "y points" : "ies point"} at a checkout or config that is gone. They are not live projects that failed to read; pruning them only edits the registry.`,
      args: ["projects", "prune", "--dry-run"],
      action: null,
    });
  }
  if (counts.unchecked > 0) {
    findings.push({
      id: "registry-unchecked",
      status: "incomplete",
      summary: `${counts.unchecked} registered checkout(s) could not be read before the check's deadline (a slow or unavailable filesystem?); they were not checked.`,
      args: ["upgrade", "check"],
      action: null,
    });
  }
  if (counts.rejected > 0) {
    findings.push({
      id: "registry-rejected",
      status: "warn",
      summary: `${counts.rejected} registry record(s) are not valid project entries and were skipped.`,
      args: ["projects", "prune", "--dry-run"],
      action: null,
    });
  }
  return findings;
}

type RegistryRead =
  | "timeout"
  | "error"
  | { readonly kind: "absent" | "invalid" };

function registryFailureState(
  read: RegistryRead
): "unreadable" | "invalid" | "absent" {
  if (read === "timeout" || read === "error") {
    return "unreadable";
  }
  return read.kind;
}

/** The one finding for a registry that is absent, invalid, unreadable or slow. */
function registryReadFinding(opts: {
  readonly read: RegistryRead;
  readonly registryPath: string;
}): UpgradeFinding {
  const { read, registryPath } = opts;
  if (read === "timeout" || read === "error") {
    return {
      id: "registry",
      status: read === "timeout" ? "incomplete" : "blocker",
      summary:
        read === "timeout"
          ? "The projects registry could not be read in time, so the projects to upgrade are unknown."
          : "The projects registry exists but cannot be read, so the projects to upgrade are unknown.",
      args: null,
      action: `Check that ${registryPath} is readable, then rerun the upgrade check.`,
    };
  }
  if (read.kind === "invalid") {
    return {
      id: "registry",
      status: "blocker",
      summary:
        "The projects registry is not valid JSON or not a registry, so the projects to upgrade are unknown.",
      args: null,
      action: `Repair ${registryPath}, or move it aside and run hack once in each project to register it again; then rerun the upgrade check.`,
    };
  }
  return {
    id: "registry",
    status: "ok",
    summary: "No projects are registered.",
    args: null,
    action: null,
  };
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

async function inspectMachine(opts: {
  readonly probes: UpgradeCheckProbes;
  readonly cliVersion: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly deadline: number;
}): Promise<readonly UpgradeFinding[]> {
  const { probes, deadline } = opts;
  const docker = await probe(probes.docker, "unreachable" as const, deadline);
  const [pathHack, daemon, infra, linuxDns, store] = await Promise.all([
    probe(probes.pathHack, null, deadline),
    probe(probes.daemon, null, deadline),
    probe(() => probes.globalInfra({ docker }), null, deadline),
    probe(probes.linuxDns, undefined, deadline),
    probe(() => inspectGlobalSecretStore({ env: opts.env }), null, deadline),
  ]);
  const proxy =
    infra?.running === true
      ? await probe(probes.proxyPorts, null, deadline)
      : null;
  const findings: UpgradeFinding[] = [];
  if (probes.disabled === true) {
    findings.push({
      id: "host-probes",
      status: "incomplete",
      summary:
        "Host probes are disabled (HACK_HOST_PROBES_DISABLE=1): Docker, the daemon service, global services, proxy ports and DNS were not checked.",
      args: null,
      action: "Unset HACK_HOST_PROBES_DISABLE, then rerun the upgrade check.",
    });
  }
  findings.push(
    pathHackFinding({ probe: pathHack, cliVersion: opts.cliVersion })
  );
  findings.push(daemonFinding(daemon));
  findings.push(...infraFindings({ docker, infra, proxy }));
  if (linuxDns !== null) {
    // Before `hack global install` runs, it sets the route up too.
    findings.push(
      infra !== null && !infra.installed
        ? {
            id: "linux-dns",
            status: "info",
            summary:
              "The Linux DNS route is set up by hack global install (listed above).",
            args: null,
            action: null,
          }
        : linuxDnsFinding(linuxDns)
    );
  }
  findings.push(
    store ?? {
      id: "secret-store",
      status: "incomplete",
      summary:
        "Not checked: the global secret store check failed or ran out of time.",
      args: ["doctor"],
      action: null,
    }
  );
  return findings;
}

function pathHackFinding(opts: {
  readonly probe: Awaited<ReturnType<UpgradeCheckProbes["pathHack"]>> | null;
  readonly cliVersion: string;
}): UpgradeFinding {
  const found = opts.probe;
  let summary: string;
  if (found === null) {
    summary = `Running ${opts.cliVersion}; the hack on PATH could not be checked.`;
  } else if (found.path === null) {
    summary = `Running ${opts.cliVersion}; no hack is on PATH.`;
  } else {
    summary = `Running ${opts.cliVersion}; the hack on PATH is ${found.version ?? "an unknown version"} (${found.install}) at ${found.path}.`;
  }
  return { id: "installed", status: "info", summary, args: null, action: null };
}

function daemonFinding(
  daemon: Awaited<ReturnType<UpgradeCheckProbes["daemon"]>> | null
): UpgradeFinding {
  if (daemon === null) {
    return {
      id: "daemon",
      status: "warn",
      summary: "Not checked: the daemon service could not be read.",
      args: ["daemon", "status"],
      action: null,
    };
  }
  const step = daemon.nextStep;
  const hackStep = step?.startsWith("hack ") === true;
  const unmanaged = daemon.running
    ? "running, started directly"
    : "not running";
  const owner =
    daemon.manager === null
      ? unmanaged
      : `${daemon.manager}: ${daemon.summary}`;
  return {
    id: "daemon",
    status: daemon.severity === "warn" ? "warn" : "info",
    summary: `hackd ${daemon.running ? "is running" : "is not running"}${daemon.managed ? `, run by ${daemon.manager}` : ""}; login service ${daemon.registered ? "registered" : "not registered"} (${owner}).`,
    args: hackStep ? (step?.slice("hack ".length).split(" ") ?? null) : null,
    action: hackStep ? null : step,
  };
}

function infraFindings(opts: {
  readonly docker: "reachable" | "unreachable" | "missing";
  readonly infra: Awaited<ReturnType<UpgradeCheckProbes["globalInfra"]>> | null;
  readonly proxy: Awaited<ReturnType<UpgradeCheckProbes["proxyPorts"]>> | null;
}): UpgradeFinding[] {
  const findings: UpgradeFinding[] = [];
  if (opts.docker !== "reachable") {
    findings.push({
      id: "docker",
      status: "warn",
      summary:
        opts.docker === "missing"
          ? "Docker is not installed; the Compose backend needs it."
          : "Docker does not answer; global services and proxy ports were not checked.",
      args: null,
      action:
        opts.docker === "missing"
          ? "Install Docker Engine (or Docker Desktop on macOS)."
          : "Start Docker, then rerun the upgrade check.",
    });
  }
  if (opts.infra === null || !opts.infra.installed) {
    findings.push({
      id: "global-infra",
      status: "warn",
      summary:
        opts.infra === null
          ? "Not checked: Hack's global services could not be read."
          : "Hack's global proxy and DNS are not installed on this machine.",
      args: ["global", "install"],
      action: null,
    });
  } else if (opts.infra.running === false) {
    findings.push({
      id: "global-infra",
      status: "warn",
      summary: "Hack's global proxy and DNS are installed but not running.",
      args: ["global", "up"],
      action: null,
    });
  } else {
    findings.push({
      id: "global-infra",
      status: opts.infra.running === null ? "info" : "ok",
      summary:
        opts.infra.running === null
          ? "Hack's global proxy is installed; whether it runs was not checked."
          : "Hack's global proxy and DNS are installed and running.",
      args: null,
      action: null,
    });
  }
  if (opts.proxy !== null) {
    findings.push({
      id: "proxy-ports",
      status: opts.proxy.status === "ok" ? "ok" : "warn",
      summary: opts.proxy.message,
      args: opts.proxy.status === "ok" ? null : ["doctor"],
      action: null,
    });
  }
  return findings;
}

function linuxDnsFinding(
  inspection: Awaited<ReturnType<UpgradeCheckProbes["linuxDns"]>> | undefined
): UpgradeFinding {
  if (inspection === undefined || inspection === null) {
    return {
      id: "linux-dns",
      status: "warn",
      summary: "Not checked: the Linux DNS route could not be read.",
      args: ["doctor"],
      action: null,
    };
  }
  return inspection.state === "configured"
    ? {
        id: "linux-dns",
        status: "ok",
        summary: "The Linux DNS route for Hack's names is configured.",
        args: null,
        action: null,
      }
    : {
        id: "linux-dns",
        status: "warn",
        summary: `Linux DNS route: ${inspection.state}${inspection.code ? ` (${inspection.code})` : ""}.`,
        args: ["global", "install"],
        action: inspection.fix[0] ?? null,
      };
}

/**
 * The global encrypted secret store and the key the runtime would use, read
 * only ({@link inspectStoreKeyState}): never the keychain, never a
 * provisioned key. A store whose key is known to be gone or wrong blocks
 * only when a registered project reads it (the #779 rule).
 */
async function inspectGlobalSecretStore(opts: {
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<UpgradeFinding> {
  const base = { id: "secret-store" } as const;
  if ((await secretStoreSelectionProblem({})) !== null) {
    return {
      ...base,
      status: "incomplete",
      summary:
        "The global config that selects the secret store cannot be read; the store was not checked.",
      args: ["doctor"],
      action: null,
    };
  }
  const location = await resolveFileSecretStorePaths({});
  if (!location.active) {
    return {
      ...base,
      status: "ok",
      summary: "Secrets use the OS keychain; no file store to check.",
      args: null,
      action: null,
    };
  }
  const retired = (await listRetiredEncryptedStores(location.storePath)).length;
  const retiredNote =
    retired > 0
      ? ` ${retired} retired store archive(s) are kept beside it.`
      : "";
  const state = await inspectStoreKeyState({
    storePath: location.storePath,
    keyPath: location.keyPath,
    env: opts.env,
  });
  if (state.kind === "no-store") {
    return {
      ...base,
      status: "ok",
      summary: `No global secret store file (nothing is stored in it).${retiredNote}`,
      args: null,
      action: null,
    };
  }
  if (state.kind === "opens") {
    return {
      ...base,
      status: "ok",
      summary: `The global secret store opens with ${state.source === "env" ? "HACK_SECRETS_FILE_KEY from this shell" : "its key file"}.${retiredNote}`,
      args: null,
      action: null,
    };
  }
  if (state.kind === "store-unreadable") {
    return {
      ...base,
      status: "incomplete",
      summary:
        "The global secret store file cannot be read, so its state is unknown.",
      args: ["doctor"],
      action: null,
    };
  }
  if (state.kind === "key-uninspected") {
    return {
      ...base,
      status: "incomplete",
      summary:
        "The global secret store's key file is missing; the OS keychain may hold its key, but it was not asked (asking can prompt).",
      args: ["doctor"],
      action:
        "hack doctor asks the OS keychain and reports whether the key is there.",
    };
  }
  // Each reader's own key decides whether it is stranded: a project may
  // share this store but name a key file of its own that works.
  const readers = await readerKeyStates({
    storePath: location.storePath,
    globalKeyPath: location.keyPath,
    globalState: state,
    env: opts.env,
  });
  return storeFailureFinding({ state, readers, retiredNote });
}

/** The finding for a global store whose own key does not open it, given each reader's key. */
function storeFailureFinding(opts: {
  readonly state: Exclude<
    Awaited<ReturnType<typeof inspectStoreKeyState>>,
    { kind: "no-store" | "opens" | "store-unreadable" | "key-uninspected" }
  >;
  readonly readers: { readonly failing: string[]; readonly opening: string[] };
  readonly retiredNote: string;
}): UpgradeFinding {
  const { state, readers, retiredNote } = opts;
  const base = { id: "secret-store" } as const;
  if (readers.failing.length === 0 && readers.opening.length > 0) {
    return {
      ...base,
      status: "warn",
      summary: `The global secret store's own key does not open it, but every registered project that reads it (${readers.opening.join(", ")}) opens it with its own key.${retiredNote}`,
      args: ["doctor"],
      action: null,
    };
  }
  const usedBy =
    readers.failing.length > 0
      ? ` Read by: ${readers.failing.join(", ")}.`
      : " No registered project reads it.";
  const blocking: UpgradeFindingStatus =
    readers.failing.length > 0 ? "blocker" : "warn";
  if (readers.opening.length > 0) {
    // Retiring is refused while another configured key opens the store.
    return {
      ...base,
      status: blocking,
      summary: `The global secret store does not open with the key${readers.failing.length === 1 ? "" : "s"} of ${readers.failing.join(", ")}, though ${readers.opening.join(", ")} open${readers.opening.length === 1 ? "s" : ""} it with another key.`,
      args: ["doctor"],
      action: `Give ${readers.failing.join(", ")} the key that opens the store (the keyPath ${readers.opening.join(", ")} use${readers.opening.length === 1 ? "s" : ""}), or HACK_SECRETS_FILE_KEY.`,
    };
  }
  if (state.kind === "key-refused") {
    return {
      ...base,
      status: blocking,
      summary: `The global secret store's key is refused at runtime (a link, readable by others, or tracked by Git).${usedBy}`,
      args: ["doctor"],
      action: state.message,
    };
  }
  if (state.kind === "wrong-key" && state.source === "env") {
    return {
      ...base,
      status: blocking,
      summary: `HACK_SECRETS_FILE_KEY in this shell does not open the global secret store.${usedBy}`,
      args: null,
      action:
        "Unset HACK_SECRETS_FILE_KEY or set it to the store's key, then rerun the upgrade check.",
    };
  }
  return {
    ...base,
    status: blocking,
    summary: `The global secret store ${state.kind === "key-missing" ? "has no key file (and the keychain fallback is off)" : "does not open with its key file"}.${usedBy}${retiredNote}`,
    args: ["secrets", "retire-store", "--allow-unchecked"],
    action:
      "Or restore the store's key file (or set HACK_SECRETS_FILE_KEY) instead of retiring it.",
  };
}

/**
 * Splits the store's readers by whether the key their own configuration
 * selects (with this shell's HACK_SECRETS_FILE_KEY first, as at runtime)
 * opens it. Read-only; never the keychain.
 */
async function readerKeyStates(opts: {
  readonly storePath: string;
  readonly globalKeyPath: string;
  readonly globalState: Awaited<ReturnType<typeof inspectStoreKeyState>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly failing: string[]; readonly opening: string[] }> {
  const found = await listSecretStoreReaders({ storePath: opts.storePath });
  const failing = new Set<string>();
  const opening = new Set<string>();
  for (const reader of found.readers) {
    const state =
      resolve(reader.keyPath) === resolve(opts.globalKeyPath)
        ? opts.globalState
        : await inspectStoreKeyState({
            storePath: opts.storePath,
            keyPath: reader.keyPath,
            env: opts.env,
          });
    (state.kind === "opens" ? opening : failing).add(reader.name);
  }
  return { failing: [...failing].sort(), opening: [...opening].sort() };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Machine fixes in the order they should run. */
const MACHINE_ORDER = [
  "host-probes",
  "registry",
  "registry-unchecked",
  "secret-store",
  "registry-dead",
  "registry-rejected",
  "docker",
  "global-infra",
  "linux-dns",
  "proxy-ports",
  "daemon",
] as const;

/** Checkout fixes in the order they should run. */
const PROJECT_ORDER = [
  "project-config",
  "env-format",
  "env-key",
  "tracked-files",
  "ignore-rules",
  "agent-integrations",
] as const;

const ACTIONABLE: ReadonlySet<UpgradeFindingStatus> = new Set([
  "blocker",
  "incomplete",
  "warn",
]);

function buildPlan(opts: {
  readonly machine: readonly UpgradeReportFinding[];
  readonly projects: readonly UpgradeProjectReport[];
  readonly prefix: UpgradeCommandPrefix;
}): UpgradePlanStep[] {
  type Draft = Omit<UpgradePlanStep, "order">;
  const actionable = (finding: UpgradeReportFinding) =>
    ACTIONABLE.has(finding.status) &&
    (finding.args !== null || finding.action !== null);
  const rank =
    (order: readonly string[]) => (finding: UpgradeReportFinding) => {
      const index = order.indexOf(finding.id);
      return index === -1 ? order.length : index;
    };
  const toStep =
    (scope: string) =>
    (finding: UpgradeReportFinding): Draft => ({
      id: finding.id,
      scope,
      status: finding.status,
      command: finding.command,
      args: finding.args,
      action: finding.action,
      why: finding.summary,
      blocker: finding.status === "blocker",
    });
  const machineSteps = [...opts.machine]
    .filter(actionable)
    .sort((a, b) => rank(MACHINE_ORDER)(a) - rank(MACHINE_ORDER)(b))
    .map(toStep("machine"));
  const projectSteps = opts.projects.flatMap((project) =>
    [...project.findings]
      .filter(actionable)
      .sort((a, b) => rank(PROJECT_ORDER)(a) - rank(PROJECT_ORDER)(b))
      .map(toStep(project.name))
  );
  const steps = [...machineSteps, ...projectSteps];
  const severity = (step: Draft) => {
    if (step.status === "blocker") {
      return 0;
    }
    return step.status === "incomplete" ? 1 : 2;
  };
  const ordered = steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => severity(a.step) - severity(b.step) || a.index - b.index)
    .map(({ step }) => step);
  // A snapshot first, before any step changes a file, so `hack upgrade
  // rollback` can put back what the following steps change. It covers
  // files only: not the Git index, services or containers.
  const snapshot: Draft[] =
    ordered.length > 0
      ? [
          {
            id: "snapshot",
            scope: "machine",
            status: "step",
            command: renderUpgradeCommand(opts.prefix, ["upgrade", "snapshot"]),
            args: ["upgrade", "snapshot"],
            action: null,
            why: "Keep a private copy of the files the following steps change, so the upgrade rollback command can put them back.",
            blocker: false,
          },
        ]
      : [];
  return [...snapshot, ...ordered].map((step, index) => ({
    order: index + 1,
    ...step,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `work`, or `timeout` once `deadline` (epoch ms) passes. */
async function withDeadline<T>(
  work: Promise<T>,
  deadline: number
): Promise<T | "timeout"> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return "timeout";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), remaining);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A probe's result, or `fallback` when it fails or outlives its limit. */
async function probe<T, F>(
  run: () => Promise<T>,
  fallback: F,
  deadline: number
): Promise<T | F> {
  try {
    const result = await withDeadline(
      run(),
      Math.min(deadline, Date.now() + PROBE_TIMEOUT_MS)
    );
    return result === "timeout" ? fallback : result;
  } catch {
    return fallback;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await run(items[index] as T);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
