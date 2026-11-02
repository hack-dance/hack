import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./e2e/harness.ts";
import {
  prepareNativeEngineTripwire,
  qualifyNativeEngineTripwire,
} from "./e2e/native-engine-tripwire.ts";

test("engine tripwire proves exact executable dispatch and resets only its witnessed marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-engine-tripwire-"));
  try {
    const marker = await prepareNativeEngineTripwire({ directory });
    expect(await Bun.file(marker).exists()).toBe(false);
    const result = await runCommand({
      argv: [join(directory, "docker"), "compose", "up"],
      cwd: directory,
      timeoutMs: 2000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(99);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(await Bun.file(marker).text()).toBe("called");
    await expect(
      qualifyNativeEngineTripwire({
        executable: join(directory, "docker"),
        marker,
        cwd: directory,
      })
    ).rejects.toThrow("stale marker");
    expect(await Bun.file(marker).text()).toBe("called");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  "literal-newlines",
  "missing-marker",
] as const)("engine tripwire qualification rejects %s even when the engine marker is absent", async (broken) => {
  const directory = await mkdtemp(
    join(tmpdir(), "native-engine-tripwire-red-")
  );
  try {
    const executable = join(directory, "docker");
    const marker = join(directory, "engine-called");
    const program =
      broken === "literal-newlines"
        ? `#!${process.execPath}\\nawait Bun.write(${JSON.stringify(marker)}, "called");process.exit(99);\\n`
        : `#!${process.execPath} --no-env-file\nprocess.exit(99);\n`;
    await writeFile(executable, program, { mode: 0o700 });
    await expect(
      qualifyNativeEngineTripwire({ executable, marker, cwd: directory })
    ).rejects.toThrow();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
