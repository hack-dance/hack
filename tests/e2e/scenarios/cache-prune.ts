import { join } from "node:path";

import { createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  runCommand,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

const COMMAND_TIMEOUT_MS = 180_000;
const DISPOSABLE_VOLUME = "build-cache";
const DURABLE_VOLUME = "application-data";

type DownPayload = {
  readonly data?: {
    readonly cacheVolumesRemoved?: readonly string[];
  };
};

/**
 * Exercises the real Compose label, container-mount, teardown, and exact
 * volume-removal path while proving an adjacent durable volume survives.
 */
export const cachePruneScenario: Scenario = {
  name: "cache-prune",
  tier: "docker",
  summary: "prunes an opted-in cache while preserving durable volume data",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });

    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { standaloneContainers: true },
    });
    await Bun.write(
      join(fixture.hackDir, "docker-compose.yml"),
      renderCacheCompose({ name: fixture.name })
    );

    try {
      const up = await ctx.cli({
        args: ["up", "--detach"],
        cwd: fixture.root,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      expectExit({
        result: up,
        codes: [0],
        message: "cache-prune fixture should start",
      });

      const disposableName = await resolveComposeVolumeName({
        ctx,
        composeProject: fixture.name,
        logicalName: DISPOSABLE_VOLUME,
      });
      const durableName = await resolveComposeVolumeName({
        ctx,
        composeProject: fixture.name,
        logicalName: DURABLE_VOLUME,
      });

      const writeMarkers = await runCommand({
        argv: [
          "docker",
          "compose",
          "-p",
          fixture.name,
          "-f",
          join(fixture.hackDir, "docker-compose.yml"),
          "exec",
          "-T",
          "web",
          "bun",
          "-e",
          'await Bun.write("/app/.turbo/cache.txt", "cache"); await Bun.write("/app/data/durable.txt", "durable")',
        ],
        cwd: fixture.root,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      expectExit({
        result: writeMarkers,
        codes: [0],
        message: "fixture should write cache and durable-volume markers",
      });

      const down = await ctx.cli({
        args: ["down", "--prune-caches", "--yes", "--json"],
        cwd: fixture.root,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      expectExit({
        result: down,
        codes: [0],
        message: "hack down --prune-caches should succeed",
      });
      const payload = extractJsonObject<DownPayload>({ text: down.stdout });
      expect({
        that:
          payload?.data?.cacheVolumesRemoved?.includes(disposableName) === true,
        message: `down JSON should report removal of ${disposableName}`,
        result: down,
      });
      expect({
        that:
          payload?.data?.cacheVolumesRemoved?.includes(durableName) !== true,
        message: `down JSON must not report durable volume ${durableName} as removed`,
        result: down,
      });

      const disposableInspect = await inspectVolume({
        ctx,
        name: disposableName,
      });
      expect({
        that: disposableInspect.exitCode !== 0,
        message: `disposable cache volume ${disposableName} should be removed`,
        result: disposableInspect,
      });

      const durableInspect = await inspectVolume({ ctx, name: durableName });
      expectExit({
        result: durableInspect,
        codes: [0],
        message: `durable volume ${durableName} should survive cache pruning`,
      });
      const durableMarker = await runCommand({
        argv: [
          "docker",
          "run",
          "--rm",
          "--volume",
          `${durableName}:/data:ro`,
          "oven/bun:1",
          "bun",
          "-e",
          'process.stdout.write(await Bun.file("/data/durable.txt").text())',
        ],
        cwd: fixture.root,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      expectExit({
        result: durableMarker,
        codes: [0],
        message: "durable volume marker should remain readable after pruning",
      });
      expect({
        that: durableMarker.stdout === "durable",
        message: `durable volume marker changed: ${durableMarker.stdout}`,
        result: durableMarker,
      });
    } finally {
      await downBestEffort({ ctx, fixture });
    }
  },
};

function renderCacheCompose(opts: { readonly name: string }): string {
  return [
    `name: ${opts.name}`,
    "services:",
    "  web:",
    "    image: oven/bun:1",
    "    command: bun -e 'setInterval(() => {}, 60000)'",
    "    volumes:",
    `      - ${DISPOSABLE_VOLUME}:/app/.turbo`,
    `      - ${DURABLE_VOLUME}:/app/data`,
    "    networks:",
    "      - hack-dev",
    "      - default",
    "volumes:",
    `  ${DISPOSABLE_VOLUME}:`,
    "    labels:",
    '      hack.cache.disposable: "true"',
    `  ${DURABLE_VOLUME}:`,
    "networks:",
    "  hack-dev:",
    "    external: true",
    "",
  ].join("\n");
}

async function resolveComposeVolumeName(opts: {
  readonly ctx: ScenarioContext;
  readonly composeProject: string;
  readonly logicalName: string;
}): Promise<string> {
  const result = await runCommand({
    argv: [
      "docker",
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${opts.composeProject}`,
      "--filter",
      `label=com.docker.compose.volume=${opts.logicalName}`,
    ],
    cwd: opts.ctx.tempRoot,
  });
  expectExit({
    result,
    codes: [0],
    message: `should resolve Compose volume ${opts.logicalName}`,
  });
  const names = result.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  expect({
    that: names.length === 1,
    message: `expected one ${opts.logicalName} volume, found ${names.join(", ") || "none"}`,
    result,
  });
  return names[0] ?? "";
}

async function inspectVolume(opts: {
  readonly ctx: ScenarioContext;
  readonly name: string;
}) {
  return await runCommand({
    argv: ["docker", "volume", "inspect", opts.name],
    cwd: opts.ctx.tempRoot,
  });
}
