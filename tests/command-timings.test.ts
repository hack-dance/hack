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
import { fstatSync, writeSync } from "node:fs";
const flag = process.argv.find((arg) => arg.startsWith("--internal-timings="));
let fdOpen = true;
try { fdOpen = fstatSync(3).isSocket(); } catch { fdOpen = false; }
console.log(JSON.stringify([Boolean(flag), fdOpen]));
if (flag) {
  const [fd, trace, parent, spawn] = flag.split("=")[1].split(":");
  await Bun.sleep(200);
  const record = {
    schema: "hack.timings/1", trace, parent, span: "00f067aa0ba902b7",
    proc: "runtime", clock: "host", origin_unix_us: 1,
    origin_mono_us: Number(spawn), step: "container.start",
    start_us: 0, dur_us: 1, outcome: "ok",
  };
  const send = (value, suffix = "\\n") => writeSync(Number(fd), JSON.stringify(value) + suffix);
  send({...record, step: "forged.root", parent: null});
  send({...record, step: "forged.cli", proc: "cli"});
  send({...record, step: "forged.collision", span: parent, parent: record.span});
  send({...record, step: "forged.partial"}, "");
  send({...record, step: "forged.cached", cached: false});
  send({...record, step: "forged.attrs", attrs: []});
  send({...record, step: "forged.outcome", outcome: 1});
  for (let i = 0; i < 1100; i++) {
    send({...record, span: (i + 1).toString(16).padStart(16,"0")});
    if (i % 8 === 0) await Bun.sleep(2);
  }
}`;

test("child timing is opt-in, nonblocking, validated and capped across children", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-timings-"));
  const file = join(root, "timings.jsonl");
  const script = join(root, "child");
  const run = async (enabled: boolean) => {
    const child = timedNativeSpawn([script], options);
    const stdout = await new Response(child.stdout).text();
    expect(JSON.parse(stdout)).toEqual([enabled, enabled]);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
  };
  try {
    await writeFile(script, `#!${process.execPath}\n${childSource}`, {
      mode: 0o700,
    });
    await run(false);
    expect(await readdir(root)).toEqual(["child"]);
    await withCommandTimings(file, async () => {
      const first = run(true);
      const elapsed = performance.now();
      await Bun.sleep(30);
      expect(performance.now() - elapsed).toBeLessThan(180);
      await first;
      await run(true);
    });
    const lines = (await Bun.file(file).text()).trim().split("\n");
    const records = lines.map(readTimingLine);
    expect(records).toHaveLength(2048);
    expect(records.every((r) => r && !r.step.startsWith("forged."))).toBe(true);
    const service = records[0];
    const request = records.find((r) => r?.step === "runtime.request");
    expect(service?.step).toBe("container.start");
    expect(service?.parent).toBe(request?.span);
    expect(service?.trace).toBe(request?.trace);
    expect(records.at(-1)?.step).toBe("timings.truncated");
    expect(records.at(-1)?.attrs.dropped).toBe(156);
    await withCommandTimings(file, () => run(false));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
