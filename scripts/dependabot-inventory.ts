#!/usr/bin/env bun
/**
 * Read-only inventory of open Dependabot alerts for a GitHub repository.
 *
 * Lists each open alert's package, ecosystem, severity, manifest path,
 * vulnerable range and first patched version through `gh api` with the
 * caller's existing authentication. It never handles a token, sends only GET
 * requests, writes no files and changes no alert, branch or dependency: use the
 * output to plan dependency bumps in separate, reviewed changes.
 *
 *   bun scripts/dependabot-inventory.ts [--repo owner/name] [--json]
 *
 * Diagnostics are closed and value-free: a refusal never echoes arguments or
 * `gh` output.
 */

/** A closed, value-free diagnostic the inventory may print. */
export class InventoryError extends Error {}

/** Runs `gh` with the given arguments and resolves its stdout; rejects on failure. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

export type AlertSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export type DependabotAlert = {
  readonly number: number;
  readonly ecosystem: string;
  readonly package: string;
  readonly severity: AlertSeverity;
  readonly manifest: string;
  readonly vulnerableRange: string | null;
  /** First patched version, or null when no fix is published. */
  readonly fixedIn: string | null;
  readonly advisory: string | null;
};

export type InventoryOptions = {
  readonly repository: string;
  readonly json: boolean;
};

export const DEFAULT_REPOSITORY = "hack-dance/hack";

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SEVERITY_ORDER: readonly AlertSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
];
/** Printable, bounded text from GitHub; anything else becomes a fixed placeholder. */
const PRINTABLE = /^[\x20-\x7e]{1,200}$/;

export const USAGE =
  "Usage: bun scripts/dependabot-inventory.ts [--repo owner/name] [--json]\n";

export function parseInventoryArguments(
  argv: readonly string[]
): InventoryOptions | "help" {
  let repository = DEFAULT_REPOSITORY;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (value === undefined || !REPOSITORY_PATTERN.test(value)) {
        throw new InventoryError("Invalid --repo value (expected owner/name)");
      }
      repository = value;
      index += 1;
      continue;
    }
    throw new InventoryError("Unknown argument");
  }
  return { repository, json };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function printable(value: unknown): string | null {
  return typeof value === "string" && PRINTABLE.test(value) ? value : null;
}

function severityOf(value: unknown): AlertSeverity {
  return value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low"
    ? value
    : "unknown";
}

/** Narrows one alert from the GitHub REST response; null when it is not an open alert. */
export function normalizeAlert(raw: unknown): DependabotAlert | null {
  const number = field(raw, "number");
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    field(raw, "state") !== "open"
  ) {
    return null;
  }
  return {
    number,
    ecosystem:
      printable(field(raw, "dependency", "package", "ecosystem")) ?? "unknown",
    package:
      printable(field(raw, "dependency", "package", "name")) ?? "<unprintable>",
    severity: severityOf(
      field(raw, "security_vulnerability", "severity") ??
        field(raw, "security_advisory", "severity")
    ),
    manifest:
      printable(field(raw, "dependency", "manifest_path")) ?? "<unprintable>",
    vulnerableRange: printable(
      field(raw, "security_vulnerability", "vulnerable_version_range")
    ),
    fixedIn: printable(
      field(
        raw,
        "security_vulnerability",
        "first_patched_version",
        "identifier"
      )
    ),
    advisory: printable(field(raw, "security_advisory", "ghsa_id")),
  };
}

export function sortAlerts(
  alerts: readonly DependabotAlert[]
): DependabotAlert[] {
  return [...alerts].sort(
    (left, right) =>
      SEVERITY_ORDER.indexOf(left.severity) -
        SEVERITY_ORDER.indexOf(right.severity) ||
      left.package.localeCompare(right.package) ||
      left.manifest.localeCompare(right.manifest) ||
      left.number - right.number
  );
}

/** Lists open alerts with GET-only, paginated `gh api` calls. */
export async function listOpenAlerts(opts: {
  readonly repository: string;
  readonly gh: GhRunner;
}): Promise<DependabotAlert[]> {
  if (!REPOSITORY_PATTERN.test(opts.repository)) {
    throw new InventoryError("Invalid repository");
  }
  let stdout: string;
  try {
    stdout = await opts.gh([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--jq",
      ".[]",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${opts.repository}/dependabot/alerts?state=open&per_page=100`,
    ]);
  } catch {
    throw new InventoryError(
      "gh api request failed (check `gh auth status` and Dependabot alert access)"
    );
  }
  const alerts: DependabotAlert[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new InventoryError("Unexpected GitHub response");
    }
    const alert = normalizeAlert(raw);
    if (alert) {
      alerts.push(alert);
    }
  }
  return sortAlerts(alerts);
}

export function renderInventory(opts: {
  readonly repository: string;
  readonly alerts: readonly DependabotAlert[];
}): string {
  const counts = SEVERITY_ORDER.map(
    (severity) =>
      `${severity}=${opts.alerts.filter((alert) => alert.severity === severity).length}`
  ).join(" ");
  const lines = [
    `Open Dependabot alerts for ${opts.repository}: ${opts.alerts.length} (${counts})`,
  ];
  if (opts.alerts.length === 0) {
    return `${lines.join("\n")}\n`;
  }
  const header = ["#", "severity", "package", "manifest", "fixed-in"];
  const rows = opts.alerts.map((alert) => [
    String(alert.number),
    alert.severity,
    `${alert.package} (${alert.ecosystem})`,
    alert.manifest,
    alert.fixedIn ?? "no fix",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0))
  );
  const format = (row: readonly string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  lines.push("", format(header), ...rows.map(format));
  return `${lines.join("\n")}\n`;
}

/** Default runner: `gh` with the caller's authentication; stderr is discarded. */
export const ghCliRunner: GhRunner = async (args) => {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new InventoryError("gh failed");
  }
  return text;
};

export async function runInventory(opts: {
  readonly argv: readonly string[];
  readonly gh: GhRunner;
  readonly write: (text: string) => void;
}): Promise<number> {
  const options = parseInventoryArguments(opts.argv);
  if (options === "help") {
    opts.write(USAGE);
    return 0;
  }
  const alerts = await listOpenAlerts({
    repository: options.repository,
    gh: opts.gh,
  });
  opts.write(
    options.json
      ? `${JSON.stringify({ repository: options.repository, alerts }, null, 2)}\n`
      : renderInventory({ repository: options.repository, alerts })
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runInventory({
      argv: process.argv.slice(2),
      gh: ghCliRunner,
      write: (text) => process.stdout.write(text),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof InventoryError ? error.message : "Dependabot inventory failed"}\n`
    );
    process.exitCode = 1;
  }
}
