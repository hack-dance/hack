import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  timedNativeSpawn,
  withCommandTimings,
} from "../src/lib/command-timings.ts";
import { readTimingLine } from "../src/lib/timing-record.ts";

const options = { stdin: "ignore", stdout: "pipe", stderr: "pipe" } as const;
const childSource = `
import { writeSync } from "node:fs";
const flag = process.argv.find((arg) => arg.startsWith("--internal-timings="));
if (flag) {
  const [fd, trace, parent, spawn] = flag.split("=")[1].split(":");
  writeSync(Number(fd), JSON.stringify({
    schema: "hack.timings/1", trace, parent, span: "00f067aa0ba902b7",
    proc: "runtime", clock: "host", origin_unix_us: 1,
    origin_mono_us: Number(spawn), step: "container.start",
    start_us: 0, dur_us: 1, outcome: "ok",
  }) + "\\n");
}`;

test("timings stay off by default and join records over the selected descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-timings-"));
  const file = join(root, "timings.jsonl");
  const script = join(root, "child");
  const run = async () => {
    const child = timedNativeSpawn([script], options);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
  };
  try {
    await writeFile(script, `#!${process.execPath}\n${childSource}`, {
      mode: 0o700,
    });
    await run();
    expect(await readdir(root)).toEqual(["child"]);
    await withCommandTimings(file, run);
    const [service, request, command] = (await Bun.file(file).text())
      .trim()
      .split("\n")
      .map(readTimingLine);
    expect(service?.step).toBe("container.start");
    expect(service?.parent).toBe(request?.span);
    expect(service?.trace).toBe(command?.trace);
    expect(
      readTimingLine('{"schema":"hack.timings/1","step":"unsafe/path"}')
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
