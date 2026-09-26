import { join } from "node:path";

import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";

const OWNER_LABEL = "hack.e2e.dependency-cache-owner";
const BRANCH = "cache-linked";
const TIMEOUT_MS = 180_000;
const READ_ARTIFACT = "test -f /deps/ready && cat /deps/artifact";

type Container = {
  readonly Config: { readonly Labels: Record<string, string> };
  readonly Mounts: readonly {
    readonly Type: string;
    readonly Name?: string;
    readonly Destination: string;
  }[];
};

type Volume = {
  readonly Name: string;
  readonly Labels: Record<string, string>;
};

/**
 * A tiny fixture producer owns readiness and cold/warm markers. This checks real
 * Compose cache wiring, not package-manager behavior or a generic installer lock.
 */
export const dependencyCacheScenario: Scenario = {
  name: "dependency-cache",
  tier: "docker",
  summary: "real dependency volume reuse across worktrees and lockfile changes",
  run: async (ctx) => {
    const docker = (args: readonly string[]) =>
      runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT_MS,
      });
    const info = await docker(["info", "--format", "{{.Architecture}}"]);
    if (info.exitCode !== 0) {
      ctx.skip("Docker daemon unavailable");
    }
    const architecture = info.stdout.trim();
    const architectures: Record<string, string> = {
      aarch64: "arm64",
      arm64: "arm64",
      x86_64: "amd64",
      amd64: "amd64",
    };
    const arch = architectures[architecture];
    if (!arch) {
      ctx.skip(`unsupported Docker architecture: ${architecture}`);
    }
    const image = await docker([
      "image",
      "inspect",
      "alpine:3.20",
      "--format",
      "{{json .RepoDigests}}",
    ]);
    expectExit({
      result: image,
      codes: [0],
      message: "alpine:3.20 must already be available (no image download)",
    });
    const digests = JSON.parse(image.stdout) as string[];
    const imageRef = digests.find((digest) =>
      digest.startsWith("alpine@sha256:")
    );
    if (!imageRef) {
      throw new Error(
        "Cached Alpine image must have a pinned repository digest"
      );
    }
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { standaloneContainers: true, disableInternal: true },
    });
    const producer = [
      "set -eu",
      "if test -f /deps/ready; then echo warm; else",
      "cat /proc/sys/kernel/random/uuid > /deps/artifact",
      "test -s /deps/artifact",
      "touch /deps/ready",
      "echo cold; fi",
    ]
      .join("; ")
      .replace("else;", "else");
    const base = {
      image: imageRef,
      platform: `linux/${arch}`,
      pull_policy: "never",
      labels: { [OWNER_LABEL]: fixture.name },
      network_mode: "none",
    };
    await Bun.write(join(fixture.root, "fixture.lock"), "version-one\n");
    const compose = {
      name: fixture.name,
      services: {
        installer: {
          ...base,
          command: ["sh", "-c", producer],
          labels: {
            ...base.labels,
            "hack.dependencies.cache-volume": "dependencies",
            "hack.dependencies.lockfiles": "fixture.lock",
            "hack.dependencies.runtime-files": "package.json",
          },
          volumes: ["dependencies:/deps"],
        },
        web: {
          ...base,
          depends_on: {
            installer: { condition: "service_completed_successfully" },
          },
          command: ["sh", "-c", `${READ_ARTIFACT} && exec sleep infinity`],
          volumes: ["dependencies:/deps:ro"],
        },
      },
      volumes: {
        dependencies: { labels: { [OWNER_LABEL]: fixture.name } },
      },
    };
    const writeCompose = (root: string) =>
      Bun.write(
        join(root, ".hack/docker-compose.yml"),
        JSON.stringify(compose, null, 2)
      );
    await writeCompose(fixture.root);
    await commitAll({
      root: fixture.root,
      message: "dependency cache fixture",
    });
    const linked = await addLinkedWorktree({ fixture, branch: BRANCH });
    const projects = [fixture.name, `${fixture.name}--${BRANCH}`];
    const cli = async (cwd: string, args: readonly string[]) => {
      const result = await ctx.cli({ cwd, args, timeoutMs: TIMEOUT_MS });
      expectExit({
        result,
        codes: [0],
        message: `hack ${args.join(" ")} should succeed`,
      });
      return result;
    };
    const containers = async (project: string, service: string) => {
      const result = await docker([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]);
      expectExit({ result, codes: [0], message: "list fixture containers" });
      const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
      expect({
        that: ids.length === 1,
        message: `expected exactly one ${project}/${service} container`,
      });
      const inspected = await docker(["inspect", ...ids]);
      expectExit({
        result: inspected,
        codes: [0],
        message: "inspect fixture container",
      });
      const container = (JSON.parse(inspected.stdout) as Container[])[0];
      expect({
        that:
          container?.Config.Labels[OWNER_LABEL] === fixture.name &&
          container.Config.Labels["com.docker.compose.project"] === project,
        message: "container must belong to this fixture and instance",
      });
      return { id: ids[0] as string, container: container as Container };
    };
    const volume = async (project: string) => {
      const { container } = await containers(project, "web");
      const mount = container.Mounts.find(
        (entry) => entry.Destination === "/deps"
      );
      expect({
        that:
          mount?.Type === "volume" &&
          Boolean(
            mount.Name?.startsWith(`hack-cache-${fixture.name}-dependencies-`)
          ),
        message: "web must mount a fingerprinted dependency volume",
      });
      return mount?.Name;
    };
    const artifact = async (cwd: string) => {
      const result = await cli(cwd, [
        "exec",
        "web",
        "--",
        "sh",
        "-c",
        READ_ARTIFACT,
      ]);
      const value = result.stdout.trim();
      expect({
        that: /^[a-f0-9-]{36}$/.test(value),
        message: "ready dependency artifact must be readable",
        result,
      });
      return value;
    };
    const producerMode = async (project: string, mode: string) => {
      const { id } = await containers(project, "installer");
      // The exited producer reports its fixture-owned cold/warm decision.
      const result = await docker(["logs", id]);
      expectExit({
        result,
        codes: [0],
        message: "read fixture producer result",
      });
      expect({
        that: result.stdout.trim() === mode,
        message: `fixture producer should report ${mode}`,
      });
    };
    try {
      await cli(fixture.root, ["up", "--detach"]);
      const firstVolume = await volume(fixture.name);
      const firstArtifact = await artifact(fixture.root);
      await producerMode(fixture.name, "cold");
      ctx.log("primary cold artifact and fingerprinted volume verified");
      await cli(linked, ["up", "--detach"]);
      expect({
        that:
          (await volume(projects[1] as string)) === firstVolume &&
          (await artifact(linked)) === firstArtifact,
        message:
          "linked checkout must reuse the ready primary artifact and exact volume",
      });
      await producerMode(projects[1] as string, "warm");
      ctx.log("linked warm artifact and exact shared volume verified");
      const run = await cli(linked, [
        "run",
        "web",
        "--",
        "sh",
        "-c",
        READ_ARTIFACT,
      ]);
      expect({
        that: run.stdout.includes(firstArtifact),
        message: "hack run must read the shared ready artifact",
        result: run,
      });
      ctx.log("hack run shared artifact readiness verified");
      await cli(fixture.root, ["restart"]);
      expect({
        that:
          (await volume(fixture.name)) === firstVolume &&
          (await artifact(fixture.root)) === firstArtifact &&
          (await artifact(linked)) === firstArtifact,
        message: "restart must preserve shared cache data in both instances",
      });
      ctx.log("restart preserved both instances and shared artifact");
      await Bun.write(join(linked, "fixture.lock"), "version-two\n");
      await cli(linked, ["up", "--detach"]);
      expect({
        that:
          (await volume(projects[1] as string)) !== firstVolume &&
          (await artifact(linked)) !== firstArtifact,
        message: "changed lockfile must select a fresh populated volume",
      });
      await producerMode(projects[1] as string, "cold");
      expect({
        that:
          (await volume(fixture.name)) === firstVolume &&
          (await artifact(fixture.root)) === firstArtifact,
        message: "linked invalidation must preserve the primary cache",
      });
      ctx.log("lockfile invalidation and unchanged primary artifact verified");

      const replacementImage = await docker([
        "image",
        "inspect",
        "alpine:3.22",
        "--format",
        "{{json .RepoDigests}}",
      ]);
      expectExit({
        result: replacementImage,
        codes: [0],
        message: "cached alternate Alpine image required; no pulls",
      });
      const replacementDigests: unknown = JSON.parse(replacementImage.stdout);
      const replacement = Array.isArray(replacementDigests)
        ? replacementDigests.find(
            (value: unknown): value is string =>
              typeof value === "string" && value.startsWith("alpine@sha256:")
          )
        : undefined;
      expect({
        that: typeof replacement === "string" && replacement !== imageRef,
        message: "alternate image must have a distinct pinned digest",
      });
      if (typeof replacement !== "string") {
        throw new Error("Missing alternate image digest");
      }
      const invalidate = async (reason: string) => {
        const beforeVolume = await volume(projects[1] as string);
        const beforeArtifact = await artifact(linked);
        await writeCompose(linked);
        expect({
          that:
            (await artifact(linked)) === beforeArtifact &&
            (await volume(projects[1] as string)) === beforeVolume,
          message:
            "exec must retain the running mount after configuration changes",
        });
        await cli(linked, ["up", "--detach"]);
        expect({
          that:
            (await volume(projects[1] as string)) !== beforeVolume &&
            (await artifact(linked)) !== beforeArtifact,
          message: `${reason} must populate a fresh cache`,
        });
        await producerMode(projects[1] as string, "cold");
        expect({
          that:
            (await volume(fixture.name)) === firstVolume &&
            (await artifact(fixture.root)) === firstArtifact,
          message: "linked runtime invalidation must preserve primary data",
        });
        ctx.log(
          `${reason} invalidation populated fresh cache; exec retained old mount until up; primary preserved`
        );
      };
      compose.services.installer.image = replacement;
      await invalidate("image digest");
      if (arch === "arm64") {
        compose.services.installer.platform = "linux/arm64/v8";
        await invalidate("explicit native platform variant");
      } else {
        ctx.log(
          "native platform variant check not applicable on this architecture; cross-architecture execution remains unqualified"
        );
      }
    } finally {
      // Label-scoped fallback also handles a partially failed up. Never prune or
      // use down -v: the two projects intentionally share the original volume.
      const listed = await docker([
        "ps",
        "-aq",
        "--filter",
        `label=${OWNER_LABEL}=${fixture.name}`,
      ]);
      expectExit({
        result: listed,
        codes: [0],
        message: "discover owned cleanup containers",
      });
      for (const id of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
        const inspected = await docker(["inspect", id]);
        expectExit({
          result: inspected,
          codes: [0],
          message: "verify cleanup container",
        });
        const item = (JSON.parse(inspected.stdout) as Container[])[0];
        expect({
          that:
            item?.Config.Labels[OWNER_LABEL] === fixture.name &&
            projects.includes(
              item.Config.Labels["com.docker.compose.project"] ?? ""
            ),
          message: "refuse cleanup outside exact fixture ownership",
        });
        const removed = await docker(["rm", "-f", id]);
        expectExit({
          result: removed,
          codes: [0],
          message: "remove owned fixture container",
        });
      }
      const listedVolumes = await docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${OWNER_LABEL}=${fixture.name}`,
      ]);
      expectExit({
        result: listedVolumes,
        codes: [0],
        message: "discover owned cleanup volumes",
      });
      for (const name of listedVolumes.stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean)) {
        const inspected = await docker(["volume", "inspect", name]);
        expectExit({
          result: inspected,
          codes: [0],
          message: "verify cleanup volume",
        });
        const item = (JSON.parse(inspected.stdout) as Volume[])[0];
        expect({
          that:
            item?.Name === name &&
            item.Labels[OWNER_LABEL] === fixture.name &&
            projects.includes(
              item.Labels["com.docker.compose.project"] ?? ""
            ) &&
            item.Labels["com.docker.compose.volume"] === "dependencies",
          message: "refuse volume cleanup outside exact fixture ownership",
        });
        const removed = await docker(["volume", "rm", name]);
        expectExit({
          result: removed,
          codes: [0],
          message: "remove owned dependency volume",
        });
      }
      for (const args of [
        ["ps", "-aq"],
        ["volume", "ls", "-q"],
      ]) {
        const remaining = await docker([
          ...args,
          "--filter",
          `label=${OWNER_LABEL}=${fixture.name}`,
        ]);
        expectExit({
          result: remaining,
          codes: [0],
          message: "verify owned resource cleanup",
        });
        expect({
          that: remaining.stdout.trim() === "",
          message: "no owned fixture resources may remain",
          result: remaining,
        });
      }
      ctx.log("owned fixture containers and volumes removed; absence verified");
    }
  },
};
