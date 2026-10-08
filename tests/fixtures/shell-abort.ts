import { getEventListeners } from "node:events";
import { join } from "node:path";
import { type RunExitEvent, run } from "../../src/lib/shell.ts";

const [mode, root, python, worker] = process.argv.slice(2);
if (!(mode && root && python && worker)) {
  throw new Error("missing synthetic fixture arguments");
}
const controller = new AbortController();
const replacement = new AbortController();
const cancelFromOs = () => controller.abort("PRIVATE_ABORT_CANARY");
// Register in the same order as the production command's outer controller.
process.on("SIGINT", cancelFromOs);
process.on("SIGTERM", cancelFromOs);
let spawned = false;
let exit: RunExitEvent | undefined;
if (mode === "pre-abort") {
  controller.abort("PRIVATE_ABORT_CANARY");
}
const options = {
  signal: controller.signal,
  forwardSignals: true,
  timeoutMs: 10_000,
  stdin: mode.startsWith("pipe-") ? ("ignore" as const) : ("inherit" as const),
  onSpawn: async ({ pid }: { readonly pid: number }) => {
    spawned = true;
    await Bun.write(join(root, "group.pid"), String(pid));
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
const command = mode.startsWith("pipe-")
  ? [
      "/bin/sh",
      "-c",
      "trap '' TERM INT; (trap '' TERM INT; sleep 30) & echo $! > \"$1\"; wait",
      "sh",
      join(root, "grandchild.pid"),
    ]
  : [python, worker, "worker", root, mode];
const code = await run(command, options);
process.off("SIGINT", cancelFromOs);
process.off("SIGTERM", cancelFromOs);
const listenersAfter = getEventListeners(controller.signal, "abort").length;
controller.abort("PRIVATE_ABORT_CANARY");
await Bun.sleep(50);
await Bun.write(
  join(root, "result.json"),
  JSON.stringify({ code, spawned, exit, listenersAfter })
);
