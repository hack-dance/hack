import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NATIVE_PLAN_CLI_CHECKS } from "../scripts/check-native-plan-clis.ts";

const root = resolve(import.meta.dir, "..");
const owned: string[] = [];

afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** Compiled-bundle CLI checks that CI runs and the local command must cover. */
async function discoveredChecks(): Promise<string[]> {
  const names = await readdir(join(root, "scripts"));
  return names
    .filter(
      (name) =>
        /^check-native-[a-z-]+-plan-cli\.ts$/.test(name) ||
        name === "check-native-config-import-cli.ts" ||
        name === "check-config-compiler-cli.ts"
    )
    .map((name) => `scripts/${name}`)
    .sort();
}

test("check:native-plan-cli runs every compiled-bundle plan CLI check", async () => {
  const discovered = await discoveredChecks();
  expect(discovered.length).toBeGreaterThanOrEqual(8);
  expect(Array.from(NATIVE_PLAN_CLI_CHECKS, String).sort()).toEqual(discovered);

  const scripts = (await Bun.file(join(root, "package.json")).json()).scripts;
  expect(scripts["check:native-plan-cli"]).toBe(
    "bun run check:bun-version && bun scripts/check-native-plan-clis.ts"
  );
});

test("every local plan CLI check is also a CI step", async () => {
  const ci = await Bun.file(join(root, ".github/workflows/ci.yml")).text();
  for (const script of NATIVE_PLAN_CLI_CHECKS) {
    expect(ci, `${script} is not run in CI`).toMatch(
      new RegExp(`^\\s+bun ${script.replaceAll(".", "\\.")}$`, "m")
    );
  }
});

test("the runner refuses to start without the built bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hack-native-plan-cli-"));
  owned.push(directory);
  await mkdir(join(directory, "scripts"));
  await copyFile(
    join(root, "scripts/check-native-plan-clis.ts"),
    join(directory, "scripts/check-native-plan-clis.ts")
  );
  const child = Bun.spawn(
    [process.execPath, join(directory, "scripts/check-native-plan-clis.ts")],
    {
      cwd: directory,
      env: { PATH: process.env.PATH ?? "", HOME: directory },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("dist/hack is missing");
  expect(stderr).toContain("bun run build && bun run build:config-compiler");
});
