import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("v5 guest engine output is capped while its producer continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-guest-log-"));
  try {
    const logPath = join(root, "engine.log");
    const markerPath = join(root, "completed");
    const script = await Bun.file(
      "packages/runtime-core/src/provider/guest-daemon.sh"
    ).text();
    await writeFile(
      join(root, "dockerd"),
      `#!/bin/sh\nexec "$HACK_TEST_BUN" "$HACK_TEST_PRODUCER"\n`,
      { mode: 0o755 }
    );
    const producer = join(root, "producer.ts");
    await writeFile(
      producer,
      `import { writeSync } from "node:fs";
const chunk = Buffer.alloc(65536, "x");
for (let index = 0; index < 120; index++) {
  writeSync(index % 2 === 0 ? 1 : 2, chunk);
}
await Bun.write(process.env.HACK_TEST_MARKER, "complete");
`
    );
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        script.replaceAll(
          "/storage/hack-local-dockerd.log",
          '"$HACK_TEST_LOG"'
        ),
        "guest-daemon",
        "isolated",
      ],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          HACK_TEST_BUN: process.execPath,
          HACK_TEST_PRODUCER: producer,
          HACK_TEST_MARKER: markerPath,
          HACK_TEST_LOG: logPath,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect((await stat(logPath)).size).toBe(5 * 1024 * 1024);
    expect(await Bun.file(markerPath).text()).toBe("complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
