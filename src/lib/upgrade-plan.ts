import type {
  UpgradeProjectReport,
  UpgradeReportFinding,
} from "./upgrade-check.ts";
import type { UpgradeFindingStatus } from "./upgrade-check-project.ts";
import { UPGRADE_REVIEW_REASONS } from "./upgrade-review-reasons.ts";

/**
 * The upgrade plan (HACK-2188, HACK-2220): one step per kind of change, not
 * one per checkout. A machine finding is its own step. Checkout findings of
 * the same id are one step that lists every checkout it covers
 * (`targets`, each with its own command), so a machine with 170 checkouts
 * gets a plan of about ten steps.
 *
 * The fixes `hack upgrade apply` runs for every checkout of a step
 * ({@link UPGRADE_APPLY_FIXES}) are the ones whose writes a snapshot or a
 * backup manifest can undo: refreshing `.hack/.gitignore` (a file in the
 * upgrade snapshot) and removing stale standalone agent files (each
 * removal backed up by the plugin migration's own manifest). Every other
 * step keeps its per-checkout command or manual action.
 */

/** Checkout fixes `hack upgrade apply` runs, in the order it runs them. */
export const UPGRADE_APPLY_FIXES = [
  "ignore-rules",
  "agent-integrations",
  "env-key-permissions",
] as const;

export type UpgradeApplyFix = (typeof UPGRADE_APPLY_FIXES)[number];

export function isUpgradeApplyFix(id: string): id is UpgradeApplyFix {
  return (UPGRADE_APPLY_FIXES as readonly string[]).includes(id);
}

/** One checkout a plan step covers. */
export type UpgradePlanTarget = {
  /** The checkout's name (`project (worktree dir)` for a worktree). */
  readonly scope: string;
  /** The registered project it belongs to. */
  readonly project: string;
  readonly root: string;
  /** This checkout's finding severity, before group escalation. */
  readonly status: UpgradeFindingStatus;
  /** False when any required checkout check is blocked or incomplete. */
  readonly apply_eligible: boolean;
  /** This checkout's own command line; null when only `action` applies. */
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly action: string | null;
};

export type UpgradePlanStep = {
  readonly order: number;
  /** The finding id this step resolves, or `snapshot`. */
  readonly id: string;
  /**
   * `machine`, the checkout's name when the step covers one checkout, or
   * `projects` when it covers several (listed in `targets`).
   */
  readonly scope: string;
  readonly status: UpgradeFindingStatus | "step";
  /** How many checkouts the step covers (0 for a machine step). */
  readonly count: number;
  /** The checkouts it covers; empty for a machine step. */
  readonly targets: readonly UpgradePlanTarget[];
  /** One executable command line for the whole step; null for a manual step. */
  readonly command: string | null;
  /** Its Hack CLI arguments (after `cli.command`); null for a manual step. */
  readonly args: readonly string[] | null;
  /** A manual action: what to do when there is no command, or instead of it. */
  readonly action: string | null;
  readonly why: string;
  readonly blocker: boolean;
  /** `hack upgrade apply` runs this step for every checkout it covers. */
  readonly applies: boolean;
};

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
  "project-store",
  "env-secrets",
  "env-format",
  "env-key",
  "env-key-permissions",
  "tracked-files",
  "ignore-rules",
  "agent-integrations",
] as const;

/** What a step covering several checkouts is about (no counts, no values). */
const GROUP_WHY: Readonly<Record<string, string>> = {
  "env-key-permissions":
    "Make verified owner-held, untracked env keys private (0600); keep their exact bytes and snapshot the original mode.",
  "project-config": "These live checkouts cannot be read.",
  "project-store": "The project's own secret store or its key needs attention.",
  "env-secrets": "Env layer secrets must open under the project env key.",
  "env-format": "Env uses the legacy format; migrate it to YAML layers.",
  "env-key": "The env key is missing, not private, or tracked.",
  "tracked-files":
    "Machine-local or sensitive files are tracked or not ignored.",
  "ignore-rules": "The committed .hack/.gitignore is missing or out of date.",
  "agent-integrations":
    "Standalone Hack agent files are stale; the hack plugin replaces them.",
};

const ACTIONABLE: ReadonlySet<UpgradeFindingStatus> = new Set([
  "blocker",
  "incomplete",
  "warn",
]);

const PATH_PLACEHOLDER = "<checkout>";

/**
 * Builds the grouped plan. `render` turns Hack CLI arguments into a command
 * line for the CLI that produced the report.
 */
export function buildUpgradePlan(opts: {
  readonly machine: readonly UpgradeReportFinding[];
  readonly projects: readonly UpgradeProjectReport[];
  readonly render: (args: readonly string[]) => string;
}): UpgradePlanStep[] {
  type Draft = Omit<UpgradePlanStep, "order">;
  const actionable = (finding: UpgradeReportFinding) =>
    ACTIONABLE.has(finding.status) &&
    (finding.args !== null || finding.action !== null);
  const rank = (order: readonly string[], id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  const machineSteps: Draft[] = [...opts.machine]
    .filter(actionable)
    .sort((a, b) => rank(MACHINE_ORDER, a.id) - rank(MACHINE_ORDER, b.id))
    .map((finding) => ({
      id: finding.id,
      scope: "machine",
      status: finding.status,
      count: 0,
      targets: [],
      command: finding.command,
      args: finding.args,
      action: finding.action,
      why: finding.summary,
      blocker: finding.status === "blocker",
      applies: false,
    }));
  const groups = new Map<
    string,
    {
      id: string;
      status: UpgradeFindingStatus;
      findings: { target: UpgradePlanTarget; summary: string }[];
    }
  >();
  for (const project of opts.projects) {
    for (const finding of project.findings) {
      if (!actionable(finding)) {
        continue;
      }
      const key = finding.apply_fix ?? finding.id;
      const group = groups.get(key) ?? {
        id: key,
        status: finding.status,
        findings: [],
      };
      const severity = { blocker: 0, incomplete: 1, warn: 2, info: 3, ok: 4 };
      if (severity[finding.status] < severity[group.status]) {
        group.status = finding.status;
      }
      group.findings.push({
        target: {
          scope: project.name,
          project: project.project,
          root: project.root,
          status: finding.status,
          apply_eligible: !project.findings.some(
            (f) => f.status === "blocker" || f.status === "incomplete"
          ),
          command: finding.command,
          args: finding.args,
          action: finding.action,
        },
        summary: finding.summary,
      });
      groups.set(key, group);
    }
  }
  const projectSteps: Draft[] = [...groups.values()]
    .sort((a, b) => rank(PROJECT_ORDER, a.id) - rank(PROJECT_ORDER, b.id))
    .map((group) => groupStep({ group, render: opts.render }));
  const severity = (step: Draft) => {
    if (step.status === "blocker") {
      return 0;
    }
    return step.status === "incomplete" ? 1 : 2;
  };
  const ordered = [...machineSteps, ...projectSteps]
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
            count: 0,
            targets: [],
            command: opts.render(["upgrade", "snapshot"]),
            args: ["upgrade", "snapshot"],
            action: null,
            why: "Keep a private copy of the files the following steps change, so the upgrade rollback command can put them back.",
            blocker: false,
            applies: false,
          },
        ]
      : [];
  return [...snapshot, ...ordered].map((step, index) => ({
    order: index + 1,
    ...step,
  }));
}

function groupStep(opts: {
  readonly group: {
    readonly id: string;
    readonly status: UpgradeFindingStatus;
    readonly findings: readonly {
      readonly target: UpgradePlanTarget;
      readonly summary: string;
    }[];
  };
  readonly render: (args: readonly string[]) => string;
}): Omit<UpgradePlanStep, "order"> {
  const { id, status, findings } = opts.group;
  const targets = findings.map((finding) => finding.target);
  const base = {
    id,
    status,
    count: targets.length,
    targets,
    blocker: status === "blocker",
  };
  if (isUpgradeApplyFix(id)) {
    const args = ["upgrade", "apply", "--only", id];
    return {
      ...base,
      scope:
        targets.length === 1 ? (targets[0]?.scope ?? "projects") : "projects",
      command: opts.render(args),
      args,
      action: null,
      why: GROUP_WHY[id] ?? findings[0]?.summary ?? id,
      applies: true,
    };
  }
  if (id in UPGRADE_REVIEW_REASONS) {
    const args = ["upgrade", "review", "--only", id];
    return {
      ...base,
      scope:
        targets.length === 1 ? (targets[0]?.scope ?? "projects") : "projects",
      command: opts.render(args),
      args,
      action: UPGRADE_REVIEW_REASONS[id] ?? null,
      why: GROUP_WHY[id] ?? id,
      applies: false,
    };
  }
  const only = findings.length === 1 ? findings[0] : undefined;
  if (only !== undefined) {
    return {
      ...base,
      scope: only.target.scope,
      command: only.target.command,
      args: only.target.args,
      action: only.target.action,
      why: only.summary,
      applies: false,
    };
  }
  return {
    ...base,
    scope: "projects",
    command: null,
    args: null,
    action: groupAction({ targets, render: opts.render }),
    why: GROUP_WHY[id] ?? findings[0]?.summary ?? id,
    applies: false,
  };
}

/**
 * A manual action for a step over several checkouts: the shared command
 * with the checkout as a placeholder when every target runs the same
 * command for its own path, else a pointer to the per-checkout findings.
 */
function groupAction(opts: {
  readonly targets: readonly UpgradePlanTarget[];
  readonly render: (args: readonly string[]) => string;
}): string {
  const count = opts.targets.length;
  const shapes = new Set(
    opts.targets.map((target) =>
      target.args === null
        ? null
        : JSON.stringify(withoutPath(target.args, target.root))
    )
  );
  const first = opts.targets[0];
  const shared =
    shapes.size === 1 && first?.args
      ? withoutPath(first.args, first.root)
      : null;
  const advice = opts.targets.some((target) => target.action !== null)
    ? " Each checkout's finding says what else to do."
    : "";
  if (shared !== null && first?.args?.includes(first.root)) {
    return `Run ${opts.render(shared)} --path ${PATH_PLACEHOLDER} for each of the ${count} checkouts (hack upgrade check --verbose lists them).${advice}`;
  }
  return `See the finding in each of the ${count} checkouts (hack upgrade check --verbose lists them).`;
}

/** `args` without its `--path <root>` pair. */
function withoutPath(args: readonly string[], root: string): readonly string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--path" && args[index + 1] === root) {
      index += 1;
      continue;
    }
    out.push(args[index] as string);
  }
  return out;
}
