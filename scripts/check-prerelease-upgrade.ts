#!/usr/bin/env bun
/**
 * Release gate (HACK-2262): before a prerelease publishes, install the previous
 * published prerelease into a fresh channel with that release's own standalone
 * manager, then upgrade it to the candidate with the documented command, which
 * runs the channel's retained (previous) manager:
 *
 *   <root>/bin/hack-next --manager upgrade --version <candidate> --archive ... --sha256 ...
 *
 * The gate fails when that upgrade fails. It then also reports whether the
 * documented extra step works (the candidate's standalone manager running
 * `upgrade-manager` on the channel, then the same upgrade). A release may pass on
 * that step only with HACK_PRERELEASE_ACCEPT_MANAGER_STEP=1, which means its
 * release notes tell existing users to run it. The prerelease workflow does not
 * set it: using it is a deliberate maintainer change to that workflow.
 *
 * It executes the previous release only when its manager is a reviewed
 * predecessor and its archive is pinned in this file; release assets are
 * mutable. The managers run with a fixed environment (no token, no output path),
 * the candidate is installed from copies, and the gate fails if the packaged
 * candidate assets changed while it ran.
 *
 * Inputs: HACK_PRERELEASE_VERSION, HACK_PRERELEASE_OUTPUT (the packaged candidate
 * assets) and a GitHub token for `gh` (GH_TOKEN). Runs on Apple Silicon macOS
 * only; it starts no runtime and changes nothing outside its own temp directory.
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEWED_PREDECESSORS } from "./installer/channel.ts";
import {
  candidateVersion,
  compareCandidateVersions,
  digest,
} from "./installer/integrity.ts";

const REPOSITORY = "hack-dance/hack";
const PLATFORM = "darwin-arm64";
export const MANAGER_ASSET = "hack-next-manager-darwin-arm64";
const TAG = /^v(5\.\d+\.\d+-next\.\d+)$(?![\s\S])/;

/**
 * Published prereleases, pinned in review: each release's manager
 * (`INSTALLER-SHA256SUMS`) and archive (`SHA256SUMS`) digests when it published.
 * Release assets can be replaced after publication, so the gate executes a
 * previous release only when both match this release's own pins; the manager
 * must also be a reviewed predecessor. Binding the manager to its release stops
 * a later reviewed manager from standing in for an older one and hiding exactly
 * the incompatibility this gate exists to catch. Add each release when it
 * publishes.
 */
export const PUBLISHED_RELEASES: Readonly<
  Record<string, { readonly manager: string; readonly archive: string }>
> = {
  "5.0.0-next.17": {
    manager: "85bbe4f064b3277efc88a9f79c197e81950ab8881320aef1b3443b70d95b530f",
    archive: "6f63804f5f81935ba9cfa05ab085e1ccbffc789e89633277547b0e85da1e1466",
  },
  "5.0.0-next.18": {
    manager: "90d1bc60bfd2b7eaad48dcf56ad45264f395c0ac1a8c4530e986be7fa194d4d9",
    archive: "da7c3e74629c049a25c40fbe95c5aa35433f241499065df372a23b27ee95aaee",
  },
};

/** A fixed environment for the managers: no token, output path or caller state. */
function managerEnvironment(work: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: join(work, "home"),
    TMPDIR: join(work, "tmp"),
    LC_ALL: "C",
  };
}

/** Name to sha256 of every regular file directly in `directory`. */
function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, digest(join(directory, entry.name))])
  );
}

/** The newest published prerelease older than `candidate`, or null. */
export function previousPrerelease(
  tags: readonly string[],
  candidate: string
): string | null {
  const older = tags
    .map((tag) => TAG.exec(tag)?.[1])
    .filter(
      (version): version is string =>
        version !== undefined &&
        compareCandidateVersions(version, candidate) < 0
    )
    .sort((a, b) => compareCandidateVersions(a, b));
  return older.at(-1) ?? null;
}

/** The sha256 a `SHA256SUMS`-style file lists for `name`; throws when absent. */
export function listedDigest(sums: string, name: string): string {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match?.[2] === name) {
      return match[1] as string;
    }
  }
  throw new Error(`${name} is not listed in its release's checksums.`);
}

export function archiveName(version: string): string {
  return `hack-${version}-${PLATFORM}-native.tar.gz`;
}

type Step = { readonly ok: boolean; readonly output: string };

function step(
  argv: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>
): Step {
  const result = Bun.spawnSync([...argv], {
    ...(env ? { env } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const output =
    `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  return {
    ok: result.exitCode === 0 && result.exitedDueToTimeout !== true,
    output:
      result.exitedDueToTimeout === true
        ? `${argv[0]} did not finish within ${timeoutMs} ms`
        : output,
  };
}

function required(step: Step, what: string): string {
  if (!step.ok) {
    throw new Error(`${what} failed: ${step.output}`);
  }
  return step.output;
}

async function main(): Promise<number> {
  const candidate = process.env.HACK_PRERELEASE_VERSION ?? "";
  const output = process.env.HACK_PRERELEASE_OUTPUT ?? "";
  candidateVersion(candidate);
  if (!output) {
    throw new Error("HACK_PRERELEASE_OUTPUT is required.");
  }
  const tags = required(
    step(
      [
        "gh",
        "api",
        "--paginate",
        `repos/${REPOSITORY}/releases`,
        "--jq",
        ".[] | select(.draft | not) | .tag_name",
      ],
      120_000
    ),
    "Listing published releases"
  ).split("\n");
  const previous = previousPrerelease(tags, candidate);
  if (previous === null) {
    console.log(
      `No published prerelease precedes ${candidate}; nothing to upgrade.`
    );
    return 0;
  }
  // Managers refuse a path that is not canonical; macOS tmpdir() is /var/...,
  // a link to /private/var.
  const work = realpathSync(mkdtempSync(join(tmpdir(), "hack-upgrade-gate-")));
  try {
    const assets = join(work, "previous");
    required(
      step(
        [
          "gh",
          "release",
          "download",
          `v${previous}`,
          "--repo",
          REPOSITORY,
          "--dir",
          assets,
          "--pattern",
          MANAGER_ASSET,
          "--pattern",
          "INSTALLER-SHA256SUMS",
          "--pattern",
          archiveName(previous),
          "--pattern",
          "SHA256SUMS",
        ],
        600_000
      ),
      `Downloading ${previous}`
    );
    const previousManager = join(assets, MANAGER_ASSET);
    const previousArchive = join(assets, archiveName(previous));
    const sums = (name: string) => Bun.file(join(assets, name)).text();
    // The release's own checksum files are only a consistency check: they
    // live beside the assets. Execution needs this release's reviewed pins.
    const pins = PUBLISHED_RELEASES[previous];
    if (pins === undefined) {
      throw new Error(
        `${previous} is not pinned (PUBLISHED_RELEASES in scripts/check-prerelease-upgrade.ts); add its published manager and archive digests in review before this gate runs it.`
      );
    }
    const managerDigest = digest(previousManager);
    if (
      managerDigest !== pins.manager ||
      !REVIEWED_PREDECESSORS.includes(managerDigest) ||
      listedDigest(await sums("INSTALLER-SHA256SUMS"), MANAGER_ASSET) !==
        pins.manager
    ) {
      throw new Error(
        `${previous}'s manager does not match its pin or is not a reviewed predecessor (REVIEWED_PREDECESSORS in scripts/installer/channel.ts).`
      );
    }
    const previousSum = pins.archive;
    if (
      digest(previousArchive) !== previousSum ||
      listedDigest(await sums("SHA256SUMS"), archiveName(previous)) !==
        previousSum
    ) {
      throw new Error(`${previous}'s archive does not match its pin.`);
    }
    chmodSync(previousManager, 0o700);
    // Run the candidate from copies, and prove afterwards that nothing the gate
    // ran changed the assets that will be uploaded.
    const before = snapshot(output);
    const copies = join(work, "candidate");
    mkdirSync(copies, { mode: 0o700 });
    for (const name of [MANAGER_ASSET, archiveName(candidate)]) {
      copyFileSync(join(output, name), join(copies, name));
    }
    const candidateManager = join(copies, MANAGER_ASSET);
    const candidateArchive = join(copies, archiveName(candidate));
    const candidateSum = listedDigest(
      await Bun.file(join(output, "SHA256SUMS")).text(),
      archiveName(candidate)
    );
    if (digest(candidateArchive) !== candidateSum) {
      throw new Error("The candidate archive does not match its checksums.");
    }
    const env = managerEnvironment(work);
    mkdirSync(env.HOME as string, { mode: 0o700 });
    mkdirSync(env.TMPDIR as string, { mode: 0o700 });
    const unchanged = () => {
      if (JSON.stringify(snapshot(output)) !== JSON.stringify(before)) {
        throw new Error(
          "The candidate assets changed while the upgrade gate ran; do not publish them."
        );
      }
    };
    const root = join(work, "channel");
    required(
      step(
        [
          previousManager,
          "--root",
          root,
          "install",
          "--version",
          previous,
          "--archive",
          previousArchive,
          "--sha256",
          previousSum,
        ],
        600_000,
        env
      ),
      `Installing ${previous} with its own manager`
    );
    const upgrade = () =>
      step(
        [
          join(root, "bin/hack-next"),
          "--manager",
          "upgrade",
          "--version",
          candidate,
          "--archive",
          candidateArchive,
          "--sha256",
          candidateSum,
        ],
        600_000,
        env
      );
    const direct = upgrade();
    unchanged();
    if (direct.ok) {
      console.log(
        `The ${previous} manager upgrades its channel to ${candidate} with the documented command.`
      );
      return 0;
    }
    console.error(
      `The ${previous} manager cannot upgrade its channel to ${candidate}: ${direct.output}`
    );
    chmodSync(candidateManager, 0o700);
    const takeover = step(
      [candidateManager, "--root", root, "upgrade-manager"],
      600_000,
      env
    );
    const retried = takeover.ok ? upgrade() : null;
    unchanged();
    if (!(takeover.ok && retried?.ok)) {
      console.error(
        `The documented upgrade-manager step does not work either: ${takeover.ok ? retried?.output : takeover.output}`
      );
      return 1;
    }
    if (process.env.HACK_PRERELEASE_ACCEPT_MANAGER_STEP === "1") {
      console.log(
        `Accepted: ${previous} users must run the ${candidate} standalone manager's upgrade-manager first; the release notes must say so.`
      );
      return 0;
    }
    console.error(
      `The documented upgrade-manager step works. Publish only with HACK_PRERELEASE_ACCEPT_MANAGER_STEP=1 and release notes that tell ${previous} users to run it.`
    );
    return 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
