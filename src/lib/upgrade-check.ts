import { isCandidateRun } from "../daemon/client.ts";
import {
  type RegisteredProject,
  readProjectsRegistryStrict,
  resolveProjectsRegistryPath,
} from "./projects-registry.ts";
import {
  keyFileOpensStore,
  listRetiredEncryptedStores,
  resolveFileSecretStorePaths,
} from "./secret-store.ts";
import {
  listProjectsUsingSecretStore,
  secretStoreSelectionProblem,
} from "./secret-store-retire.ts";
import type { UpgradeCheckProbes } from "./upgrade-check-probes.ts";
import {
  classifyRegistryEntry,
  inspectUpgradeProject,
  type UpgradeFinding,
} from "./upgrade-check-project.ts";

export type {
  UpgradeFinding,
  UpgradeFindingStatus,
} from "./upgrade-check-project.ts";

/**
 * `hack upgrade check` (HACK-2189, the upgrade assistant HACK-2188): a
 * read-only report on the machine and every registered project, ending in an
 * ordered plan and the single next command.
 *
 * Contract:
 * - Changes nothing: no file, registry, service, container or key is
 *   written, started or provisioned, and nothing prompts. Host probes are
 *   injected ({@link UpgradeCheckProbes}) and time-limited.
 * - No value in the report: names, paths, counts, states and codes only.
 * - Dead registry entries (the checkout or its config is gone) are counted
 *   apart from live entries that cannot be read; only live projects get the
 *   per-project checks, so a registry of mostly dead entries stays fast.
 * - A finding is a `blocker` when continuing would fail or lose data; the
 *   report is `ready` exactly when there is none.
 */

export const UPGRADE_CHECK_REPORT_VERSION = 1;

export type UpgradePlanStep = {
  readonly order: number;
  /** The finding this step resolves, or `snapshot`. */
  readonly id: string;
  /** `machine`, or the project's registered name. */
  readonly scope: string;
  readonly command: string;
  readonly why: string;
  readonly blocker: boolean;
};

export type UpgradeProjectReport = {
  readonly name: string;
  readonly root: string;
  readonly state: "live" | "unreadable";
  readonly reason: string | null;
  readonly findings: readonly UpgradeFinding[];
};

export type UpgradeCheckReport = {
  readonly report_version: typeof UPGRADE_CHECK_REPORT_VERSION;
  readonly generated_at: string;
  readonly duration_ms: number;
  readonly cli: {
    readonly version: string;
    readonly channel: "stable" | "next";
    readonly candidate_run: boolean;
  };
  readonly machine: readonly UpgradeFinding[];
  readonly registry: {
    readonly state: "valid" | "absent" | "invalid" | "unreadable";
    readonly total: number;
    readonly live: number;
    /** Dead entries: the checkout or its config is gone. */
    readonly missing: readonly {
      readonly name: string;
      readonly root: string;
      readonly reason: string;
    }[];
    /** Entries that exist but cannot be read. */
    readonly unreadable: readonly {
      readonly name: string;
      readonly root: string;
      readonly reason: string;
    }[];
    /** Registry records that are not valid project entries. */
    readonly rejected: number;
  };
  readonly projects: readonly UpgradeProjectReport[];
  readonly blockers: readonly {
    readonly scope: string;
    readonly id: string;
    readonly summary: string;
  }[];
  readonly plan: readonly UpgradePlanStep[];
  /** The first plan step's command; null when there is nothing to do. */
  readonly next_command: string | null;
  readonly ready: boolean;
};

const PROJECT_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 12_000;

/** Runs every check and builds the plan. */
export async function runUpgradeCheck(opts: {
  readonly cliVersion: string;
  readonly homeDir: string;
  readonly probes: UpgradeCheckProbes;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}): Promise<UpgradeCheckReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const env = opts.env ?? process.env;
  const [registry, machine] = await Promise.all([
    inspectRegistry(),
    inspectMachine({ probes: opts.probes, cliVersion: opts.cliVersion }),
  ]);
  const projects = await mapLimit(
    registry.live,
    PROJECT_CONCURRENCY,
    async (project): Promise<UpgradeProjectReport> => ({
      name: project.name,
      root: project.repoRoot,
      state: "live",
      reason: null,
      findings: await inspectUpgradeProject({
        project,
        homeDir: opts.homeDir,
        nativePreflight: opts.probes.nativePreflight,
      }),
    })
  );
  const unreadableProjects: UpgradeProjectReport[] =
    registry.report.unreadable.map((entry) => ({
      name: entry.name,
      root: entry.root,
      state: "unreadable",
      reason: entry.reason,
      findings: [],
    }));
  const allProjects = [...projects, ...unreadableProjects].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const machineFindings = [...machine, ...registry.findings];
  const blockers = [
    ...machineFindings
      .filter((finding) => finding.status === "blocker")
      .map((finding) => ({
        scope: "machine",
        id: finding.id,
        summary: finding.summary,
      })),
    ...allProjects.flatMap((project) =>
      project.findings
        .filter((finding) => finding.status === "blocker")
        .map((finding) => ({
          scope: project.name,
          id: finding.id,
          summary: finding.summary,
        }))
    ),
  ];
  const plan = buildPlan({ machine: machineFindings, projects: allProjects });
  const version = opts.cliVersion;
  return {
    report_version: UPGRADE_CHECK_REPORT_VERSION,
    generated_at: new Date(started).toISOString(),
    duration_ms: Math.max(0, now() - started),
    cli: {
      version,
      channel: version.includes("-next.") ? "next" : "stable",
      candidate_run: isCandidateRun(env),
    },
    machine: machineFindings,
    registry: registry.report,
    projects: allProjects,
    blockers,
    plan,
    next_command: plan[0]?.command ?? null,
    ready: blockers.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

async function inspectRegistry(): Promise<{
  readonly report: UpgradeCheckReport["registry"];
  readonly live: readonly RegisteredProject[];
  readonly findings: readonly UpgradeFinding[];
}> {
  const empty = {
    total: 0,
    live: 0,
    missing: [],
    unreadable: [],
    rejected: 0,
  } as const;
  let read: Awaited<ReturnType<typeof readProjectsRegistryStrict>>;
  try {
    read = await readProjectsRegistryStrict();
  } catch {
    return {
      report: { state: "unreadable", ...empty },
      live: [],
      findings: [
        {
          id: "registry",
          status: "blocker",
          summary:
            "The projects registry exists but cannot be read, so the projects to upgrade are unknown.",
          fix: `Check the permissions of ${resolveProjectsRegistryPath()}, then rerun hack upgrade check.`,
        },
      ],
    };
  }
  if (read.kind === "invalid") {
    return {
      report: { state: "invalid", ...empty },
      live: [],
      findings: [
        {
          id: "registry",
          status: "blocker",
          summary:
            "The projects registry is not valid JSON or not a registry, so the projects to upgrade are unknown.",
          fix: `Repair ${resolveProjectsRegistryPath()} (or move it aside and rerun hack in each project), then rerun hack upgrade check.`,
        },
      ],
    };
  }
  if (read.kind !== "valid") {
    return {
      report: { state: "absent", ...empty },
      live: [],
      findings: [
        {
          id: "registry",
          status: "ok",
          summary: "No projects are registered.",
          fix: null,
        },
      ],
    };
  }
  const projects = read.registry.projects;
  const states = await mapLimit(projects, 16, async (project) => ({
    project,
    state: await classifyRegistryEntry(project),
  }));
  const live = states
    .filter((entry) => entry.state.state === "live")
    .map((entry) => entry.project);
  const missing = states.flatMap((entry) =>
    entry.state.state === "missing"
      ? [
          {
            name: entry.project.name,
            root: entry.project.repoRoot,
            reason: entry.state.reason,
          },
        ]
      : []
  );
  const unreadable = states.flatMap((entry) =>
    entry.state.state === "unreadable"
      ? [
          {
            name: entry.project.name,
            root: entry.project.repoRoot,
            reason: entry.state.reason,
          },
        ]
      : []
  );
  const findings: UpgradeFinding[] = [];
  findings.push({
    id: "registry",
    status: "ok",
    summary: `${projects.length} registered project(s): ${live.length} live, ${missing.length} dead, ${unreadable.length} unreadable.`,
    fix: null,
  });
  if (missing.length > 0) {
    findings.push({
      id: "registry-dead",
      status: "warn",
      summary: `${missing.length} registry entr${missing.length === 1 ? "y points" : "ies point"} at a checkout or config that is gone. They are not live projects that failed to read; pruning them only edits the registry.`,
      fix: "hack projects prune --dry-run",
    });
  }
  if (unreadable.length > 0) {
    findings.push({
      id: "registry-unreadable",
      status: "warn",
      summary: `${unreadable.length} registered project(s) exist but cannot be read (${unreadable.map((entry) => entry.name).join(", ")}); they were not checked.`,
      fix: "Fix their permissions or config, then rerun hack upgrade check.",
    });
  }
  if (read.rejected > 0) {
    findings.push({
      id: "registry-rejected",
      status: "warn",
      summary: `${read.rejected} registry record(s) are not valid project entries and were skipped.`,
      fix: "hack projects prune --dry-run",
    });
  }
  return {
    report: {
      state: "valid",
      total: projects.length,
      live: live.length,
      missing,
      unreadable,
      rejected: read.rejected,
    },
    live,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

async function inspectMachine(opts: {
  readonly probes: UpgradeCheckProbes;
  readonly cliVersion: string;
}): Promise<readonly UpgradeFinding[]> {
  const { probes } = opts;
  const docker = await probe(probes.docker, "unreachable" as const);
  const [pathHack, daemon, infra, linuxDns, store] = await Promise.all([
    probe(probes.pathHack, null),
    probe(probes.daemon, null),
    probe(() => probes.globalInfra({ docker }), null),
    probe(probes.linuxDns, undefined),
    probe(inspectGlobalSecretStore, null),
  ]);
  const proxy =
    infra?.running === true ? await probe(probes.proxyPorts, null) : null;
  const findings: UpgradeFinding[] = [];
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
            fix: null,
          }
        : linuxDnsFinding(linuxDns)
    );
  }
  findings.push(
    store ?? {
      id: "secret-store",
      status: "warn",
      summary: "Not checked: the global secret store check failed.",
      fix: "hack doctor",
    }
  );
  return findings;
}

function pathHackFinding(opts: {
  readonly probe: Awaited<ReturnType<UpgradeCheckProbes["pathHack"]>> | null;
  readonly cliVersion: string;
}): UpgradeFinding {
  const found = opts.probe;
  if (found === null) {
    return {
      id: "installed",
      status: "info",
      summary: `Running ${opts.cliVersion}; the hack on PATH could not be checked.`,
      fix: null,
    };
  }
  if (found.path === null) {
    return {
      id: "installed",
      status: "info",
      summary: `Running ${opts.cliVersion}; no hack is on PATH.`,
      fix: null,
    };
  }
  return {
    id: "installed",
    status: "info",
    summary: `Running ${opts.cliVersion}; the hack on PATH is ${found.version ?? "an unknown version"} (${found.install}) at ${found.path}.`,
    fix: null,
  };
}

function daemonFinding(
  daemon: Awaited<ReturnType<UpgradeCheckProbes["daemon"]>> | null
): UpgradeFinding {
  if (daemon === null) {
    return {
      id: "daemon",
      status: "warn",
      summary: "Not checked: the daemon service could not be read.",
      fix: "hack daemon status",
    };
  }
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
    fix: daemon.nextStep,
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
      fix: null,
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
      fix: "hack global install",
    });
  } else if (opts.infra.running === false) {
    findings.push({
      id: "global-infra",
      status: "warn",
      summary: "Hack's global proxy and DNS are installed but not running.",
      fix: "hack global up",
    });
  } else {
    findings.push({
      id: "global-infra",
      status: opts.infra.running === null ? "info" : "ok",
      summary:
        opts.infra.running === null
          ? "Hack's global proxy is installed; whether it runs was not checked."
          : "Hack's global proxy and DNS are installed and running.",
      fix: null,
    });
  }
  if (opts.proxy !== null) {
    findings.push({
      id: "proxy-ports",
      status: opts.proxy.status === "ok" ? "ok" : "warn",
      summary: opts.proxy.message,
      fix: opts.proxy.status === "ok" ? null : "hack doctor",
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
      fix: "hack doctor",
    };
  }
  return inspection.state === "configured"
    ? {
        id: "linux-dns",
        status: "ok",
        summary: "The Linux DNS route for Hack's names is configured.",
        fix: null,
      }
    : {
        id: "linux-dns",
        status: "warn",
        summary: `Linux DNS route: ${inspection.state}${inspection.code ? ` (${inspection.code})` : ""}.`,
        fix: inspection.fix[0] ?? "hack global install",
      };
}

/**
 * The global encrypted secret store and its key, read only: the key file is
 * tried directly, never the keychain or `HACK_SECRETS_FILE_KEY`, so nothing
 * prompts. Blocks only when a registered project reads a store whose key is
 * gone (the #779 rule).
 */
async function inspectGlobalSecretStore(): Promise<UpgradeFinding> {
  if ((await secretStoreSelectionProblem({})) !== null) {
    return {
      id: "secret-store",
      status: "warn",
      summary:
        "The global config that selects the secret store cannot be read; the store was not checked.",
      fix: "hack doctor",
    };
  }
  const location = await resolveFileSecretStorePaths({});
  if (!location.active) {
    return {
      id: "secret-store",
      status: "ok",
      summary: "Secrets use the OS keychain; no file store to check.",
      fix: null,
    };
  }
  const retired = (await listRetiredEncryptedStores(location.storePath)).length;
  const retiredNote =
    retired > 0
      ? ` ${retired} retired store archive(s) are kept beside it.`
      : "";
  const key = await keyFileOpensStore({
    storePath: location.storePath,
    keyPath: location.keyPath,
  });
  if (key === "opens") {
    return {
      id: "secret-store",
      status: "ok",
      summary: `The global secret store opens with its key file.${retiredNote}`,
      fix: null,
    };
  }
  const users = await listProjectsUsingSecretStore({
    storePath: location.storePath,
  });
  const usedBy =
    users.names.length > 0
      ? ` Read by: ${users.names.join(", ")}.`
      : " No live registered project reads it.";
  if (key === "unknown") {
    return {
      id: "secret-store",
      status: "warn",
      summary: `The global secret store or its key file cannot be read.${usedBy}${retiredNote}`,
      fix: "hack doctor",
    };
  }
  const state =
    key === "absent"
      ? "Its key file is missing (or the store is empty)."
      : "Its key file does not open it.";
  const blocker = users.names.length > 0;
  return {
    id: "secret-store",
    status: blocker ? "blocker" : "warn",
    summary: `Global secret store: ${state}${usedBy}${retiredNote}`,
    fix: blocker
      ? "Restore the key file (or set HACK_SECRETS_FILE_KEY), or retire the store: hack secrets retire-store --allow-unchecked"
      : "hack secrets retire-store --allow-unchecked",
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Machine fixes in the order they should run. */
const MACHINE_ORDER = [
  "registry",
  "secret-store",
  "registry-dead",
  "registry-rejected",
  "registry-unreadable",
  "global-infra",
  "linux-dns",
  "proxy-ports",
  "daemon",
] as const;

/** Project fixes in the order they should run. */
const PROJECT_ORDER = [
  "env-format",
  "env-key",
  "tracked-files",
  "ignore-rules",
  "agent-integrations",
] as const;

function buildPlan(opts: {
  readonly machine: readonly UpgradeFinding[];
  readonly projects: readonly UpgradeProjectReport[];
}): UpgradePlanStep[] {
  type Draft = Omit<UpgradePlanStep, "order">;
  const actionable = (finding: UpgradeFinding) =>
    finding.fix !== null &&
    (finding.status === "warn" || finding.status === "blocker");
  const byOrder = (order: readonly string[]) => (finding: UpgradeFinding) =>
    order.indexOf(finding.id) === -1 ? order.length : order.indexOf(finding.id);
  const machineSteps: Draft[] = [...opts.machine]
    .filter(actionable)
    .sort((a, b) => byOrder(MACHINE_ORDER)(a) - byOrder(MACHINE_ORDER)(b))
    .map((finding) => ({
      id: finding.id,
      scope: "machine",
      command: finding.fix ?? "",
      why: finding.summary,
      blocker: finding.status === "blocker",
    }));
  const projectSteps: Draft[] = opts.projects.flatMap((project) =>
    [...project.findings]
      .filter(actionable)
      .sort((a, b) => byOrder(PROJECT_ORDER)(a) - byOrder(PROJECT_ORDER)(b))
      .map((finding) => ({
        id: finding.id,
        scope: project.name,
        command: finding.fix ?? "",
        why: finding.summary,
        blocker: finding.status === "blocker",
      }))
  );
  const blockers = [...machineSteps, ...projectSteps].filter(
    (step) => step.blocker
  );
  const rest = [...machineSteps, ...projectSteps].filter(
    (step) => !step.blocker
  );
  // A snapshot before the first change, so every later step can be undone.
  const snapshot: Draft[] =
    rest.length > 0
      ? [
          {
            id: "snapshot",
            scope: "machine",
            command: "hack upgrade snapshot",
            why: "Keep a copy of the files the next steps change, so `hack upgrade rollback` can put them back.",
            blocker: false,
          },
        ]
      : [];
  return [...blockers, ...snapshot, ...rest].map((step, index) => ({
    order: index + 1,
    ...step,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function probe<T, F>(run: () => Promise<T>, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), PROBE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([run(), timeout]);
    return result === "timeout" ? fallback : result;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
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
