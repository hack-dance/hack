import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { encryptSynthetic } from "../../../scripts/portable-bootstrap-smoke.ts";
import { commitAll, createMonorepoFixture } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  runCommand,
  type Scenario,
} from "../harness.ts";
import {
  type AppIdentity,
  checkStageExpectation,
  classifyAppTransition,
  containsForbiddenValue,
  PORTABLE_BOOTSTRAP_OWNER as OWNER,
  PORTABLE_BOOTSTRAP_INSTALL_SCRIPT,
  PORTABLE_BOOTSTRAP_VERIFY_SCRIPT,
  type PortableBootstrapStage,
  renderBootstrapCompose,
  renderBootstrapEnvFile,
  renderBootstrapLock,
  renderPortableBootstrapReceipt,
  type StageReceipt,
  sha256Hex,
  unexpectedWorktreeChanges,
} from "../portable-bootstrap-controls.ts";

const PROJECT = "com.docker.compose.project";
const TIMEOUT = 180_000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const META = "/deps/.hack-dependency-cache-v1";
const OVERLAY = "drift";
const ARCHITECTURES: Readonly<Record<string, string>> = {
  aarch64: "arm64",
  arm64: "arm64",
  amd64: "amd64",
  x86_64: "amd64",
};
type ResourceKind = "container" | "network" | "volume";

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Headless bootstrap negative controls on the portable slim path (HACK-1143).
 *
 * One app consumes a locked-v1 dependency cache initialized by a frozen-install
 * producer, with an encrypted synthetic env value scoped to the app. Missing,
 * wrong and wrong-overlay keys refuse before any Docker resource exists. Two
 * identical bootstraps produce one initialization, one consumer and no
 * worktree diff. A wrong key, a stale pinned image, a lockfile that no longer
 * matches its manifest and a corrupted ready marker each refuse without
 * touching the running consumer, pulling, rewriting the lockfile or
 * reinstalling. A changed lockfile and a new cache generation select new
 * caches and keep the old ones. Each stage records value-free time and bytes.
 *
 * No published ports, networks, pulls or real credentials. WU12 storage
 * admission, mounts and retention are outside this fixture.
 */
export const portableBootstrapNegativesScenario: Scenario = {
  name: "portable-bootstrap-negatives",
  tier: "docker",
  summary:
    "bootstrap refusals: key/overlay, stale image, lockfile, corrupted cache; no-diff repeat",
  run: async (ctx) => {
    const docker = async (args: readonly string[]) => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
      expectExit({
        result,
        codes: [0],
        message: `Docker ${args[0]} must succeed`,
      });
      return result.stdout.trim();
    };
    expect({
      that: (await docker(["info", "--format", "{{.OSType}}"])) === "linux",
      message: "A Linux Docker daemon is required",
    });
    await docker(["compose", "version"]);
    const arch =
      ARCHITECTURES[await docker(["info", "--format", "{{.Architecture}}"])];
    expect({
      that: arch !== undefined,
      message: "A supported Docker architecture is required",
    });
    const image = await docker([
      "image",
      "inspect",
      "alpine:3.20",
      "--format",
      "{{.Id}}",
    ]);
    expect({
      that: IMAGE_ID.test(image),
      message: "alpine:3.20 must already be cached with an immutable ID",
    });
    const imageBytes = Number(
      await docker(["image", "inspect", image, "--format", "{{.Size}}"])
    );
    // A pinned ID that is not present: what a toolchain bump leaves behind.
    const staleImage = `sha256:${sha256Hex(`hack-e2e-stale-${randomBytes(16).toString("hex")}`)}`;
    const imagePresent = async (ref: string) =>
      (
        await runCommand({
          argv: ["docker", "image", "inspect", ref, "--format", "{{.Id}}"],
          cwd: ctx.tempRoot,
          timeoutMs: TIMEOUT,
        })
      ).exitCode === 0;
    expect({
      that: !(await imagePresent(staleImage)),
      message: "The stale pinned image must be absent before the control",
    });

    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
    const name = fixture.name;
    const canary = `${name}-canary`;
    const cachePrefix = `hack-cache-${name}-deps-`;
    // Synthetic values only; never logged, written in plaintext or passed as arguments.
    const key = randomBytes(32).toString("base64url");
    const wrongKey = randomBytes(32).toString("base64url");
    const driftKey = randomBytes(32).toString("base64url");
    const secret = randomBytes(24).toString("base64url");
    const driftSecret = randomBytes(24).toString("base64url");
    const forbidden = [key, wrongKey, driftKey, secret, driftSecret];
    const compose = (opts: {
      readonly ref: string;
      readonly generation: string;
    }) =>
      renderBootstrapCompose({
        name,
        ref: opts.ref,
        platform: `linux/${arch}`,
        generation: opts.generation,
        tokenDigest: sha256Hex(secret),
      });
    const composePath = join(fixture.hackDir, "docker-compose.yml");
    const lockPath = join(fixture.root, "bun.lock");
    const manifestPath = join(fixture.root, "package.json");
    const manifest = await Bun.file(manifestPath).text();
    const lock = (revision: number) =>
      renderBootstrapLock({ manifest, revision });
    await Bun.write(
      join(fixture.hackDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name,
          internal: { dns: false, tls: false },
          logs: {
            follow_backend: "compose",
            snapshot_backend: "compose",
            clear_on_down: false,
          },
        },
        null,
        2
      )}\n`
    );
    await Bun.write(composePath, compose({ ref: image, generation: "0" }));
    await Bun.write(
      join(fixture.hackDir, "hack.env.default.yaml"),
      renderBootstrapEnvFile({
        environment: "default",
        sealed: encryptSynthetic({ key, secret }),
      })
    );
    // The overlay is valid YAML but sealed under a key the runner never has.
    await Bun.write(
      join(fixture.hackDir, `hack.env.${OVERLAY}.yaml`),
      renderBootstrapEnvFile({
        environment: OVERLAY,
        sealed: encryptSynthetic({ key: driftKey, secret: driftSecret }),
      })
    );
    await Bun.write(
      join(fixture.root, "deps/install.sh"),
      PORTABLE_BOOTSTRAP_INSTALL_SCRIPT
    );
    await Bun.write(
      join(fixture.root, "deps/verify.sh"),
      PORTABLE_BOOTSTRAP_VERIFY_SCRIPT
    );
    await Bun.write(lockPath, lock(1));
    await commitAll({ root: fixture.root, message: "bootstrap negatives" });

    const git = async (args: readonly string[]) => {
      const result = await runCommand({
        argv: ["git", "-C", fixture.root, ...args],
        cwd: fixture.root,
      });
      expectExit({ result, codes: [0], message: `git ${args[0]}` });
      return result.stdout;
    };
    const worktree = async (allowed: readonly string[], message: string) => {
      const unexpected = unexpectedWorktreeChanges({
        porcelain: await git([
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        allowed,
      });
      expect({
        that: unexpected.length === 0,
        message: `${message}; unexpected paths: ${unexpected.join(", ")}`,
      });
    };
    const trackedFiles = async () =>
      (await git(["ls-files", "-z"])).split("\0").filter(Boolean);
    const trackedBytes = async () => {
      let total = 0;
      for (const path of await trackedFiles()) {
        total += Bun.file(join(fixture.root, path)).size;
      }
      return total;
    };

    const list = async (kind: ResourceKind, owner: string) => {
      const args = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
      return words(
        await docker([...args, "--filter", `label=${OWNER}=${owner}`])
      );
    };
    const owned = async (kind: ResourceKind, id: string, owner: string) => {
      const expression =
        kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}";
      const labels: unknown = JSON.parse(
        await docker([kind, "inspect", id, "--format", expression])
      );
      expect({
        that:
          typeof labels === "object" &&
          labels !== null &&
          (labels as Record<string, unknown>)[OWNER] === owner &&
          (labels as Record<string, unknown>)[PROJECT] === owner,
        message: `Refuse ${kind} access outside exact fixture ownership`,
      });
    };
    const clean = async (owner: string) => {
      for (const kind of ["container", "network", "volume"] as const) {
        for (const id of await list(kind, owner)) {
          await owned(kind, id, owner);
          await docker([
            kind,
            "rm",
            ...(kind === "container" ? ["--force"] : []),
            id,
          ]);
        }
        expect({
          that: (await list(kind, owner)).length === 0,
          message: `Owned ${kind} cleanup must leave no resources`,
        });
      }
    };
    const cacheVolumes = async () => {
      const names = (await list("volume", name)).filter((volume) =>
        volume.startsWith(cachePrefix)
      );
      for (const volume of names) {
        await owned("volume", volume, name);
      }
      return names.sort();
    };
    // Inspect only fixed fields: the consumer's Config.Env holds the secret.
    const appIdentity = async (): Promise<AppIdentity> => {
      const ids = words(
        await docker([
          "ps",
          "-aq",
          "--filter",
          `label=${OWNER}=${name}`,
          "--filter",
          "label=com.docker.compose.service=app",
        ])
      );
      const id = ids[0];
      if (id === undefined) {
        return null;
      }
      expect({
        that: ids.length === 1,
        message: "Expected at most one owned consumer container",
      });
      await owned("container", id, name);
      const [fullId, running, startedAt] = words(
        await docker([
          "inspect",
          id,
          "--format",
          "{{.Id}} {{.State.Running}} {{.State.StartedAt}}",
        ])
      );
      if (!(fullId && running && startedAt)) {
        throw new Error("Consumer identity is incomplete");
      }
      return { id: fullId, running: running === "true", startedAt };
    };
    const appExec = async (id: string, script: string) =>
      await runCommand({
        argv: ["docker", "exec", id, "sh", "-c", script],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
    // The consumer copies the artifact only after its env digest matched.
    const loaded = async (identity: AppIdentity) => {
      if (identity === null) {
        throw new Error("Consumer container missing");
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const result = await appExec(identity.id, "cat /tmp/loaded");
        if (result.exitCode === 0) {
          return result.stdout.trim();
        }
        const state = await docker([
          "inspect",
          identity.id,
          "--format",
          "{{.State.Running}}",
        ]);
        expect({
          that: state === "true",
          message:
            "Consumer exited before loading the cache (env digest or artifact missing)",
        });
        await Bun.sleep(250);
      }
      throw new Error("Consumer did not load its dependency cache in time");
    };
    const mountedCache = async (identity: AppIdentity) => {
      if (identity === null) {
        throw new Error("Consumer container missing");
      }
      const volume = await docker([
        "inspect",
        identity.id,
        "--format",
        '{{range .Mounts}}{{if eq .Destination "/deps"}}{{.Name}} {{.RW}}{{end}}{{end}}',
      ]);
      const [mounted, rw] = words(volume);
      expect({
        that: Boolean(mounted?.startsWith(cachePrefix)) && rw === "false",
        message: "Consumer must mount a fingerprinted cache read-only",
      });
      return mounted as string;
    };
    const cacheFacts = async (identity: AppIdentity) => {
      if (identity === null) {
        throw new Error("Consumer container missing");
      }
      const result = await appExec(
        identity.id,
        "wc -l < /deps/initializations; find /deps -type f -exec cat {} + | wc -c"
      );
      expectExit({ result, codes: [0], message: "Read mounted cache facts" });
      const [initializations, bytes] = words(result.stdout).map(Number);
      if (initializations === undefined || bytes === undefined) {
        throw new Error("Cache facts are incomplete");
      }
      return { initializations, bytes };
    };
    // Read-only, network-less probe of one exact owned volume.
    const probeVolume = async (volume: string, script: string) => {
      await owned("volume", volume, name);
      return (
        await runCommand({
          argv: [
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--network=none",
            "--label",
            `${OWNER}=${name}`,
            "--label",
            `${PROJECT}=${name}`,
            "--volume",
            `${volume}:/deps:ro`,
            image,
            "sh",
            "-c",
            script,
          ],
          cwd: ctx.tempRoot,
          timeoutMs: TIMEOUT,
        })
      ).exitCode;
    };
    const readyMarker = (volume: string) =>
      `printf 'locked-v1\\n%s\\n' '${volume.slice(cachePrefix.length)}' | cmp -s - ${META}/ready`;

    const cli = async (opts: {
      readonly args: readonly string[];
      readonly key: string | null;
    }): Promise<CliResult> => {
      const result = await ctx.cli({
        args: opts.args,
        cwd: fixture.root,
        timeoutMs: TIMEOUT,
        env: {
          HACK_EXECUTION_MODE: "slim",
          HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
          ...(opts.key === null ? {} : { HACK_ENV_SECRET_KEY: opts.key }),
        },
      });
      // Checked before any assertion can attach this output to a failure.
      expect({
        that: !containsForbiddenValue({
          texts: [result.stdout, result.stderr],
          forbidden,
        }),
        message: `hack ${opts.args[0]} output must not contain keys or env values`,
      });
      return result;
    };
    const receipts: StageReceipt[] = [];
    let consumer: AppIdentity = null;
    let expectedArtifact = "";
    const stage = async (opts: {
      readonly stage: PortableBootstrapStage;
      readonly key: string | null;
      readonly overlay?: string;
    }) => {
      const before = await appIdentity();
      const result = await cli({
        args: [
          "up",
          "--detach",
          ...(opts.overlay ? ["--env", opts.overlay] : []),
          "app",
        ],
        key: opts.key,
      });
      const after = await appIdentity();
      const transition = classifyAppTransition({ before, after });
      const failure = checkStageExpectation({
        stage: opts.stage,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        transition,
        running: after?.running === true,
      });
      expect({
        that: failure === null,
        message: `${opts.stage}: ${failure}`,
        result,
      });
      if (after !== null) {
        // A new consumer must load its cache and stay the same container.
        await loaded(after);
        expect({
          that:
            classifyAppTransition({
              before: after,
              after: await appIdentity(),
            }) === "unchanged",
          message: `${opts.stage}: consumer must stay running without a restart`,
        });
      }
      const facts = after === null ? null : await cacheFacts(after);
      receipts.push({
        stage: opts.stage,
        outcome: result.exitCode === 0 ? "bootstrapped" : "refused",
        app: transition,
        durationMs: result.durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        trackedBytes: await trackedBytes(),
        cacheBytes: facts?.bytes ?? null,
        cacheVolumes: (await cacheVolumes()).length,
      });
      ctx.log(
        `${opts.stage}: ${result.exitCode === 0 ? "bootstrapped" : "refused"}, consumer ${transition}, ${result.durationMs} ms`
      );
      consumer = after;
      return { result, facts };
    };
    // Refusals and repeats must leave the consumer reading the same artifact.
    const consumerKeeps = async (message: string) => {
      expect({
        that: (await loaded(consumer)) === expectedArtifact,
        message,
      });
    };
    const nothingCreated = async (message: string) => {
      for (const kind of ["container", "network", "volume"] as const) {
        expect({
          that: (await list(kind, name)).length === 0,
          message: `${message}: no owned ${kind} may exist`,
        });
      }
    };

    try {
      await docker([
        "volume",
        "create",
        "--label",
        `${OWNER}=${canary}`,
        "--label",
        `${PROJECT}=${canary}`,
        canary,
      ]);

      // 1-3: env refusals happen before any Docker resource exists.
      await stage({ stage: "refuse-missing-key", key: null });
      await nothingCreated("Missing key refusal");
      // The first lifecycle command converges Hack's managed ignore block.
      await worktree(
        [".hack/.gitignore"],
        "A refused bootstrap may only add the managed .hack ignore block"
      );
      if ((await git(["status", "--porcelain=v1"])).trim().length > 0) {
        await commitAll({
          root: fixture.root,
          message: "managed ignore block",
        });
      }
      await stage({ stage: "refuse-wrong-key", key: wrongKey });
      await nothingCreated("Wrong key refusal");
      await worktree([], "Wrong key refusal must leave no diff");
      await stage({ stage: "refuse-wrong-overlay", key, overlay: OVERLAY });
      await nothingCreated("Wrong overlay refusal");
      await worktree([], "Wrong overlay refusal must leave no diff");

      // 4-5: two identical bootstraps; one initialization and no diff.
      const cold = await stage({ stage: "bootstrap-cold", key });
      expectedArtifact = sha256Hex(lock(1));
      await consumerKeeps("Cold bootstrap must load the locked artifact");
      expect({
        that: cold.facts?.initializations === 1,
        message: "Cold bootstrap must initialize the cache exactly once",
      });
      const firstCache = await mountedCache(consumer);
      expect({
        that:
          (await probeVolume(firstCache, readyMarker(firstCache))) === 0 &&
          (await cacheVolumes()).length === 1,
        message: "Cold bootstrap must publish one ready cache",
      });
      await worktree([], "Cold bootstrap must leave no diff");
      const trackedBefore = await git(["ls-files", "-s"]);
      const repeat = await stage({ stage: "bootstrap-repeat", key });
      await consumerKeeps("Repeat bootstrap must keep the loaded artifact");
      expect({
        that:
          repeat.facts?.initializations === 1 &&
          (await mountedCache(consumer)) === firstCache &&
          (await cacheVolumes()).length === 1,
        message:
          "Repeat bootstrap must reuse the ready cache without reinstalling",
      });
      await worktree([], "Repeat bootstrap must leave no diff");
      expect({
        that: (await git(["ls-files", "-s"])) === trackedBefore,
        message: "Repeat bootstrap must leave the tracked index unchanged",
      });

      // 6: a wrong key cannot disturb a running generation.
      await stage({ stage: "refuse-wrong-key-running", key: wrongKey });
      await consumerKeeps("Wrong key refusal must keep the consumer");
      await worktree([], "Wrong key refusal must leave no diff");

      // 7: a stale pinned image is refused, never pulled or retagged.
      const composeBytes = await Bun.file(composePath).text();
      await Bun.write(
        composePath,
        compose({ ref: staleImage, generation: "0" })
      );
      await stage({ stage: "refuse-stale-image", key });
      await consumerKeeps("Stale image refusal must keep the consumer");
      expect({
        that:
          !(await imagePresent(staleImage)) &&
          (await docker([
            "image",
            "inspect",
            "alpine:3.20",
            "--format",
            "{{.Id}}",
          ])) === image,
        message: "Stale image refusal must not pull, build or retag images",
      });
      await worktree(
        [".hack/docker-compose.yml"],
        "Stale image refusal must change only the edited compose file"
      );
      await Bun.write(composePath, composeBytes);
      await worktree([], "Restored compose must match HEAD");

      // 8: a lockfile that no longer matches its manifest is never rewritten
      // and never publishes a ready cache.
      const lockBytes = await Bun.file(lockPath).text();
      const quarantineBefore = await cacheVolumes();
      const unfrozen = manifest.replace(
        /\n\}\n?$/,
        ',\n  "hackE2eFrozenProbe": true\n}\n'
      );
      expect({
        that: unfrozen !== manifest,
        message: "The frozen lockfile control must change the manifest",
      });
      await Bun.write(manifestPath, unfrozen);
      await stage({ stage: "refuse-frozen-lockfile", key });
      await consumerKeeps("Frozen lockfile refusal must keep the consumer");
      const quarantined = (await cacheVolumes()).filter(
        (volume) => !quarantineBefore.includes(volume)
      );
      expect({
        that:
          (await Bun.file(lockPath).text()) === lockBytes &&
          quarantined.length === 1 &&
          (await probeVolume(
            quarantined[0] as string,
            `test -f ${META}/attempt && test ! -e ${META}/ready && test ! -e /deps/artifact`
          )) === 0,
        message:
          "Frozen refusal must keep the lockfile and quarantine its cache without a ready marker",
      });
      await worktree(
        ["package.json"],
        "Frozen lockfile refusal must change only the edited manifest"
      );
      await Bun.write(manifestPath, manifest);
      await worktree([], "Restored manifest must match HEAD");

      // 9: a changed lockfile selects and initializes a new cache.
      await Bun.write(lockPath, lock(2));
      await commitAll({ root: fixture.root, message: "lockfile revision 2" });
      const changed = await stage({
        stage: "bootstrap-changed-lockfile",
        key,
      });
      expectedArtifact = sha256Hex(lock(2));
      await consumerKeeps("Changed lockfile must load the new artifact");
      const secondCache = await mountedCache(consumer);
      expect({
        that:
          changed.facts?.initializations === 1 &&
          secondCache !== firstCache &&
          (await probeVolume(firstCache, readyMarker(firstCache))) === 0,
        message:
          "Changed lockfile must initialize a new cache once and retain the previous ready cache",
      });
      await worktree([], "Changed lockfile bootstrap must leave no diff");

      // 10: a corrupted ready marker fails closed without reinstalling.
      const corrupt = `printf 'locked-v1\\n%s\\n' '${"0".repeat(16)}'`;
      await owned("volume", secondCache, name);
      await docker([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--label",
        `${OWNER}=${name}`,
        "--label",
        `${PROJECT}=${name}`,
        "--volume",
        `${secondCache}:/deps`,
        image,
        "sh",
        "-c",
        `${corrupt} > ${META}/ready`,
      ]);
      const corrupted = await stage({ stage: "refuse-corrupted-cache", key });
      await consumerKeeps("Corrupted cache refusal must keep the consumer");
      expect({
        that:
          corrupted.facts?.initializations === 1 &&
          (await probeVolume(
            secondCache,
            `${corrupt} | cmp -s - ${META}/ready`
          )) === 0,
        message:
          "Corrupted cache refusal must neither reinstall nor rewrite the marker",
      });
      await worktree([], "Corrupted cache refusal must leave no diff");

      // 11: the documented recovery is a new generation, not in-place repair.
      await Bun.write(composePath, compose({ ref: image, generation: "1" }));
      await commitAll({ root: fixture.root, message: "cache generation 1" });
      const recovered = await stage({
        stage: "bootstrap-new-generation",
        key,
      });
      await consumerKeeps("New generation must load the current artifact");
      const thirdCache = await mountedCache(consumer);
      expect({
        that:
          recovered.facts?.initializations === 1 &&
          thirdCache !== secondCache &&
          (await cacheVolumes()).includes(secondCache),
        message:
          "New generation must initialize once and retain the corrupted cache for inspection",
      });
      await worktree([], "New generation bootstrap must leave no diff");

      const tracked: string[] = [];
      for (const path of await trackedFiles()) {
        tracked.push(await Bun.file(join(fixture.root, path)).text());
      }
      expect({
        that: !containsForbiddenValue({ texts: tracked, forbidden }),
        message: "Tracked fixture files must not contain keys or env values",
      });

      expectExit({
        result: await cli({ args: ["down"], key }),
        codes: [0],
        message: "hack down must succeed",
      });
      expect({
        that: (await list("container", name)).length === 0,
        message: "hack down must remove the fixture containers",
      });
      await clean(name);
      await owned("volume", canary, canary);
      ctx.log(
        `portable-bootstrap receipt ${renderPortableBootstrapReceipt({ stages: receipts, imageBytes })}`
      );
    } finally {
      try {
        await clean(name);
      } finally {
        await clean(canary);
      }
    }
  },
};
