import { dirname, resolve } from "node:path"
import { existsSync } from "node:fs"

import { execOrThrow } from "../lib/shell.ts"
import { isRecord } from "../lib/guards.ts"
import { ensureDir } from "../lib/fs.ts"

export type GumLogLevel = "debug" | "info" | "warn" | "error" | "fatal"

export type GumFieldValue = string | number | boolean
export type GumFields = Readonly<Record<string, GumFieldValue>>

export type GumOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "unavailable" }
  | { readonly ok: false; readonly reason: "cancelled" }
  | {
      readonly ok: false
      readonly reason: "failed"
      readonly exitCode: number
    }

export interface GumLogInput {
  readonly level: GumLogLevel
  readonly message: string
  readonly fields?: GumFields
}

let gumPathCached: string | null | undefined

export function getGumPath(): string | null {
  if (gumPathCached !== undefined) return gumPathCached
  const overrideRaw = (process.env.HACK_GUM_PATH ?? "").trim()
  if (overrideRaw.length > 0) {
    gumPathCached = overrideRaw
    return gumPathCached
  }

  const bundled = getBundledGumInstallPath()
  if (bundled && existsSync(bundled)) {
    gumPathCached = bundled
    return gumPathCached
  }

  gumPathCached = Bun.which("gum")
  return gumPathCached
}

export function resetGumPathCacheForTests(): void {
  gumPathCached = undefined
}

export function isGumAvailable(): boolean {
  return getGumPath() !== null
}

export type BundledGumInstallOutcome =
  | { readonly ok: true; readonly installed: boolean; readonly gumPath: string }
  | {
      readonly ok: false
      readonly reason:
        | "home-not-set"
        | "unsupported-platform"
        | "bundle-not-found"
        | "tar-not-found"
        | "failed"
      readonly message?: string
    }

export async function ensureBundledGumInstalled(): Promise<BundledGumInstallOutcome> {
  const installPath = getBundledGumInstallPath()
  if (!installPath) {
    return { ok: false, reason: "home-not-set" }
  }

  if (existsSync(installPath)) {
    gumPathCached = installPath
    return { ok: true, installed: false, gumPath: installPath }
  }

  if (process.platform !== "darwin") {
    return { ok: false, reason: "unsupported-platform" }
  }

  const bundle = resolveBundledGumArtifact()
  if (!bundle) {
    return { ok: false, reason: "bundle-not-found" }
  }

  const tar = Bun.which("tar")
  if (!tar) {
    return { ok: false, reason: "tar-not-found" }
  }

  try {
    await ensureDir(dirname(installPath))
    await execOrThrow(
      [
        tar,
        "-xzf",
        bundle.tarballPath,
        "-C",
        dirname(installPath),
        "--strip-components=1",
        `${bundle.topDir}/gum`
      ],
      { stdin: "ignore" }
    )
    await execOrThrow(["chmod", "+x", installPath], { stdin: "ignore" })
    gumPathCached = installPath
    return { ok: true, installed: true, gumPath: installPath }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { ok: false, reason: "failed", message }
  }
}

export function tryGumLog({ level, message, fields }: GumLogInput): boolean {
  const gum = getGumPath()
  if (!gum) return false

  const kv: string[] = []
  if (fields && isRecord(fields)) {
    for (const key of Object.keys(fields).sort()) {
      const value = fields[key]
      if (value === undefined) continue
      kv.push(key, String(value))
    }
  }

  const cmd = [
    gum,
    "log",
    "--level",
    level,
    ...(kv.length > 0 ? ["--structured"] : []),
    message,
    ...kv
  ]

  const res = Bun.spawnSync({
    cmd,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit"
  })

  return res.exitCode === 0
}

function getBundledGumInstallPath(): string | null {
  const home = process.env.HOME
  if (!home) return null
  return `${home}/.hack/bin/gum`
}

type BundledGumArtifact = {
  readonly tarballPath: string
  readonly topDir: string
}

function resolveBundledGumArtifact(): BundledGumArtifact | null {
  if (process.platform !== "darwin") {
    return null
  }

  const arch = process.arch
  const isArm = arch === "arm64"
  const filename = isArm ? "gum_0.17.0_Darwin_arm64.tar.gz" : "gum_0.17.0_Darwin_x86_64.tar.gz"
  const topDir = isArm ? "gum_0.17.0_Darwin_arm64" : "gum_0.17.0_Darwin_x86_64"

  for (const p of bundledGumTarballCandidates(filename)) {
    if (existsSync(p)) return { tarballPath: p, topDir }
  }

  return null
}

function bundledGumTarballCandidates(filename: string): readonly string[] {
  const out: string[] = []

  const envDir = (process.env.HACK_ASSETS_DIR ?? "").trim()
  if (envDir.length > 0) {
    out.push(resolve(envDir, filename))
    out.push(resolve(envDir, "binaries", "gum", filename))
  }

  const home = process.env.HOME
  if (home) {
    const defaultAssets = resolve(home, ".hack", "assets")
    out.push(resolve(defaultAssets, filename))
    out.push(resolve(defaultAssets, "binaries", "gum", filename))
  }

  // Dev/source layout: <repo>/src/ui/gum.ts → <repo>/binaries/gum/<tarball>
  out.push(resolve(import.meta.dir, "../../binaries/gum", filename))

  const argv1 = process.argv[1]
  if (typeof argv1 === "string" && argv1.length > 0) {
    out.push(resolve(dirname(argv1), "binaries", "gum", filename))
    out.push(resolve(dirname(argv1), "..", "binaries", "gum", filename))
  }

  const execPath = process.execPath
  if (typeof execPath === "string" && execPath.length > 0) {
    out.push(resolve(dirname(execPath), "binaries", "gum", filename))
    out.push(resolve(dirname(execPath), "..", "binaries", "gum", filename))
  }

  return out
}

export interface GumConfirmInput {
  readonly prompt?: string
  readonly default?: boolean
  readonly showOutput?: boolean
  readonly affirmative?: string
  readonly negative?: string
  readonly showHelp?: boolean
  readonly timeout?: string
}

export async function gumConfirm({
  prompt,
  default: defaultChoice,
  showOutput,
  affirmative,
  negative,
  showHelp,
  timeout
}: GumConfirmInput): Promise<GumOutcome<boolean>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "confirm",
    ...(prompt ? [prompt] : []),
    ...(defaultChoice ? ["--default"] : []),
    ...(showOutput ? ["--show-output"] : []),
    ...(affirmative ? ["--affirmative", affirmative] : []),
    ...(negative ? ["--negative", negative] : []),
    ...(showHelp === undefined ? []
    : showHelp ? ["--show-help"]
    : ["--no-show-help"]),
    ...(timeout ? ["--timeout", timeout] : [])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })

  const exitCode = await proc.exited
  if (exitCode === 0) return { ok: true, value: true }
  if (exitCode === 1) return { ok: true, value: false }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumInputInput {
  readonly placeholder?: string
  readonly prompt?: string
  readonly header?: string
  readonly value?: string
  readonly width?: number
  readonly charLimit?: number
  readonly password?: boolean
  readonly showHelp?: boolean
  readonly timeout?: string
  readonly stripAnsi?: boolean
}

export async function gumInput({
  placeholder,
  prompt,
  header,
  value,
  width,
  charLimit,
  password,
  showHelp,
  timeout,
  stripAnsi
}: GumInputInput): Promise<GumOutcome<string>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "input",
    ...(placeholder ? ["--placeholder", placeholder] : []),
    ...(prompt ? ["--prompt", prompt] : []),
    ...(header ? ["--header", header] : []),
    ...(value ? ["--value", value] : []),
    ...(width === undefined ? [] : ["--width", String(width)]),
    ...(charLimit === undefined ? [] : ["--char-limit", String(charLimit)]),
    ...(password ? ["--password"] : []),
    ...(showHelp === undefined ? []
    : showHelp ? ["--show-help"]
    : ["--no-show-help"]),
    ...(timeout ? ["--timeout", timeout] : []),
    ...(stripAnsi === undefined ? []
    : stripAnsi ? ["--strip-ansi"]
    : ["--no-strip-ansi"])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) return { ok: true, value: stdout.trimEnd() }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumWriteInput {
  readonly placeholder?: string
  readonly prompt?: string
  readonly header?: string
  readonly value?: string
  readonly width?: number
  readonly height?: number
  readonly charLimit?: number
  readonly maxLines?: number
  readonly showCursorLine?: boolean
  readonly showLineNumbers?: boolean
  readonly showHelp?: boolean
  readonly timeout?: string
  readonly stripAnsi?: boolean
}

export async function gumWrite({
  placeholder,
  prompt,
  header,
  value,
  width,
  height,
  charLimit,
  maxLines,
  showCursorLine,
  showLineNumbers,
  showHelp,
  timeout,
  stripAnsi
}: GumWriteInput): Promise<GumOutcome<string>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "write",
    ...(width === undefined ? [] : ["--width", String(width)]),
    ...(height === undefined ? [] : ["--height", String(height)]),
    ...(header ? ["--header", header] : []),
    ...(placeholder ? ["--placeholder", placeholder] : []),
    ...(prompt ? ["--prompt", prompt] : []),
    ...(showCursorLine ? ["--show-cursor-line"] : []),
    ...(showLineNumbers ? ["--show-line-numbers"] : []),
    ...(value ? ["--value", value] : []),
    ...(charLimit === undefined ? [] : ["--char-limit", String(charLimit)]),
    ...(maxLines === undefined ? [] : ["--max-lines", String(maxLines)]),
    ...(showHelp === undefined ? []
    : showHelp ? ["--show-help"]
    : ["--no-show-help"]),
    ...(timeout ? ["--timeout", timeout] : []),
    ...(stripAnsi === undefined ? []
    : stripAnsi ? ["--strip-ansi"]
    : ["--no-strip-ansi"])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) return { ok: true, value: stdout.trimEnd() }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumChooseInputBase {
  readonly options: readonly string[]
  readonly header?: string
  readonly height?: number
  readonly cursor?: string
  readonly ordered?: boolean
  readonly selectIfOne?: boolean
  readonly timeout?: string
  readonly showHelp?: boolean
  readonly selected?: readonly string[] | "*"
  readonly inputDelimiter?: string
  readonly outputDelimiter?: string
  readonly labelDelimiter?: string
  readonly stripAnsi?: boolean
}

export async function gumChooseOne(input: GumChooseInputBase): Promise<GumOutcome<string>> {
  const res = await gumChooseMany({ ...input, limit: 1 })
  if (!res.ok) return res
  const first = res.value[0]
  if (!first) return { ok: false, reason: "failed", exitCode: 1 }
  return { ok: true, value: first }
}

export async function gumChooseMany(
  input: GumChooseInputBase & {
    readonly limit?: number
    readonly noLimit?: boolean
  }
): Promise<GumOutcome<readonly string[]>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const delimiter = input.outputDelimiter ?? "\n"
  const cmd = [
    gum,
    "choose",
    ...input.options,
    ...(input.ordered ? ["--ordered"] : []),
    ...(input.height === undefined ? [] : ["--height", String(input.height)]),
    ...(input.cursor ? ["--cursor", input.cursor] : []),
    ...(input.showHelp === undefined ? []
    : input.showHelp ? ["--show-help"]
    : ["--no-show-help"]),
    ...(input.timeout ? ["--timeout", input.timeout] : []),
    ...(input.header ? ["--header", input.header] : []),
    ...(input.selected ?
      input.selected === "*" ?
        ["--selected", "*"]
      : ["--selected", input.selected.join(",")]
    : []),
    ...(input.inputDelimiter ? ["--input-delimiter", input.inputDelimiter] : []),
    ...(input.outputDelimiter ? ["--output-delimiter", input.outputDelimiter] : []),
    ...(input.labelDelimiter ? ["--label-delimiter", input.labelDelimiter] : []),
    ...(input.stripAnsi === undefined ? []
    : input.stripAnsi ? ["--strip-ansi"]
    : ["--no-strip-ansi"]),
    ...(input.noLimit ? ["--no-limit"] : []),
    ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
    ...(input.selectIfOne ? ["--select-if-one"] : [])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) {
    const out = stdout.trimEnd()
    const parts = delimiter === "\n" ? out.split("\n") : out.split(delimiter)
    return { ok: true, value: parts.filter(p => p.length > 0) }
  }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumFilterInputBase {
  readonly options: readonly string[]
  readonly header?: string
  readonly placeholder?: string
  readonly prompt?: string
  readonly value?: string
  readonly width?: number
  readonly height?: number
  readonly reverse?: boolean
  readonly fuzzy?: boolean
  readonly fuzzySort?: boolean
  readonly strict?: boolean
  readonly selectIfOne?: boolean
  readonly timeout?: string
  readonly showHelp?: boolean
  readonly selected?: readonly string[] | "*"
  readonly inputDelimiter?: string
  readonly outputDelimiter?: string
  readonly stripAnsi?: boolean
}

export async function gumFilterOne(input: GumFilterInputBase): Promise<GumOutcome<string>> {
  const res = await gumFilterMany({ ...input, limit: 1 })
  if (!res.ok) return res
  const first = res.value[0]
  if (!first) return { ok: false, reason: "failed", exitCode: 1 }
  return { ok: true, value: first }
}

export async function gumFilterMany(
  input: GumFilterInputBase & {
    readonly limit?: number
    readonly noLimit?: boolean
  }
): Promise<GumOutcome<readonly string[]>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const delimiter = input.outputDelimiter ?? "\n"
  const cmd = [
    gum,
    "filter",
    ...input.options,
    ...(input.selected ?
      input.selected === "*" ?
        ["--selected", "*"]
      : ["--selected", input.selected.join(",")]
    : []),
    ...(input.showHelp === undefined ? []
    : input.showHelp ? ["--show-help"]
    : ["--no-show-help"]),
    ...(input.header ? ["--header", input.header] : []),
    ...(input.placeholder ? ["--placeholder", input.placeholder] : []),
    ...(input.prompt ? ["--prompt", input.prompt] : []),
    ...(input.width === undefined ? [] : ["--width", String(input.width)]),
    ...(input.height === undefined ? [] : ["--height", String(input.height)]),
    ...(input.value ? ["--value", input.value] : []),
    ...(input.reverse ? ["--reverse"] : []),
    ...(input.fuzzy === undefined ? []
    : input.fuzzy ? ["--fuzzy"]
    : ["--no-fuzzy"]),
    ...(input.fuzzySort === undefined ? []
    : input.fuzzySort ? ["--fuzzy-sort"]
    : ["--no-fuzzy-sort"]),
    ...(input.timeout ? ["--timeout", input.timeout] : []),
    ...(input.inputDelimiter ? ["--input-delimiter", input.inputDelimiter] : []),
    ...(input.outputDelimiter ? ["--output-delimiter", input.outputDelimiter] : []),
    ...(input.stripAnsi === undefined ? []
    : input.stripAnsi ? ["--strip-ansi"]
    : ["--no-strip-ansi"]),
    ...(input.noLimit ? ["--no-limit"] : []),
    ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
    ...(input.selectIfOne ? ["--select-if-one"] : []),
    ...(input.strict === undefined ? []
    : input.strict ? ["--strict"]
    : ["--no-strict"])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) {
    const out = stdout.trimEnd()
    const parts = delimiter === "\n" ? out.split("\n") : out.split(delimiter)
    return { ok: true, value: parts.filter(p => p.length > 0) }
  }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumFileInput {
  readonly path?: string
  readonly all?: boolean
  readonly permissions?: boolean
  readonly size?: boolean
  readonly file?: boolean
  readonly directory?: boolean
  readonly cursor?: string
  readonly header?: string
  readonly height?: number
  readonly showHelp?: boolean
  readonly timeout?: string
}

export async function gumFile({
  path,
  all,
  permissions,
  size,
  file,
  directory,
  cursor,
  header,
  height,
  showHelp,
  timeout
}: GumFileInput): Promise<GumOutcome<string>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "file",
    ...(path ? [path] : []),
    ...(cursor ? ["--cursor", cursor] : []),
    ...(all ? ["--all"] : []),
    ...(permissions === undefined ? []
    : permissions ? ["--permissions"]
    : ["--no-permissions"]),
    ...(size === undefined ? []
    : size ? ["--size"]
    : ["--no-size"]),
    ...(file ? ["--file"] : []),
    ...(directory ? ["--directory"] : []),
    ...(showHelp === undefined ? []
    : showHelp ? ["--show-help"]
    : ["--no-show-help"]),
    ...(timeout ? ["--timeout", timeout] : []),
    ...(header ? ["--header", header] : []),
    ...(height === undefined ? [] : ["--height", String(height)])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) return { ok: true, value: stdout.trimEnd() }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumPagerInput {
  readonly content?: string
  readonly showLineNumbers?: boolean
  readonly softWrap?: boolean
  readonly timeout?: string
}

export async function gumPager({
  content,
  showLineNumbers,
  softWrap,
  timeout
}: GumPagerInput): Promise<GumOutcome<void>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "pager",
    ...(content ? [content] : []),
    ...(showLineNumbers ? ["--show-line-numbers"] : []),
    ...(softWrap === undefined ? []
    : softWrap ? ["--soft-wrap"]
    : ["--no-soft-wrap"]),
    ...(timeout ? ["--timeout", timeout] : [])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })

  const exitCode = await proc.exited
  if (exitCode === 0) return { ok: true, value: undefined }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumSpinInput {
  readonly cmd: readonly string[]
  readonly title?: string
  readonly spinner?: string
  readonly align?: "left" | "right" | "center"
  readonly timeout?: string
  readonly showOutput?: boolean
  readonly showError?: boolean
  readonly showStdout?: boolean
  readonly showStderr?: boolean
}

export async function gumSpin({
  cmd,
  title,
  spinner,
  align,
  timeout,
  showOutput,
  showError,
  showStdout,
  showStderr
}: GumSpinInput): Promise<GumOutcome<number>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const gumCmd = [
    gum,
    "spin",
    ...(showOutput ? ["--show-output"] : []),
    ...(showError ? ["--show-error"] : []),
    ...(showStdout ? ["--show-stdout"] : []),
    ...(showStderr ? ["--show-stderr"] : []),
    ...(spinner ? ["--spinner", spinner] : []),
    ...(title ? ["--title", title] : []),
    ...(align ? ["--align", align] : []),
    ...(timeout ? ["--timeout", timeout] : []),
    ...cmd
  ]

  const proc = Bun.spawn(gumCmd, {
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })

  const exitCode = await proc.exited
  if (exitCode === 0) return { ok: true, value: 0 }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: true, value: exitCode }
}

export interface GumStyleInput {
  readonly text: readonly string[]
  readonly trim?: boolean
  readonly stripAnsi?: boolean
  readonly foreground?: string
  readonly background?: string
  readonly border?: string
  readonly borderForeground?: string
  readonly borderBackground?: string
  readonly align?: "left" | "right" | "center"
  readonly height?: number
  readonly width?: number
  readonly margin?: string
  readonly padding?: string
  readonly bold?: boolean
  readonly faint?: boolean
  readonly italic?: boolean
  readonly strikethrough?: boolean
  readonly underline?: boolean
}

export async function gumStyle({
  text,
  trim,
  stripAnsi,
  foreground,
  background,
  border,
  borderForeground,
  borderBackground,
  align,
  height,
  width,
  margin,
  padding,
  bold,
  faint,
  italic,
  strikethrough,
  underline
}: GumStyleInput): Promise<GumOutcome<string>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "style",
    ...text,
    ...(trim ? ["--trim"] : []),
    ...(stripAnsi === undefined ? []
    : stripAnsi ? ["--strip-ansi"]
    : ["--no-strip-ansi"]),
    ...(foreground ? ["--foreground", foreground] : []),
    ...(background ? ["--background", background] : []),
    ...(border ? ["--border", border] : []),
    ...(borderBackground ? ["--border-background", borderBackground] : []),
    ...(borderForeground ? ["--border-foreground", borderForeground] : []),
    ...(align ? ["--align", align] : []),
    ...(height === undefined ? [] : ["--height", String(height)]),
    ...(width === undefined ? [] : ["--width", String(width)]),
    ...(margin ? ["--margin", margin] : []),
    ...(padding ? ["--padding", padding] : []),
    ...(bold ? ["--bold"] : []),
    ...(faint ? ["--faint"] : []),
    ...(italic ? ["--italic"] : []),
    ...(strikethrough ? ["--strikethrough"] : []),
    ...(underline ? ["--underline"] : [])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) return { ok: true, value: stdout }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumJoinInput {
  readonly text: readonly string[]
  readonly align?: "left" | "right" | "center"
  readonly horizontal?: boolean
  readonly vertical?: boolean
}

export async function gumJoin({
  text,
  align,
  horizontal,
  vertical
}: GumJoinInput): Promise<GumOutcome<string>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "join",
    ...text,
    ...(align ? ["--align", align] : []),
    ...(horizontal ? ["--horizontal"] : []),
    ...(vertical ? ["--vertical"] : [])
  ]

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) return { ok: true, value: stdout }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumFormatInput {
  readonly template?: readonly string[]
  readonly input?: string
  readonly type?: "markdown" | "template" | "code" | "emoji"
  readonly theme?: string
  readonly language?: string
  readonly stripAnsi?: boolean
}

export async function gumFormat({
  template,
  input,
  type,
  theme,
  language,
  stripAnsi
}: GumFormatInput): Promise<GumOutcome<string>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "format",
    ...(template ?? []),
    ...(theme ? ["--theme", theme] : []),
    ...(language ? ["--language", language] : []),
    ...(stripAnsi === undefined ? []
    : stripAnsi ? ["--strip-ansi"]
    : ["--no-strip-ansi"]),
    ...(type ? ["--type", type] : [])
  ]

  const stdin = input !== undefined ? streamFromText(input) : "inherit"
  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin,
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) return { ok: true, value: stdout }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumTableInput {
  readonly file?: string
  readonly input?: string
  readonly separator?: string
  readonly columns?: readonly string[]
  readonly widths?: readonly number[]
  readonly height?: number
  readonly print?: boolean
  readonly border?: string
  readonly showHelp?: boolean
  readonly hideCount?: boolean
  readonly lazyQuotes?: boolean
  readonly fieldsPerRecord?: number
  readonly returnColumn?: number
  readonly timeout?: string
}

export async function gumTable({
  file,
  input,
  separator,
  columns,
  widths,
  height,
  print,
  border,
  showHelp,
  hideCount,
  lazyQuotes,
  fieldsPerRecord,
  returnColumn,
  timeout
}: GumTableInput): Promise<GumOutcome<string>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const cmd = [
    gum,
    "table",
    ...(separator ? ["--separator", separator] : []),
    ...(columns ? ["--columns", columns.join(",")] : []),
    ...(widths ? ["--widths", widths.join(",")] : []),
    ...(height === undefined ? [] : ["--height", String(height)]),
    ...(print ? ["--print"] : []),
    ...(file ? ["--file", file] : []),
    ...(border ? ["--border", border] : []),
    ...(showHelp === undefined ? []
    : showHelp ? ["--show-help"]
    : ["--no-show-help"]),
    ...(hideCount === undefined ? []
    : hideCount ? ["--hide-count"]
    : ["--no-hide-count"]),
    ...(lazyQuotes ? ["--lazy-quotes"] : []),
    ...(fieldsPerRecord === undefined ? [] : ["--fields-per-record", String(fieldsPerRecord)]),
    ...(returnColumn === undefined ? [] : ["--return-column", String(returnColumn)]),
    ...(timeout ? ["--timeout", timeout] : [])
  ]

  const stdin = input !== undefined ? streamFromText(input) : "inherit"
  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin,
    stdout: "pipe",
    stderr: "inherit"
  })

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode === 0) return { ok: true, value: stdout.trimEnd() }
  if (exitCode === 130) return { ok: false, reason: "cancelled" }
  return { ok: false, reason: "failed", exitCode }
}

export interface GumVersionCheckInput {
  readonly constraint: string
}

export async function gumVersionCheck({
  constraint
}: GumVersionCheckInput): Promise<GumOutcome<boolean>> {
  const gum = getGumPath()
  if (!gum) return { ok: false, reason: "unavailable" }

  const proc = Bun.spawn([gum, "version-check", constraint], {
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit"
  })

  const exitCode = await proc.exited
  if (exitCode === 0) return { ok: true, value: true }
  if (exitCode === 1) return { ok: true, value: false }
  return { ok: false, reason: "failed", exitCode }
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text))
      controller.close()
    }
  })
}
