import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { captureCompletedJobFixtureCommand } from "./scenarios/native-compose-adoption-job-worktrees.ts";

const LIMIT = 256 * 1024;
function refuse(): never {
  throw new Error(
    "Owned file fixture command did not settle within its contract; values omitted."
  );
}
export type NativeFileFixtureCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
type NativeFileFixtureCommandOptions = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
  readonly capturePrefix?: string;
  readonly onUnconfirmed?: () => void;
};
function captureCommandInputs(opts: NativeFileFixtureCommandOptions) {
  // Freeze selection before the first await. In particular, the validated
  // capture parent must never authorize a later caller-supplied output path.
  const privateInput = opts.stdin;
  const captured = {
    argv: [...opts.argv],
    cwd: opts.cwd,
    env: { ...opts.env },
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    stdin: privateInput === undefined ? undefined : Buffer.from(privateInput),
    capturePrefix: opts.capturePrefix,
    onUnconfirmed: opts.onUnconfirmed,
  };
  const binary = captured.argv[0];
  if (
    !(
      binary &&
      isAbsolute(binary) &&
      isAbsolute(captured.cwd) &&
      Number.isSafeInteger(captured.timeoutMs) &&
      captured.timeoutMs > 0 &&
      captured.timeoutMs <= 90_000 &&
      !captured.signal?.aborted &&
      (captured.stdin === undefined || captured.stdin.byteLength <= 8192)
    )
  ) {
    refuse();
  }
  return captured;
}
/** Reuses the maintained finite exit/EOF/group-absence owner; unknown settlement retains the fixture. */
export async function runNativeFileFixtureCommand(
  opts: NativeFileFixtureCommandOptions
): Promise<NativeFileFixtureCommandResult> {
  const captured = captureCommandInputs(opts);
  const deadline = Date.now() + captured.timeoutMs;
  const temporary =
    captured.capturePrefix === undefined
      ? await realpath(
          await mkdtemp(resolve(tmpdir(), "protected-file-command-"))
        )
      : undefined;
  const prefix = captured.capturePrefix ?? resolve(temporary!, "capture");
  const captureDirectory = dirname(prefix);
  let captureIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  if (captureDirectory !== undefined) {
    if (
      !isAbsolute(prefix) ||
      resolve(prefix) !== prefix ||
      !/^[a-z0-9-]+$/.test(basename(prefix)) ||
      (await realpath(captureDirectory)) !== captureDirectory
    ) {
      refuse();
    }
    captureIdentity = await lstat(captureDirectory);
    if (
      !captureIdentity.isDirectory() ||
      captureIdentity.isSymbolicLink() ||
      captureIdentity.uid !== process.getuid?.() ||
      (captureIdentity.mode & 0o777) !== 0o700
    ) {
      refuse();
    }
  }
  const checkCapture = async () => {
    if (captureDirectory === undefined || captureIdentity === undefined) {
      return;
    }
    const current = await lstat(captureDirectory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== captureIdentity.dev ||
      current.ino !== captureIdentity.ino ||
      current.uid !== captureIdentity.uid ||
      current.mode !== captureIdentity.mode ||
      (await realpath(captureDirectory)) !== captureDirectory
    ) {
      refuse();
    }
  };
  let unconfirmed = false;
  const onUnconfirmed = () => {
    unconfirmed = true;
    captured.onUnconfirmed?.();
  };
  try {
    await checkCapture();
    const remaining = deadline - Date.now();
    if (captured.signal?.aborted || remaining <= 0) {
      refuse();
    }
    const result = await captureCompletedJobFixtureCommand({
      argv: captured.argv,
      cwd: captured.cwd,
      env: captured.env,
      stdin: captured.stdin,
      signal: captured.signal,
      captures: prefix,
      timeoutMs: remaining,
      maxStreamBytes: LIMIT,
      onUnconfirmed,
    });
    await checkCapture();
    if (captured.signal?.aborted || Date.now() >= deadline) {
      refuse();
    }
    const output = await readFile(`${prefix}.stdout`);
    const diagnostics = await readFile(`${prefix}.stderr`);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const stdout = decoder.decode(output),
      stderr = decoder.decode(diagnostics);
    await writeFile(
      `${prefix}.json`,
      JSON.stringify({
        exitCode: result.exitCode,
        outputBytes: output.byteLength,
        diagnosticBytes: diagnostics.byteLength,
        settled: true,
        stopRequested: false,
        aborted: false,
      }),
      { mode: 0o600, flag: "wx" }
    );
    await checkCapture();
    if (captured.signal?.aborted || Date.now() >= deadline) {
      refuse();
    }
    return { exitCode: result.exitCode, stdout, stderr };
  } catch {
    return refuse();
  } finally {
    if (temporary !== undefined && !unconfirmed) {
      await checkCapture();
      await rm(temporary, { recursive: true });
    }
  }
}
