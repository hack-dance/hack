import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

test("native disk usage reports partial host totals without starting the pool", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-disk-usage-"));
  try {
    const binary = join(root, "hack-native");
    await writeFile(
      binary,
      `#!/bin/sh
[ "$#" -eq 5 ] && [ "$1" = --candidate-root ] && [ "$3" = runtime ] && [ "$4" = disk-usage ] && [ "$5" = --json ] || exit 2
printf '%s\\n' '{"scope":"candidate-state-metadata-only","complete":false,"total_allocated_file_bytes":512,"total_logical_file_bytes":32768,"categories":{"directory/run":{"allocated_file_bytes":512,"logical_file_bytes":32768}}}'
`,
      { mode: 0o700 }
    );
    const env = privateCliEnv({
      root,
      env: { HACK_NATIVE_BINARY: binary, HACK_NATIVE_HOME: root },
    });
    async function run(command: string[], flags: string[]) {
      const child = Bun.spawn(
        [process.execPath, resolve("index.ts"), ...command, ...flags],
        { cwd: root, env, stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      return stdout;
    }

    const human = await run(["native", "disk-usage"], []);
    expect(human).toContain(
      "Native home total · 512 B allocated · 32768 B logical"
    );
    expect(human).toContain("Disk usage scan was incomplete.");
    expect(human).toContain("Reclaimable bytes: unknown");

    expect(
      JSON.parse(await run(["native", "disk-usage"], ["--json"]))
    ).toMatchObject({
      ok: true,
      data: {
        scope: "native-home-host-files",
        complete: false,
        allocatedBytes: 512,
        logicalBytes: 32_768,
        reclaimableBytes: null,
        categories: [
          {
            label: "Runtime state and VM disks",
            allocatedBytes: 512,
            logicalBytes: 32_768,
          },
        ],
      },
    });
    const doctor = ["doctor", "--disk"];
    expect(await run(doctor, [])).toContain(
      "Native home disk usage · 512 B allocated · 32768 B logical · incomplete scan"
    );
    expect(JSON.parse(await run(doctor, ["--json"]))).toMatchObject({
      ok: true,
      data: {
        checks: [
          {
            id: "native disk usage",
            status: "warn",
            detail: "512 B allocated · 32768 B logical · incomplete scan",
          },
        ],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
