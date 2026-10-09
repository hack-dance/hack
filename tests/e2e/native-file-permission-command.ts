import { lstat, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";

const LIMIT = 256 * 1024;
function refuse(): never {
  throw new Error(
    "Owned file fixture command did not settle within its contract; values omitted."
  );
}
function capture(stream: ReadableStream<Uint8Array>, stop: () => void) {
  const reader = stream.getReader();
  const value = (async () => {
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        size += next.value.length;
        if (size > LIMIT) {
          refuse();
        }
        parts.push(next.value);
      }
      return Buffer.concat(parts);
    } catch {
      stop();
      refuse();
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    value,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        /* Settled readers have released their lock. */
      }
    },
  };
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
/**
 * Uses the compiler/config-only owner pattern: leader AND both pipes must settle
 * before group authority disarms. Private stdin is bounded and never captured.
 * Failure/cancellation kills once, cancels inherited pipes and reaps the leader;
 * publication errors after settlement never signal a former process group.
 */
export async function runNativeFileFixtureCommand(
  opts: NativeFileFixtureCommandOptions
): Promise<NativeFileFixtureCommandResult> {
  const captured = captureCommandInputs(opts);
  const deadline = Date.now() + captured.timeoutMs;
  const captureDirectory =
    captured.capturePrefix === undefined
      ? undefined
      : dirname(captured.capturePrefix);
  let captureIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  if (captureDirectory !== undefined) {
    if (
      !(captured.capturePrefix && isAbsolute(captured.capturePrefix)) ||
      resolve(captured.capturePrefix) !== captured.capturePrefix ||
      !/^[a-z0-9-]+$/.test(basename(captured.capturePrefix)) ||
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
  if (captured.signal?.aborted || Date.now() >= deadline) {
    refuse();
  }
  const child = Bun.spawn(captured.argv, {
    cwd: captured.cwd,
    env: captured.env,
    stdin: captured.stdin === undefined ? "ignore" : new Blob([captured.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let complete = false,
    stopped = false;
  let stdout: ReturnType<typeof capture> | undefined,
    stderr: ReturnType<typeof capture> | undefined;
  const stop = () => {
    if (!(complete || stopped)) {
      stopped = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error: unknown) {
        if (!(isRecord(error) && error.code === "ESRCH")) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Failure cannot pass; leader is still awaited. */
          }
        }
      }
    }
    void stdout?.cancel();
    void stderr?.cancel();
  };
  const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
  captured.signal?.addEventListener("abort", stop, { once: true });
  stdout = capture(child.stdout, stop);
  stderr = capture(child.stderr, stop);
  const pending = [child.exited, stdout.value, stderr.value] as const;
  try {
    const [exitCode, output, diagnostics] = await Promise.all(pending);
    complete = true;
    if (captured.capturePrefix !== undefined) {
      await checkCapture();
      await writeFile(`${captured.capturePrefix}.stdout`, output, {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(`${captured.capturePrefix}.stderr`, diagnostics, {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(
        `${captured.capturePrefix}.json`,
        JSON.stringify({
          exitCode,
          outputBytes: output.length,
          diagnosticBytes: diagnostics.length,
          settled: true,
          stopRequested: stopped,
          aborted: captured.signal?.aborted === true,
        }),
        { mode: 0o600, flag: "wx" }
      );
    }
    await checkCapture();
    if (stopped || captured.signal?.aborted || Date.now() >= deadline) {
      refuse();
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      exitCode,
      stdout: decoder.decode(output),
      stderr: decoder.decode(diagnostics),
    };
  } catch {
    stop();
    await Promise.allSettled(pending);
    return refuse();
  } finally {
    clearTimeout(timer);
    captured.signal?.removeEventListener("abort", stop);
  }
}
