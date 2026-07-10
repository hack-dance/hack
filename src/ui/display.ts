import { gumJoin, gumStyle, gumTable, isGumAvailable } from "./gum.ts";
import { isColorEnabled, isTty } from "./terminal.ts";

export type DisplayCell = string | number | boolean | null | undefined;

export type DisplayStatus = "ok" | "warn" | "error" | "info";

export type DisplayStatusItem = {
  readonly label: string;
  readonly status: DisplayStatus;
  readonly detail?: string;
  readonly meta?: string;
};

export interface Display {
  /**
   * Render a section heading. This is for UI output, not structured logs.
   */
  section(title: string): Promise<void>;

  /**
   * Render a table. When available, uses `gum table` for a polished view.
   */
  table(input: {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly DisplayCell[])[];
  }): Promise<void>;

  /**
   * Render aligned key/value lines inside a styled box when possible.
   */
  kv(input: {
    readonly title?: string;
    readonly entries: readonly (readonly [key: string, value: DisplayCell])[];
  }): Promise<void>;

  /**
   * Render a boxed panel (good for "next steps" or short guidance).
   */
  panel(input: {
    readonly title?: string;
    readonly lines: readonly string[];
    readonly tone?: "info" | "success" | "warn" | "error";
  }): Promise<void>;

  /**
   * Render compact diagnostic rows with optional indented detail.
   * Healthy rows stay terse while warnings and errors can explain themselves.
   */
  statusList(input: {
    readonly title?: string;
    readonly items: readonly DisplayStatusItem[];
  }): Promise<void>;

  /**
   * Render blocks side-by-side when possible.
   */
  columns(input: { readonly blocks: readonly string[] }): Promise<void>;
}

function writeLine(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

const DEFAULT_TERMINAL_WIDTH = 80;
const MAX_READING_WIDTH = 100;
const LEADING_WHITESPACE_PATTERN = /^\s*/;
const LIST_PREFIX_PATTERN = /^(?:[-*]|\d+\.)\s+/;
const WHITESPACE_PATTERN = /\s+/;

function resolveReadingWidth(): number {
  const terminalWidth =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : DEFAULT_TERMINAL_WIDTH;
  return Math.max(40, Math.min(MAX_READING_WIDTH, terminalWidth - 2));
}

function wrapLine(input: {
  readonly text: string;
  readonly width: number;
}): string[] {
  if (input.text.length <= input.width) {
    return [input.text];
  }

  const words = input.text.trim().split(WHITESPACE_PATTERN);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + word.length + 1 <= input.width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

export function buildStatusListLines(input: {
  readonly items: readonly DisplayStatusItem[];
  readonly width: number;
}): readonly string[] {
  const symbols: Readonly<Record<DisplayStatus, string>> = {
    ok: "✓",
    warn: "!",
    error: "×",
    info: "•",
  };
  const labelWidth = Math.max(
    0,
    ...input.items.map((item) => item.label.length)
  );
  const lines: string[] = [];

  for (const item of input.items) {
    const paddedLabel = item.label.padEnd(labelWidth);
    const meta = item.meta ? `  ${item.meta}` : "";
    lines.push(`${symbols[item.status]}  ${paddedLabel}${meta}`.trimEnd());
    if (!item.detail) {
      continue;
    }
    const detailIndent = "   ";
    const detailWidth = Math.max(20, input.width - detailIndent.length);
    for (const paragraph of item.detail.split("\n")) {
      for (const detailLine of wrapLine({
        text: paragraph,
        width: detailWidth,
      })) {
        lines.push(`${detailIndent}${detailLine}`);
      }
    }
  }

  return lines;
}

export function buildPanelLines(input: {
  readonly lines: readonly string[];
  readonly width: number;
}): readonly string[] {
  return input.lines.flatMap((line) => {
    if (line.length <= input.width) {
      return [line];
    }
    const leadingWhitespace = line.match(LEADING_WHITESPACE_PATTERN)?.[0] ?? "";
    const body = line.slice(leadingWhitespace.length);
    const bullet = body.match(LIST_PREFIX_PATTERN)?.[0] ?? "";
    const firstPrefix = `${leadingWhitespace}${bullet}`;
    const continuationPrefix = " ".repeat(firstPrefix.length);
    const content = body.slice(bullet.length);
    const contentWidth = Math.max(20, input.width - firstPrefix.length);
    return wrapLine({ text: content, width: contentWidth }).map(
      (part, index) =>
        `${index === 0 ? firstPrefix : continuationPrefix}${part}`
    );
  });
}

function statusListWithAnsi(input: {
  readonly title?: string;
  readonly items: readonly DisplayStatusItem[];
}): void {
  const enableColor = isColorEnabled();
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const FAINT = "\x1b[2m";
  const colors: Readonly<Record<DisplayStatus, string>> = {
    ok: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    info: "\x1b[36m",
  };
  const lines = buildStatusListLines({
    items: input.items,
    width: resolveReadingWidth(),
  });

  writeLine("");
  if (input.title) {
    writeLine(enableColor ? `${BOLD}${input.title}${RESET}` : input.title);
  }
  let itemIndex = 0;
  for (const line of lines) {
    const isDetail = line.startsWith("   ");
    if (isDetail) {
      writeLine(enableColor ? `${FAINT}${line}${RESET}` : line);
      continue;
    }
    const status = input.items[itemIndex]?.status ?? "info";
    const symbol = line.slice(0, 1);
    const remainder = line.slice(1);
    writeLine(
      enableColor ? `${colors[status]}${symbol}${RESET}${remainder}` : line
    );
    itemIndex += 1;
  }
}

function sanitizeCell(value: string): string {
  return value.replaceAll("\t", " ").replaceAll("\n", " ");
}

async function sectionWithGum(title: string): Promise<boolean> {
  if (!isTty()) {
    return false;
  }
  if (!isGumAvailable()) {
    return false;
  }

  const res = await gumStyle({
    text: [title],
    bold: true,
    foreground: "212",
    margin: "1 0 0 0",
  });

  if (!res.ok) {
    return false;
  }
  writeLine(res.value.trimEnd());
  return true;
}

function sectionWithAnsi(title: string): void {
  const enableColor = isColorEnabled();
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const MAGENTA = "\x1b[35m";

  const line = enableColor ? `${BOLD}${MAGENTA}${title}${RESET}` : title;
  writeLine("");
  writeLine(line);
}

async function tableWithGum(input: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly DisplayCell[])[];
}): Promise<boolean> {
  if (!isTty()) {
    return false;
  }
  if (!isGumAvailable()) {
    return false;
  }

  const sep = "\t";
  const body = input.rows
    .map((row) =>
      row
        .map((cell) =>
          sanitizeCell(cell === null || cell === undefined ? "" : String(cell))
        )
        .join(sep)
    )
    .join("\n");

  const res = await gumTable({
    columns: [...input.columns],
    separator: sep,
    input: body,
    // `gum table` is interactive by default; `--print` forces a static render.
    print: true,
    // Looks great for status output; can revisit per-command if it feels too heavy.
    border: "rounded",
    // Keep output compact (gum will otherwise show a row count line).
    hideCount: true,
  });

  if (!res.ok) {
    return false;
  }
  writeLine(res.value);
  return true;
}

function tableWithAnsi(input: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly DisplayCell[])[];
}): void {
  const enableColor = isColorEnabled();
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";

  const rows = input.rows.map((r) =>
    r.map((c) => (c === null || c === undefined ? "" : String(c)))
  );
  const widths = input.columns.map((col, i) => {
    const cellMax = Math.max(0, ...rows.map((r) => (r[i] ?? "").length));
    return Math.max(col.length, cellMax);
  });

  const pad = (s: string, w: number) =>
    s.length >= w ? s : s + " ".repeat(w - s.length);
  const header = input.columns
    .map((c, i) => pad(c, widths[i] ?? c.length))
    .join("  ");
  const sep = widths.map((w) => "-".repeat(Math.max(1, w))).join("  ");

  writeLine(enableColor ? `${BOLD}${header}${RESET}` : header);
  writeLine(sep);
  for (const r of rows) {
    const line = r.map((c, i) => pad(c ?? "", widths[i] ?? 0)).join("  ");
    writeLine(line);
  }
}

async function panelWithGum(input: {
  readonly title?: string;
  readonly lines: readonly string[];
  readonly tone?: "info" | "success" | "warn" | "error";
}): Promise<boolean> {
  if (!isTty()) {
    return false;
  }
  if (!isGumAvailable()) {
    return false;
  }

  const titleRaw = (input.title ?? "").trim();
  const tone = input.tone ?? "info";
  const borderForeground =
    {
      info: "212",
      success: "42",
      warn: "214",
      error: "196",
    }[tone] ?? "212";

  const readingWidth = resolveReadingWidth();
  const contentWidth = readingWidth - 4;
  const panelLines = buildPanelLines({
    lines: input.lines,
    width: contentWidth,
  });
  const text =
    titleRaw.length > 0 ? [titleRaw, ...panelLines] : [...panelLines];
  const needsWidthConstraint = input.lines.some(
    (line) => line.length > contentWidth
  );
  const res = await gumStyle({
    text,
    border: "rounded",
    borderForeground,
    padding: "0 1",
    margin: "1 0 0 0",
    width: needsWidthConstraint ? readingWidth : undefined,
  });
  if (!res.ok) {
    return false;
  }
  writeLine(res.value);
  return true;
}

function panelWithAnsi(input: {
  readonly title?: string;
  readonly lines: readonly string[];
}): void {
  const titleRaw = (input.title ?? "").trim();
  writeLine("");
  if (titleRaw.length > 0) {
    writeLine(titleRaw);
  }
  for (const line of buildPanelLines({
    lines: input.lines,
    width: resolveReadingWidth() - 2,
  })) {
    writeLine(`  ${line}`);
  }
}

async function kvWithGum(input: {
  readonly title?: string;
  readonly entries: readonly (readonly [key: string, value: DisplayCell])[];
}): Promise<boolean> {
  if (!isTty()) {
    return false;
  }
  if (!isGumAvailable()) {
    return false;
  }

  const titleRaw = (input.title ?? "").trim();
  const keyWidth = Math.max(0, ...input.entries.map(([k]) => k.length));
  const pad = (s: string, w: number) =>
    s.length >= w ? s : s + " ".repeat(w - s.length);
  const lines = input.entries.map(([key, value]) => {
    const v = value === null || value === undefined ? "" : String(value);
    return `${pad(key, keyWidth)}  ${sanitizeCell(v)}`;
  });

  const res = await gumStyle({
    text: titleRaw.length > 0 ? [titleRaw, ...lines] : lines,
    border: "rounded",
    borderForeground: "240",
    padding: "0 1",
    margin: "1 0 0 0",
  });
  if (!res.ok) {
    return false;
  }
  writeLine(res.value);
  return true;
}

function kvWithAnsi(input: {
  readonly title?: string;
  readonly entries: readonly (readonly [key: string, value: DisplayCell])[];
}): void {
  const titleRaw = (input.title ?? "").trim();
  const keyWidth = Math.max(0, ...input.entries.map(([k]) => k.length));
  const pad = (s: string, w: number) =>
    s.length >= w ? s : s + " ".repeat(w - s.length);
  writeLine("");
  if (titleRaw.length > 0) {
    writeLine(titleRaw);
  }
  for (const [key, value] of input.entries) {
    const v = value === null || value === undefined ? "" : String(value);
    writeLine(`${pad(key, keyWidth)}  ${sanitizeCell(v)}`);
  }
}

async function columnsWithGum(input: {
  readonly blocks: readonly string[];
}): Promise<boolean> {
  if (!isTty()) {
    return false;
  }
  if (!isGumAvailable()) {
    return false;
  }
  if (input.blocks.length === 0) {
    return true;
  }

  const res = await gumJoin({
    text: [...input.blocks],
    horizontal: true,
    align: "left",
  });
  if (!res.ok) {
    return false;
  }
  writeLine(res.value.trimEnd());
  return true;
}

export const display: Display = {
  section: async (title) => {
    if (await sectionWithGum(title)) {
      return;
    }
    sectionWithAnsi(title);
  },
  table: async (input) => {
    if (await tableWithGum(input)) {
      return;
    }
    tableWithAnsi(input);
  },
  kv: async (input) => {
    if (await kvWithGum(input)) {
      return;
    }
    kvWithAnsi(input);
  },
  panel: async (input) => {
    if (await panelWithGum(input)) {
      return;
    }
    panelWithAnsi(input);
  },
  statusList: (input) => {
    statusListWithAnsi(input);
    return Promise.resolve();
  },
  columns: async (input) => {
    if (await columnsWithGum(input)) {
      return;
    }
    for (const block of input.blocks) {
      writeLine(block.trimEnd());
      writeLine("");
    }
  },
};
