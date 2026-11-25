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
 * assets) and a GitHub token for `gh` (GH_TOKEN). It starts no runtime and
 * changes nothing outside its own temp directory.
 *
 * It gates the host's platform. On Apple Silicon macOS that is the native
 * bundle. On Linux x86_64 or arm64 it is the Compose bundle, with that
 * platform's manager and archive (HACK_PRERELEASE_OUTPUT is then the Linux
 * build job's package directory). Which Linux leg runs is decided from reviewed
 * history, `PUBLISHED_LINUX_RELEASES`, never from what a release's asset list
 * happens to hold (see `linuxGateDecision`). While that history is empty and
 * the previous release has no Linux assets, there is no Linux install to
 * upgrade: the gate says so and instead installs the candidate into a fresh
 * channel, deselects, selects, rolls back and uninstalls it. Once a Linux
 * release is in reviewed history, the previous release must be pinned and its
 * assets present, and the gate upgrades that install with its retained
 * manager, as on macOS.
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
import { LINUX_SUMS } from "./installer/download.ts";
import {
  type BundlePlatform,
  bundleArchiveName,
  candidateVersion,
  compareCandidateVersions,
  composeOnly,
  digest,
  hostBundlePlatform,
  type LINUX_BUNDLE_PLATFORMS,
  managerAssetName,
  UNSUPPORTED_HOST,
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
  "5.0.0-next.19": {
    manager: "ba47091559a80b2abbb246b8e86c5530b8ddb068973f5136e120d36e2003fae6",
    archive: "57efde68a6424fc7cf0c710d058735b1e3a50cbac8e2f211b0208572aed33086",
  },
  "5.0.0-next.20": {
    manager: "2e9183b4ce7b4c4c5659f9ae33677699e1cdc9f5553e1b668bbbe6ea6846ac7b",
    archive: "a20c32bb090f7535e167702f37910812130b45d96d2d5eb930588328a1f31060",
  },
  "5.0.0-next.21": {
    manager: "af7d25e2db3e5d0edf8d0e308a49db928f1bc7f138beb54b9d3b0ccae83ee423",
    archive: "7e7f887a09d435ee20a4dfd0afe7b33eb5a171660937efd443fac73ecc09ff0e",
  },
  "5.0.0-next.22": {
    manager: "df75f28ef2fdd892e9d17f5528171117488b426a2fe9140ac3dd9add924ae45a",
    archive: "a0d36c68d0e670a2d9b8dfad895136a17fa6706fc7b84072a962afa6d1994f51",
  },
  "5.0.0-next.23": {
    manager: "c9cc02744bf801986f8962699fe633566790cb3a6e7bfff2beb0536107a56b66",
    archive: "c17cb20bfe955fb188273701f8e39016cd7e4394ebc6cb7a1714959ff2a842a4",
  },
  "5.0.0-next.24": {
    manager: "892c4cdf3a99e309df4b4d406f7e76e2b422b72f4dd2a47bef1f0b36dd29ee27",
    archive: "b77eb0908d62db66fda707ec66e2c237ae217ea340b128ebafcb57d0ee60e59d",
  },
  "5.0.0-next.25": {
    manager: "dfba3ea7bfcfbeffd5de38e0d3b0818657912764cd184d949e04deec00edb153",
    archive: "01f5a7a469a6087c78a1491a9ac82feffb48018a534fa227a8a636e1b8c3aed1",
  },
};

/**
 * The same pins for the Linux assets (`SHA256SUMS-linux`), per release and
 * platform. Kept beside `PUBLISHED_RELEASES`, whose entries stay the macOS
 * pair. 5.0.0-next.23 is the first release with Linux assets. Add both
 * platforms for each release, and each manager to `REVIEWED_PREDECESSORS`.
 */
export const PUBLISHED_LINUX_RELEASES: Readonly<
  Record<
    string,
    Readonly<
      Partial<
        Record<
          (typeof LINUX_BUNDLE_PLATFORMS)[number],
          { readonly manager: string; readonly archive: string }
        >
      >
    >
  >
> = {
  "5.0.0-next.23": {
    "linux-x86_64": {
      manager:
        "e946ba95a49018b0eff8ff81161d1ccf1a086627773e62a30db53e4e94c9195b",
      archive:
        "21a3709c8b78adaa1f399b3c91d3213862fc51cfaefbf0a0e6d06ff76fd7bb6f",
    },
    "linux-arm64": {
      manager:
        "be1599a85cd4251df4a9779f2e7fa16480094ebb48ec97ca4e9dad6dd73d0094",
      archive:
        "6874a73a1cea9410527b4831ffec7a46c4bccb28312620adfd335e0fb01d40de",
    },
  },
  "5.0.0-next.24": {
    "linux-x86_64": {
      manager:
        "00e6e01b05bd6f05ac32a41ab06b7309767d701653b220ede5148c2ffb66388c",
      archive:
        "379a0aa616fbc956e5871bc010f201eb9fead450dab462de124efdf23e7845ab",
    },
    "linux-arm64": {
      manager:
        "f52beab69e5ec62e237da74ae64a0cdef7887bcae51380ca6a0270e4b45e4d27",
      archive:
        "1636630b2a378c8d3aeb97f8015cd3c8d61c3db4d8a6e49637085d020ad7fbf6",
    },
  },
  "5.0.0-next.25": {
    "linux-x86_64": {
      manager:
        "6219e16a7b2d3eb83eaa440315829c4d77fb20af0f74664d04d8491899ea6404",
      archive:
        "30a79d0df88a947df76f229eee658dd40c7b2ab0faf42345c5ee3a71ba683912",
    },
    "linux-arm64": {
      manager:
        "a07bd7d5cd8cf6c0788c1ab2d9cd29d481850e73065709683d3c2c372182fbc4",
      archive:
        "9cd6943ccab29d18c7facd29051a1910b6a8e7e12f1ce5ed921a55e1e352bf44",
    },
  },
};

/** The reviewed manager and archive digests of `version` for `platform`. */
export function publishedPins(
  version: string,
  platform: BundlePlatform
): { readonly manager: string; readonly archive: string } | undefined {
  return platform === "darwin-arm64"
    ? PUBLISHED_RELEASES[version]
    : PUBLISHED_LINUX_RELEASES[version]?.[platform];
}

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

type LinuxPins = typeof PUBLISHED_LINUX_RELEASES;

/**
 * Which Linux leg the gate runs, decided from reviewed history.
 *
 * - `fresh`: no Linux release is in reviewed history (`history` is empty) and
 *   the previous release has no Linux manager asset. Nothing can be upgraded.
 * - `upgrade`: the previous release is pinned for this platform and has its
 *   Linux manager asset.
 *
 * Everything else refuses. In particular a missing asset is never read as
 * "Linux has not shipped yet": once any Linux release is pinned, a previous
 * release without a pin, or a pinned one whose asset is gone, fails the gate.
 * A previous release that has Linux assets but no pin fails too, whatever the
 * history holds, so the pin chore cannot be skipped after the first release.
 */
export function linuxGateDecision(opts: {
  readonly previous: string | null;
  readonly platform: (typeof LINUX_BUNDLE_PLATFORMS)[number];
  /** Whether the previous release lists this platform's manager asset. */
  readonly previousHasManagerAsset: boolean;
  readonly history?: LinuxPins;
}):
  | { readonly leg: "fresh" }
  | {
      readonly leg: "upgrade";
      readonly previous: string;
      readonly pins: { readonly manager: string; readonly archive: string };
    } {
  const history = opts.history ?? PUBLISHED_LINUX_RELEASES;
  const where =
    "PUBLISHED_LINUX_RELEASES in scripts/check-prerelease-upgrade.ts";
  const pins =
    opts.previous === null
      ? undefined
      : history[opts.previous]?.[opts.platform];
  if (opts.previous !== null && pins !== undefined) {
    if (!opts.previousHasManagerAsset) {
      throw new Error(
        `${opts.previous} is a reviewed ${opts.platform} release (${where}) but its ${managerAssetName(opts.platform)} asset is missing. A published Linux install cannot be upgraded without it; restore the release's assets or resolve this in review. The gate does not fall back to a fresh install.`
      );
    }
    return { leg: "upgrade", previous: opts.previous, pins };
  }
  if (opts.previousHasManagerAsset) {
    throw new Error(
      `${String(opts.previous)} has ${opts.platform} assets but is not pinned (${where}); add its published manager and archive digests in review before this gate runs it.`
    );
  }
  const reviewed = Object.keys(history).sort((a, b) =>
    compareCandidateVersions(a, b)
  );
  if (reviewed.length > 0) {
    throw new Error(
      `Linux releases are in reviewed history (${where}, latest ${reviewed.at(-1)}), but the previous prerelease ${String(opts.previous)} has no reviewed ${opts.platform} pin and no ${opts.platform} assets. That is not a first Linux release; pin the previous release or resolve the missing assets in review.`
    );
  }
  return { leg: "fresh" };
}

/**
 * The Linux gate when no published Linux install precedes the candidate:
 * install the candidate into a fresh channel with its own manager and take it
 * through every selection change a user can make, ending with an uninstall
 * that leaves no channel root. `manager` and `archive` are the gate's copies.
 */
export function freshChannelLeg(opts: {
  readonly work: string;
  readonly manager: string;
  readonly archive: string;
  readonly checksum: string;
  readonly version: string;
}): void {
  const env = managerEnvironment(opts.work);
  for (const directory of [env.HOME, env.TMPDIR]) {
    mkdirSync(directory as string, { mode: 0o700, recursive: true });
  }
  const root = join(opts.work, "channel");
  const launcher = join(root, "bin/hack-next");
  const selected = (output: string): unknown =>
    (JSON.parse(output.split("\n").at(-1) ?? "") as { selected?: unknown })
      .selected;
  chmodSync(opts.manager, 0o700);
  required(
    step(
      [
        opts.manager,
        "--root",
        root,
        "install",
        "--version",
        opts.version,
        "--archive",
        opts.archive,
        "--sha256",
        opts.checksum,
      ],
      600_000,
      env
    ),
    `Installing ${opts.version} into a fresh channel`
  );
  const manager = (args: readonly string[], want: string | null) => {
    const what = `hack-next --manager ${args.join(" ")}`;
    const output = required(
      step([launcher, "--manager", ...args], 600_000, env),
      what
    );
    if (selected(output) !== want) {
      throw new Error(
        `${what} left ${String(selected(output))} selected, not ${String(want)}.`
      );
    }
  };
  manager(["status"], opts.version);
  const reported = required(
    step([launcher, "--version"], 120_000, env),
    "hack-next --version"
  );
  if (reported !== `hack v${opts.version}`) {
    throw new Error(`The installed candidate reports "${reported}".`);
  }
  manager(["stable"], null);
  manager(["select", "--version", opts.version], opts.version);
  manager(["stable"], null);
  manager(["rollback"], opts.version);
  const removed = JSON.parse(
    required(
      step([launcher, "--manager", "uninstall", "--apply"], 600_000, env),
      "hack-next --manager uninstall --apply"
    )
  ) as { applied?: unknown; to?: unknown };
  if (
    removed.applied !== true ||
    typeof removed.to !== "string" ||
    readdirSync(opts.work).includes("channel") ||
    !readdirSync(opts.work).includes(removed.to.split("/").at(-1) ?? "")
  ) {
    throw new Error(
      "Uninstall did not move the whole channel to its retained sibling."
    );
  }
}

/**
 * The upgrade itself, on any platform: install the previous release into a
 * fresh channel with its own manager, then upgrade it to the candidate with
 * the documented command, which runs the retained previous manager. Returns
 * the gate's exit code. `unchanged` must throw if the candidate assets that
 * will be uploaded changed. Every file here is already verified by the caller.
 */
export function upgradeLeg(opts: {
  readonly work: string;
  readonly previous: string;
  readonly previousManager: string;
  readonly previousArchive: string;
  readonly previousSum: string;
  readonly candidate: string;
  readonly candidateManager: string;
  readonly candidateArchive: string;
  readonly candidateSum: string;
  readonly unchanged: () => void;
  readonly acceptManagerStep: boolean;
}): number {
  const {
    work,
    previous,
    previousManager,
    previousArchive,
    previousSum,
    candidate,
    candidateManager,
    candidateArchive,
    candidateSum,
    unchanged,
  } = opts;
  const env = managerEnvironment(work);
  mkdirSync(env.HOME as string, { mode: 0o700 });
  mkdirSync(env.TMPDIR as string, { mode: 0o700 });
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
  if (opts.acceptManagerStep) {
    console.log(
      `Accepted: ${previous} users must run the ${candidate} standalone manager's upgrade-manager first; the release notes must say so.`
    );
    return 0;
  }
  console.error(
    `The documented upgrade-manager step works. Publish only with HACK_PRERELEASE_ACCEPT_MANAGER_STEP=1 and release notes that tell ${previous} users to run it.`
  );
  return 1;
}

async function main(): Promise<number> {
  const candidate = process.env.HACK_PRERELEASE_VERSION ?? "";
  const output = process.env.HACK_PRERELEASE_OUTPUT ?? "";
  candidateVersion(candidate);
  if (!output) {
    throw new Error("HACK_PRERELEASE_OUTPUT is required.");
  }
  const platform = hostBundlePlatform();
  if (platform === null) {
    throw new Error(UNSUPPORTED_HOST);
  }
  const linux = composeOnly(platform);
  // The names below are the host platform's; on macOS they are the constants
  // this gate has always used.
  const MANAGER_ASSET = managerAssetName(platform);
  const archiveName = (version: string) => bundleArchiveName(version, platform);
  const SUMS = linux ? LINUX_SUMS : "SHA256SUMS";
  const INSTALLER_SUMS = linux ? LINUX_SUMS : "INSTALLER-SHA256SUMS";
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
  if (previous === null && !linux) {
    console.log(
      `No published prerelease precedes ${candidate}; nothing to upgrade.`
    );
    return 0;
  }
  // Managers refuse a path that is not canonical; macOS tmpdir() is /var/...,
  // a link to /private/var.
  const work = realpathSync(mkdtempSync(join(tmpdir(), "hack-upgrade-gate-")));
  try {
    // Linux: reviewed history decides the leg. The asset list is read only to
    // refuse inconsistencies with it, never to conclude that Linux is new.
    const decision =
      platform === "darwin-arm64"
        ? null
        : linuxGateDecision({
            previous,
            platform,
            previousHasManagerAsset:
              previous !== null &&
              required(
                step(
                  [
                    "gh",
                    "api",
                    `repos/${REPOSITORY}/releases/tags/v${previous}`,
                    "--jq",
                    ".assets[].name",
                  ],
                  120_000
                ),
                `Listing the assets of ${previous}`
              )
                .split("\n")
                .includes(MANAGER_ASSET),
          });
    if (decision?.leg === "fresh") {
      const before = snapshot(output);
      const copies = join(work, "candidate");
      mkdirSync(copies, { mode: 0o700 });
      for (const name of [MANAGER_ASSET, archiveName(candidate)]) {
        copyFileSync(join(output, name), join(copies, name));
      }
      freshChannelLeg({
        work,
        manager: join(copies, MANAGER_ASSET),
        archive: join(copies, archiveName(candidate)),
        checksum: digest(join(copies, archiveName(candidate))),
        version: candidate,
      });
      if (JSON.stringify(snapshot(output)) !== JSON.stringify(before)) {
        throw new Error(
          "The candidate assets changed while the upgrade gate ran; do not publish them."
        );
      }
      console.log(
        `No ${platform} release is in reviewed history (PUBLISHED_LINUX_RELEASES is empty) and ${previous === null ? "no published prerelease precedes this one" : `the previous prerelease ${previous} has no ${platform} assets`}, so no published ${platform} install precedes ${candidate}: there is nothing to upgrade. Instead ${candidate} was installed into a fresh channel, deselected, selected, rolled back and uninstalled with its own manager.`
      );
      return 0;
    }
    if (previous === null) {
      throw new Error("No previous prerelease.");
    }
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
          INSTALLER_SUMS,
          "--pattern",
          archiveName(previous),
          "--pattern",
          SUMS,
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
    const pins =
      decision?.leg === "upgrade"
        ? decision.pins
        : publishedPins(previous, platform);
    if (pins === undefined) {
      throw new Error(
        `${previous} is not pinned (${linux ? `PUBLISHED_LINUX_RELEASES, ${platform},` : "PUBLISHED_RELEASES"} in scripts/check-prerelease-upgrade.ts); add its published manager and archive digests in review before this gate runs it.`
      );
    }
    const managerDigest = digest(previousManager);
    if (
      managerDigest !== pins.manager ||
      !REVIEWED_PREDECESSORS.includes(managerDigest) ||
      listedDigest(await sums(INSTALLER_SUMS), MANAGER_ASSET) !== pins.manager
    ) {
      throw new Error(
        `${previous}'s manager does not match its pin or is not a reviewed predecessor (REVIEWED_PREDECESSORS in scripts/installer/channel.ts).`
      );
    }
    const previousSum = pins.archive;
    if (
      digest(previousArchive) !== previousSum ||
      listedDigest(await sums(SUMS), archiveName(previous)) !== previousSum
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
    // The Linux build job gates its own package directory, which has no
    // checksum file yet: the macOS job writes SHA256SUMS-linux afterwards.
    const candidateSum = linux
      ? digest(join(output, archiveName(candidate)))
      : listedDigest(
          await Bun.file(join(output, SUMS)).text(),
          archiveName(candidate)
        );
    if (digest(candidateArchive) !== candidateSum) {
      throw new Error("The candidate archive does not match its checksums.");
    }
    const unchanged = () => {
      if (JSON.stringify(snapshot(output)) !== JSON.stringify(before)) {
        throw new Error(
          "The candidate assets changed while the upgrade gate ran; do not publish them."
        );
      }
    };
    return upgradeLeg({
      work,
      previous,
      previousManager,
      previousArchive,
      previousSum,
      candidate,
      candidateManager,
      candidateArchive,
      candidateSum,
      unchanged,
      acceptManagerStep:
        process.env.HACK_PRERELEASE_ACCEPT_MANAGER_STEP === "1",
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
