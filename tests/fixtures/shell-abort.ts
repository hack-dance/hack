import { getEventListeners } from "node:events";
import { join } from "node:path";
import { type RunExitEvent, run } from "../../src/lib/shell.ts";

const [mode, root, python, worker] = process.argv.slice(2);
if (!(mode && root && python && worker)) {
  throw new Error("missing synthetic fixture arguments");
}
const controller = new AbortController();
const replacement = new AbortController();
let spawned = false;
let exit: RunExitEvent | undefined;
if (mode === "pre-abort") {
  controller.abort("PRIVATE_ABORT_CANARY");
}
const options = {
  signal: controller.signal,
  forwardSignals: true,
  timeoutMs: 10_000,
  onSpawn: async () => {
    spawned = true;
    options.signal = replacement.signal;
    if (mode === "active-abort") {
      const deadline = Date.now() + 2000;
      while (
        !(await Bun.file(join(root, "grandchild.pid")).exists()) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      if (!(await Bun.file(join(root, "grandchild.pid")).exists())) {
        throw new Error("synthetic child readiness unavailable");
      }
      controller.abort("PRIVATE_ABORT_CANARY");
    }
  },
  onExit: async (event: RunExitEvent) => {
    exit = event;
  },
};
const code = await run([python, worker, "worker", root, mode], options);
const listenersAfter = getEventListeners(controller.signal, "abort").length;
controller.abort("PRIVATE_ABORT_CANARY");
await Bun.sleep(50);
await Bun.write(
  join(root, "result.json"),
  JSON.stringify({ code, spawned, exit, listenersAfter })
);
