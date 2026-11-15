import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSetupGuidance } from "../src/backends/native-runtime-setup.ts";
import { candidateUpdateRefusal } from "../src/commands/update.ts";
import {
  type CandidateLauncher,
  freshNativeHomeSetupCommand,
  resolveCandidateLauncher,
} from "../src/lib/candidate-launcher.ts";
import {
  basicBuildNextStep,
  composeBackendCommand,
} from "../src/lib/native-compose-backend-features.ts";
import {
  renderUpgradeCommand,
  upgradeCommandPrefix,
} from "../src/lib/upgrade-check.ts";

/**
 * HACK-2251: text that tells the user what to run names the launcher their
 * install actually has. A fake bundle directory holds `hack-cli` (standing in
 * for the running executable) and `hack-v5`; nothing is executed.
 */
let root: string;
let home: string;
let bundle: string;
let hackCli: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-launcher-")));
  home = join(root, "home");
  bundle = join(root, "versions", "5.0.0-next.18", "bundle");
  hackCli = join(bundle, "hack-cli");
  await Bun.write(hackCli, "");
  await writeFile(join(bundle, "hack-v5"), "#!/bin/sh\n");
  await chmod(join(bundle, "hack-v5"), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolve = (entry: string | undefined, execPath = hackCli) =>
  resolveCandidateLauncher({
    env: { HACK_CANDIDATE_ENTRYPOINT: entry },
    homeDir: home,
    execPath,
  });

test("each install kind resolves to a command the user can run", () => {
  expect(resolve(undefined)).toEqual({ kind: "stable", command: "hack" });
  expect(resolve("  ")).toEqual({ kind: "stable", command: "hack" });
  expect(resolve("hack-next")).toEqual({
    kind: "hack-next",
    command: join(home, ".hack-next", "bin", "hack-next"),
    bundle: join(bundle, "hack-v5"),
  });
  // A direct bundle run names its own hack-v5 by path, not the bare name.
  expect(resolve("hack-v5")).toEqual({
    kind: "bundle",
    command: join(bundle, "hack-v5"),
  });
  // Without an adjacent hack-v5 (a source run) the name is all there is.
  expect(resolve("hack-v5", join(root, "elsewhere", "bun"))).toEqual({
    kind: "bundle",
    command: "hack-v5",
  });
});

test("upgrade check and apply print the hack-next launcher on either backend", () => {
  const launcher = join(home, ".hack-next", "bin", "hack-next");
  for (const [backend, env] of [
    [undefined, ""],
    ["native", ""],
    ["compose", "HACK_RUNTIME_BACKEND=compose "],
  ] as const) {
    const prefix = upgradeCommandPrefix({
      env: {
        HACK_CANDIDATE_ENTRYPOINT: "hack-next",
        HACK_RUNTIME_BACKEND: backend,
      },
      homeDir: home,
      execPath: hackCli,
    });
    expect(renderUpgradeCommand(prefix, ["upgrade", "snapshot"])).toBe(
      `${env}${launcher} upgrade snapshot`
    );
  }
  const direct = upgradeCommandPrefix({
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-v5" },
    homeDir: home,
    execPath: hackCli,
  });
  expect(renderUpgradeCommand(direct, ["upgrade", "snapshot"])).toBe(
    `${join(bundle, "hack-v5")} upgrade snapshot`
  );
});

const kinds = (): readonly [
  CandidateLauncher,
  CandidateLauncher,
  CandidateLauncher,
] => [resolve(undefined), resolve("hack-next"), resolve("hack-v5")];

test("native setup guidance names setup through the user's launcher", () => {
  const [stable, next, direct] = kinds();
  expect(nativeSetupGuidance({ state: "not_set_up" }, stable)).toBe(
    "Native runtime is not set up; run hack native setup."
  );
  expect(nativeSetupGuidance({ state: "not_set_up" }, next)).toBe(
    `Native runtime is not set up; run ${join(home, ".hack-next", "bin", "hack-next")} native setup.`
  );
  expect(nativeSetupGuidance({ state: "partial_resumable" }, direct)).toBe(
    `Native runtime setup is incomplete; run ${join(bundle, "hack-v5")} native setup to resume.`
  );
});

test("a fresh native home is set up through the bundle's hack-v5, never hack-next", () => {
  // hack-next refuses a custom HACK_NATIVE_HOME, so both candidate kinds name
  // the bundle script by path.
  const [stable, next, direct] = kinds();
  const bundled = `HACK_NATIVE_HOME=<new private home> ${join(bundle, "hack-v5")} native setup`;
  expect(freshNativeHomeSetupCommand(next)).toBe(bundled);
  expect(freshNativeHomeSetupCommand(direct)).toBe(bundled);
  expect(freshNativeHomeSetupCommand(stable)).toBe(
    "HACK_NATIVE_HOME=<new private home> hack native setup"
  );
  for (const state of ["invalid_preserved", "pin_mismatch"] as const) {
    const text = nativeSetupGuidance({ state }, next);
    expect(text).toContain(join(bundle, "hack-v5"));
    expect(text).not.toContain("the bundle's hack-v5 launcher");
  }
});

test("the Compose-backend hint is a command for the user's launcher", () => {
  const [stable, next, direct] = kinds();
  expect(composeBackendCommand(["up"], stable)).toBe(
    "HACK_RUNTIME_BACKEND=compose hack up"
  );
  expect(composeBackendCommand(["restart"], next)).toBe(
    `HACK_RUNTIME_BACKEND=compose ${join(home, ".hack-next", "bin", "hack-next")} restart`
  );
  expect(composeBackendCommand(["up"], direct)).toBe(
    `HACK_RUNTIME_BACKEND=compose ${join(bundle, "hack-v5")} up`
  );
});

test("the basic-build hint previews config import through the user's launcher", () => {
  const [stable, next] = kinds();
  expect(basicBuildNextStep(stable)).toContain(
    "`hack config import --dry-run --path <project root>`"
  );
  expect(basicBuildNextStep(next)).toContain(
    `\`${join(home, ".hack-next", "bin", "hack-next")} config import --dry-run --path <project root>\``
  );
});

test("the self-update refusal names the channel manager only for hack-next", () => {
  const [, next, direct] = kinds();
  const launcher = join(home, ".hack-next", "bin", "hack-next");
  expect(candidateUpdateRefusal(next)).toBe(
    `Refusing to self-update the opt-in native candidate. Upgrade it through its channel manager: ${launcher} --manager upgrade --version <newer prerelease> (${launcher} --manager status shows the selected version).`
  );
  expect(candidateUpdateRefusal(direct)).toBe(
    "Refusing to self-update the opt-in native candidate. Install a separately reviewed candidate bundle to update it."
  );
});

test("paths that need quoting are quoted as single shell words", () => {
  const spaced = resolveCandidateLauncher({
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
    homeDir: join(root, "a home"),
  });
  expect(composeBackendCommand(["up"], spaced)).toBe(
    `HACK_RUNTIME_BACKEND=compose '${join(root, "a home", ".hack-next", "bin", "hack-next")}' up`
  );
});
