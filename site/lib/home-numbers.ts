/**
 * Every performance and resource figure the homepage shows, in one place.
 *
 * Each figure records whether it has been measured. The page reads its numbers
 * from here, so replacing a figure with a measurement is one edit: change the
 * value and set `measured` to `true`. The flag renders nothing; it is the
 * record of which figures still need a measurement behind them.
 *
 * Figures about other products are published only with a measurement. Until
 * `COMPARISONS_MEASURED` is `true` the page leaves every comparison out.
 */

export interface Figure {
  /** What the figure counts or times. */
  readonly label: string;
  /** `true` once a published measurement backs the value. */
  readonly measured: boolean;
  /** The text the page shows. */
  readonly value: string;
}

/** Whether the figures that compare Hack with other products are measured. */
export const COMPARISONS_MEASURED = false;

function unmeasured(value: string, label: string): Figure {
  return { label, measured: false, value };
}

/** The five-number strip under the first figure. */
export const headline: readonly Figure[] = [
  unmeasured("300ms", "engine ready"),
  unmeasured("2s", "warm start, whole project"),
  unmeasured("500ms", "to sleep or wake a project"),
  unmeasured("50ms", "before your command runs"),
  unmeasured("0", "Docker apps required"),
];

/** Timings that the sample terminal output on the page repeats. */
export const sample = {
  warmStart: unmeasured("2.1s", "warm start of a four-service project"),
  warmStartMs: unmeasured("2104", "the same warm start, in milliseconds"),
  secondCopy: unmeasured("1.1s", "start of a second copy, engine already up"),
  engineReady: unmeasured("0.3s", "engine ready"),
  engineAlreadyUp: unmeasured("0.0s", "engine check when it is already up"),
  db: unmeasured("0.5s", "database service start"),
  api: unmeasured("0.7s", "api service start"),
  jobs: unmeasured("0.6s", "worker service start"),
  web: unmeasured("0.6s", "frontend service start"),
  nothingChanged: unmeasured("0.2s", "start when nothing changed"),
  wake: unmeasured("0.4s", "wake a sleeping copy"),
  idleWake: unmeasured("500 ms", "wake an idle project"),
  sleep: unmeasured("0.3s", "put a copy to sleep"),
  useRemote: unmeasured("0.9s", "switch a dependency to its remote target"),
  useLocal: unmeasured("0.8s", "switch a dependency back to local"),
  tunnelUp: unmeasured("0.6s", "open a tunnel for one command"),
  tunnelLatency: unmeasured("14 ms", "round trip through a tunnel"),
} as const satisfies Record<string, Figure>;

/** One bar of the warm-start chart. Offsets and widths are in characters. */
export interface ChartRow extends Figure {
  readonly start: number;
  readonly width: number;
}

function bar(
  label: string,
  start: number,
  width: number,
  value: string
): ChartRow {
  return { label, measured: false, start, value, width };
}

/** The warm-start chart: Hack's half, then the comparison half. */
export const engineChart = {
  hack: {
    total: bar("hack", 0, 4, sample.warmStart.value),
    steps: [
      bar("engine", 0, 1, sample.engineReady.value),
      bar("db", 1, 1, sample.db.value),
      bar("api, jobs", 2, 2, "together"),
      bar("web", 4, 2, sample.web.value),
      bar("plan, images, routes", 0, 0, "skipped"),
    ],
  },
  compose: {
    total: bar("docker compose", 0, 30, "14.8s"),
    steps: [
      bar("db", 0, 11, "waits on health"),
      bar("api", 11, 7, "3.6s"),
      bar("jobs", 18, 4, "2.0s"),
      bar("web", 22, 8, "3.9s"),
    ],
    summary: unmeasured("7× faster", "warm start against docker compose"),
  },
} as const;

const CHART_LABEL_WIDTH = 16;
const CHART_VALUE_COLUMN = 49;
const AXIS_LABELS = `${" ".repeat(CHART_LABEL_WIDTH)}0s        5s        10s       15s`;
const AXIS_RULE = `${" ".repeat(CHART_LABEL_WIDTH)}├─────────┼─────────┼─────────┤`;

/** Wraps text in a panel tone (`<f>…</f>`). An empty tone leaves it plain. */
function tag(name: string, text: string): string {
  return name === "" || text === "" ? text : `<${name}>${text}</${name}>`;
}

interface ChartTone {
  readonly bar: string;
  readonly glyph: string;
  readonly indent: boolean;
  readonly label: string;
  readonly value: string;
}

function chartLine(row: ChartRow, tone: ChartTone): string {
  const label = tone.indent ? `  ${row.label}` : row.label;
  const head = label.padEnd(CHART_LABEL_WIDTH);
  const marks = " ".repeat(row.start) + tone.glyph.repeat(row.width);
  const gap = " ".repeat(
    Math.max(0, CHART_VALUE_COLUMN - head.length - marks.length)
  );
  return [
    tag(tone.label, label),
    head.slice(label.length),
    tag(tone.bar, marks),
    gap,
    tag(tone.value, row.value),
  ].join("");
}

/**
 * The warm-start chart as panel markup (see `components/home-page/term.tsx`).
 * Without `comparisons` it draws only Hack's half.
 */
export function engineChartMarkup(
  comparisons: boolean = COMPARISONS_MEASURED
): string {
  const { hack, compose } = engineChart;
  const lines = [
    tag("f", AXIS_LABELS),
    tag("f", AXIS_RULE),
    chartLine(hack.total, {
      bar: "k",
      glyph: "█",
      indent: false,
      label: "k",
      value: "k",
    }),
    ...hack.steps.map((row) =>
      chartLine(row, {
        bar: "g",
        glyph: "█",
        indent: true,
        label: "",
        value: "f",
      })
    ),
  ];
  if (comparisons) {
    lines.push(
      "",
      chartLine(compose.total, {
        bar: "d",
        glyph: "█",
        indent: false,
        label: "d",
        value: "d",
      }),
      ...compose.steps.map((row) =>
        chartLine(row, {
          bar: "f",
          glyph: "▒",
          indent: true,
          label: "",
          value: "f",
        })
      )
    );
  }
  lines.push(tag("f", AXIS_RULE));
  if (comparisons) {
    lines.push(
      `${tag("k", compose.summary.value)} ${tag("f", "· one at a time against all at once, and nothing redone")}`
    );
  }
  return lines.join("\n");
}

/** One row of the `hack usage` panel. */
export interface UsageRow {
  readonly cpu: Figure;
  readonly disk: Figure;
  readonly memory: Figure;
  readonly name: string;
  readonly note?: string;
  readonly state: "up" | "asleep" | "";
  /** The colour class of a branch copy, or of the engine row. */
  readonly tone?: "c1" | "c2" | "d";
}

function usageRow(
  name: string,
  state: UsageRow["state"],
  figures: readonly [memory: string, cpu: string, disk: string],
  extra: Pick<UsageRow, "note" | "tone"> = {}
): UsageRow {
  const project = name.trim();
  return {
    cpu: unmeasured(figures[1], `${project}: cpu`),
    disk: unmeasured(figures[2], `${project}: disk`),
    memory: unmeasured(figures[0], `${project}: memory`),
    name,
    state,
    ...extra,
  };
}

/** The `hack usage` panel in the resources section. */
export const usage = {
  rows: [
    usageRow("storefront", "up", ["1.4 GB", "3%", "2.1 GB"]),
    usageRow("  fix-login", "up", ["0.3 GB", "1%", "40 MB"], {
      note: "shares images, caches",
      tone: "c1",
    }),
    usageRow("  agent/onboarding", "asleep", ["0", "0", "12 MB"], {
      tone: "c2",
    }),
    usageRow("billing-api", "asleep", ["0", "0", "0.9 GB"]),
    usageRow("engine", "", ["0.2 GB", "0.4%", "55 MB"], { tone: "d" }),
  ] satisfies readonly UsageRow[],
  totalMemory: unmeasured("1.9 GB", "total memory in use"),
  totalDisk: unmeasured("3.1 GB", "total disk in use"),
  reclaimable: unmeasured("6.2 GB", "disk hack clean can reclaim"),
} as const;

const USAGE_NAME_WIDTH = 17;
const USAGE_MEMORY_COLUMN = 26;
const USAGE_MEMORY_WIDTH = 9;
const USAGE_CPU_WIDTH = 7;
const USAGE_DISK_WIDTH = 8;

function usageLine(row: UsageRow): string {
  const indent = row.name.length - row.name.trimStart().length;
  const name = row.name.trimStart();
  const head = `${row.name} `.padEnd(USAGE_NAME_WIDTH);
  const state = `${head}${row.state}`.padEnd(USAGE_MEMORY_COLUMN);
  const figures = [
    row.memory.value.padEnd(USAGE_MEMORY_WIDTH),
    row.cpu.value.padEnd(USAGE_CPU_WIDTH),
    row.note ? row.disk.value.padEnd(USAGE_DISK_WIDTH) : row.disk.value,
  ].join("");
  return [
    " ".repeat(indent),
    row.tone ? tag(row.tone, name) : name,
    head.slice(row.name.length),
    row.state === "asleep" ? tag("a", row.state) : row.state,
    state.slice(head.length + row.state.length),
    figures,
    row.note ? tag("f", row.note) : "",
  ].join("");
}

/** The `hack usage` panel as panel markup. */
export function usageMarkup(): string {
  const blank = " ".repeat(USAGE_MEMORY_COLUMN);
  const rule = "──────";
  const between = " ".repeat(
    USAGE_MEMORY_WIDTH + USAGE_CPU_WIDTH - rule.length
  );
  const totalMemory = usage.totalMemory.value.padEnd(rule.length);
  return [
    tag("f", "PROJECT          STATE    MEMORY   CPU    DISK"),
    ...usage.rows.map(usageLine),
    `${blank}${tag("f", `${rule}${between}${rule}`)}`,
    `${"total".padEnd(USAGE_MEMORY_COLUMN)}${totalMemory}${between}${usage.totalDisk.value}`,
    "",
    `${tag("f", "reclaimable")}  ${usage.reclaimable.value}  ${tag("f", "unused images, stopped copies")}`,
    "",
    `${tag("f", "$")} hack clean`,
    `${tag("g", "✓")} ${tag("d", "removed 14 images and 3 stopped copies hack started ·")} ${usage.reclaimable.value}`,
    tag("f", "  left alone: 2 volumes it did not create"),
  ].join("\n");
}

/**
 * The idle comparison in the resources section. Hack's own two figures are
 * targets; the other products have no figure until one is measured.
 */
export const idleComparison = {
  memory: unmeasured("0.2 GB", "memory held by an idle project"),
  secondCopyDisk: unmeasured("40 MB", "disk for a second branch copy"),
  others: ["orbstack", "docker desktop", "a second clone"],
} as const;

const IDLE_LABEL_WIDTH = 16;
const IDLE_BAR_WIDTH = 20;

function idleLine(
  name: string,
  marks: string,
  value: string,
  ours: boolean
): string {
  return [
    tag(ours ? "k" : "d", name),
    " ".repeat(IDLE_LABEL_WIDTH - name.length),
    tag(ours ? "g" : "f", marks),
    " ".repeat(IDLE_BAR_WIDTH - marks.length),
    tag(ours ? "k" : "f", value),
  ].join("");
}

/**
 * The idle comparison as panel markup. The page shows it only once
 * `COMPARISONS_MEASURED` is `true`; the other products' bars are placeholders
 * until then.
 */
export function idleComparisonMarkup(): string {
  const [orbstack, dockerDesktop, secondClone] = idleComparison.others;
  const unknown = "to measure";
  return [
    tag("f", "MEMORY HELD WHILE NOTHING IS HAPPENING"),
    "",
    idleLine("hack", "██", idleComparison.memory.value, true),
    idleLine(orbstack, "▒".repeat(8), unknown, false),
    idleLine(dockerDesktop, "▒".repeat(17), unknown, false),
    "",
    tag("f", "DISK FOR A SECOND BRANCH COPY"),
    "",
    idleLine("hack", "█", idleComparison.secondCopyDisk.value, true),
    idleLine(secondClone, "▒".repeat(14), unknown, false),
    "",
    tag("f", "same project, same machine, method published"),
  ].join("\n");
}

/** Every figure the page can show, for checks and for tracking. */
export function allFigures(): readonly Figure[] {
  const { hack, compose } = engineChart;
  return [
    ...headline,
    ...Object.values(sample),
    hack.total,
    ...hack.steps,
    compose.total,
    ...compose.steps,
    compose.summary,
    ...usage.rows.flatMap((row) => [row.memory, row.cpu, row.disk]),
    usage.totalMemory,
    usage.totalDisk,
    usage.reclaimable,
    idleComparison.memory,
    idleComparison.secondCopyDisk,
  ];
}
