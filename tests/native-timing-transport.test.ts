import { expect, test } from "bun:test";
import { fstatSync, writeSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hostMonotonicUs,
  timingChannel,
} from "../src/lib/native-timing-transport.ts";

const options = {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: { HACK_DAEMON_AUTOSTART_DISABLE: "1" },
} as const;
test("native timing channel is a nonblocking socket with idempotent closure", () => {
  const channel = timingChannel(),
    lines: string[] = [];
  try {
    expect(fstatSync(channel.sender).isSocket()).toBe(true);
    channel.drain((line) => lines.push(line));
    expect(lines).toEqual([]);
    writeSync(channel.sender, "record\n");
    channel.drain((line) => lines.push(line));
    expect(lines).toEqual(["record\n"]);
    channel.closeSender();
    channel.closeSender();
    expect(() => fstatSync(channel.sender)).toThrow();
  } finally {
    channel.close();
    channel.close();
  }
  channel.drain(() => {
    throw new Error("closed receiver was used");
  });
});
test("compiled native clock shares the host anchor and extra fd transfers", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-timing-clock-"))
  );
  try {
    const source = join(root, "probe.ts"),
      binary = join(root, "probe"),
      helper = join(root, "write.sh");
    await writeFile(helper, "#!/bin/sh\nprintf 'probe\\n' >&3\n", {
      mode: 0o700,
    });
    await writeFile(
      source,
      `import {hostMonotonicUs,timingChannel} from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/native-timing-transport.ts"))};
const channel=timingChannel(), lines=[];
try {const clock=hostMonotonicUs();const child=Bun.spawn([${JSON.stringify(helper)}],{stdio:["ignore","ignore","ignore",channel.sender]});channel.closeSender();if(await child.exited!==0)throw Error("descriptor");channel.drain(line=>lines.push(line));console.log(JSON.stringify({clock,lines}));} finally {channel.close();}`
    );
    const build = Bun.spawn(
      [process.execPath, "build", source, "--compile", "--outfile", binary],
      options
    );
    const error = await new Response(build.stderr).text();
    expect(error).not.toContain("error:");
    expect(await build.exited).toBe(0);
    const before = hostMonotonicUs();
    expect(before).toBeDefined();
    const child = Bun.spawn([binary], { ...options, timeout: 5000 });
    const value: unknown = JSON.parse(await new Response(child.stdout).text());
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
    const after = hostMonotonicUs();
    expect(value).toEqual({ clock: expect.any(Number), lines: ["probe\n"] });
    if (
      typeof value !== "object" ||
      value === null ||
      !("clock" in value) ||
      typeof value.clock !== "number"
    ) {
      throw new Error("invalid proof");
    }
    expect(value.clock).toBeGreaterThanOrEqual(
      before ?? Number.POSITIVE_INFINITY
    );
    expect(value.clock).toBeLessThanOrEqual(after ?? Number.NEGATIVE_INFINITY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
