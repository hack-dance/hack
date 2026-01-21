import { homedir } from "node:os";
import { resolve } from "node:path";
import type { CommandHandlerFor } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optProject } from "../cli/options.ts";
import {
  GLOBAL_CLOUDFLARE_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
} from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { readDaemonPid } from "../daemon/process.ts";
import { sanitizeProjectSlug } from "../lib/project.ts";
import type { RuntimeProject } from "../lib/runtime-projects.ts";
import { readRuntimeProjects } from "../lib/runtime-projects.ts";
import { exec } from "../lib/shell.ts";
import { display } from "../ui/display.ts";

const optIncludeGlobal = defineOption({
  name: "includeGlobal",
  type: "boolean",
  long: "--include-global",
  description:
    "Include global infra projects under ~/.hack (e.g. logging stack)",
} as const);

const optWatch = defineOption({
  name: "watch",
  type: "boolean",
  long: "--watch",
  description: "Refresh usage continuously",
} as const);

const optInterval = defineOption({
  name: "interval",
  type: "number",
  long: "--interval",
  description: "Refresh interval (ms) for --watch",
} as const);

const optNoHost = defineOption({
  name: "noHost",
  type: "boolean",
  long: "--no-host",
  description: "Skip host process metrics",
} as const);

const options = [
  optProject,
  optIncludeGlobal,
  optWatch,
  optInterval,
  optNoHost,
  optJson,
] as const;
const positionals = [] as const;

const spec = defineCommand({
  name: "usage",
  summary: "Show resource usage across running projects",
  group: "Global",
  options,
  positionals,
  subcommands: [],
  expandInRootHelp: true,
} as const);

const handleUsage: CommandHandlerFor<typeof spec> = async ({
  args,
}): Promise<number> => {
  if (args.options.watch && args.options.json) {
    throw new CliUsageError("--json is not supported with --watch.");
  }

  const filter =
    typeof args.options.project === "string"
      ? sanitizeProjectSlug(args.options.project)
      : null;
  const controlPlane = await readControlPlaneConfig({});
  const usageConfig = controlPlane.config.usage;
  const watchIntervalMs = resolveIntervalMs({
    cliValue: args.options.interval,
    configValue: usageConfig.watchIntervalMs,
  });
  const includeHost = args.options.noHost !== true;

  if (args.options.watch) {
    await runUsageWatch({
      filter,
      includeGlobal: args.options.includeGlobal === true,
      includeHost,
      intervalMs: watchIntervalMs,
      historySize: usageConfig.historySize,
    });
    return 0;
  }

  const runtimeResult = await readRuntimeProjects({
    includeGlobal: args.options.includeGlobal === true,
  });
  const runtime = runtimeResult.ok ? runtimeResult.runtime : [];
  const filtered = filter
    ? runtime.filter((project) => project.project === filter)
    : runtime;

  const index = buildContainerIndex({ projects: filtered });
  const hostReport = includeHost
    ? await readHostUsage()
    : { rows: [], total: null };
  const stats =
    index.containerIds.length === 0
      ? { ok: true as const, samples: [] }
      : await readDockerStats({ containerIds: index.containerIds });
  if (!runtimeResult.ok) {
    if (args.options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            projects: [],
            total: null,
            host: hostReport.rows,
            host_total: hostReport.total,
            runtime_ok: false,
            runtime_error: runtimeResult.error,
          },
          null,
          2
        )}\n`
      );
      return 1;
    }
    await display.panel({
      title: "Runtime unavailable",
      tone: "error",
      lines: [runtimeResult.error ?? "Docker runtime is not responding."],
    });
    if (hostReport.rows.length > 0) {
      await display.table({
        columns: ["Host", "CPU", "Memory", "PIDs", "Processes"],
        rows: hostReport.rows.map((row) => [
          row.name,
          formatPercent({ percent: row.cpuPercent }),
          formatBytesMaybe({ bytes: row.memBytes }),
          row.pids.length > 0 ? row.pids.join(",") : "n/a",
          String(row.processes),
        ]),
      });
    }
    return 1;
  }

  if (!stats.ok) {
    if (args.options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            projects: [],
            total: null,
            host: hostReport.rows,
            host_total: hostReport.total,
            error: stats.error,
            runtime_ok: runtimeResult.ok,
            runtime_error: runtimeResult.error,
          },
          null,
          2
        )}\n`
      );
      return 1;
    }
    await display.panel({
      title: "Usage",
      tone: "error",
      lines: [stats.error],
    });
    if (hostReport.rows.length > 0) {
      await display.table({
        columns: ["Host", "CPU", "Memory", "PIDs", "Processes"],
        rows: hostReport.rows.map((row) => [
          row.name,
          formatPercent({ percent: row.cpuPercent }),
          formatBytesMaybe({ bytes: row.memBytes }),
          row.pids.length > 0 ? row.pids.join(",") : "n/a",
          String(row.processes),
        ]),
      });
    }
    return 1;
  }

  const report = buildUsageReport({
    projects: filtered,
    samples: stats.samples,
    index,
  });
  if (report.projects.length === 0 && hostReport.rows.length === 0) {
    if (args.options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            projects: [],
            total: null,
            host: [],
            host_total: null,
            warning: "no_usage_samples",
            runtime_ok: runtimeResult.ok,
            runtime_error: runtimeResult.error,
          },
          null,
          2
        )}\n`
      );
      return 0;
    }
    await display.panel({
      title: "Usage",
      tone: "info",
      lines: ["No running containers or host processes found."],
    });
    return 0;
  }

  if (args.options.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          projects: report.projects,
          total: report.total,
          host: hostReport.rows,
          host_total: hostReport.total,
          runtime_ok: runtimeResult.ok,
          runtime_error: runtimeResult.error,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (report.projects.length > 0) {
    await display.table({
      columns: ["Project", "CPU", "Memory", "PIDs", "Containers"],
      rows: report.projects.map((project) => [
        project.project,
        formatPercent({ percent: project.cpuPercent }),
        formatMemoryLabel({
          used: project.memUsedBytes,
          limit: project.memLimitBytes,
          percent: project.memPercent,
        }),
        project.pids !== null ? String(project.pids) : "n/a",
        String(project.containers),
      ]),
    });
  }

  if (hostReport.rows.length > 0) {
    await display.table({
      columns: ["Host", "CPU", "Memory", "PIDs", "Processes"],
      rows: hostReport.rows.map((row) => [
        row.name,
        formatPercent({ percent: row.cpuPercent }),
        formatBytesMaybe({ bytes: row.memBytes }),
        row.pids.length > 0 ? row.pids.join(",") : "n/a",
        String(row.processes),
      ]),
    });
  }

  if (report.total) {
    await display.panel({
      title: "Total",
      tone: "info",
      lines: [
        `CPU: ${formatPercent({ percent: report.total.cpuPercent })}`,
        `Memory: ${formatMemoryLabel({
          used: report.total.memUsedBytes,
          limit: report.total.memLimitBytes,
          percent: report.total.memPercent,
        })}`,
        `PIDs: ${report.total.pids ?? "n/a"}`,
        `Containers: ${report.total.containers}`,
      ],
    });
  }

  if (hostReport.total) {
    await display.panel({
      title: "Host total",
      tone: "info",
      lines: [
        `CPU: ${formatPercent({ percent: hostReport.total.cpuPercent })}`,
        `Memory: ${formatBytesMaybe({ bytes: hostReport.total.memBytes })}`,
        `Processes: ${hostReport.total.processes}`,
      ],
    });
  }

  return 0;
};

export const usageCommand = withHandler(spec, handleUsage);

type HostProcessSample = {
  readonly name: string;
  readonly pid: number;
  readonly cpuPercent: number | null;
  readonly memBytes: number | null;
};

type DockerStatsSample = {
  readonly containerId: string | null;
  readonly cpuPercent: number | null;
  readonly memUsedBytes: number | null;
  readonly memLimitBytes: number | null;
  readonly memPercent: number | null;
  readonly netInputBytes: number | null;
  readonly netOutputBytes: number | null;
  readonly blockInputBytes: number | null;
  readonly blockOutputBytes: number | null;
  readonly pids: number | null;
};

type UsageProjectRow = {
  readonly project: string;
  readonly cpuPercent: number | null;
  readonly memUsedBytes: number | null;
  readonly memLimitBytes: number | null;
  readonly memPercent: number | null;
  readonly netInputBytes: number | null;
  readonly netOutputBytes: number | null;
  readonly blockInputBytes: number | null;
  readonly blockOutputBytes: number | null;
  readonly pids: number | null;
  readonly containers: number;
};

type UsageReport = {
  readonly projects: readonly UsageProjectRow[];
  readonly total: UsageProjectRow | null;
};

type HostUsageRow = {
  readonly name: string;
  readonly cpuPercent: number | null;
  readonly memBytes: number | null;
  readonly processes: number;
  readonly pids: readonly number[];
};

type HostUsageReport = {
  readonly rows: readonly HostUsageRow[];
  readonly total: HostUsageRow | null;
};

type ContainerIndex = {
  readonly containerIds: readonly string[];
  readonly projectByContainer: ReadonlyMap<string, string>;
};

type UsageSnapshot = {
  readonly report: UsageReport;
  readonly host: HostUsageReport;
  readonly errors: readonly string[];
  readonly timestamp: Date;
};

async function runUsageWatch(opts: {
  readonly filter: string | null;
  readonly includeGlobal: boolean;
  readonly includeHost: boolean;
  readonly intervalMs: number;
  readonly historySize: number;
}): Promise<void> {
  let running = true;
  const cpuHistory: Array<number | null> = [];
  const memHistory: Array<number | null> = [];
  const onSigint = () => {
    running = false;
  };
  process.on("SIGINT", onSigint);

  try {
    while (running) {
      const snapshot = await resolveUsageSnapshot({
        filter: opts.filter,
        includeGlobal: opts.includeGlobal,
        includeHost: opts.includeHost,
      });

      const totalCpu = snapshot.report.total?.cpuPercent ?? null;
      const totalMem = snapshot.report.total?.memPercent ?? null;
      pushHistory(cpuHistory, totalCpu, opts.historySize);
      pushHistory(memHistory, totalMem, opts.historySize);

      const output = renderUsageSnapshot({
        snapshot,
        intervalMs: opts.intervalMs,
        cpuHistory,
        memHistory,
      });
      clearScreen();
      process.stdout.write(output);
      if (!output.endsWith("\n")) {
        process.stdout.write("\n");
      }
      if (!running) {
        break;
      }
      await sleep({ ms: opts.intervalMs });
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function resolveUsageSnapshot(opts: {
  readonly filter: string | null;
  readonly includeGlobal: boolean;
  readonly includeHost: boolean;
}): Promise<UsageSnapshot> {
  const runtimeResult = await readRuntimeProjects({
    includeGlobal: opts.includeGlobal,
  });
  const runtime = runtimeResult.ok ? runtimeResult.runtime : [];
  const filtered = opts.filter
    ? runtime.filter((project) => project.project === opts.filter)
    : runtime;
  const index = buildContainerIndex({ projects: filtered });
  const host = opts.includeHost
    ? await readHostUsage()
    : { rows: [], total: null };
  const errors: string[] = [];
  if (!runtimeResult.ok) {
    errors.push(runtimeResult.error ?? "Docker runtime is not responding.");
  }

  let report: UsageReport = { projects: [], total: null };
  if (index.containerIds.length > 0) {
    const stats = await readDockerStats({ containerIds: index.containerIds });
    if (stats.ok) {
      report = buildUsageReport({
        projects: filtered,
        samples: stats.samples,
        index,
      });
    } else {
      errors.push(stats.error);
    }
  }

  return {
    report,
    host,
    errors,
    timestamp: new Date(),
  };
}

function renderUsageSnapshot(opts: {
  readonly snapshot: UsageSnapshot;
  readonly intervalMs: number;
  readonly cpuHistory: readonly (number | null)[];
  readonly memHistory: readonly (number | null)[];
}): string {
  const lines: string[] = [];
  lines.push(
    `hack usage --watch (interval ${opts.intervalMs}ms)  ${opts.snapshot.timestamp.toISOString()}`
  );
  if (opts.snapshot.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    opts.snapshot.errors.forEach((error) => {
      lines.push(`- ${error}`);
    });
  }

  if (opts.snapshot.report.projects.length > 0) {
    lines.push("");
    lines.push("Projects");
    lines.push(
      renderTable({
        columns: ["Project", "CPU", "Memory", "PIDs", "Containers"],
        rows: opts.snapshot.report.projects.map((project) => [
          project.project,
          formatPercent({ percent: project.cpuPercent }),
          formatMemoryLabel({
            used: project.memUsedBytes,
            limit: project.memLimitBytes,
            percent: project.memPercent,
          }),
          project.pids !== null ? String(project.pids) : "n/a",
          String(project.containers),
        ]),
      })
    );
  } else {
    lines.push("");
    lines.push("Projects: none");
  }

  if (opts.snapshot.host.rows.length > 0) {
    lines.push("");
    lines.push("Host processes");
    lines.push(
      renderTable({
        columns: ["Host", "CPU", "Memory", "PIDs", "Processes"],
        rows: opts.snapshot.host.rows.map((row) => [
          row.name,
          formatPercent({ percent: row.cpuPercent }),
          formatBytesMaybe({ bytes: row.memBytes }),
          row.pids.length > 0 ? row.pids.join(",") : "n/a",
          String(row.processes),
        ]),
      })
    );
  } else if (opts.snapshot.report.projects.length === 0) {
    lines.push("");
    lines.push("Host processes: none");
  }

  if (opts.snapshot.report.total || opts.snapshot.host.total) {
    lines.push("");
    lines.push("Totals");
    if (opts.snapshot.report.total) {
      lines.push(
        `Containers: CPU ${formatPercent({ percent: opts.snapshot.report.total.cpuPercent })} | Memory ${formatMemoryLabel(
          {
            used: opts.snapshot.report.total.memUsedBytes,
            limit: opts.snapshot.report.total.memLimitBytes,
            percent: opts.snapshot.report.total.memPercent,
          }
        )} | PIDs ${opts.snapshot.report.total.pids ?? "n/a"}`
      );
    }
    if (opts.snapshot.host.total) {
      lines.push(
        `Host: CPU ${formatPercent({ percent: opts.snapshot.host.total.cpuPercent })} | Memory ${formatBytesMaybe(
          {
            bytes: opts.snapshot.host.total.memBytes,
          }
        )} | Processes ${opts.snapshot.host.total.processes}`
      );
    }
  }

  if (opts.cpuHistory.length > 0 || opts.memHistory.length > 0) {
    lines.push("");
    lines.push("Trends (most recent right)");
    if (opts.cpuHistory.length > 0) {
      lines.push(
        `CPU: ${renderSparkline({ values: opts.cpuHistory })} ${formatPercent({
          percent: opts.cpuHistory.at(-1) ?? null,
        })}`
      );
    }
    if (opts.memHistory.length > 0) {
      lines.push(
        `MEM: ${renderSparkline({ values: opts.memHistory })} ${formatPercent({
          percent: opts.memHistory.at(-1) ?? null,
        })}`
      );
    }
  }

  return lines.join("\n");
}

function renderTable(opts: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): string {
  const widths = opts.columns.map((col, i) => {
    const cellMax = Math.max(
      0,
      ...opts.rows.map((row) => (row[i] ?? "").length)
    );
    return Math.max(col.length, cellMax);
  });
  const pad = (value: string, width: number) =>
    value.length >= width ? value : value + " ".repeat(width - value.length);
  const header = opts.columns
    .map((col, i) => pad(col, widths[i] ?? col.length))
    .join("  ");
  const sep = widths.map((width) => "-".repeat(Math.max(1, width))).join("  ");
  const body = opts.rows.map((row) =>
    row.map((cell, i) => pad(cell, widths[i] ?? 0)).join("  ")
  );
  return [header, sep, ...body].join("\n");
}

function renderSparkline(opts: {
  readonly values: readonly (number | null)[];
}): string {
  const symbols = [" ", ".", "-", "=", "#"];
  return opts.values
    .map((value) => {
      if (value === null || !Number.isFinite(value)) {
        return " ";
      }
      const clamped = Math.max(0, Math.min(100, value));
      const idx = Math.round((clamped / 100) * (symbols.length - 1));
      return symbols[idx] ?? " ";
    })
    .join("");
}

function pushHistory(
  target: Array<number | null>,
  value: number | null,
  maxSize: number
): void {
  target.push(value);
  if (target.length > maxSize) {
    target.splice(0, target.length - maxSize);
  }
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

async function sleep(opts: { readonly ms: number }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, opts.ms));
}

function resolveIntervalMs(opts: {
  readonly cliValue: number | undefined;
  readonly configValue: number;
}): number {
  const raw = opts.cliValue ?? opts.configValue;
  if (!Number.isFinite(raw) || raw <= 0) {
    return 2000;
  }
  return Math.max(250, Math.floor(raw));
}

async function readHostUsage(): Promise<HostUsageReport> {
  const trackedPids = await resolveTrackedPids();
  const samples = await readHostProcessSamples({ trackedPids });
  return buildHostUsageReport({ samples });
}

async function resolveTrackedPids(): Promise<Map<number, string>> {
  const tracked = new Map<number, string>();
  const daemonPaths = resolveDaemonPaths({});
  const daemonPid = await readDaemonPid({ pidPath: daemonPaths.pidPath });
  if (daemonPid) {
    tracked.set(daemonPid, "hackd");
  }
  const cloudflaredPid = await readPidFile({
    path: resolve(
      homedir(),
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_CLOUDFLARE_DIR_NAME,
      "cloudflared.pid"
    ),
  });
  if (cloudflaredPid) {
    tracked.set(cloudflaredPid, "cloudflared");
  }
  return tracked;
}

async function readHostProcessSamples(opts: {
  readonly trackedPids: Map<number, string>;
}): Promise<HostProcessSample[]> {
  const res = await exec(["ps", "-axo", "pid=,pcpu=,rss=,command="], {
    stdin: "ignore",
  });
  if (res.exitCode !== 0) {
    return [];
  }

  const lines = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const samples: HostProcessSample[] = [];

  for (const line of lines) {
    const match = line.match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(pid)) {
      continue;
    }
    const cpuPercent = Number.parseFloat(match[2] ?? "");
    const rssKb = Number.parseInt(match[3] ?? "", 10);
    const command = match[4] ?? "";

    const trackedName =
      opts.trackedPids.get(pid) ?? resolveHostProcessKind({ command });
    if (!trackedName) {
      continue;
    }

    samples.push({
      name: trackedName,
      pid,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
      memBytes: Number.isFinite(rssKb) ? rssKb * 1024 : null,
    });
  }

  return samples;
}

function resolveHostProcessKind(opts: {
  readonly command: string;
}): string | null {
  const normalized = opts.command.replaceAll(/\s+/g, " ").toLowerCase();
  if (normalized.includes("cloudflared")) {
    return "cloudflared";
  }
  if (normalized.includes("tailscaled")) {
    return "tailscaled";
  }
  if (normalized.includes(" hack tui")) {
    return "hack tui";
  }
  if (normalized.includes(" hack remote")) {
    return "hack tui";
  }
  if (normalized.includes(" hack logs")) {
    return "log-stream";
  }
  if (normalized.includes(" log-pipe")) {
    return "log-stream";
  }
  return null;
}

function buildHostUsageReport(opts: {
  readonly samples: readonly HostProcessSample[];
}): HostUsageReport {
  if (opts.samples.length === 0) {
    return { rows: [], total: null };
  }

  const grouped = new Map<
    string,
    { cpu: number[]; mem: number[]; pids: number[] }
  >();
  for (const sample of opts.samples) {
    const existing = grouped.get(sample.name) ?? { cpu: [], mem: [], pids: [] };
    if (sample.cpuPercent !== null) {
      existing.cpu.push(sample.cpuPercent);
    }
    if (sample.memBytes !== null) {
      existing.mem.push(sample.memBytes);
    }
    existing.pids.push(sample.pid);
    grouped.set(sample.name, existing);
  }

  const rows: HostUsageRow[] = [];
  for (const [name, bucket] of grouped.entries()) {
    const cpuPercent = sumNullable(bucket.cpu);
    const memBytes = sumNullable(bucket.mem);
    rows.push({
      name,
      cpuPercent,
      memBytes,
      processes: bucket.pids.length,
      pids: bucket.pids,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const totalCpu = sumNullable(rows.map((row) => row.cpuPercent));
  const totalMem = sumNullable(rows.map((row) => row.memBytes));
  const totalProcesses = rows.reduce((sum, row) => sum + row.processes, 0);
  const totalPids = rows.flatMap((row) => row.pids);

  return {
    rows,
    total: {
      name: "host",
      cpuPercent: totalCpu,
      memBytes: totalMem,
      processes: totalProcesses,
      pids: totalPids,
    },
  };
}

async function readPidFile(opts: {
  readonly path: string;
}): Promise<number | null> {
  const file = Bun.file(opts.path);
  if (!(await file.exists())) {
    return null;
  }
  const text = await file.text();
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function sumNullable(values: readonly (number | null)[]): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    total += value;
    count += 1;
  }
  return count === 0 ? null : total;
}

function buildContainerIndex(opts: {
  projects: readonly RuntimeProject[];
}): ContainerIndex {
  const projectByContainer = new Map<string, string>();
  const containerIds: string[] = [];
  for (const project of opts.projects) {
    for (const service of project.services.values()) {
      for (const container of service.containers) {
        if (!container.id) {
          continue;
        }
        containerIds.push(container.id);
        projectByContainer.set(container.id, project.project);
        if (container.id.length >= 12) {
          projectByContainer.set(container.id.slice(0, 12), project.project);
        }
      }
    }
  }
  return {
    containerIds: [...new Set(containerIds)],
    projectByContainer,
  };
}

async function readDockerStats(opts: {
  containerIds: readonly string[];
}): Promise<
  { ok: true; samples: DockerStatsSample[] } | { ok: false; error: string }
> {
  const res = await exec(
    [
      "docker",
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      ...opts.containerIds,
    ],
    { stdin: "ignore" }
  );
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || "docker stats failed" };
  }

  const samples = parseDockerStatsOutput({ output: res.stdout });
  if (samples.length === 0) {
    return { ok: false, error: "docker stats returned no samples" };
  }
  return { ok: true, samples };
}

function parseDockerStatsOutput(opts: {
  readonly output: string;
}): DockerStatsSample[] {
  const lines = opts.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const samples: DockerStatsSample[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const containerId =
      getString(parsed, "ID") ?? getString(parsed, "Container");
    const cpuPercent = parsePercent({
      value: typeof parsed.CPUPerc === "string" ? parsed.CPUPerc : null,
    });
    const memUsageRaw =
      typeof parsed.MemUsage === "string" ? parsed.MemUsage : null;
    const memPercent = parsePercent({
      value: typeof parsed.MemPerc === "string" ? parsed.MemPerc : null,
    });
    const netIo = parseIoPair({
      value: typeof parsed.NetIO === "string" ? parsed.NetIO : null,
    });
    const blockIo = parseIoPair({
      value: typeof parsed.BlockIO === "string" ? parsed.BlockIO : null,
    });
    const pidsValue = typeof parsed.PIDs === "string" ? parsed.PIDs : null;

    let memUsedBytes: number | null = null;
    let memLimitBytes: number | null = null;
    if (memUsageRaw) {
      const [usedRaw = "", limitRaw = ""] = memUsageRaw
        .split("/")
        .map((part) => part.trim());
      memUsedBytes = parseBytes({ value: usedRaw.length > 0 ? usedRaw : null });
      memLimitBytes = parseBytes({
        value: limitRaw.length > 0 ? limitRaw : null,
      });
    }

    const parsedPids = pidsValue ? Number.parseInt(pidsValue, 10) : Number.NaN;
    const pids = Number.isFinite(parsedPids) ? parsedPids : null;

    samples.push({
      containerId,
      cpuPercent,
      memUsedBytes,
      memLimitBytes,
      memPercent,
      netInputBytes: netIo.inputBytes,
      netOutputBytes: netIo.outputBytes,
      blockInputBytes: blockIo.inputBytes,
      blockOutputBytes: blockIo.outputBytes,
      pids,
    });
  }

  return samples;
}

function buildUsageReport(opts: {
  readonly projects: readonly RuntimeProject[];
  readonly samples: readonly DockerStatsSample[];
  readonly index: ContainerIndex;
}): UsageReport {
  const projectSamples = new Map<string, DockerStatsSample[]>();
  for (const sample of opts.samples) {
    if (!sample.containerId) {
      continue;
    }
    const project = opts.index.projectByContainer.get(sample.containerId);
    if (!project) {
      continue;
    }
    const existing = projectSamples.get(project) ?? [];
    projectSamples.set(project, [...existing, sample]);
  }

  const projects: UsageProjectRow[] = [];
  for (const project of opts.projects) {
    const samples = projectSamples.get(project.project) ?? [];
    if (samples.length === 0) {
      continue;
    }
    const aggregate = aggregateDockerStats({ samples });
    if (!aggregate) {
      continue;
    }
    projects.push({
      project: project.project,
      containers: samples.length,
      ...aggregate,
    });
  }

  const totalAggregate = aggregateDockerStats({ samples: opts.samples });
  const total = totalAggregate
    ? {
        project: "total",
        containers: opts.samples.length,
        ...totalAggregate,
      }
    : null;

  return {
    projects,
    total,
  };
}

function aggregateDockerStats(opts: {
  readonly samples: readonly DockerStatsSample[];
}): Omit<UsageProjectRow, "project" | "containers"> | null {
  if (opts.samples.length === 0) {
    return null;
  }

  const cpuPercent = sumNullable(
    opts.samples.map((sample) => sample.cpuPercent)
  );
  const memUsedBytes = sumNullable(
    opts.samples.map((sample) => sample.memUsedBytes)
  );
  const memLimitBytes = sumNullable(
    opts.samples.map((sample) => sample.memLimitBytes)
  );
  const netInputBytes = sumNullable(
    opts.samples.map((sample) => sample.netInputBytes)
  );
  const netOutputBytes = sumNullable(
    opts.samples.map((sample) => sample.netOutputBytes)
  );
  const blockInputBytes = sumNullable(
    opts.samples.map((sample) => sample.blockInputBytes)
  );
  const blockOutputBytes = sumNullable(
    opts.samples.map((sample) => sample.blockOutputBytes)
  );
  const pids = sumNullable(opts.samples.map((sample) => sample.pids));
  const memPercent =
    memUsedBytes !== null && memLimitBytes !== null && memLimitBytes > 0
      ? (memUsedBytes / memLimitBytes) * 100
      : null;

  return {
    cpuPercent,
    memUsedBytes,
    memLimitBytes,
    memPercent,
    netInputBytes,
    netOutputBytes,
    blockInputBytes,
    blockOutputBytes,
    pids,
  };
}

function parsePercent(opts: { readonly value: string | null }): number | null {
  if (!opts.value) {
    return null;
  }
  const match = opts.value.trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIoPair(opts: { readonly value: string | null }): {
  readonly inputBytes: number | null;
  readonly outputBytes: number | null;
} {
  if (!opts.value) {
    return { inputBytes: null, outputBytes: null };
  }
  const [inputRaw = "", outputRaw = ""] = opts.value
    .split("/")
    .map((part) => part.trim());
  return {
    inputBytes: parseBytes({ value: inputRaw.length > 0 ? inputRaw : null }),
    outputBytes: parseBytes({ value: outputRaw.length > 0 ? outputRaw : null }),
  };
}

function parseBytes(opts: { readonly value: string | null }): number | null {
  if (!opts.value) {
    return null;
  }
  const trimmed = opts.value.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value)) {
    return null;
  }
  const unitRaw = (match[2] ?? "B").trim();
  const unit = unitRaw.toLowerCase();
  const multiplier =
    unit === "b"
      ? 1
      : unit === "kb"
        ? 1000
        : unit === "kib"
          ? 1024
          : unit === "mb"
            ? 1_000_000
            : unit === "mib"
              ? 1_048_576
              : unit === "gb"
                ? 1_000_000_000
                : unit === "gib"
                  ? 1_073_741_824
                  : unit === "tb"
                    ? 1_000_000_000_000
                    : unit === "tib"
                      ? 1_099_511_627_776
                      : null;
  if (!multiplier) {
    return null;
  }
  return value * multiplier;
}

function formatBytes(opts: { readonly bytes: number }): string {
  if (!Number.isFinite(opts.bytes)) {
    return "n/a";
  }
  const sign = opts.bytes < 0 ? "-" : "";
  let value = Math.abs(opts.bytes);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 10 || idx === 0 ? 0 : 1;
  return `${sign}${value.toFixed(digits)} ${units[idx] ?? "B"}`;
}

function formatBytesMaybe(opts: { readonly bytes: number | null }): string {
  if (opts.bytes === null || !Number.isFinite(opts.bytes)) {
    return "n/a";
  }
  return formatBytes({ bytes: opts.bytes });
}

function formatPercent(opts: { readonly percent: number | null }): string {
  if (opts.percent === null || !Number.isFinite(opts.percent)) {
    return "n/a";
  }
  return `${opts.percent.toFixed(1)}%`;
}

function formatMemoryLabel(opts: {
  readonly used: number | null;
  readonly limit: number | null;
  readonly percent: number | null;
}): string {
  if (opts.used === null || opts.limit === null) {
    return "n/a";
  }
  return `${formatBytes({ bytes: opts.used })} / ${formatBytes({ bytes: opts.limit })} (${formatPercent({ percent: opts.percent })})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" ? raw.trim() : null;
}
