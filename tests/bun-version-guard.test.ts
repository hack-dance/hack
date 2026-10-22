import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUN_VERSION_OVERRIDE_ENV,
  checkBunVersion,
} from "../scripts/check-bun-version.ts";

const root = resolve(import.meta.dir, "..");
const owned: string[] = [];

afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function pinned(): Promise<string> {
  const manifest = await Bun.file(join(root, "package.json")).json();
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager);
  if (!match?.[1]) {
    throw new Error("packageManager is not an exact Bun pin");
  }
  return match[1];
}

test("matching Bun passes; a mismatch fails unless the override is exactly 1", () => {
  const packageManager = "bun@1.4.2";
  expect(
    checkBunVersion({ running: "1.4.2", packageManager, override: undefined })
  ).toEqual({ kind: "match", pinned: "1.4.2" });

  const mismatch = checkBunVersion({
    running: "1.4.3",
    packageManager,
    override: undefined,
  });
  expect(mismatch.kind).toBe("mismatch");
  if (mismatch.kind !== "mismatch") {
    throw new Error("expected mismatch");
  }
  expect(mismatch.message).toContain("Bun 1.4.3 is running");
  expect(mismatch.message).toContain("bun@1.4.2");
  expect(mismatch.message).toContain("mise x bun@1.4.2 -- bun run <script>");
  expect(mismatch.message).toContain(`${BUN_VERSION_OVERRIDE_ENV}=1`);

  for (const override of ["", "0", "true", "yes"]) {
    expect(
      checkBunVersion({ running: "1.4.3", packageManager, override }).kind
    ).toBe("mismatch");
  }
  expect(
    checkBunVersion({ running: "1.4.3", packageManager, override: "1" }).kind
  ).toBe("overridden");
});

test("a missing or inexact packageManager pin is rejected", () => {
  for (const packageManager of [
    undefined,
    42,
    "bun",
    "bun@1.4",
    "bun@^1.4.2",
    "npm@1.4.2",
    "bun@1.4.2 ",
  ]) {
    expect(
      checkBunVersion({ running: "1.4.2", packageManager, override: "1" }).kind
    ).toBe("invalid-pin");
  }
});

test("the script exits nonzero on a mismatch and zero with the override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hack-bun-version-guard-"));
  owned.push(directory);
  await Promise.all([
    mkdir(join(directory, "scripts")),
    mkdir(join(directory, "src/lib"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(
      join(root, "scripts/check-bun-version.ts"),
      join(directory, "scripts/check-bun-version.ts")
    ),
    copyFile(
      join(root, "src/lib/guards.ts"),
      join(directory, "src/lib/guards.ts")
    ),
    Bun.write(
      join(directory, "package.json"),
      JSON.stringify({ packageManager: "bun@0.0.1" })
    ),
  ]);
  const run = async (env: Record<string, string>) => {
    const child = Bun.spawn(
      [process.execPath, join(directory, "scripts/check-bun-version.ts")],
      {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "", HOME: directory, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { exit, stderr };
  };

  const refused = await run({});
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toContain(`Bun ${Bun.version} is running`);
  expect(refused.stderr).toContain("bun@0.0.1");

  const allowed = await run({ [BUN_VERSION_OVERRIDE_ENV]: "1" });
  expect(allowed.exit).toBe(0);
  expect(allowed.stderr).toContain("Warning:");
});

test("mise, asdf and CI agree with the packageManager pin", async () => {
  const version = await pinned();
  const mise = await Bun.file(join(root, "mise.toml")).text();
  expect(mise).toMatch(
    new RegExp(`^bun = "${version.replaceAll(".", "\\.")}"$`, "m")
  );
  const toolVersions = await Bun.file(join(root, ".tool-versions")).text();
  expect(toolVersions).toMatch(
    new RegExp(`^bun\\s+${version.replaceAll(".", "\\.")}$`, "m")
  );

  const workflows = join(root, ".github/workflows");
  let literalPins = 0;
  for (const name of await readdir(workflows)) {
    const text = await Bun.file(join(workflows, name)).text();
    for (const match of text.matchAll(/bun-version:\s*"?([^"\s]+)"?/g)) {
      if (match[1]?.startsWith("${{")) {
        continue;
      }
      literalPins += 1;
      expect(match[1], `${name} pins another Bun`).toBe(version);
    }
  }
  expect(literalPins).toBeGreaterThan(0);
});

test("local test, check and typecheck entry points run the Bun guard", async () => {
  const guard = "bun run check:bun-version && ";
  const rootScripts = (await Bun.file(join(root, "package.json")).json())
    .scripts;
  expect(rootScripts["check:bun-version"]).toBe(
    "bun scripts/check-bun-version.ts"
  );
  for (const name of ["test", "check", "typecheck", "check:native-plan-cli"]) {
    expect(rootScripts[name], name).toStartWith(guard);
  }

  const cliScripts = (
    await Bun.file(join(root, "packages/cli/package.json")).json()
  ).scripts;
  expect(cliScripts.typecheck).toStartWith(
    "bun ../../scripts/check-bun-version.ts && "
  );
  expect(cliScripts.test).toStartWith(`cd ../.. && ${guard}`);
  expect(cliScripts.check).toStartWith(`cd ../.. && ${guard}`);

  // Turbo's strict environment mode would otherwise drop the override for
  // package tasks, so the documented opt-in must pass through.
  const turbo = await Bun.file(join(root, "turbo.json")).json();
  expect(turbo.globalPassThroughEnv).toContain(BUN_VERSION_OVERRIDE_ENV);
});
