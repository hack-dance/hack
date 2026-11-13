import { ChildProcess, spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NativeRuntimeRequestError,
  retainNativeRuntimeFailure,
} from "../../src/backends/native-runtime-client.ts";
import { handleRunCliError } from "../../src/cli/run.ts";
import { ClosedCliError } from "../../src/lib/cli-result.ts";
import {
  nativeDetachedUpFailedServices,
  nativeDetachedUpFailure,
  nativeDetachedUpReady,
  nativeDetachedUpShellVariables,
  runNativeDetachedOwner,
  startNativeDetachedUp,
} from "../../src/lib/native-detached-up.ts";

/**
 * Publish a marker file atomically. Tests poll these files, and a plain
 * writeFile is visible empty before its contents land.
 */
async function publish(path: string, contents: string): Promise<void> {
  await writeFile(`${path}.tmp`, contents);
  await rename(`${path}.tmp`, path);
}

const [role, root, mode] = Bun.argv.slice(2);
if (!(root && mode)) {
  process.exit(2);
}

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
  const restore =
    mode === "held-channel"
      ? deferChannelClosure()
      : mode === "exit-first-failure"
        ? deliverExitBeforeMessages()
        : undefined;
  try {
    process.exitCode = await startNativeDetachedUp({
      cwd: root,
      args: [],
      json: true,
      invocation: [
        process.execPath,
        ...(Bun.main.startsWith("/$bunfs/") ? [] : [import.meta.filename]),
        "owner",
        root,
        mode,
      ],
      timeoutMs: ["timeout", "late-ready"].includes(mode) ? 1000 : 10_000,
    });
  } catch (error) {
    process.exitCode = [
      "wrapped-failure",
      "wrapped-static-failure",
      "provider-pin",
      "wrapped-provider-pin",
      "immediate-failure",
      "exit-first-failure",
      "failed-services",
    ].includes(mode)
      ? await handleRunCliError({ error, jsonRequested: true })
      : 1;
  } finally {
    restore?.();
  }
} else if (role === "owner") {
  process.exitCode = await runNativeDetachedOwner({
    args: [],
    run: async () => {
      const done = Promise.withResolvers<number>();
      const stop = () => done.resolve(0);
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
      if (["fail", "provider-pin", "wrapped-provider-pin"].includes(mode)) {
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
      const notifyReady = () =>
        nativeDetachedUpReady({
          project: "fixture",
          branch: null,
          composeProject: "fixture",
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
      if (
        [
          "ready",
          "cancel-at-accept",
          "shell-names",
          "shell-names-empty",
          "unsafe-failure",
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
