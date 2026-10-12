import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Selection fails before any runtime, host DNS or privileged step. */
async function invoke(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), "hack-local-route-cli-"));
  roots.push(home);
  const child = Bun.spawn([process.execPath, "index.ts", ...args], {
    env: {
      ...process.env,
      HOME: home,
      HACK_HOME: join(home, ".hack"),
      HACK_GLOBAL_CONFIG_PATH: join(home, ".hack", "hack.config.json"),
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "/nonexistent/hack-native",
      HACK_NATIVE_HOME: "/nonexistent/native-home",
      HACK_NO_INTERACTIVE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output: stdout + stderr, code };
}

for (const verb of ["preview", "activate", "deactivate"]) {
  test(`global dns ${verb} without --domain names the right command`, async () => {
    const result = await invoke(["global", "dns", verb]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `hack global dns ${verb} needs --domain: the default domain hack.local is a built-in root`
    );
    expect(result.output).toContain("hack doctor --fix");
    expect(result.output).toContain(
      "hack global dns deactivate --domain hack.local"
    );
    expect(result.output).not.toContain("Native domain DNS plan refused");
  });
}

test("global dns activate --domain hack.local points to the doctor repair", async () => {
  const result = await invoke([
    "global",
    "dns",
    "activate",
    "--domain",
    "hack.local",
  ]);
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    "Repair its native route with: hack doctor --fix"
  );
});
