import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, runCommand } from "./harness.ts";

/** Qualify the exact executable before an absent marker can prove no engine request. */
export async function qualifyNativeEngineTripwire(opts: {
  readonly executable: string;
  readonly marker: string;
  readonly cwd: string;
}): Promise<void> {
  expect({
    that: !(await Bun.file(opts.marker).exists()),
    message: "The engine tripwire must start without a stale marker",
  });
  const result = await runCommand({
    argv: [opts.executable, "version"],
    cwd: opts.cwd,
    timeoutMs: 5000,
  });
  expect({
    that:
      !result.timedOut &&
      result.exitCode === 99 &&
      result.stdout === "" &&
      result.stderr === "" &&
      (await Bun.file(opts.marker).exists()) &&
      (await Bun.file(opts.marker).text()) === "called",
    message:
      "The engine tripwire executable must prove its exact marker and exit",
  });
  await unlink(opts.marker);
}

/** Create a synthetic Docker replacement; it never delegates to an engine. */
export async function prepareNativeEngineTripwire(opts: {
  readonly directory: string;
}): Promise<string> {
  const executable = join(opts.directory, "docker");
  const marker = join(opts.directory, "engine-called");
  await Bun.write(
    executable,
    `#!${process.execPath} --no-env-file\nawait Bun.write(${JSON.stringify(marker)}, "called");process.exit(99);\n`
  );
  await chmod(executable, 0o700);
  await qualifyNativeEngineTripwire({
    executable,
    marker,
    cwd: opts.directory,
  });
  return marker;
}
