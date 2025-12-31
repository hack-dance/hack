import { isColorEnabled, isTty } from "./terminal.ts"
import { gumJoin, gumStyle, gumTable, isGumAvailable } from "./gum.ts"

export type DisplayCell = string | number | boolean | null | undefined

export interface Display {
  /**
   * Render a section heading. This is for UI output, not structured logs.
   */
  section(title: string): Promise<void>

  /**
   * Render a table. When available, uses `gum table` for a polished view.
   */
  table(input: {
    readonly columns: readonly string[]
    readonly rows: readonly (readonly DisplayCell[])[]
  }): Promise<void>

  /**
   * Render aligned key/value lines inside a styled box when possible.
   */
  kv(input: {
    readonly title?: string
    readonly entries: readonly (readonly [key: string, value: DisplayCell])[]
  }): Promise<void>

  /**
   * Render a boxed panel (good for "next steps" or short guidance).
   */
  panel(input: {
    readonly title?: string
    readonly lines: readonly string[]
    readonly tone?: "info" | "success" | "warn" | "error"
  }): Promise<void>

  /**
   * Render blocks side-by-side when possible.
   */
  columns(input: { readonly blocks: readonly string[] }): Promise<void>
}

function writeLine(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
}

function sanitizeCell(value: string): string {
  return value.replaceAll("\t", " ").replaceAll("\n", " ")
}

async function sectionWithGum(title: string): Promise<boolean> {
  if (!isTty()) return false
  if (!isGumAvailable()) return false

  const res = await gumStyle({
    text: [title],
    bold: true,
    foreground: "212",
    margin: "1 0 0 0"
  })

  if (!res.ok) return false
  writeLine(res.value.trimEnd())
  return true
}

function sectionWithAnsi(title: string): void {
  const enableColor = isColorEnabled()
  const RESET = "\x1b[0m"
  const BOLD = "\x1b[1m"
  const MAGENTA = "\x1b[35m"

  const line = enableColor ? `${BOLD}${MAGENTA}${title}${RESET}` : title
  writeLine("")
  writeLine(line)
}

async function tableWithGum(input: {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly DisplayCell[])[]
}): Promise<boolean> {
  if (!isTty()) return false
  if (!isGumAvailable()) return false

  const sep = "\t"
  const body = input.rows
    .map(row =>
      row
        .map(cell => sanitizeCell(cell === null || cell === undefined ? "" : String(cell)))
        .join(sep)
    )
    .join("\n")

  const res = await gumTable({
    columns: [...input.columns],
    separator: sep,
    input: body,
    // `gum table` is interactive by default; `--print` forces a static render.
    print: true,
    // Looks great for status output; can revisit per-command if it feels too heavy.
    border: "rounded",
    // Keep output compact (gum will otherwise show a row count line).
    hideCount: true
  })

  if (!res.ok) return false
  writeLine(res.value)
  return true
}

function tableWithAnsi(input: {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly DisplayCell[])[]
}): void {
  const enableColor = isColorEnabled()
  const RESET = "\x1b[0m"
  const BOLD = "\x1b[1m"

  const rows = input.rows.map(r => r.map(c => (c === null || c === undefined ? "" : String(c))))
  const widths = input.columns.map((col, i) => {
    const cellMax = Math.max(0, ...rows.map(r => (r[i] ?? "").length))
    return Math.max(col.length, cellMax)
  })

  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length))
  const header = input.columns.map((c, i) => pad(c, widths[i] ?? c.length)).join("  ")
  const sep = widths.map(w => "-".repeat(Math.max(1, w))).join("  ")

  writeLine(enableColor ? `${BOLD}${header}${RESET}` : header)
  writeLine(sep)
  for (const r of rows) {
    const line = r.map((c, i) => pad(c ?? "", widths[i] ?? 0)).join("  ")
    writeLine(line)
  }
}

async function panelWithGum(input: {
  readonly title?: string
  readonly lines: readonly string[]
  readonly tone?: "info" | "success" | "warn" | "error"
}): Promise<boolean> {
  if (!isTty()) return false
  if (!isGumAvailable()) return false

  const titleRaw = (input.title ?? "").trim()
  const tone = input.tone ?? "info"
  const borderForeground =
    {
      info: "212",
      success: "42",
      warn: "214",
      error: "196"
    }[tone] ?? "212"

  const text = titleRaw.length > 0 ? [titleRaw, ...input.lines] : [...input.lines]
  const res = await gumStyle({
    text,
    border: "rounded",
    borderForeground,
    padding: "0 1",
    margin: "1 0 0 0"
  })
  if (!res.ok) return false
  writeLine(res.value)
  return true
}

function panelWithAnsi(input: {
  readonly title?: string
  readonly lines: readonly string[]
}): void {
  const titleRaw = (input.title ?? "").trim()
  writeLine("")
  if (titleRaw.length > 0) writeLine(titleRaw)
  for (const line of input.lines) {
    writeLine(`  ${line}`)
  }
}

async function kvWithGum(input: {
  readonly title?: string
  readonly entries: readonly (readonly [key: string, value: DisplayCell])[]
}): Promise<boolean> {
  if (!isTty()) return false
  if (!isGumAvailable()) return false

  const titleRaw = (input.title ?? "").trim()
  const keyWidth = Math.max(0, ...input.entries.map(([k]) => k.length))
  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length))
  const lines = input.entries.map(([key, value]) => {
    const v = value === null || value === undefined ? "" : String(value)
    return `${pad(key, keyWidth)}  ${sanitizeCell(v)}`
  })

  const res = await gumStyle({
    text: titleRaw.length > 0 ? [titleRaw, ...lines] : lines,
    border: "rounded",
    borderForeground: "240",
    padding: "0 1",
    margin: "1 0 0 0"
  })
  if (!res.ok) return false
  writeLine(res.value)
  return true
}

function kvWithAnsi(input: {
  readonly title?: string
  readonly entries: readonly (readonly [key: string, value: DisplayCell])[]
}): void {
  const titleRaw = (input.title ?? "").trim()
  const keyWidth = Math.max(0, ...input.entries.map(([k]) => k.length))
  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length))
  writeLine("")
  if (titleRaw.length > 0) writeLine(titleRaw)
  for (const [key, value] of input.entries) {
    const v = value === null || value === undefined ? "" : String(value)
    writeLine(`${pad(key, keyWidth)}  ${sanitizeCell(v)}`)
  }
}

async function columnsWithGum(input: { readonly blocks: readonly string[] }): Promise<boolean> {
  if (!isTty()) return false
  if (!isGumAvailable()) return false
  if (input.blocks.length === 0) return true

  const res = await gumJoin({
    text: [...input.blocks],
    horizontal: true,
    align: "left"
  })
  if (!res.ok) return false
  writeLine(res.value.trimEnd())
  return true
}

export const display: Display = {
  section: async title => {
    if (await sectionWithGum(title)) return
    sectionWithAnsi(title)
  },
  table: async input => {
    if (await tableWithGum(input)) return
    tableWithAnsi(input)
  },
  kv: async input => {
    if (await kvWithGum(input)) return
    kvWithAnsi(input)
  },
  panel: async input => {
    if (await panelWithGum(input)) return
    panelWithAnsi(input)
  },
  columns: async input => {
    if (await columnsWithGum(input)) return
    for (const block of input.blocks) {
      writeLine(block.trimEnd())
      writeLine("")
    }
  }
}
