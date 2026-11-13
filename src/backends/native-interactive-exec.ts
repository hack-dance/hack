import { type ChildProcess, spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { keys } from "../lib/native-compose-private-state.ts";
import { openTerminalControl } from "../lib/tty-process-group.ts";
import { withPinnedRuntimeBinary } from "./native-authored-runtime-binary.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
function refused(): never {
  throw new ClosedCliError(
    "Native interactive exec could not confirm its terminal or session; no request was replayed."
  );
}

/** Match Compose's terminal-driven exec selection; pipes retain finite exec. */
export function nativeInteractiveRequested(): boolean {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      process.env.HACK_NO_INTERACTIVE !== "1"
  );
}

type Report = {
  code: number;
  session?: string;
  retained: boolean;
  failure?: string;
};
export function parseInteractiveReport(value: unknown): Report {
  if (!isRecord(value) || value.version !== 1) {
    return refused();
  }
  if (
    value.outcome === "completed" &&
    keys(value, "completion,outcome,version")
  ) {
    const r = value.completion;
    if (
      !(isRecord(r) && keys(r, "exit_code,retained,session")) ||
      typeof r.exit_code !== "number" ||
      !Number.isInteger(r.exit_code) ||
      r.exit_code < 0 ||
      r.exit_code > 255 ||
      typeof r.retained !== "boolean" ||
      typeof r.session !== "string" ||
      !UUID.test(r.session)
    ) {
      return refused();
    }
    return { code: r.exit_code, session: r.session, retained: r.retained };
  }
  if (
    value.outcome === "refused" &&
    keys(value, "code,outcome,session,version") &&
    typeof value.code === "string" &&
    CODE.test(value.code) &&
    (value.session === null ||
      (typeof value.session === "string" && UUID.test(value.session)))
  ) {
    return {
      code: 1,
      retained: value.session !== null,
      ...(typeof value.session === "string" ? { session: value.session } : {}),
      failure: value.code,
    };
  }
  return refused();
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The child stays in the foreground group. fd 3 is duplex: private envelope,
 * then lifetime leash on input; a bounded value-free result on output. The
 * frontend owns a second terminal snapshot for abrupt native-child death. */
type InteractiveOptions = {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly branch: string | null;
  readonly run: string;
  readonly owner: string;
  readonly plan: string;
  readonly namespace: string;
  readonly service: string;
  readonly command: readonly string[];
  readonly workdir?: string;
  readonly native: boolean;
  readonly payload?: Uint8Array;
  readonly expectedContainer?: string;
  readonly expectedGeneration?: string;
  readonly signal?: AbortSignal;
};

export async function nativeInteractiveExec(
  opts: InteractiveOptions
): Promise<number> {
  if (
    !nativeInteractiveRequested() ||
    (opts.payload?.length ?? 0) > 256 * 1024 ||
    opts.signal?.aborted
  ) {
    return refused();
  }
  const remedy = `hack down --path ${quote(opts.projectRoot)}${opts.branch ? ` --branch ${quote(opts.branch)}` : ""}`;
  // Cancellation closes the child leash; it must not suppress the subsequent
  // read-only receipt query that reports an uncertain admission.
  return await withPinnedRuntimeBinary(
    { binary: opts.runtime.binary, refused },
    async (pin) => {
      const terminal = openTerminalControl();
      const attributes = terminal.attributes();
      if (!attributes || terminal.foreground() !== terminal.group()) {
        terminal.close();
        return refused();
      }
      let report: Report | undefined;
      let exit = 1;
      let restorationFailed = false;
      try {
        pin.checkSync();
        if (opts.signal?.aborted) {
          return refused();
        }
        ({ report, exit } = await runInteractiveChild(
          spawnInteractiveChild(opts),
          opts
        ));
      } finally {
        const restored = terminal.restoreAttributes(attributes);
        terminal.close();
        if (!restored) {
          restorationFailed = true;
          process.stderr.write(
            "interactive_terminal_restore_failed: run stty sane in this terminal.\n"
          );
        }
      }
      return await finishInteractiveReport({
        opts,
        report,
        exit,
        restorationFailed,
        remedy,
        check: () => pin.checkSync(),
      });
    }
  );
}

function spawnInteractiveChild(opts: InteractiveOptions): ChildProcess {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return spawn(
    opts.runtime.binary,
    [
      "--candidate-root",
      opts.runtime.home,
      "graph",
      "exec-interactive",
      "--run-id",
      opts.run,
      "--service",
      opts.service,
      "--expect-owner",
      opts.owner,
      "--expect-plan",
      opts.plan,
      "--expect-namespace",
      opts.namespace,
      ...(opts.native ? ["--native"] : []),
      ...(opts.workdir ? ["--workdir", opts.workdir] : []),
      ...(opts.expectedContainer
        ? ["--expect-container", opts.expectedContainer]
        : []),
      ...(opts.expectedGeneration
        ? ["--expect-generation", opts.expectedGeneration]
        : []),
      "--",
      ...opts.command,
    ],
    {
      cwd: opts.projectRoot,
      env,
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      detached: false,
    }
  );
}

async function runInteractiveChild(
  child: ChildProcess,
  opts: InteractiveOptions
): Promise<{ report?: Report; exit: number }> {
  let report: Report | undefined;
  let exit = 1;
  const control = child.stdio[3];
  if (!(control instanceof Duplex)) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    return refused();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let invalid = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    control.destroy();
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
  };
  const ended = new Promise<number>((resolve) => {
    child.once("error", () => {
      invalid = true;
    });
    child.once("close", (code, signal) =>
      resolve(code ?? (signal === "SIGINT" ? 130 : 1))
    );
  });
  control.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 4096) {
      invalid = true;
      cancel();
    } else {
      chunks.push(chunk);
    }
  });
  control.on("error", () => {
    invalid = true;
    cancel();
  });
  opts.signal?.addEventListener("abort", cancel, { once: true });
  // Adopted exec has no enclosing authored signal scope.
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const payload = Buffer.alloc(4 + (opts.payload?.length ?? 0));
  payload.writeUInt32BE(opts.payload?.length ?? 0);
  if (opts.payload) {
    payload.set(opts.payload, 4);
  }
  try {
    deliveryTimer = setTimeout(cancel, 5000);
    control.write(payload, () => {
      payload.fill(0);
      clearTimeout(deliveryTimer);
    });
    if (opts.signal?.aborted) {
      cancel();
    }
    exit = await ended;
    if (!invalid) {
      try {
        report = parseInteractiveReport(
          JSON.parse(Buffer.concat(chunks).toString("utf8"))
        );
      } catch {
        /* A lost child leaves durable evidence for the query below. */
      }
    }
  } finally {
    payload.fill(0);
    clearTimeout(deliveryTimer);
    clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", cancel);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    control.destroy();
  }

  return { report, exit };
}

async function reportRetainedSessions(
  opts: InteractiveOptions,
  check: () => void,
  remedy: string
): Promise<void> {
  const retained = await (async () => {
    check();
    return await invokeNativeRuntime({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        "graph",
        "interactive-sessions",
        "--run-id",
        opts.run,
        "--service",
        opts.service,
        "--json",
      ],
      timeoutMs: 5000,
    });
  })().catch(() => null);
  if (
    isRecord(retained) &&
    keys(retained, "sessions,version") &&
    retained.version === 1 &&
    Array.isArray(retained.sessions) &&
    retained.sessions.length <= 1024 &&
    retained.sessions.every(
      (id: unknown) => typeof id === "string" && UUID.test(id)
    )
  ) {
    if (retained.sessions.length > 0) {
      process.stderr.write(
        "Retained sessions for this service (the interrupted session may be among them):\n"
      );
    }
    for (const id of retained.sessions) {
      process.stderr.write(
        `session_cleanup_uncertain: session ${id}; cleanup: ${remedy}\n`
      );
    }
  } else {
    process.stderr.write(
      `session_cleanup_uncertain: session evidence unavailable; cleanup: ${remedy}\n`
    );
  }
}

async function finishInteractiveReport({
  opts,
  report,
  exit,
  restorationFailed,
  remedy,
  check,
}: {
  opts: InteractiveOptions;
  report?: Report;
  exit: number;
  restorationFailed: boolean;
  remedy: string;
  check: () => void;
}): Promise<number> {
  if (report?.failure === "session_receipt_limit") {
    process.stderr.write(
      "session_receipt_limit: the native home has 1024 retained interactive sessions; run hack down for a project with retained sessions before opening another.\n"
    );
    return 1;
  }
  if (!report || (report.failure && !report.session)) {
    // SIGKILL cannot send a final report. Query only value-free receipts after
    // the child is reaped; never replay its start to recover an outcome.
    await reportRetainedSessions(opts, check, remedy);
    if (report?.failure) {
      process.stderr.write(
        `Native interactive exec ended (${report.failure}).\n`
      );
    }
    return exit === 0 ? 1 : exit;
  }
  if (report.retained) {
    process.stderr.write(
      `session_cleanup_uncertain: session ${report.session}; cleanup: ${remedy}\n`
    );
  }
  if (report.failure) {
    process.stderr.write(
      `Native interactive exec ended (${report.failure}).\n`
    );
  }
  return restorationFailed && report.code === 0 ? 1 : report.code;
}
