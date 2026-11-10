// Runs `restartNativeProject` with in-memory owners so a test can deliver real
// signals to this process. argv[2] selects the phase that waits for a signal:
// "preflight", "down", "start" (before the start's own handlers), "starting"
// (after the hand-off, before ready) or "serving" (after ready). Each step prints one line to stdout.
// "runtime" (HACK-1953) makes the old run's stop a real runtime request to the
// executable in argv[3], started in the process group named by argv[4]
// ("own" or "inherit"), so a test can send a terminal-style SIGINT to the
// whole group while that request runs.
import { restartNativeProject } from "../../src/backends/native-project-restart.ts";
import type { NativeRestartIntent } from "../../src/backends/native-project-run.ts";
import { invokeNativeRuntime } from "../../src/backends/native-runtime-client.ts";

const hold = process.argv[2];
const runtimeBinary = process.argv[3];
const processGroup = process.argv[4] === "own" ? "own" : "inherit";
const say = (line: string) => process.stdout.write(`${line}\n`);
const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  effectiveEnvName: "qa",
  profiles: ["app"],
  aws: null,
};
const token = {
  version: 1 as const,
  attempt: "e".repeat(32),
  scope: "f".repeat(64),
  run: run.run,
  owner: run.owner,
  namespace: run.namespace,
  planId: run.planId,
};
let pending: NativeRestartIntent | null = null;
/** Announce the phase, then let it run long enough for the signal to arrive. */
async function phase(name: string): Promise<void> {
  say(`phase ${name}`);
  if (hold === name) {
    await Bun.sleep(1500);
  }
}
const restart = restartNativeProject({
  scope: {
    projectRoot: "/fixture",
    projectDir: "/fixture/.hack",
    nativeHome: "/candidate",
    branch: null,
  },
  preflight: async () => await phase("preflight"),
  down: async () => {
    await phase("down");
    if (hold === "runtime" && runtimeBinary) {
      await invokeNativeRuntime({
        runtime: { binary: runtimeBinary, home: "/candidate" },
        cwd: "/",
        args: ["graph", "cleanup", "--run-id", run.run, "--json"],
        processGroup,
      });
    }
    say("old run stopped");
  },
  progress: (event) =>
    say(event.phase === "stopping" ? "stopping" : `stopped: ${event.summary}`),
  start: async ({ signal, onStopSignals, onStopRequested, onReady }) => {
    await phase("start");
    if (signal.aborted) {
      throw new Error("start canceled before hand-off");
    }
    // The start's own stop handling, as nativeForegroundStopSignals installs it.
    const own = Promise.withResolvers<number>();
    process.once("SIGINT", () => {
      onStopRequested();
      own.resolve(130);
    });
    onStopSignals();
    if (hold === "starting") {
      // Stopped by its own owner before it became ready.
      await phase("starting");
    } else {
      await onReady();
      say("ready");
      await phase("serving");
    }
    const exit = await own.promise;
    say("new run stopped by its own owner");
    return exit;
  },
  dependencies: {
    load: async () => (pending?.phase === "cleaned" ? null : run),
    pending: async () => pending,
    save: async ({ intent }) => {
      pending = intent;
    },
    cleaned: async ({ expected }) => {
      pending = { ...expected, phase: "cleaned" };
      return pending;
    },
    remove: async () => {
      pending = null;
      say("intent removed");
    },
    capture: async () => token,
    wait: async () => {
      say("old frontend finalized");
    },
    lock: async (_scope, action) => await action(async () => undefined),
  },
});
const code = await restart.catch((error: unknown) => {
  say(`error ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
// Assigned in the callbacks above, which control-flow narrowing does not see.
const left = pending as NativeRestartIntent | null;
say(`pending ${left?.phase ?? "none"}`);
say(`exit ${code} listeners=${process.listenerCount("SIGINT")}`);
process.exit(code);
