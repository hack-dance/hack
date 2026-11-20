import { childEnvironment } from "../lib/child-environment.ts";
import { isRecord } from "../lib/guards.ts";

/**
 * Hack's own file watcher for one running native project (HACK-2409). With
 * `HACK_NATIVE_HOT_RELOAD=watcher` the pool runs without the provider's
 * change notifications, and the project's owner process keeps one child,
 * `hack-native runtime source-notify`, that forwards host file changes under
 * the project's shared folder to the guest.
 *
 * The child lives exactly as long as the run: it is started once the graph is
 * ready, stops when its input closes (so it cannot outlive this process), and
 * is restarted if it dies while the project runs. While it is down the
 * project has no hot reload; that is said once, and said again when it is
 * back. `runtime status` reports the same from the runtime's side.
 */

const SYSTEM_ENVIRONMENT = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"];
const RESTART_DELAYS_MS = [1000, 2000, 5000, 15_000, 30_000];
const STOP_GRACE_MS = 2000;
const OUTPUT_LIMIT = 64 * 1024;
const FORWARDING = "source-notify: forwarding";
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Runtime refusals a restart cannot cure. */
const PERMANENT = new Set([
  "source_notify",
  "source_notify_unavailable",
  "unsupported_host",
  "invalid_arguments",
]);

const WITHOUT =
  "Edits made on the Mac reach services after up to about 5 seconds and file watchers inside them do not fire";

export const NATIVE_SOURCE_NOTIFY_STOPPED = `Hot reload on shared source stopped for this project: its file watcher exited and is being restarted. ${WITHOUT} until it is back.`;
export const NATIVE_SOURCE_NOTIFY_BACK =
  "Hot reload on shared source is back for this project.";
export const NATIVE_SOURCE_NOTIFY_UNAVAILABLE = `Hot reload on shared source is not available for this project: the virtual machine did not accept file-change events. ${WITHOUT}.`;

/** Whether the pool runs in the mode where Hack's own watcher forwards changes. */
export function nativeHotReloadUsesWatcher(pool: unknown): boolean {
  return (
    isRecord(pool) &&
    isRecord(pool.hot_reload) &&
    pool.hot_reload.state === "watcher"
  );
}

type Child = {
  readonly stdin: { end(): unknown } | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
};

/** Bounded text of a stream; the rest is read and dropped so the child never blocks. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  onText?: (text: string) => void
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    if (text.length < OUTPUT_LIMIT) {
      text += decoder.decode(value, { stream: true });
      onText?.(text);
    }
  }
}

/** The validated code of the runtime's refusal, from its last stderr line. */
function refusalCode(stderr: string): string | undefined {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) &&
      typeof parsed.code === "string" &&
      CODE.test(parsed.code)
      ? parsed.code
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts the watcher child when the pool runs in watcher mode; returns its
 * stop function, or undefined when there is nothing to run.
 */
export function startNativeSourceNotify(opts: {
  readonly runtime: { readonly binary: string; readonly home: string };
  readonly projectRoot: string;
  /** The `runtime up` result of this start. */
  readonly pool: unknown;
  readonly warn: (line: string) => void;
  /** Test seam: restart delays. */
  readonly restartDelaysMs?: readonly number[];
}): (() => Promise<void>) | undefined {
  if (!nativeHotReloadUsesWatcher(opts.pool)) {
    return;
  }
  const delays = opts.restartDelaysMs ?? RESTART_DELAYS_MS;
  const env: Record<string, string> = {};
  for (const key of SYSTEM_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  let stopped = false;
  let down = false;
  let failures = 0;
  let current: Child | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const launch = (): void => {
    if (stopped) {
      return;
    }
    const child: Child = Bun.spawn(
      [
        opts.runtime.binary,
        "--candidate-root",
        opts.runtime.home,
        "runtime",
        "source-notify",
        "--project",
        opts.projectRoot,
        "--until-stdin-closes",
      ],
      {
        cwd: opts.projectRoot,
        env: childEnvironment(env),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    current = child;
    let forwarding = false;
    void drain(child.stdout, (text) => {
      if (!forwarding && text.includes(FORWARDING)) {
        forwarding = true;
        failures = 0;
        if (down && !stopped) {
          down = false;
          opts.warn(NATIVE_SOURCE_NOTIFY_BACK);
        }
      }
    }).catch(() => undefined);
    const stderr = drain(child.stderr).catch(() => "");
    void child.exited.then(async () => {
      const code = refusalCode(await stderr);
      if (stopped || current !== child) {
        return;
      }
      const permanent = code !== undefined && PERMANENT.has(code);
      if (!down) {
        down = true;
        opts.warn(
          permanent
            ? NATIVE_SOURCE_NOTIFY_UNAVAILABLE
            : NATIVE_SOURCE_NOTIFY_STOPPED
        );
      }
      if (permanent) {
        return;
      }
      const delay = delays[Math.min(failures, delays.length - 1)] ?? 30_000;
      failures += 1;
      timer = setTimeout(launch, delay);
    });
  };
  launch();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    const child = current;
    if (!child) {
      return;
    }
    // Closing its input is the child's stop request; it holds no state to clean.
    try {
      child.stdin?.end();
    } catch {
      // Already gone.
    }
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(STOP_GRACE_MS).then(() => false),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited;
    }
  };
}
