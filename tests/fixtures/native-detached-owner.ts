import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NativeRuntimeRequestError,
  retainNativeRuntimeFailure,
} from "../../src/backends/native-runtime-client.ts";
import { handleRunCliError } from "../../src/cli/run.ts";
import { ClosedCliError } from "../../src/lib/cli-result.ts";
import {
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
if (role === "launcher") {
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
      "provider-pin",
      "wrapped-provider-pin",
    ].includes(mode)
      ? await handleRunCliError({ error, jsonRequested: true })
      : 1;
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
      if (mode === "wrapped-failure") {
        const failure = new NativeRuntimeRequestError({
          message: "synthetic-private-value",
          nativeCode: "graph_port_publication",
          nativeMessage:
            "Native publishes only TCP ports; keep UDP publication on the Compose backend.",
          nativeService: "web",
        });
        await nativeDetachedUpFailure(
          retainNativeRuntimeFailure({
            error: new ClosedCliError("synthetic-private-value"),
            original: failure,
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
