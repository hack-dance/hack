import { escapeTerminalControls } from "./terminal-text.ts";
import type {
  UpgradeCheckReport,
  UpgradeFinding,
  UpgradePlanStep,
  UpgradeProjectReport,
} from "./upgrade-check.ts";

/**
 * Text output of `hack upgrade check` (HACK-2220): one screen whatever the
 * number of checkouts. The summary comes first (build, machine, counts,
 * what blocks, what could not be checked), then the projects that have a
 * finding (worktrees folded under their project), then the plan grouped
 * by kind of change, then the single next command. `verbose` adds every
 * checkout's findings and the dead registry entries. Every line is escaped;
 * no value is ever printed. `--json` keeps the full detail.
 */

const MARK: Readonly<Record<UpgradeFinding["status"], string>> = {
  ok: "ok   ",
  info: "info ",
  warn: "warn ",
  incomplete: "UNCHK",
  blocker: "BLOCK",
};

/** Projects listed in the summary before the rest are counted. */
const MAX_PROJECT_LINES = 12;
/** Blockers or unchecked items named before the rest are counted. */
const MAX_NAMED = 5;

const NEEDS_WORK: ReadonlySet<UpgradeFinding["status"]> = new Set([
  "blocker",
  "incomplete",
  "warn",
]);

/** Short names for finding ids in the folded project lines and the plan. */
const LABEL: Readonly<Record<string, string>> = {
  "project-config": "unreadable config",
  "project-store": "project secret store",
  "env-secrets": "env secrets",
  "env-format": "legacy env format",
  "env-key": "env key",
  "tracked-files": "tracked machine-local files",
  "ignore-rules": "outdated .hack/.gitignore",
  "agent-integrations": "stale agent files",
};

export function renderUpgradeCheck(
  report: UpgradeCheckReport,
  opts: { readonly verbose?: boolean } = {}
): string {
  const lines = [
    buildLine(report),
    "",
    ...machineLines(report),
    ...findingCounts(report),
    "",
    ...projectSummaryLines(report),
    ...(opts.verbose === true ? verboseLines(report) : []),
    "",
    ...planLines(report),
  ];
  return `${lines.map((text) => escapeTerminalControls(text)).join("\n")}\n`;
}

/** Count finding kinds across all live checkouts, including folded-away projects. */
function findingCounts(report: UpgradeCheckReport): string[] {
  const counts = new Map<string, number>();
  for (const checkout of report.projects) {
    for (const finding of checkout.findings) {
      if (NEEDS_WORK.has(finding.status)) {
        counts.set(finding.id, (counts.get(finding.id) ?? 0) + 1);
      }
    }
  }
  return [...counts].map(
    ([id, count]) => `  ${count} checkout(s): ${LABEL[id] ?? id}`
  );
}

/** First line: version, channel, and whether a source build or a candidate launcher ran. */
function buildLine(report: UpgradeCheckReport): string {
  const how: string[] = [`${report.cli.channel} channel`];
  if (report.cli.build === "source") {
    how.push("SOURCE BUILD, not an installed release");
  }
  if (report.cli.candidate_run) {
    how.push(`candidate launcher: ${report.cli.command}`);
  }
  return `hack ${report.cli.version} (${how.join("; ")})`;
}

function machineLines(report: UpgradeCheckReport): string[] {
  const lines = ["Machine"];
  for (const finding of report.machine) {
    if (finding.id === "registry" && finding.status === "ok") {
      continue; // The project counts below say it.
    }
    if (finding.id === "registry-dead") {
      lines.push(
        `  ${MARK.warn} ${report.registry.missing.length} dead registry entr${report.registry.missing.length === 1 ? "y" : "ies"} (checkout or config gone): ${finding.command ?? ""}`
      );
      continue;
    }
    lines.push(`  ${MARK[finding.status]} ${finding.summary}`);
  }
  return lines;
}

type ProjectGroup = {
  readonly project: string;
  readonly checkouts: readonly UpgradeProjectReport[];
};

function groupProjects(
  projects: readonly UpgradeProjectReport[]
): ProjectGroup[] {
  const groups = new Map<string, UpgradeProjectReport[]>();
  for (const checkout of projects) {
    const list = groups.get(checkout.project) ?? [];
    list.push(checkout);
    groups.set(checkout.project, list);
  }
  return [...groups.entries()].map(([project, checkouts]) => ({
    project,
    checkouts,
  }));
}

function projectSummaryLines(report: UpgradeCheckReport): string[] {
  const r = report.registry;
  const lines = [
    `Projects: ${r.projects} registered, ${r.total} checkout(s) with worktrees: ${r.live} live, ${r.missing.length} dead, ${r.unreadable.length} unreadable${r.unchecked.length > 0 ? `, ${r.unchecked.length} not checked` : ""}.`,
  ];
  const groups = groupProjects(report.projects);
  const worst = (group: ProjectGroup) => {
    const statuses = group.checkouts.flatMap((c) =>
      c.findings.map((f) => f.status)
    );
    if (statuses.includes("blocker")) {
      return 0;
    }
    return statuses.includes("incomplete") ? 1 : 2;
  };
  const withFindings = groups
    .filter((group) =>
      group.checkouts.some((c) =>
        c.findings.some((f) => NEEDS_WORK.has(f.status))
      )
    )
    .sort((a, b) => worst(a) - worst(b) || a.project.localeCompare(b.project));
  if (withFindings.length === 0) {
    return lines;
  }
  lines.push(
    `With findings: ${withFindings.length} of ${groups.length} project(s) (hack upgrade check --verbose shows every checkout):`
  );
  for (const group of withFindings.slice(0, MAX_PROJECT_LINES)) {
    lines.push(projectLine(group));
  }
  const rest = withFindings.length - MAX_PROJECT_LINES;
  if (rest > 0) {
    lines.push(`  … and ${rest} more project(s); the plan below covers them.`);
  }
  return lines;
}

/** One line per project: its worst status and its finding kinds, with checkout counts. */
function projectLine(group: ProjectGroup): string {
  const counts = new Map<string, number>();
  let mark = MARK.warn;
  for (const checkout of group.checkouts) {
    for (const finding of checkout.findings) {
      if (!NEEDS_WORK.has(finding.status)) {
        continue;
      }
      if (finding.status === "blocker") {
        mark = MARK.blocker;
      } else if (finding.status === "incomplete" && mark !== MARK.blocker) {
        mark = MARK.incomplete;
      }
      const label = LABEL[finding.id] ?? finding.id;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const worktrees = group.checkouts.length - 1;
  const name =
    worktrees > 0
      ? `${group.project} (+${worktrees} worktree${worktrees === 1 ? "" : "s"})`
      : group.project;
  const kinds = [...counts.entries()]
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
    .join(", ");
  return `  ${mark} ${name}: ${kinds}`;
}

function verboseLines(report: UpgradeCheckReport): string[] {
  const lines: string[] = [];
  if (report.registry.missing.length > 0) {
    lines.push(
      "",
      `Dead entries: ${report.registry.missing.map((entry) => entry.name).join(", ")}`
    );
  }
  for (const project of report.projects) {
    lines.push("", `Checkout ${project.name} (${project.root})`);
    for (const finding of project.findings) {
      lines.push(`  ${MARK[finding.status]} ${finding.summary}`);
      if (NEEDS_WORK.has(finding.status) && finding.command !== null) {
        lines.push(`        ${finding.command}`);
      }
      if (NEEDS_WORK.has(finding.status) && finding.action !== null) {
        lines.push(`        manual: ${finding.action}`);
      }
    }
  }
  return lines;
}

function planLines(report: UpgradeCheckReport): string[] {
  const lines =
    report.plan.length === 0
      ? [
          report.ready
            ? "Nothing to do: this machine and its projects are ready."
            : "No step to suggest, but the check is not complete; see below.",
        ]
      : ["Plan", ...report.plan.flatMap(stepLines)];
  if (report.plan.some((step) => step.applies)) {
    lines.push(
      "  Steps marked (apply) run for all their checkouts with hack upgrade apply (--dry-run to preview, --project <name> for one project)."
    );
  }
  lines.push("");
  lines.push(...namedLines("Blocked by", report.blockers));
  lines.push(...namedLines("Not checked", report.incomplete, true));
  if (report.next_command !== null) {
    lines.push(`Next: ${report.next_command}`);
  } else if (report.next_action !== null) {
    lines.push(`Next (manual): ${report.next_action}`);
  }
  return lines;
}

function stepLines(step: UpgradePlanStep): string[] {
  const tag =
    {
      blocker: "[blocker] ",
      incomplete: "[not checked] ",
    }[step.status as string] ?? "";
  const label = LABEL[step.id];
  const what =
    step.count > 1
      ? `${label ?? step.id}, ${step.count} checkouts${step.applies ? " (apply)" : ""}: `
      : "";
  let scope = "";
  if (step.count === 1) {
    scope = `   (${step.scope}${step.applies ? ", apply" : ""})`;
  } else if (step.count === 0 && step.scope !== "machine") {
    scope = `   (${step.scope})`;
  }
  const head =
    step.command === null
      ? `  ${step.order}. ${tag}${what}manual: ${step.action ?? step.why}${scope}`
      : `  ${step.order}. ${tag}${what}${step.command}${scope}`;
  const skipped = step.applies
    ? step.targets.filter((target) => !target.apply_eligible).length
    : 0;
  const line =
    skipped === 0
      ? head
      : `${head} (${skipped} blocked/unchecked; apply skips them)`;
  return step.count <= 1 && step.command !== null && step.action !== null
    ? [line, `       ${step.action}`]
    : [line];
}

/** Blockers or unchecked items: a few named (with why for unchecked), the rest counted. */
function namedLines(
  title: string,
  items: UpgradeCheckReport["blockers"],
  why = false
): string[] {
  if (items.length === 0) {
    return [];
  }
  const shown = items.slice(0, MAX_NAMED);
  const lines = why
    ? [
        `${title} (${items.length}):`,
        ...shown.map((item) => `  ${item.scope} ${item.id}: ${item.summary}`),
      ]
    : [
        `${title}: ${shown.map((item) => `${item.scope} ${item.id}`).join(", ")}${items.length > MAX_NAMED ? ` and ${items.length - MAX_NAMED} more` : ""}`,
      ];
  if (why && items.length > MAX_NAMED) {
    lines.push(
      `  … and ${items.length - MAX_NAMED} more (hack upgrade check --verbose).`
    );
  }
  lines.push("");
  return lines;
}
