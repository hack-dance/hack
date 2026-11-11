import { expect, test } from "bun:test";
import { COMPILER_HOSTS } from "../scripts/ci-change-scope.ts";

/**
 * HACK-1978. The stable build smoke is not a separate workflow: every push to
 * `next` or `main` already builds the stable archive on each release host in
 * CI's `Config compiler (<host>)` jobs and runs
 * `scripts/check-release-config-compiler.ts` on it, which installs the archive
 * through the generated download scripts and runs the installed `hack`. These
 * tests keep that claim true: the hosts `release.yml` publishes from must stay
 * covered by the CI push matrix, with the same toolchain pins and the same
 * build and acceptance commands.
 */

/** Runner label of each `release.yml` build host and the archive target it produces. */
const RELEASE_HOST_TARGETS: Record<string, string> = {
  "ubuntu-latest": "linux/x64",
  "ubuntu-24.04-arm": "linux/arm64",
  "macos-15": "darwin/arm64",
  "macos-15-intel": "darwin/x64",
};

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly permissions?: Record<string, string>;
  readonly strategy?: { readonly matrix?: { readonly include?: unknown } };
  readonly steps: readonly Step[];
}

async function job(workflow: string, name: string): Promise<Job> {
  const parsed = Bun.YAML.parse(
    await Bun.file(`.github/workflows/${workflow}`).text()
  ) as { jobs: Record<string, Job> };
  const found = parsed.jobs[name];
  if (found === undefined) {
    throw new Error(`${workflow} has no ${name} job`);
  }
  return found;
}

function pins(steps: readonly Step[]) {
  const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  const rust = steps.find((step) =>
    step.uses?.startsWith("dtolnay/rust-toolchain@")
  );
  return { bun: bun?.with?.["bun-version"], rust: rust?.uses };
}

function runs(steps: readonly Step[]): string {
  return steps.map((step) => step.run ?? "").join("\n");
}

test("every stable release build host is a CI push compiler host", async () => {
  const release = await job("release.yml", "build");
  const include = release.strategy?.matrix?.include;
  expect(Array.isArray(include)).toBe(true);
  const labels = (include as { os: string }[]).map((entry) => entry.os);
  // A new or renamed release runner must be added to the table above, and then to CI.
  const targets = labels.map((label) => RELEASE_HOST_TARGETS[label]);
  expect(targets).not.toContain(undefined);
  expect(new Set(targets).size).toBe(labels.length);
  const ci = COMPILER_HOSTS.map((host) => `${host.platform}/${host.arch}`);
  expect([...targets].sort()).toEqual([...ci].sort());
});

test("CI and the release build use the same pins, build and installed-archive acceptance", async () => {
  const release = await job("release.yml", "build");
  const ci = await job("ci.yml", "config-compiler");
  expect(pins(release.steps)).toEqual(pins(ci.steps));
  expect(pins(ci.steps)).toEqual({
    bun: expect.any(String),
    rust: expect.stringMatching(/^dtolnay\/rust-toolchain@\d+\.\d+\.\d+$/),
  });
  // CI builds without a version override, so its archive carries package.json's
  // version: the one a stable tag must equal (stableReleaseVersion).
  expect(runs(ci.steps)).toContain(
    "bun run build:release --skip-tests --out=dist/config-compiler-release\n"
  );
  expect(runs(ci.steps)).toContain(
    "bun scripts/check-release-config-compiler.ts dist/config-compiler-release\n"
  );
  expect(runs(release.steps)).toContain(
    'bun run build:release "--version=$RELEASE_VERSION" --skip-tests'
  );
  // The release accepts the installed archive before it uploads anything.
  const names = release.steps.map((step) => step.run ?? step.name ?? "");
  const accepted = names.indexOf(
    "bun scripts/check-release-config-compiler.ts dist/release"
  );
  const uploaded = release.steps.findIndex((step) =>
    (step.run ?? "").includes("gh release upload")
  );
  expect(accepted).toBeGreaterThan(-1);
  expect(uploaded).toBeGreaterThan(accepted);
  // The CI smoke cannot publish: its token is read-only.
  expect(ci.permissions).toEqual({ contents: "read" });
});
