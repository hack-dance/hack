import { ChildProcess, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  batchImageFailure,
  NativeImageBatchError,
  NativeImageBlocker,
} from "../../src/backends/native-image-policy.ts";
import {
  NativeRuntimeRequestError,
  retainNativeRuntimeFailure,
} from "../../src/backends/native-runtime-client.ts";
import { handleRunCliError } from "../../src/cli/run.ts";
import { ClosedCliError, HackCliError } from "../../src/lib/cli-result.ts";
import {
  startupTimingSpawn,
  withCommandTimings,
} from "../../src/lib/command-timings.ts";
import type { NativeDetachedStartPhase } from "../../src/lib/native-detached-start-deadline.ts";
import {
  nativeDetachedUpBranchDropped,
  nativeDetachedUpFailedServices,
  nativeDetachedUpFailure,
  nativeDetachedUpHookFailed,
  nativeDetachedUpHotReload,
  nativeDetachedUpPrestart,
  nativeDetachedUpProfileNotice,
  nativeDetachedUpProgress,
  nativeDetachedUpReady,
  nativeDetachedUpShellVariables,
  reportNativeImageDownloadWait,
  reportNativeImageWork,
  runNativeDetachedOwner,
  setNativeDetachedHeartbeatIntervalForTests,
  startNativeDetachedUp,
} from "../../src/lib/native-detached-up.ts";

import { NativeAuthoredAttemptLimitError } from "../../src/lib/native-up-refusals.ts";

/**
 * Publish a marker file atomically. Tests poll these files, and a plain
 * writeFile is visible empty before its contents land.
 */
async function publish(path: string, contents: string): Promise<void> {
  await writeFile(`${path}.tmp`, contents);
  await rename(`${path}.tmp`, path);
}

/** HACK-2338: a detached owner hands its profile notice to the launcher. */
function publishFixtureProfileNotice(fixtureMode: string): void {
  if (fixtureMode === "profile-notice") {
    nativeDetachedUpProfileNotice({
      kind: "left-out",
      services: ["jobs"],
      profiles: [],
      source: "none",
    });
  }
}

/** HACK-2338: a detached owner hands its dropped-branch-site notice to the launcher. */
function publishFixtureBranchDropped(fixtureMode: string): void {
  if (fixtureMode === "branch-dropped") {
    nativeDetachedUpBranchDropped({
      branch: "feature-a",
      service: "web",
      label: "caddy",
      count: 2,
    });
  }
}

/**
 * HACK-2535: the detached owner runs the source preflight; restarting an idle pool
 * for a new root reaches the launcher as one validated notice line.
 */
async function publishFixturePoolRestart(fixtureMode: string): Promise<void> {
  if (fixtureMode !== "pool-restart-notice") {
    return;
  }
  // This preflight is specific to the idle-pool fixture. Loading it eagerly
  // makes every owner, including the deadline probes, pay for its imports.
  const {
    NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED,
    preflightNativeProjectSource,
  } = await import("../../src/backends/native-project-source-preflight.ts");
  let shared = false;
  await preflightNativeProjectSource({
    runtime: { binary: "/fixture/hack-native", home: "/fixture/home" },
    projectRoot: "/fixture/second-app",
    invoke: (request) => {
      if (request.args[1] === "check-project-share") {
        if (!shared) {
          return Promise.reject(
            new NativeRuntimeRequestError({
              message:
                "Native runtime request failed (project_share_extension_required).",
              nativeCode: NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED,
            })
          );
        }
        return Promise.resolve({
          source_admitted: true,
          pool_initialized: true,
        });
      }
      if (request.args[1] === "status") {
        return Promise.resolve({ phase: "running", process_alive: true });
      }
      shared = true;
      return Promise.resolve({
        kind: "project_share_added",
        project: "/fixture/second-app",
        restarted: false,
        disks_preserved: true,
        stopped_idle_pool: true,
      });
    },
  });
}

/** HACK-2409: a detached owner hands the pool's hot-reload notice to the launcher. */
function publishFixtureHotReload(fixtureMode: string): void {
  if (fixtureMode === "hot-reload-off") {
    nativeDetachedUpHotReload({
      state: "off",
      reason: "large_share",
      limit: 100_000,
    });
  } else if (fixtureMode === "hot-reload-unsafe") {
    // A notice that is not exactly two known names and a bounded number is dropped whole.
    nativeDetachedUpHotReload({
      state: "off",
      reason: "large_share",
      limit: 100_000,
      message: "synthetic-private-value",
    } as never);
  }
}

/** HACK-2351 modes: phase reports against short launcher limits. */
const DEADLINE_MODES = [
  "slow-images",
  "slow-runtime",
  "images-ceiling",
  "images-wait-ceiling",
];

const IMAGE_WORK_FINISHED = "image-work-finished";
const IMAGE_WORK_MS = 2500;

/** Advance synthetic time on IPC progress, independent of host scheduling. */
function fixtureDeadlineClock(fixtureMode: string, fixtureRoot: string) {
  if (!DEADLINE_MODES.includes(fixtureMode)) {
    return;
  }
  const { budgetMs, ceilingMs } = fixtureLimits(fixtureMode);
  const imageLimit = fixtureMode === "slow-images" ? IMAGE_WORK_MS : ceilingMs;
  let elapsed = 0;
  let lastPhase: NativeDetachedStartPhase | undefined;
  let released = false;
  return (phase?: NativeDetachedStartPhase): number => {
    if (phase) {
      if (phase === "images" && lastPhase === "images") {
        elapsed = Math.min(imageLimit, elapsed + 100);
      }
      lastPhase = phase;
    } else if (fixtureMode === "slow-runtime" && lastPhase === "runtime") {
      elapsed = budgetMs;
    } else if (
      fixtureMode === "slow-images" &&
      elapsed >= IMAGE_WORK_MS &&
      !released
    ) {
      // The launcher's timer now checks the budget before it can handle ready.
      writeFileSync(join(fixtureRoot, IMAGE_WORK_FINISHED), "");
      released = true;
    }
    return elapsed;
  };
}

/** The launcher's limits for a fixture mode. */
function fixtureLimits(fixtureMode: string) {
  if (
    fixtureMode === "images-ceiling" ||
    fixtureMode === "images-wait-ceiling"
  ) {
    return { budgetMs: 1000, ceilingMs: 2000 };
  }
  if (["timeout", "late-ready", ...DEADLINE_MODES].includes(fixtureMode)) {
    return {
      budgetMs: 1000,
      ceilingMs:
        fixtureMode === "timeout" || fixtureMode === "late-ready"
          ? 1000
          : 10_000,
    };
  }
  return { budgetMs: 10_000, ceilingMs: 10_000 };
}

/**
 * HACK-2351: report startup phases as native up does. `slow-images` builds
 * for longer than the launcher's budget with heartbeats, then continues;
 * `slow-runtime` stalls before image work; `images-ceiling` builds forever.
 */
async function reportFixturePhases(
  fixtureMode: string,
  fixtureRoot: string,
  hasStopped: () => boolean
): Promise<void> {
  if (!DEADLINE_MODES.includes(fixtureMode)) {
    return;
  }
  if (fixtureMode === "slow-runtime") {
    // Model the loaded Mac: the first phase arrives after the full runtime
    // budget would have expired if the fixture clock still counted startup.
    await Bun.sleep(fixtureLimits(fixtureMode).budgetMs + 250);
  }
  setNativeDetachedHeartbeatIntervalForTests(10);
  nativeDetachedUpProgress("input");
  nativeDetachedUpProgress("runtime");
  if (fixtureMode === "slow-runtime") {
    return;
  }
  if (fixtureMode !== "images-wait-ceiling") {
    reportNativeImageWork(["docker.io/fixture/image:stable"]);
  }
  nativeDetachedUpProgress("images");
  if (fixtureMode === "images-wait-ceiling") {
    reportNativeImageDownloadWait("docker.io/fixture/image:stable");
  }
  if (fixtureMode === "slow-images") {
    const finished = join(fixtureRoot, IMAGE_WORK_FINISHED);
    while (!(hasStopped() || existsSync(finished))) {
      await Bun.sleep(10);
    }
    reportNativeImageWork([]);
    nativeDetachedUpProgress("services");
  }
}

/** HACK-2339 modes whose owner fails before VM work. */
const PRESTART_MODES = [
  "prestart-refusal",
  "prestart-after-runtime",
  "prestart-plain-error",
  "prestart-long",
  "prestart-hook-long-line",
  "prestart-persistent-hook",
];

/**
 * A closed refusal longer than any one terminal line, like a source-size
 * list; tests/native-detached-up.test.ts repeats it.
 */
const PRESTART_LONG_MESSAGE = `Selected source is too large. ${"assets/deeply/nested/".repeat(2100)}`;

/** Run a real lifecycle phase in this owner, as native up's before hooks do. */
async function runFixtureHooks(
  fixtureMode: string,
  fixtureRoot: string
): Promise<void> {
  const { runLifecycleCommands } = await import(
    "../../src/commands/project.ts"
  );
  await runLifecycleCommands({
    title: "Lifecycle (native up before)",
    commands: [
      fixtureMode === "prestart-persistent-hook"
        ? { name: "session", command: "run-session", persistent: true }
        : {
            name: "seed-check",
            command:
              "head -c 3000000 /dev/zero | tr '\\000' x; echo; printf 'last line\\n'; exit 3",
          },
    ],
    projectRoot: fixtureRoot,
    env: {},
    projectDir: join(fixtureRoot, ".hack"),
    composeProject: "fixture",
    onPersistentCommand: () =>
      Promise.reject(new Error("Lifecycle session could not start.")),
  });
}

/**
 * HACK-2339: a refusal before VM work crosses as the foreground prints it;
 * after VM work starts, or for any other error, it does not.
 */
async function publishFixturePrestartFailure(
  fixtureMode: string,
  fixtureRoot: string
) {
  if (!PRESTART_MODES.includes(fixtureMode)) {
    return;
  }
  nativeDetachedUpPrestart(true);
  if (fixtureMode === "prestart-long") {
    await nativeDetachedUpFailure(
      new HackCliError({
        code: "E_NATIVE_PROJECT_UNSUPPORTED",
        message: PRESTART_LONG_MESSAGE,
      })
    );
    return;
  }
  if (
    fixtureMode === "prestart-hook-long-line" ||
    fixtureMode === "prestart-persistent-hook"
  ) {
    await runFixtureHooks(fixtureMode, fixtureRoot);
    await nativeDetachedUpFailure(
      new HackCliError({
        code: "E_LIFECYCLE_FAILED",
        message:
          "Lifecycle (native up before) failed (exit 3); values omitted.",
      })
    );
    return;
  }
  nativeDetachedUpHookFailed({
    step: "Lifecycle (native up before): seed-check: ./seed.sh",
    output: ["\u001b[31mred hook line\u001b[0m", "x".repeat(600)],
    failure:
      "Lifecycle (native up before) failed (exit 3): seed-check: ./seed.sh",
  });
  if (fixtureMode === "prestart-after-runtime") {
    nativeDetachedUpPrestart(false);
  }
  await nativeDetachedUpFailure(
    fixtureMode === "prestart-plain-error"
      ? new Error("synthetic-private-value")
      : new HackCliError({
          code: "E_LIFECYCLE_FAILED",
          message:
            "Lifecycle (native up before) failed (exit 3); values omitted.",
        })
  );
}

/** Malformed pre-VM refusals the launcher must ignore. */
function sendUnsafePrestartRefusals(fixtureMode: string): void {
  if (fixtureMode !== "unsafe-prestart-refusal") {
    return;
  }
  for (const data of [
    { error: "hack", code: "E_NOT_A_CODE", message: "m" },
    { error: "hack", message: "missing code" },
    { error: "closed", code: "E_USAGE", message: "closed with code" },
    { error: "hack", code: "E_USAGE", message: "bad\u001b[2Jcontrol" },
    { error: "hack", code: "E_USAGE", message: "p".repeat(64 * 1024 + 1) },
    { error: "hack", code: "E_USAGE", message: "m", extra: "x" },
    { error: "hack", code: "E_USAGE", message: "m", hook: ["a\nb"] },
    { error: "hack", code: "E_USAGE", message: "m", hook: [] },
    { error: "other", message: "m" },
  ]) {
    process.send?.({ kind: "prestart-refusal", data });
  }
  process.send?.({
    kind: "prestart-refusal",
    data: { error: "hack", code: "E_USAGE", message: "m" },
    extra: true,
  });
}

const [role, root, mode] = Bun.argv.slice(2);
if (!(root && mode)) {
  process.exit(2);
}

const rootPoll = setInterval(() => {
  if (!existsSync(root)) {
    process.exit(0);
  }
}, 100);
rootPoll.unref();
await publish(join(root, `${role}.fixture-pid`), String(process.pid));

/** Exercise the valid exit-before-buffered-IPC order in this isolated launcher. */
function deliverExitBeforeMessages(): () => void {
  const emit = ChildProcess.prototype.emit;
  const drained = new WeakSet<ChildProcess>();
  const pending = new WeakMap<
    ChildProcess,
    { messages: unknown[][]; closed: [string | symbol, unknown[]][] }
  >();
  ChildProcess.prototype.emit = function (
    this: ChildProcess,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    let buffered = pending.get(this);
    if (!buffered) {
      buffered = { messages: [], closed: [] };
      pending.set(this, buffered);
    }
    if (event === "message" && !drained.has(this)) {
      buffered.messages.push(args);
      return true;
    }
    if ((event === "disconnect" || event === "close") && !drained.has(this)) {
      buffered.closed.push([event, args]);
      return true;
    }
    if (event !== "exit") {
      return emit.call(this, event, ...args);
    }
    const result = emit.call(this, event, ...args);
    for (const message of buffered.messages) {
      emit.call(this, "message", ...message);
    }
    drained.add(this);
    for (const [closed, values] of buffered.closed) {
      emit.call(this, closed, ...values);
    }
    return result;
  };
  return () => {
    ChildProcess.prototype.emit = emit;
  };
}

/** Force the valid delayed-close order, even on hosts that promptly close IPC. */
function deferChannelClosure(): () => void {
  const emit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function (
    this: ChildProcess,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    return event === "close" || event === "disconnect"
      ? true
      : emit.call(this, event, ...args);
  };
  return () => {
    ChildProcess.prototype.emit = emit;
  };
}

/** The exact spawned descendant retains fd 3 until its private stop endpoint is called. */
async function leaveChannelWithDescendant(opts: {
  readonly root: string;
  readonly mode: string;
}): Promise<never> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].includes(key)
    )
  );
  const holder = spawn(
    process.execPath,
    [import.meta.filename, "channel-holder", opts.root, opts.mode],
    {
      env,
      stdio: ["ignore", "ignore", "ignore", 3],
    }
  );
  const deadline = performance.now() + 3000;
  while (!(await Bun.file(join(opts.root, "holder-ready")).exists())) {
    if (performance.now() > deadline) {
      holder.kill("SIGTERM");
      throw new Error("Channel holder did not start.");
    }
    await Bun.sleep(10);
  }
  holder.unref();
  process.exit(1);
}

if (role === "channel-holder") {
  const done = Promise.withResolvers<void>();
  const server = Bun.serve({
    unix: join(root, "holder.sock"),
    fetch: () => {
      setTimeout(() => done.resolve(), 25);
      return new Response("held");
    },
  });
  const timeout = setTimeout(() => done.resolve(), 12_000);
  await publish(join(root, "holder-ready"), "ready");
  await done.promise;
  clearTimeout(timeout);
  server.stop(true);
  await publish(join(root, "holder-stopped"), "stopped");
} else if (role === "launcher") {
  // HACK-2339: a failed hook's lines are written only to a terminal stderr.
  if (process.env.FIXTURE_STDERR_TERMINAL === "1") {
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
  }
  const restore =
    mode === "held-channel"
      ? deferChannelClosure()
      : mode === "exit-first-failure"
        ? deliverExitBeforeMessages()
        : undefined;
  try {
    const launch = () =>
      startNativeDetachedUp({
        cwd: root,
        args: [],
        json: !process.env.FIXTURE_TEXT_OUTPUT,
        ...(mode === "restart-action" ? { action: "restart" as const } : {}),
        invocation: [
          process.execPath,
          ...(Bun.main.startsWith("/$bunfs/") ? [] : [import.meta.filename]),
          "owner",
          root,
          mode,
        ],
        limits: fixtureLimits(mode),
        heartbeatStaleMs: 400,
        deadlineNow: fixtureDeadlineClock(mode, root),
        unwindMs: 3000,
      });
    process.exitCode =
      mode === "timings"
        ? await withCommandTimings(join(root, "timings.jsonl"), launch)
        : await launch();
  } catch (error) {
    process.exitCode = [
      "authored-attempt-limit",
      "wrapped-failure",
      "wrapped-static-failure",
      "builder-missing",
      "build-registry-limit",
      "provider-pin",
      "wrapped-provider-pin",
      "immediate-failure",
      "exit-first-failure",
      "failed-services",
      "image-batch-errors",
      "prestart-refusal",
      "prestart-after-runtime",
      "prestart-plain-error",
      "prestart-long",
      "prestart-hook-long-line",
      "prestart-persistent-hook",
      "slow-runtime",
      "images-ceiling",
      "images-wait-ceiling",
    ].includes(mode)
      ? await handleRunCliError({ error, jsonRequested: true })
      : 1;
  } finally {
    restore?.();
  }
} else if (role === "owner") {
  process.exitCode = await runNativeDetachedOwner({
    args: Bun.argv.slice(5),
    run: async () => {
      const done = Promise.withResolvers<number>();
      let stopped = false;
      const stop = () => {
        stopped = true;
        done.resolve(0);
      };
      let stopSignals = 0;
      const terminate = () => {
        stopSignals += 1;
        stop();
      };
      process.on("SIGTERM", terminate);
      const server = Bun.serve({
        unix: join(root, "control.sock"),
        fetch: () => {
          stop();
          return new Response("stopping");
        },
      });
      await publish(join(root, "owner.pid"), String(process.pid));
      if (mode === "held-channel") {
        server.stop(true);
        return await leaveChannelWithDescendant({ root, mode });
      }
      process.stdout.write(
        "synthetic hook output must not reach launcher stdout\n"
      );
      process.stderr.write(
        "synthetic hook output must not reach launcher stderr\n"
      );
      if (mode === "shell-names") {
        process.send?.({
          kind: "shell-variables",
          names: ["invalid\nsynthetic-private-value"],
        });
        process.send?.({
          kind: "shell-variables",
          names: ["EXTRA_FIELD_MUST_NOT_PRINT"],
          output: "synthetic-private-value",
        });
        nativeDetachedUpShellVariables(["Z_TOKEN", "A_TOKEN", "A_TOKEN"]);
        nativeDetachedUpShellVariables(["DUPLICATE_NOTICE"]);
      }
      if (mode === "shell-names-empty") {
        nativeDetachedUpShellVariables([]);
      }
      if (mode === "shell-names-root-dotenv") {
        nativeDetachedUpShellVariables([], true);
        nativeDetachedUpShellVariables([], true);
      }
      if (mode === "build-registry-limit") {
        await nativeDetachedUpFailure(
          new NativeImageBlocker({
            missing: "docker.io/library/python:3.12-alpine",
            buildBase: true,
            reason: "registry_http_429",
            present: ["docker.io/library/alpine:3.22"],
          })
        );
      }
      if (mode === "builder-missing") {
        await nativeDetachedUpFailure(
          new NativeRuntimeRequestError({
            nativeCode: "builder_not_prepared",
            message: "synthetic-private-value",
          })
        );
      }
      if (["provider-pin", "wrapped-provider-pin"].includes(mode)) {
        await nativeDetachedUpFailure(new Error("synthetic-private-value"));
        const failure = new NativeRuntimeRequestError({
          nativeCode: "provider_pin_changed",
          message: "synthetic-private-value",
        });
        await nativeDetachedUpFailure(
          mode === "wrapped-provider-pin"
            ? retainNativeRuntimeFailure({
                error: new ClosedCliError("synthetic-private-value"),
                original: failure,
              })
            : failure
        );
      }
      if (mode === "authored-attempt-limit") {
        await nativeDetachedUpFailure(new NativeAuthoredAttemptLimitError());
        server.stop(true);
        process.off("SIGTERM", terminate);
        return 1;
      }
      await publishFixturePrestartFailure(mode, root);
      if (
        [
          ...PRESTART_MODES,
          "fail",
          "builder-missing",
          "build-registry-limit",
          "provider-pin",
          "wrapped-provider-pin",
        ].includes(mode)
      ) {
        server.stop(true);
        process.off("SIGTERM", terminate);
        return 1;
      }
      if (
        [
          "wrapped-failure",
          "wrapped-static-failure",
          "immediate-failure",
          "exit-first-failure",
        ].includes(mode)
      ) {
        const failure = new NativeRuntimeRequestError({
          message: "synthetic-private-value",
          nativeCode: "graph_port_publication",
          nativeMessage:
            "Native publishes only TCP ports; keep UDP publication on the Compose backend.",
          nativeService: "web",
          ...(mode === "wrapped-static-failure"
            ? { nativeStartupPhase: "static-preflight" as const }
            : {}),
        });
        await nativeDetachedUpFailure(
          retainNativeRuntimeFailure({
            error: new ClosedCliError("synthetic-private-value"),
            original: failure,
          })
        );
        server.stop(true);
        process.off("SIGTERM", terminate);
        if (["immediate-failure", "exit-first-failure"].includes(mode)) {
          process.exit(1);
        }
        return 1;
      }
      if (mode === "image-batch-errors") {
        await nativeDetachedUpFailure(
          new NativeImageBatchError([
            batchImageFailure("fixture/image:a", { code: "provider_busy" }, [
              "web",
            ]),
            batchImageFailure("fixture/image:b", { code: "image_disk_space" }, [
              "db",
            ]),
          ])
        );
        return 1;
      }
      if (mode === "failed-services") {
        // A service's process exited during startup: only its name may cross
        // IPC. Unsafe names and anything resembling output are dropped.
        nativeDetachedUpFailedServices([
          "web",
          "api",
          "web",
          "synthetic private value",
          "line\nbreak",
        ]);
        await nativeDetachedUpFailure(
          new NativeRuntimeRequestError({
            message: "synthetic-private-value",
            nativeCode: "engine_rejected",
          })
        );
        server.stop(true);
        process.off("SIGTERM", terminate);
        return 1;
      }
      if (mode === "unsafe-failure") {
        for (const value of [
          {
            kind: "failure",
            data: { code: "invalid\ncode", message: "synthetic-private-value" },
          },
          {
            kind: "failure",
            data: {
              code: "graph_port_publication",
              message: "synthetic-private-value\nline",
            },
          },
          {
            kind: "failure",
            data: {
              code: "graph_port_publication",
              message: "synthetic-private-value",
              output: "extra",
            },
          },
          {
            kind: "failure",
            data: {
              code: "graph_port_publication",
              message: "synthetic-private-value",
            },
            output: "extra",
          },
          {
            kind: "failure",
            data: { code: "graph_port_publication", message: "p".repeat(401) },
          },
          {
            kind: "failure",
            data: {
              code: "graph_port_publication",
              startupPhase: "unknown-phase",
            },
          },
        ]) {
          process.send?.(value);
        }
        await nativeDetachedUpFailure(new Error("synthetic-private-value"));
      }
      if (mode === "timings") {
        const runtime = startupTimingSpawn([join(root, "runtime")], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((await runtime.exited) !== 0) {
          throw new Error(
            "Synthetic runtime failed to deliver timing records."
          );
        }
      }
      const notifyReady = () =>
        nativeDetachedUpReady({
          project: "fixture",
          branch: null,
          composeProject: "fixture",
          address: process.env.FIXTURE_READY_ADDRESS,
          started: ["web"],
          completed: ["seed"],
        });
      const cancelAtAccept = (value: unknown) => {
        if (value === "accept") {
          process.emit("message", "cancel");
        }
      };
      if (mode === "cancel-at-accept") {
        // Force cancellation just before the existing owner accepts the IPC
        // handoff, with the real owner handler still processing that accept.
        process.prependListener("message", cancelAtAccept);
      }
      await reportFixturePhases(mode, root, () => stopped);
      publishFixtureProfileNotice(mode);
      publishFixtureBranchDropped(mode);
      publishFixtureHotReload(mode);
      await publishFixturePoolRestart(mode);
      sendUnsafePrestartRefusals(mode);
      if (
        [
          "ready",
          "profile-notice",
          "pool-restart-notice",
          "branch-dropped",
          "hot-reload-off",
          "hot-reload-unsafe",
          "restart-action",
          "cancel-at-accept",
          "shell-names",
          "shell-names-empty",
          "shell-names-root-dotenv",
          "unsafe-failure",
          "unsafe-prestart-refusal",
          "slow-images",
          "timings",
        ].includes(mode)
      ) {
        notifyReady();
      }
      const code = await done.promise;
      await Bun.sleep(20);
      if (mode === "late-ready") {
        // A readiness callback already in flight can finish after cancellation
        // and channel closure. It must not publish or crash the lifetime owner.
        await Bun.sleep(20);
        notifyReady();
      }
      process.off("message", cancelAtAccept);
      server.stop(true);
      process.off("SIGTERM", terminate);
      await publish(join(root, "stop-signals"), String(stopSignals));
      await publish(
        join(root, "stopped"),
        "down.before\nprocess.stop\ndown.after\n"
      );
      return code;
    },
  });
}
