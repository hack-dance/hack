import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { ensureDir } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { execOrThrow } from "../lib/shell.ts";
import { isColorDisabledByEnv } from "./terminal.ts";

/**
 * Environment for non-interactive gum renderers (log/style/format/table/join).
 *
 * When color is disabled (NO_COLOR / HACK_NO_COLOR) or stdout is not a TTY,
 * force-plain output by clearing force-color variables and setting NO_COLOR,
 * so piped output never carries ANSI escapes.
 */
export function buildGumRenderEnv(): Record<string, string> {
  const forcePlain = isColorDisabledByEnv() || process.stdout.isTTY !== true;
  const skipKeys = new Set(forcePlain ? ["CLICOLOR_FORCE", "FORCE_COLOR"] : []);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !skipKeys.has(key)) {
      env[key] = value;
    }
  }

  if (forcePlain) {
    env.NO_COLOR = "1";
  }
  return env;
}

export type GumLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type GumFieldValue = string | number | boolean;
export type GumFields = Readonly<Record<string, GumFieldValue>>;

export type GumOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "unavailable" }
  | { readonly ok: false; readonly reason: "cancelled" }
  | {
      readonly ok: false;
      readonly reason: "failed";
      readonly exitCode: number;
    };

export interface GumLogInput {
  readonly level: GumLogLevel;
  readonly message: string;
  readonly fields?: GumFields;
}

let gumPathCached: string | null | undefined;

export function getGumPath(): string | null {
  if (gumPathCached !== undefined) {
    return gumPathCached;
  }
  const overrideRaw = (process.env.HACK_GUM_PATH ?? "").trim();
  if (overrideRaw.length > 0) {
    gumPathCached = overrideRaw;
    return gumPathCached;
  }

  const bundled = getBundledGumInstallPath();
  if (bundled && existsSync(bundled)) {
    gumPathCached = bundled;
    return gumPathCached;
  }

  gumPathCached = Bun.which("gum");
  return gumPathCached;
}

export function resetGumPathCacheForTests(): void {
  gumPathCached = undefined;
}

export function isGumAvailable(): boolean {
  return getGumPath() !== null;
}

export type BundledGumInstallOutcome =
  | { readonly ok: true; readonly installed: boolean; readonly gumPath: string }
  | {
      readonly ok: false;
      readonly reason:
        | "home-not-set"
        | "unsupported-platform"
        | "bundle-not-found"
        | "tar-not-found"
        | "failed";
      readonly message?: string;
    };

export async function ensureBundledGumInstalled(): Promise<BundledGumInstallOutcome> {
  const installPath = getBundledGumInstallPath();
  if (!installPath) {
    return { ok: false, reason: "home-not-set" };
  }

  if (existsSync(installPath)) {
    gumPathCached = installPath;
    return { ok: true, installed: false, gumPath: installPath };
  }

  if (process.platform !== "darwin") {
    return { ok: false, reason: "unsupported-platform" };
  }

  const bundle = resolveBundledGumArtifact();
  if (!bundle) {
    return { ok: false, reason: "bundle-not-found" };
  }

  const tar = Bun.which("tar");
  if (!tar) {
    return { ok: false, reason: "tar-not-found" };
  }

  try {
    await ensureDir(dirname(installPath));
    await execOrThrow(
      [
        tar,
        "-xzf",
        bundle.tarballPath,
        "-C",
        dirname(installPath),
        "--strip-components=1",
        `${bundle.topDir}/gum`,
      ],
      { stdin: "ignore" }
    );
    await execOrThrow(["chmod", "+x", installPath], { stdin: "ignore" });
    gumPathCached = installPath;
    return { ok: true, installed: true, gumPath: installPath };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, reason: "failed", message };
  }
}

/**
 * One gum process invocation. stderr is always inherited so gum's own
 * diagnostics reach the user; `stdin.text` is written to gum and closed.
 */
export interface GumRunRequest {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: "inherit" | "ignore" | { readonly text: string };
  readonly stdout: "inherit" | "pipe" | "ignore";
}

export interface GumRunResult {
  readonly exitCode: number;
  /** Captured stdout when the request used `stdout: "pipe"`, otherwise "". */
  readonly stdout: string;
}

/** Process boundary for every gum invocation in this module. */
export interface GumRunner {
  /** Synchronous run, used by the logger so log lines keep their order. */
  runSync(request: GumRunRequest): number;
  run(request: GumRunRequest): Promise<GumRunResult>;
}

const bunGumRunner: GumRunner = {
  runSync({ cmd, env, stdin, stdout }) {
    const res = Bun.spawnSync({
      cmd: [...cmd],
      env: { ...env },
      stdin:
        typeof stdin === "string"
          ? stdin
          : new TextEncoder().encode(stdin.text),
      stdout,
      stderr: "inherit",
    });
    return res.exitCode;
  },
  async run({ cmd, env, stdin, stdout }) {
    const proc = Bun.spawn([...cmd], {
      env: { ...env },
      stdin: typeof stdin === "string" ? stdin : streamFromText(stdin.text),
      stdout,
      stderr: "inherit",
    });
    const piped = proc.stdout;
    const [text, exitCode] = await Promise.all([
      piped instanceof ReadableStream
        ? new Response(piped).text()
        : Promise.resolve(""),
      proc.exited,
    ]);
    return { exitCode, stdout: text };
  },
};

let gumRunner: GumRunner = bunGumRunner;

/**
 * Test seam: route gum invocations through `runner` instead of spawning.
 * Pass `null` to restore the real Bun process runner.
 */
export function setGumRunnerForTests({
  runner,
}: {
  readonly runner: GumRunner | null;
}): void {
  gumRunner = runner ?? bunGumRunner;
}

export function tryGumLog({ level, message, fields }: GumLogInput): boolean {
  const gum = getGumPath();
  if (!gum) {
    return false;
  }

  const kv: string[] = [];
  if (fields && isRecord(fields)) {
    for (const key of Object.keys(fields).sort()) {
      const value = fields[key];
      if (value === undefined) {
        continue;
      }
      kv.push(key, String(value));
    }
  }

  const cmd = [
    gum,
    "log",
    ...valueFlag({ flag: "level", value: level }),
    ...(kv.length > 0 ? ["--structured"] : []),
    ...positionals([message, ...kv]),
  ];

  const exitCode = gumRunner.runSync({
    cmd,
    env: buildGumRenderEnv(),
    stdin: "ignore",
    stdout: "inherit",
  });

  return exitCode === 0;
}

function getBundledGumInstallPath(): string {
  return resolve(resolveGlobalHackDir(), "bin", "gum");
}

type BundledGumArtifact = {
  readonly tarballPath: string;
  readonly topDir: string;
};

function resolveBundledGumArtifact(): BundledGumArtifact | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const arch = process.arch;
  const isArm = arch === "arm64";
  const filename = isArm
    ? "gum_0.17.0_Darwin_arm64.tar.gz"
    : "gum_0.17.0_Darwin_x86_64.tar.gz";
  const topDir = isArm ? "gum_0.17.0_Darwin_arm64" : "gum_0.17.0_Darwin_x86_64";

  for (const p of bundledGumTarballCandidates(filename)) {
    if (existsSync(p)) {
      return { tarballPath: p, topDir };
    }
  }

  return null;
}

function bundledGumTarballCandidates(filename: string): readonly string[] {
  const out: string[] = [];

  const envDir = (process.env.HACK_ASSETS_DIR ?? "").trim();
  if (envDir.length > 0) {
    out.push(resolve(envDir, filename));
    out.push(resolve(envDir, "binaries", "gum", filename));
  }

  const defaultAssets = resolve(resolveGlobalHackDir(), "assets");
  out.push(resolve(defaultAssets, filename));
  out.push(resolve(defaultAssets, "binaries", "gum", filename));

  // Dev/source layout: <repo>/src/ui/gum.ts → <repo>/binaries/gum/<tarball>
  out.push(resolve(import.meta.dir, "../../binaries/gum", filename));

  const argv1 = process.argv[1];
  if (typeof argv1 === "string" && argv1.length > 0) {
    out.push(resolve(dirname(argv1), "binaries", "gum", filename));
    out.push(resolve(dirname(argv1), "..", "binaries", "gum", filename));
  }

  const execPath = process.execPath;
  if (typeof execPath === "string" && execPath.length > 0) {
    out.push(resolve(dirname(execPath), "binaries", "gum", filename));
    out.push(resolve(dirname(execPath), "..", "binaries", "gum", filename));
  }

  return out;
}

export interface GumConfirmInput {
  readonly prompt?: string;
  readonly default?: boolean;
  readonly showOutput?: boolean;
  readonly affirmative?: string;
  readonly negative?: string;
  readonly showHelp?: boolean;
  readonly timeout?: string;
}

export async function gumConfirm({
  prompt,
  default: defaultChoice,
  showOutput,
  affirmative,
  negative,
  showHelp,
  timeout,
}: GumConfirmInput): Promise<GumOutcome<boolean>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "confirm",
    ...(defaultChoice ? ["--default"] : []),
    ...(showOutput ? ["--show-output"] : []),
    ...valueFlag({ flag: "affirmative", value: affirmative }),
    ...valueFlag({ flag: "negative", value: negative }),
    ...booleanFlag({ value: showHelp, flag: "show-help" }),
    ...valueFlag({ flag: "timeout", value: timeout }),
    ...positionals(prompt ? [prompt] : []),
  ];

  const { exitCode } = await gumRunner.run({
    cmd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
  });
  if (exitCode === 0) {
    return { ok: true, value: true };
  }
  if (exitCode === 1) {
    return { ok: true, value: false };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumInputInput {
  readonly placeholder?: string;
  readonly prompt?: string;
  readonly header?: string;
  readonly value?: string;
  readonly width?: number;
  readonly charLimit?: number;
  readonly password?: boolean;
  readonly showHelp?: boolean;
  readonly timeout?: string;
  readonly stripAnsi?: boolean;
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
  stripAnsi,
}: GumInputInput): Promise<GumOutcome<string>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "input",
    ...valueFlag({ flag: "placeholder", value: placeholder }),
    ...valueFlag({ flag: "prompt", value: prompt }),
    ...valueFlag({ flag: "header", value: header }),
    ...valueFlag({ flag: "value", value }),
    ...valueFlag({ flag: "width", value: width }),
    ...valueFlag({ flag: "char-limit", value: charLimit }),
    ...(password ? ["--password"] : []),
    ...booleanFlag({ value: showHelp, flag: "show-help" }),
    ...valueFlag({ flag: "timeout", value: timeout }),
    ...booleanFlag({ value: stripAnsi, flag: "strip-ansi" }),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
  });
  if (exitCode === 0) {
    return { ok: true, value: stdout.trimEnd() };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumWriteInput {
  readonly placeholder?: string;
  readonly prompt?: string;
  readonly header?: string;
  readonly value?: string;
  readonly width?: number;
  readonly height?: number;
  readonly charLimit?: number;
  readonly maxLines?: number;
  readonly showCursorLine?: boolean;
  readonly showLineNumbers?: boolean;
  readonly showHelp?: boolean;
  readonly timeout?: string;
  readonly stripAnsi?: boolean;
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
  stripAnsi,
}: GumWriteInput): Promise<GumOutcome<string>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "write",
    ...valueFlag({ flag: "width", value: width }),
    ...valueFlag({ flag: "height", value: height }),
    ...valueFlag({ flag: "header", value: header }),
    ...valueFlag({ flag: "placeholder", value: placeholder }),
    ...valueFlag({ flag: "prompt", value: prompt }),
    ...(showCursorLine ? ["--show-cursor-line"] : []),
    ...(showLineNumbers ? ["--show-line-numbers"] : []),
    ...valueFlag({ flag: "value", value }),
    ...valueFlag({ flag: "char-limit", value: charLimit }),
    ...valueFlag({ flag: "max-lines", value: maxLines }),
    ...booleanFlag({ value: showHelp, flag: "show-help" }),
    ...valueFlag({ flag: "timeout", value: timeout }),
    ...booleanFlag({ value: stripAnsi, flag: "strip-ansi" }),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
  });
  if (exitCode === 0) {
    return { ok: true, value: stdout.trimEnd() };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumChooseInputBase {
  readonly options: readonly string[];
  readonly header?: string;
  readonly height?: number;
  readonly cursor?: string;
  readonly ordered?: boolean;
  readonly selectIfOne?: boolean;
  readonly timeout?: string;
  readonly showHelp?: boolean;
  readonly selected?: readonly string[] | "*";
  readonly inputDelimiter?: string;
  readonly outputDelimiter?: string;
  readonly labelDelimiter?: string;
  readonly stripAnsi?: boolean;
}

export async function gumChooseOne(
  input: GumChooseInputBase
): Promise<GumOutcome<string>> {
  const res = await gumChooseMany({ ...input, limit: 1 });
  if (!res.ok) {
    return res;
  }
  const first = res.value[0];
  if (!first) {
    return { ok: false, reason: "failed", exitCode: 1 };
  }
  return { ok: true, value: first };
}

export async function gumChooseMany(
  input: GumChooseInputBase & {
    readonly limit?: number;
    readonly noLimit?: boolean;
  }
): Promise<GumOutcome<readonly string[]>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const delimiter = input.outputDelimiter ?? "\n";
  const cmd = [
    gum,
    "choose",
    ...(input.ordered ? ["--ordered"] : []),
    ...valueFlag({ flag: "height", value: input.height }),
    ...valueFlag({ flag: "cursor", value: input.cursor }),
    ...booleanFlag({ value: input.showHelp, flag: "show-help" }),
    ...valueFlag({ flag: "timeout", value: input.timeout }),
    ...valueFlag({ flag: "header", value: input.header }),
    ...buildSelectedArg(input.selected),
    ...valueFlag({ flag: "input-delimiter", value: input.inputDelimiter }),
    ...valueFlag({ flag: "output-delimiter", value: input.outputDelimiter }),
    ...valueFlag({ flag: "label-delimiter", value: input.labelDelimiter }),
    ...booleanFlag({ value: input.stripAnsi, flag: "strip-ansi" }),
    ...(input.noLimit ? ["--no-limit"] : []),
    ...valueFlag({ flag: "limit", value: input.limit }),
    ...(input.selectIfOne ? ["--select-if-one"] : []),
    ...positionals(input.options),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
  });
  if (exitCode === 0) {
    const out = stdout.trimEnd();
    const parts = delimiter === "\n" ? out.split("\n") : out.split(delimiter);
    return { ok: true, value: parts.filter((p) => p.length > 0) };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumFilterInputBase {
  readonly options: readonly string[];
  readonly header?: string;
  readonly placeholder?: string;
  readonly prompt?: string;
  readonly value?: string;
  readonly width?: number;
  readonly height?: number;
  readonly reverse?: boolean;
  readonly fuzzy?: boolean;
  readonly fuzzySort?: boolean;
  readonly strict?: boolean;
  readonly selectIfOne?: boolean;
  readonly timeout?: string;
  readonly showHelp?: boolean;
  readonly selected?: readonly string[] | "*";
  readonly inputDelimiter?: string;
  readonly outputDelimiter?: string;
  readonly stripAnsi?: boolean;
}

export async function gumFilterOne(
  input: GumFilterInputBase
): Promise<GumOutcome<string>> {
  const res = await gumFilterMany({ ...input, limit: 1 });
  if (!res.ok) {
    return res;
  }
  const first = res.value[0];
  if (!first) {
    return { ok: false, reason: "failed", exitCode: 1 };
  }
  return { ok: true, value: first };
}

export async function gumFilterMany(
  input: GumFilterInputBase & {
    readonly limit?: number;
    readonly noLimit?: boolean;
  }
): Promise<GumOutcome<readonly string[]>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const delimiter = input.outputDelimiter ?? "\n";
  const cmd = [
    gum,
    "filter",
    ...buildSelectedArg(input.selected),
    ...booleanFlag({ value: input.showHelp, flag: "show-help" }),
    ...valueFlag({ flag: "header", value: input.header }),
    ...valueFlag({ flag: "placeholder", value: input.placeholder }),
    ...valueFlag({ flag: "prompt", value: input.prompt }),
    ...valueFlag({ flag: "width", value: input.width }),
    ...valueFlag({ flag: "height", value: input.height }),
    ...valueFlag({ flag: "value", value: input.value }),
    ...(input.reverse ? ["--reverse"] : []),
    ...booleanFlag({ value: input.fuzzy, flag: "fuzzy" }),
    ...booleanFlag({ value: input.fuzzySort, flag: "fuzzy-sort" }),
    ...valueFlag({ flag: "timeout", value: input.timeout }),
    ...valueFlag({ flag: "input-delimiter", value: input.inputDelimiter }),
    ...valueFlag({ flag: "output-delimiter", value: input.outputDelimiter }),
    ...booleanFlag({ value: input.stripAnsi, flag: "strip-ansi" }),
    ...(input.noLimit ? ["--no-limit"] : []),
    ...valueFlag({ flag: "limit", value: input.limit }),
    ...(input.selectIfOne ? ["--select-if-one"] : []),
    ...booleanFlag({ value: input.strict, flag: "strict" }),
    ...positionals(input.options),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
  });
  if (exitCode === 0) {
    const out = stdout.trimEnd();
    const parts = delimiter === "\n" ? out.split("\n") : out.split(delimiter);
    return { ok: true, value: parts.filter((p) => p.length > 0) };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumFileInput {
  readonly path?: string;
  readonly all?: boolean;
  readonly permissions?: boolean;
  readonly size?: boolean;
  readonly file?: boolean;
  readonly directory?: boolean;
  readonly cursor?: string;
  readonly header?: string;
  readonly height?: number;
  readonly showHelp?: boolean;
  readonly timeout?: string;
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
  timeout,
}: GumFileInput): Promise<GumOutcome<string>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "file",
    ...valueFlag({ flag: "cursor", value: cursor }),
    ...(all ? ["--all"] : []),
    ...booleanFlag({ value: permissions, flag: "permissions" }),
    ...booleanFlag({ value: size, flag: "size" }),
    ...(file ? ["--file"] : []),
    ...(directory ? ["--directory"] : []),
    ...booleanFlag({ value: showHelp, flag: "show-help" }),
    ...valueFlag({ flag: "timeout", value: timeout }),
    ...valueFlag({ flag: "header", value: header }),
    ...valueFlag({ flag: "height", value: height }),
    ...positionals(path ? [path] : []),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
  });
  if (exitCode === 0) {
    return { ok: true, value: stdout.trimEnd() };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumPagerInput {
  readonly content?: string;
  readonly showLineNumbers?: boolean;
  readonly softWrap?: boolean;
  readonly timeout?: string;
}

export async function gumPager({
  content,
  showLineNumbers,
  softWrap,
  timeout,
}: GumPagerInput): Promise<GumOutcome<void>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "pager",
    ...(showLineNumbers ? ["--show-line-numbers"] : []),
    ...booleanFlag({ value: softWrap, flag: "soft-wrap" }),
    ...valueFlag({ flag: "timeout", value: timeout }),
    ...positionals(content ? [content] : []),
  ];

  const { exitCode } = await gumRunner.run({
    cmd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
  });
  if (exitCode === 0) {
    return { ok: true, value: undefined };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumSpinInput {
  readonly cmd: readonly string[];
  readonly title?: string;
  readonly spinner?: string;
  readonly align?: "left" | "right" | "center";
  readonly timeout?: string;
  readonly showOutput?: boolean;
  readonly showError?: boolean;
  readonly showStdout?: boolean;
  readonly showStderr?: boolean;
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
  showStderr,
}: GumSpinInput): Promise<GumOutcome<number>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const gumCmd = [
    gum,
    "spin",
    ...(showOutput ? ["--show-output"] : []),
    ...(showError ? ["--show-error"] : []),
    ...(showStdout ? ["--show-stdout"] : []),
    ...(showStderr ? ["--show-stderr"] : []),
    ...valueFlag({ flag: "spinner", value: spinner }),
    ...valueFlag({ flag: "title", value: title }),
    ...valueFlag({ flag: "align", value: align }),
    ...valueFlag({ flag: "timeout", value: timeout }),
    // gum consumes this marker; the wrapped command keeps its own flags.
    ...positionals(cmd),
  ];

  const { exitCode } = await gumRunner.run({
    cmd: gumCmd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
  });
  if (exitCode === 0) {
    return { ok: true, value: 0 };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: true, value: exitCode };
}

export interface GumStyleInput {
  readonly text: readonly string[];
  readonly trim?: boolean;
  readonly stripAnsi?: boolean;
  readonly foreground?: string;
  readonly background?: string;
  readonly border?: string;
  readonly borderForeground?: string;
  readonly borderBackground?: string;
  readonly align?: "left" | "right" | "center";
  readonly height?: number;
  readonly width?: number;
  readonly margin?: string;
  readonly padding?: string;
  readonly bold?: boolean;
  readonly faint?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly underline?: boolean;
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
  underline,
}: GumStyleInput): Promise<GumOutcome<string>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "style",
    ...(trim ? ["--trim"] : []),
    ...booleanFlag({ value: stripAnsi, flag: "strip-ansi" }),
    ...valueFlag({ flag: "foreground", value: foreground }),
    ...valueFlag({ flag: "background", value: background }),
    ...valueFlag({ flag: "border", value: border }),
    ...valueFlag({ flag: "border-background", value: borderBackground }),
    ...valueFlag({ flag: "border-foreground", value: borderForeground }),
    ...valueFlag({ flag: "align", value: align }),
    ...valueFlag({ flag: "height", value: height }),
    ...valueFlag({ flag: "width", value: width }),
    ...valueFlag({ flag: "margin", value: margin }),
    ...valueFlag({ flag: "padding", value: padding }),
    ...(bold ? ["--bold"] : []),
    ...(faint ? ["--faint"] : []),
    ...(italic ? ["--italic"] : []),
    ...(strikethrough ? ["--strikethrough"] : []),
    ...(underline ? ["--underline"] : []),
    ...positionals(text),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: buildGumRenderEnv(),
    stdin: "ignore",
    stdout: "pipe",
  });
  if (exitCode === 0) {
    return { ok: true, value: stdout };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumJoinInput {
  readonly text: readonly string[];
  readonly align?: "left" | "right" | "center";
  readonly horizontal?: boolean;
  readonly vertical?: boolean;
}

export async function gumJoin({
  text,
  align,
  horizontal,
  vertical,
}: GumJoinInput): Promise<GumOutcome<string>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "join",
    ...valueFlag({ flag: "align", value: align }),
    ...(horizontal ? ["--horizontal"] : []),
    ...(vertical ? ["--vertical"] : []),
    ...positionals(text),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: buildGumRenderEnv(),
    stdin: "ignore",
    stdout: "pipe",
  });
  if (exitCode === 0) {
    return { ok: true, value: stdout };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumFormatInput {
  readonly template?: readonly string[];
  readonly input?: string;
  readonly type?: "markdown" | "template" | "code" | "emoji";
  readonly theme?: string;
  readonly language?: string;
  readonly stripAnsi?: boolean;
}

export async function gumFormat({
  template,
  input,
  type,
  theme,
  language,
  stripAnsi,
}: GumFormatInput): Promise<GumOutcome<string>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "format",
    ...valueFlag({ flag: "theme", value: theme }),
    ...valueFlag({ flag: "language", value: language }),
    ...booleanFlag({ value: stripAnsi, flag: "strip-ansi" }),
    ...valueFlag({ flag: "type", value: type }),
    ...positionals(template ?? []),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: buildGumRenderEnv(),
    stdin: input === undefined ? "inherit" : { text: input },
    stdout: "pipe",
  });
  if (exitCode === 0) {
    return { ok: true, value: stdout };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumTableInput {
  readonly file?: string;
  readonly input?: string;
  readonly separator?: string;
  readonly columns?: readonly string[];
  readonly widths?: readonly number[];
  readonly height?: number;
  readonly print?: boolean;
  readonly border?: string;
  readonly showHelp?: boolean;
  readonly hideCount?: boolean;
  readonly lazyQuotes?: boolean;
  readonly fieldsPerRecord?: number;
  readonly returnColumn?: number;
  readonly timeout?: string;
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
  timeout,
}: GumTableInput): Promise<GumOutcome<string>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    gum,
    "table",
    ...valueFlag({ flag: "separator", value: separator }),
    ...valueFlag({ flag: "columns", value: columns?.join(",") }),
    ...valueFlag({ flag: "widths", value: widths?.join(",") }),
    ...valueFlag({ flag: "height", value: height }),
    ...(print ? ["--print"] : []),
    ...valueFlag({ flag: "file", value: file }),
    ...valueFlag({ flag: "border", value: border }),
    ...booleanFlag({ value: showHelp, flag: "show-help" }),
    ...booleanFlag({ value: hideCount, flag: "hide-count" }),
    ...(lazyQuotes ? ["--lazy-quotes"] : []),
    ...valueFlag({ flag: "fields-per-record", value: fieldsPerRecord }),
    ...valueFlag({ flag: "return-column", value: returnColumn }),
    ...valueFlag({ flag: "timeout", value: timeout }),
  ];

  const { exitCode, stdout } = await gumRunner.run({
    cmd,
    env: buildGumRenderEnv(),
    stdin: input === undefined ? "inherit" : { text: input },
    stdout: "pipe",
  });
  if (exitCode === 0) {
    return { ok: true, value: stdout.trimEnd() };
  }
  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed", exitCode };
}

export interface GumVersionCheckInput {
  readonly constraint: string;
}

export async function gumVersionCheck({
  constraint,
}: GumVersionCheckInput): Promise<GumOutcome<boolean>> {
  const gum = getGumPath();
  if (!gum) {
    return { ok: false, reason: "unavailable" };
  }

  const { exitCode } = await gumRunner.run({
    cmd: [gum, "version-check", ...positionals([constraint])],
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
  });
  if (exitCode === 0) {
    return { ok: true, value: true };
  }
  if (exitCode === 1) {
    return { ok: true, value: false };
  }
  return { ok: false, reason: "failed", exitCode };
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

/**
 * Builds command line arguments for a boolean flag that supports three states:
 * - undefined: no flag (returns empty array)
 * - true: positive flag (returns ["--{flag}"])
 * - false: negative flag (returns ["--no-{flag}"])
 *
 * @param value - The boolean value or undefined
 * @param flag - The flag name (without dashes)
 * @returns Array of command line arguments
 */
function booleanFlag({
  value,
  flag,
}: {
  readonly value: boolean | undefined;
  readonly flag: string;
}): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (value) {
    return [`--${flag}`];
  }
  return [`--no-${flag}`];
}

/**
 * Builds command line arguments for the --selected flag used by gum choose/filter.
 * Handles "*" for all items, an array of specific items, or undefined for none.
 *
 * @param selected - "*" for all, array of strings, or undefined
 * @returns Array of command line arguments
 */
function buildSelectedArg(
  selected: readonly string[] | "*" | undefined
): readonly string[] {
  if (!selected) {
    return [];
  }
  if (selected === "*") {
    return ["--selected=*"];
  }
  return valueFlag({ flag: "selected", value: selected.join(",") });
}

/**
 * gum (kong) ends option parsing at this token; every later argument is a
 * positional, even when it begins with "-" or "--".
 */
export const GUM_END_OF_OPTIONS = "--";

/**
 * Builds a valued flag in single-token `--flag=value` form.
 *
 * Invariant: free text must never be parsed as a gum option. In the
 * two-token form kong rejects a value that begins with "-" (it reads it as a
 * flag); the joined form always binds the value to the flag. Empty strings and
 * `undefined` omit the flag, matching the previous truthiness checks.
 */
function valueFlag({
  flag,
  value,
}: {
  readonly flag: string;
  readonly value: string | number | undefined;
}): readonly string[] {
  if (value === undefined || value === "") {
    return [];
  }
  return [`--${flag}=${String(value)}`];
}

/**
 * Places positional text after the end-of-options marker. Callers must spread
 * this last, after every flag, so text such as "--value-stdin requires ..."
 * is printed instead of being parsed as an unknown flag.
 */
function positionals(args: readonly string[]): readonly string[] {
  if (args.length === 0) {
    return [];
  }
  return [GUM_END_OF_OPTIONS, ...args];
}
