import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  runCommand,
  type Scenario,
} from "../harness.ts";

const OWNER = "hack.e2e.cache-protocol-owner";
const BRANCH = "protocol-linked";
const COMMAND_MS = 30_000;
const GENERATION_ZERO = "0";
const VERIFY = ["sh", "/fixture/verify.sh"];
const PRODUCER = ["sh", "/fixture/install.sh"];
const VERIFY_SCRIPT =
  'set -eu\nmode=$(tr -d "[:space:]" < /fixture/mode)\nif test "$mode" = concurrent; then while test ! -f /fixture/release-verifier; do sleep 0.1; done; fi\ntest "$(cat /deps/artifact)" = fixture-artifact\ntest "$(wc -l < /deps/initializations)" -eq 1\n';
// Only this test's external fault-control file is excluded from the identity.
// Production scripts and verifier content are explicit fingerprint inputs.
const INSTALL_SCRIPT = [
  "set -eu",
  'mode=$(tr -d "[:space:]" < /fixture/mode)',
  'printf "fixture-mode=%s\\n" "$mode"',
  'case "$mode" in success|concurrent|init-fail|verify-fail|interrupt) ;; *) echo "unknown fixture mode" >&2; exit 89;; esac',
  "echo initialized >> /deps/initializations",
  "touch /deps/began",
  'case "$mode" in init-fail) exit 23;; interrupt) sleep 60;; esac',
  'if test "$mode" = concurrent; then while test ! -f /fixture/release; do sleep 0.1; done; fi',
  'if test "$mode" = verify-fail; then echo invalid > /deps/artifact; else echo fixture-artifact > /deps/artifact; fi',
  "",
].join("\n");
const NO_READY =
  "test -f /deps/.hack-dependency-cache-v1/attempt && test ! -e /deps/.hack-dependency-cache-v1/ready && test ! -e /deps/.hack-dependency-cache-v1/ready.pending && test $(wc -l < /deps/initializations) -eq 1";

type Resource = {
  readonly Id?: string;
  readonly Name?: string;
  readonly Labels?: Record<string, string>;
  readonly Config?: { readonly Labels: Record<string, string> };
  readonly State?: { readonly Running: boolean; readonly ExitCode: number };
  readonly Mounts?: readonly {
    readonly Type: string;
    readonly Name?: string;
    readonly Source?: string;
    readonly Destination: string;
    readonly RW: boolean;
  }[];
};

/** Real Compose protocol coverage with synthetic artifacts, no package downloads. */
export const dependencyCacheProtocolScenario: Scenario = {
  name: "dependency-cache-protocol",
  tier: "docker",
  summary:
    "locked cache initialization, failure quarantine and generation recovery",
  run: async (ctx) => {
    const docker = (args: readonly string[]) =>
      runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: COMMAND_MS,
      });
    const checkedDocker = async (args: readonly string[]) => {
      const result = await docker(args);
      expectExit({
        result,
        codes: [0],
        message: `docker ${args[0]} fixture operation`,
      });
      return result;
    };
    const info = await docker(["info", "--format", "{{.Architecture}}"]);
    if (info.exitCode !== 0) {
      ctx.skip("Docker daemon unavailable");
    }
    const architectures: Record<string, string> = {
      arm64: "arm64",
      aarch64: "arm64",
      amd64: "amd64",
      x86_64: "amd64",
    };
    const arch = architectures[info.stdout.trim()];
    if (!arch) {
      ctx.skip("unsupported Docker daemon architecture");
    }
    const image = await checkedDocker([
      "image",
      "inspect",
      "alpine:3.20",
      "--format",
      "{{json .RepoDigests}}",
    ]);
    const imageRef =
      (JSON.parse(image.stdout) as string[]).find((value) =>
        value.startsWith("alpine@sha256:")
      ) ?? "alpine:3.20";
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { standaloneContainers: true, disableInternal: true },
    });
    const projects = [fixture.name, `${fixture.name}--${BRANCH}`];
    const pending: Promise<CliResult>[] = [];
    const writeCompose = async (
      root: string,
      generation: string,
      mode = "success"
    ) => {
      // Publish a new inode: an existing Docker bind must never observe an
      // in-place rewrite of this external fault-control file.
      const modePath = join(root, "fixture/mode");
      const pendingModePath = join(root, "fixture/mode.pending");
      expect({
        that: mode.length < 64 && /^[a-z-]+$/.test(mode),
        message: "fixture mode must fit the fixed-width control record",
      });
      // Keep the byte length stable across replacements: Docker's shared
      // filesystem returned truncated control records despite atomic rename.
      // Constant width avoids changing-size metadata in this test control.
      await Bun.write(pendingModePath, `${mode.padEnd(63, " ")}\n`);
      await rename(pendingModePath, modePath);
      const base = {
        image: imageRef,
        platform: `linux/${arch}`,
        pull_policy: "never",
        network_mode: "none",
        labels: { [OWNER]: fixture.name },
      };
      await Bun.write(
        join(root, ".hack/docker-compose.yml"),
        JSON.stringify(
          {
            name: fixture.name,
            services: {
              installer: {
                ...base,
                entrypoint: [],
                command: PRODUCER,
                labels: {
                  ...base.labels,
                  "hack.dependencies.cache-volume": "dependencies",
                  "hack.dependencies.lockfiles": "fixture.lock",
                  "hack.dependencies.runtime-files":
                    "package.json,fixture/install.sh,fixture/verify.sh",
                  "hack.dependencies.cache-protocol": "locked-v1",
                  "hack.dependencies.cache-generation": generation,
                  "hack.dependencies.cache-verify": JSON.stringify(VERIFY),
                },
                volumes: ["dependencies:/deps", "../fixture:/fixture:ro"],
              },
              web: {
                ...base,
                depends_on: {
                  installer: { condition: "service_completed_successfully" },
                },
                command: [
                  "sh",
                  "-c",
                  "sh /fixture/verify.sh && exec sleep infinity",
                ],
                volumes: ["dependencies:/deps:ro", "../fixture:/fixture:ro"],
              },
            },
            volumes: { dependencies: { labels: { [OWNER]: fixture.name } } },
          },
          null,
          2
        )
      );
    };
    await mkdir(join(fixture.root, "fixture"));
    await Bun.write(join(fixture.root, "fixture/install.sh"), INSTALL_SCRIPT);
    await Bun.write(join(fixture.root, "fixture/verify.sh"), VERIFY_SCRIPT);
    await Bun.write(
      join(fixture.root, "fixture.lock"),
      "protocol-fixture-v1\n"
    );
    await writeCompose(fixture.root, GENERATION_ZERO, "concurrent");
    await commitAll({
      root: fixture.root,
      message: "locked cache protocol fixture",
    });
    const linked = await addLinkedWorktree({ fixture, branch: BRANCH });
    const up = (
      root: string,
      options?: {
        readonly json?: boolean;
        readonly onStderrChunk?: (chunk: string) => void;
      }
    ) => {
      const task = ctx.cli({
        cwd: root,
        args: options?.json ? ["up", "--json"] : ["up", "--detach"],
        onStderrChunk: options?.onStderrChunk,
        env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "25000" },
        timeoutMs: COMMAND_MS,
      });
      pending.push(task);
      return task;
    };
    const owned = (resource: Resource) => {
      const labels = resource.Config?.Labels ?? resource.Labels ?? {};
      expect({
        that:
          labels[OWNER] === fixture.name &&
          projects.includes(labels["com.docker.compose.project"] ?? ""),
        message: "refuse operations outside exact fixture ownership",
      });
      return labels;
    };
    const listContainers = async (project?: string, service?: string) => {
      const listed = await checkedDocker([
        "ps",
        "-aq",
        "--filter",
        `label=${OWNER}=${fixture.name}`,
        ...(project
          ? ["--filter", `label=com.docker.compose.project=${project}`]
          : []),
        ...(service
          ? ["--filter", `label=com.docker.compose.service=${service}`]
          : []),
      ]);
      const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
      if (!ids.length) {
        return [];
      }
      const inspected = await checkedDocker(["inspect", ...ids]);
      const resources = JSON.parse(inspected.stdout) as Resource[];
      resources.forEach(owned);
      return resources;
    };
    const installer = async (project: string) => {
      const resources = await listContainers(project, "installer");
      expect({
        that: resources.length === 1,
        message: "expected exactly one owned installer",
      });
      return resources[0] as Resource;
    };
    const cacheVolume = async (project: string) => {
      const resource = await installer(project);
      const mount = resource.Mounts?.find(
        (value) => value.Destination === "/deps"
      );
      expect({
        that:
          mount?.Type === "volume" &&
          Boolean(
            mount.Name?.startsWith(`hack-cache-${fixture.name}-dependencies-`)
          ),
        message: "protocol must use a fingerprinted cache volume",
      });
      return mount?.Name as string;
    };
    const inspectCache = async (name: string, script: string) => {
      const inspected = await checkedDocker(["volume", "inspect", name]);
      const volume = (
        JSON.parse(inspected.stdout) as Resource[]
      )[0] as Resource;
      owned(volume);
      expect({
        that:
          volume.Name === name &&
          volume.Labels?.["com.docker.compose.volume"] === "dependencies",
        message: "reader must mount the exact owned dependency volume",
      });
      return await checkedDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--label",
        `${OWNER}=${fixture.name}`,
        "--label",
        `com.docker.compose.project=${fixture.name}`,
        "--volume",
        `${name}:/deps:ro`,
        imageRef,
        "sh",
        "-c",
        script,
      ]);
    };
    const waitFor = async (check: () => Promise<boolean>, message: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await check()) {
          return;
        }
        await Bun.sleep(100);
      }
      throw new Error(message);
    };
    const ready = async (root: string, project: string) => {
      const result = await ctx.cli({
        cwd: root,
        args: ["exec", "web", "--", ...VERIFY],
        timeoutMs: COMMAND_MS,
      });
      expectExit({
        result,
        codes: [0],
        message: "consumer must read the verified one-initialization artifact",
      });
      const resources = await listContainers(project, "web");
      expect({
        that:
          resources.length === 1 &&
          resources[0]?.State?.Running === true &&
          resources[0]?.Mounts?.some(
            (mount) => mount.Destination === "/deps" && !mount.RW
          ) === true,
        message: "consumer must run with a read-only dependency mount",
      });
    };
    const removeProjectContainers = async (project: string) => {
      for (const resource of await listContainers(project)) {
        owned(resource);
        await checkedDocker(["rm", "-f", resource.Id as string]);
      }
    };
    const failed = (result: CliResult) =>
      expect({
        that:
          !result.timedOut && result.exitCode !== 0 && result.exitCode !== 124,
        message:
          "protocol failure must fail startup rather than wait for harness timeout",
        result,
      });
    const releaseBarrier = async (name: string) => {
      await Promise.all(
        [fixture.root, linked].map((root) =>
          Bun.write(join(root, `fixture/${name}`), "release\n")
        )
      );
    };
    const releaseInitializers = () => releaseBarrier("release");
    const releaseVerifiers = () => releaseBarrier("release-verifier");
    const releaseAll = async () => {
      await releaseInitializers();
      await releaseVerifiers();
    };
    const reportStartupFailures = async (
      initialError: unknown,
      starts: readonly Promise<CliResult>[]
    ) => {
      const failures: unknown[] = [initialError];
      const outcomes = await Promise.allSettled(starts);
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === "rejected") {
          failures.push(outcome.reason);
          continue;
        }
        ctx.log(
          `${projects[index]} startup exit ${outcome.value.exitCode}:\n${outcome.value.combined.slice(-6000)}`
        );
        try {
          expectExit({
            result: outcome.value,
            codes: [0],
            message: `${projects[index]} concurrent protocol startup`,
          });
        } catch (startupError) {
          failures.push(startupError);
        }
      }
      throw new AggregateError(
        failures,
        "Concurrent protocol startup did not demonstrate producer overlap"
      );
    };
    const assertStartupProgress = (results: readonly CliResult[]) => {
      const stderr = results.map((result) => result.stderr).join("\n");
      for (const phase of ["waiting", "installing", "verifying", "ready"]) {
        expect({
          that: stderr.includes(`Dependency cache installer: ${phase}`),
          message: `startup stderr must report ${phase}`,
        });
      }
      expect({
        that: !(
          stderr.includes("fixture-mode=") ||
          stderr.includes("HACK_DEPENDENCY_PHASE_V1")
        ),
        message:
          "progress must forward only fixed stage messages, not arbitrary installer output or raw markers",
      });
      const jsonResult: unknown = JSON.parse(results[1]?.stdout ?? "");
      expect({
        that:
          typeof jsonResult === "object" &&
          jsonResult !== null &&
          "ok" in jsonResult &&
          jsonResult.ok === true,
        message: "JSON startup stdout must remain a single successful envelope",
      });
      ctx.log(
        "live installing/verifying progress observed before completion; JSON stdout isolated"
      );
    };
    try {
      const liveStderr = ["", ""];
      const completed = [false, false];
      const primaryUp = up(fixture.root, {
        onStderrChunk: (chunk) => {
          liveStderr[0] += chunk;
        },
      }).then((result) => {
        completed[0] = true;
        return result;
      });
      const linkedUp = up(linked, {
        json: true,
        onStderrChunk: (chunk) => {
          liveStderr[1] += chunk;
        },
      }).then((result) => {
        completed[1] = true;
        return result;
      });
      try {
        await waitFor(
          async () =>
            (await listContainers(undefined, "installer")).filter(
              (resource) => resource.State?.Running
            ).length === 2,
          "first-start producer containers did not overlap"
        );
        await waitFor(
          async () =>
            liveStderr
              .join("\n")
              .includes("Dependency cache installer: installing"),
          "installing progress was not delivered while initialization was blocked"
        );
        expect({
          that: completed.every((value) => !value),
          message:
            "installing progress must arrive before either startup completes",
        });
        await releaseInitializers();
        await waitFor(
          async () =>
            liveStderr
              .join("\n")
              .includes("Dependency cache installer: verifying"),
          "verifying progress was not delivered while verification was blocked"
        );
        expect({
          that: completed.every((value) => !value),
          message:
            "verifying progress must arrive before either startup completes",
        });
        await releaseVerifiers();
      } catch (overlapError) {
        await releaseAll();
        await reportStartupFailures(overlapError, [primaryUp, linkedUp]);
      }
      const startupResults = await Promise.all([primaryUp, linkedUp]);
      for (const result of startupResults) {
        expectExit({
          result,
          codes: [0],
          message: "concurrent protocol startup",
        });
      }
      assertStartupProgress(startupResults);
      const originalVolume = await cacheVolume(fixture.name);
      await inspectCache(
        originalVolume,
        `printf 'locked-v1\\n%s\\n' '${originalVolume.split("-").at(-1)}' | cmp -s - /deps/.hack-dependency-cache-v1/ready`
      );
      expect({
        that: (await cacheVolume(projects[1] as string)) === originalVolume,
        message: "linked producers must share the exact volume",
      });
      await ready(fixture.root, fixture.name);
      await ready(linked, projects[1] as string);
      ctx.log(
        "overlapping first starts initialized once; both read-only consumers ready"
      );
      await removeProjectContainers(projects[1] as string);
      expectExit({
        result: await up(linked),
        codes: [0],
        message: "warm protocol startup",
      });
      await ready(linked, projects[1] as string);
      expect({
        that: (await cacheVolume(projects[1] as string)) === originalVolume,
        message: "warm startup must preserve volume identity",
      });
      ctx.log("warm startup reused artifact without another initialization");
      for (const mode of ["init-fail", "verify-fail"] as const) {
        await removeProjectContainers(projects[1] as string);
        await writeCompose(linked, mode, mode);
        const hostMode = (
          await Bun.file(join(linked, "fixture/mode")).text()
        ).trim();
        expect({
          that: hostMode === mode,
          message: "host fault control must match the requested case",
        });
        ctx.log(`starting ${mode}; linked fixture host mode=${hostMode}`);
        const faultResult = await up(linked);
        const faultInstaller = await installer(projects[1] as string);
        const faultLogs = await checkedDocker([
          "logs",
          "--tail",
          "80",
          faultInstaller.Id as string,
        ]);
        ctx.log(
          `${mode} installer diagnostic:\n${faultLogs.combined.slice(-3000)}`
        );
        expect({
          that:
            faultLogs.stdout
              .split("\n")
              .filter((line) => line.startsWith("fixture-mode="))
              .join("\n") === `fixture-mode=${mode}`,
          message: "installer must observe the exact requested failure mode",
          result: faultLogs,
        });
        failed(faultResult);
        expect({
          that: faultResult.stderr.includes(
            "Dependency cache installer: failed"
          ),
          message: "failed protocol startup must report fixed failed progress",
          result: faultResult,
        });
        const volume = await cacheVolume(projects[1] as string);
        await inspectCache(volume, NO_READY);
        expect({
          that: (await listContainers(projects[1] as string, "web")).every(
            (resource) => !resource.State?.Running
          ),
          message: "failed generation must not start a consumer",
        });
        await removeProjectContainers(projects[1] as string);
        await writeCompose(linked, mode);
        failed(await up(linked));
        expect({
          that: (await cacheVolume(projects[1] as string)) === volume,
          message: "same generation retry must address the quarantined volume",
        });
        await inspectCache(volume, NO_READY);
        ctx.log(
          `${mode}: consumer withheld and same-generation mutation refused`
        );
      }
      await removeProjectContainers(projects[1] as string);
      await writeCompose(linked, "interrupt", "interrupt");
      const interrupted = up(linked);
      let killedId = "";
      await waitFor(async () => {
        const resources = await listContainers(
          projects[1] as string,
          "installer"
        );
        const resource = resources[0];
        if (!(resource?.State?.Running && resource.Id)) {
          return false;
        }
        const began = await docker([
          "exec",
          resource.Id,
          "test",
          "-f",
          "/deps/began",
        ]);
        if (began.exitCode !== 0) {
          return false;
        }
        owned(resource);
        killedId = resource.Id;
        return true;
      }, "interrupt fixture did not reach initialization");
      await checkedDocker(["kill", "--signal=KILL", killedId]);
      failed(await interrupted);
      const interruptedVolume = await cacheVolume(projects[1] as string);
      await removeProjectContainers(projects[1] as string);
      await writeCompose(linked, "interrupt");
      failed(await up(linked));
      expect({
        that: (await cacheVolume(projects[1] as string)) === interruptedVolume,
        message: "interrupted generation must not silently change identity",
      });
      await inspectCache(interruptedVolume, NO_READY);
      await removeProjectContainers(projects[1] as string);
      await writeCompose(linked, "recovered");
      expectExit({
        result: await up(linked),
        codes: [0],
        message: "explicit fresh generation must recover",
      });
      expect({
        that: (await cacheVolume(projects[1] as string)) !== interruptedVolume,
        message: "generation bump must select a fresh volume",
      });
      await ready(linked, projects[1] as string);
      await ready(fixture.root, fixture.name);
      ctx.log(
        "interrupted generation quarantined; fresh generation recovered; primary preserved"
      );
    } catch (failure) {
      // Only synthetic fixture output from ownership-checked installers is read.
      // Diagnostics must not replace the original failure or prevent cleanup.
      try {
        for (const resource of await listContainers(undefined, "installer")) {
          const labels = owned(resource);
          const root =
            labels["com.docker.compose.project"] === fixture.name
              ? fixture.root
              : linked;
          const hostMode = (
            await Bun.file(join(root, "fixture/mode")).text()
          ).trim();
          const bind = resource.Mounts?.find(
            (mount) => mount.Destination === "/fixture"
          );
          ctx.log(
            `${labels["com.docker.compose.project"]} fixture diagnostic: ${JSON.stringify({ expectedSource: join(root, "fixture"), bindSource: bind?.Source, bindType: bind?.Type, readOnly: bind?.RW === false, hostMode: hostMode.slice(0, 80), state: resource.State })}`
          );
          const logs = await docker([
            "logs",
            "--tail",
            "80",
            resource.Id as string,
          ]);
          ctx.log(
            `${labels["com.docker.compose.project"]} installer logs (docker exit ${logs.exitCode}):\n${logs.combined.slice(-6000)}`
          );
        }
      } catch (diagnosticError) {
        ctx.log(
          `Installer diagnostics unavailable: ${String(diagnosticError)}`
        );
      }
      throw failure;
    } finally {
      await releaseAll();
      // Let every owned CLI invocation finish before removing any resource.
      await Promise.allSettled(pending);
      for (const project of projects) {
        await removeProjectContainers(project);
      }
      const listed = await checkedDocker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${OWNER}=${fixture.name}`,
      ]);
      for (const name of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
        const inspected = await checkedDocker(["volume", "inspect", name]);
        const volume = (
          JSON.parse(inspected.stdout) as Resource[]
        )[0] as Resource;
        owned(volume);
        expect({
          that:
            volume.Name === name &&
            volume.Labels?.["com.docker.compose.volume"] === "dependencies",
          message: "refuse removal of non-fixture cache volume",
        });
        await checkedDocker(["volume", "rm", name]);
      }
      for (const args of [
        ["ps", "-aq"],
        ["volume", "ls", "-q"],
      ]) {
        const remaining = await checkedDocker([
          ...args,
          "--filter",
          `label=${OWNER}=${fixture.name}`,
        ]);
        expect({
          that: remaining.stdout.trim() === "",
          message: "all owned protocol fixture resources must be gone",
        });
      }
      ctx.log(
        "protocol fixture containers and volumes removed; absence verified"
      );
    }
  },
};
