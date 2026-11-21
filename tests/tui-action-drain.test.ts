import { expect, test } from "bun:test";
import { consumeLogStream } from "../src/tui/log-stream.ts";

/** A child that writes 4 MiB to stderr, far past a pipe's capacity. */
function chattyChild() {
  return Bun.spawn(["sh", "-c", "head -c 4194304 /dev/zero >&2"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
}

test("a closed view keeps draining an action's stderr so the child can finish", async () => {
  const child = chattyChild();
  const lines: string[] = [];
  const drained = consumeLogStream({
    stream: child.stderr,
    isActive: () => false,
    onLine: (line) => lines.push(line),
    drainWhenInactive: true,
  });
  const exited = await Promise.race([
    Promise.all([child.exited, drained]).then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  expect(exited).toBe(true);
  expect(await child.exited).toBe(0);
  expect(lines).toEqual([]);
});

test("without draining, the same child blocks on its full pipe", async () => {
  const child = chattyChild();
  await consumeLogStream({
    stream: child.stderr,
    isActive: () => false,
    onLine: () => undefined,
  });
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1500).then(() => false),
  ]);
  expect(exited).toBe(false);
  child.kill("SIGKILL");
  await child.exited;
});
