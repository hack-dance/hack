import { isTty } from "./terminal.ts"

import type { PlanetAnimation } from "./planet-animations.ts"

export async function playPlanetAnimation(opts: {
  readonly animations: readonly PlanetAnimation[]
  readonly loop: boolean
}): Promise<boolean> {
  if (!isTty()) {
    process.stderr.write("This command must be run in an interactive TTY.\n")
    return false
  }

  const animations = opts.animations.filter(a => a.frames.length > 0)
  if (animations.length === 0) return true

  const prepared = animations.map(anim => ({
    anim,
    metrics: computeFrameMetrics(anim.frames)
  }))

  const restore = enterAltScreen()
  const stop = installExitHandlers(restore)

  try {
    // Initial clear (reset styles first to avoid odd terminal state on entry).
    process.stdout.write("\x1b[0m\x1b[H\x1b[J")

    do {
      for (const { anim, metrics } of prepared) {
        const frameMs = Math.max(1, Math.round(1000 / anim.fps))
        for (const frame of anim.frames) {
          if (stop.shouldStop()) break

          // Reset styles before clearing to avoid per-frame ANSI state leaking into the border.
          process.stdout.write("\x1b[0m\x1b[H\x1b[J")
          const size = readTerminalSize()
          process.stdout.write(
            renderTvFrame({
              frame,
              contentWidth: metrics.width,
              contentHeight: metrics.height,
              cols: size.cols ?? undefined,
              rows: size.rows ?? undefined
            })
          )

          await sleep(frameMs)
        }
        if (stop.shouldStop()) break
      }
    } while (opts.loop && !stop.shouldStop())
  } finally {
    stop.dispose()
    restore()
  }

  return true
}

function computeFrameMetrics(frames: readonly string[]): {
  readonly width: number
  readonly height: number
} {
  let width = 0
  let height = 0

  for (const frame of frames) {
    const lines = trimFinalNewline(frame).split("\n")
    if (lines.length > height) height = lines.length
    for (const line of lines) {
      const w = visibleWidth(line)
      if (w > width) width = w
    }
  }

  return { width, height }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function enterAltScreen(): () => void {
  // Alternate screen + hidden cursor, like `less`.
  process.stdout.write("\x1b[?1049h\x1b[?25l")
  return () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l")
  }
}

function installExitHandlers(restore: () => void): {
  readonly shouldStop: () => boolean
  readonly dispose: () => void
} {
  let stopping = false

  const onSigInt = () => {
    stopping = true
  }

  const onExit = () => {
    try {
      restore()
    } catch {
      // ignore
    }
  }

  process.once("SIGINT", onSigInt)
  process.once("exit", onExit)

  return {
    shouldStop: () => stopping,
    dispose: () => {
      process.off("SIGINT", onSigInt)
      process.off("exit", onExit)
    }
  }
}

function renderTvFrame(opts: {
  readonly frame: string
  readonly contentWidth: number
  readonly contentHeight: number
  readonly cols?: number
  readonly rows?: number
}): string {
  const reset = "\x1b[0m"
  const rawLines = trimFinalNewline(opts.frame).split("\n")
  const lines = padLinesToHeight({
    lines: rawLines,
    height: opts.contentHeight
  })
  const contentWidth = opts.contentWidth
  const contentHeight = opts.contentHeight

  const cols = typeof opts.cols === "number" && opts.cols > 0 ? opts.cols : null
  const rows = typeof opts.rows === "number" && opts.rows > 0 ? opts.rows : null

  const desiredPadX = 4
  const desiredPadY = 1

  const maxPadX = cols ? Math.max(0, Math.floor((cols - contentWidth - 2) / 2)) : desiredPadX
  const maxPadY = rows ? Math.max(0, Math.floor((rows - contentHeight - 2) / 2)) : desiredPadY

  const padX = Math.min(desiredPadX, maxPadX)
  const padY = Math.min(desiredPadY, maxPadY)

  const innerWidth = contentWidth + padX * 2
  const outerWidth = innerWidth + 2
  const outerHeight = contentHeight + padY * 2 + 2

  // If the terminal is too small to fit the border, just center the raw frame.
  if ((cols !== null && contentWidth > cols) || (rows !== null && contentHeight > rows)) {
    return centerRaw({
      lines,
      width: contentWidth,
      height: contentHeight,
      cols,
      rows
    })
  }
  if (cols !== null && outerWidth > cols) {
    return centerRaw({
      lines,
      width: contentWidth,
      height: contentHeight,
      cols,
      rows
    })
  }
  if (rows !== null && outerHeight > rows) {
    return centerRaw({
      lines,
      width: contentWidth,
      height: contentHeight,
      cols,
      rows
    })
  }

  const leftMargin = cols !== null ? Math.max(0, Math.floor((cols - outerWidth) / 2)) : 0
  const topMargin = rows !== null ? Math.max(0, Math.floor((rows - outerHeight) / 2)) : 0

  const out: string[] = []
  for (let i = 0; i < topMargin; i += 1) out.push("")

  const margin = leftMargin > 0 ? " ".repeat(leftMargin) : ""
  const h = "━".repeat(innerWidth)

  out.push(`${reset}${margin}╭${h}╮${reset}`)
  for (let i = 0; i < padY; i += 1) {
    out.push(`${reset}${margin}┃${" ".repeat(innerWidth)}┃${reset}`)
  }

  for (const line of lines) {
    const padRight = Math.max(0, contentWidth - visibleWidth(line))
    out.push(
      `${reset}${margin}┃${" ".repeat(padX)}${line}${reset}${" ".repeat(padRight)}${" ".repeat(padX)}┃${reset}`
    )
  }

  for (let i = 0; i < padY; i += 1) {
    out.push(`${reset}${margin}┃${" ".repeat(innerWidth)}┃${reset}`)
  }
  out.push(`${reset}${margin}╰${h}╯${reset}`)

  return out.join("\n")
}

function centerRaw(opts: {
  readonly lines: readonly string[]
  readonly width: number
  readonly height: number
  readonly cols: number | null
  readonly rows: number | null
}): string {
  const reset = "\x1b[0m"
  const lines = padLinesToHeight({ lines: opts.lines, height: opts.height })
  const width = opts.width
  const height = opts.height

  const leftMargin = opts.cols !== null ? Math.max(0, Math.floor((opts.cols - width) / 2)) : 0
  const topMargin = opts.rows !== null ? Math.max(0, Math.floor((opts.rows - height) / 2)) : 0

  const out: string[] = []
  for (let i = 0; i < topMargin; i += 1) out.push("")

  const margin = leftMargin > 0 ? " ".repeat(leftMargin) : ""
  for (const line of lines) {
    const padRight = Math.max(0, width - visibleWidth(line))
    out.push(`${reset}${margin}${line}${reset}${" ".repeat(padRight)}`)
  }
  return out.join("\n")
}

function trimFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

function visibleWidth(text: string): number {
  return stringWidth(stripAnsi(text))
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "")
}

function padLinesToHeight(opts: {
  readonly lines: readonly string[]
  readonly height: number
}): readonly string[] {
  if (opts.lines.length === opts.height) return opts.lines
  if (opts.lines.length > opts.height) return opts.lines.slice(0, opts.height)
  return [...opts.lines, ...Array.from({ length: opts.height - opts.lines.length }, () => "")]
}

function stringWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0
    width += wcwidth(codePoint)
  }
  return width
}

function wcwidth(codePoint: number): number {
  // Fast-path common ASCII.
  if (codePoint >= 0x20 && codePoint < 0x7f) return 1

  // Control chars.
  if (codePoint === 0) return 0
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0

  if (isCombining(codePoint)) return 0
  if (isWide(codePoint)) return 2
  return 1
}

function isCombining(codePoint: number): boolean {
  return isInRanges(codePoint, COMBINING_RANGES)
}

function isWide(codePoint: number): boolean {
  // Includes CJK wide/fullwidth + common emoji blocks.
  return isInRanges(codePoint, WIDE_RANGES) || isInRanges(codePoint, EMOJI_RANGES)
}

function isInRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

const COMBINING_RANGES = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f]
] as const

// Rough wcwidth wide table (covers what we need for chafa frames).
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
] as const

const EMOJI_RANGES = [
  [0x1f300, 0x1f5ff],
  [0x1f600, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f700, 0x1f77f],
  [0x1f780, 0x1f7ff],
  [0x1f800, 0x1f8ff],
  [0x1f900, 0x1f9ff],
  [0x1fa00, 0x1faff]
] as const

type TerminalSize = {
  readonly cols: number | null
  readonly rows: number | null
}

function readTerminalSize(): TerminalSize {
  const cols =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0 ?
      process.stdout.columns
    : null
  const rows =
    typeof process.stdout.rows === "number" && process.stdout.rows > 0 ? process.stdout.rows : null
  if (cols !== null && rows !== null) return { cols, rows }

  const win = tryGetWindowSize()
  const env = tryGetEnvSize()

  return {
    cols: cols ?? win.cols ?? env.cols,
    rows: rows ?? win.rows ?? env.rows
  }
}

function tryGetEnvSize(): TerminalSize {
  const cols = parsePositiveInt(process.env.COLUMNS)
  const rows = parsePositiveInt(process.env.LINES)
  return { cols, rows }
}

function parsePositiveInt(value: string | undefined): number | null {
  const v = (value ?? "").trim()
  if (v.length === 0) return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

type WindowSized = { readonly getWindowSize: () => unknown }

function hasGetWindowSize(value: unknown): value is WindowSized {
  if (!value || typeof value !== "object") return false
  const rec = value as Record<string, unknown>
  return typeof rec["getWindowSize"] === "function"
}

function tryGetWindowSize(): TerminalSize {
  const stdout: unknown = process.stdout
  if (!hasGetWindowSize(stdout)) return { cols: null, rows: null }
  const out = stdout.getWindowSize()
  if (!Array.isArray(out) || out.length < 2) return { cols: null, rows: null }
  const cols = typeof out[0] === "number" && out[0] > 0 ? out[0] : null
  const rows = typeof out[1] === "number" && out[1] > 0 ? out[1] : null
  return { cols, rows }
}
