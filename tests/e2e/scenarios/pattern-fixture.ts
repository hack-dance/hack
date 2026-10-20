import { cp, rename } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { YAML } from "bun";

import { PATTERN_CATALOGUE } from "../../../src/agents/pattern-catalogue.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import {
  gitInitAndCommit,
  type MonorepoFixture,
  randomProjectName,
} from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  REPO_ROOT,
  runCommand,
  type ScenarioContext,
} from "../harness.ts";

/**
 * Shared setup for the Docker-tier scenarios that start a HACK-P example
 * fixture (`examples/patterns/`) against a real engine.
 *
 * The scenario copies the checked-in fixture and changes only what a
 * disposable, offline CI run needs:
 * - the project name and dev host become a random `e2e-<hex>` name;
 * - the digest-pinned Alpine Bun image becomes the repository digest of the
 *   runner's cached `oven/bun:1.4.2-slim` (same Bun release), with
 *   `pull_policy: never`, so nothing is downloaded during qualification;
 * - a declared `platform` becomes the daemon's architecture;
 * - every service and named volume gets an exact owner label for cleanup.
 * Commands, mounts, labels, dependency gates and health checks stay as the
 * fixture authored them. A fixture whose image no longer matches
 * `PATTERN_FIXTURE_IMAGE` fails instead of being silently rewritten.
 */

/** The image every pattern fixture declares today. */
export const PATTERN_FIXTURE_IMAGE =
  "oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f";
/** Pre-pulled by the docker-e2e job; resolved to its repository digest. */
export const CACHED_BUN_IMAGE = "oven/bun:1.4.2-slim";

const DOCKER_TIMEOUT_MS = 60_000;
const ARCHITECTURES: Readonly<Record<string, string>> = {
  arm64: "arm64",
  aarch64: "arm64",
  amd64: "amd64",
  x86_64: "amd64",
};
/** Never copied from a contributor checkout into the disposable fixture. */
const UNCOPIED = new Set(["node_modules", ".internal", ".branch", ".env"]);

export type PatternEngine = {
  /** Docker architecture name, `arm64` or `amd64`. */
  readonly arch: string;
  /** Immutable `oven/bun@sha256:...` reference of the cached image. */
  readonly image: string;
};

export type DockerResource = {
  readonly Id?: string;
  readonly Name?: string;
  readonly Labels?: Record<string, string> | null;
  readonly Config?: {
    readonly Labels?: Record<string, string> | null;
    readonly Env?: readonly string[] | null;
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly ExitCode?: number;
    readonly Health?: { readonly Status?: string } | null;
  };
  readonly Mounts?: readonly {
    readonly Type: string;
    readonly Name?: string;
    readonly Source?: string;
    readonly Destination: string;
    readonly RW: boolean;
  }[];
};

/** Run a docker client command; the scenario owns argument selection. */
export async function docker(opts: {
  readonly ctx: ScenarioContext;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}): Promise<CliResult> {
  return await runCommand({
    argv: ["docker", ...opts.args],
    cwd: opts.ctx.tempRoot,
    timeoutMs: opts.timeoutMs ?? DOCKER_TIMEOUT_MS,
  });
}

/** Run a docker client command that must succeed. */
export async function checkedDocker(opts: {
  readonly ctx: ScenarioContext;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}): Promise<CliResult> {
  const result = await docker(opts);
  expectExit({
    result,
    codes: [0],
    message: `docker ${opts.args[0]} pattern fixture operation`,
  });
  return result;
}

/**
 * Resolve the daemon architecture and the cached Bun image. An unavailable
 * daemon or unsupported architecture skips; a missing cached image fails,
 * because the scenario never pulls.
 */
export async function requirePatternEngine(
  ctx: ScenarioContext
): Promise<PatternEngine> {
  const info = await docker({
    ctx,
    args: ["info", "--format", "{{.Architecture}}"],
  });
  if (info.exitCode !== 0) {
    ctx.skip("Docker daemon unavailable");
  }
  const arch = ARCHITECTURES[info.stdout.trim()];
  if (!arch) {
    ctx.skip("unsupported Docker daemon architecture");
  }
  const inspected = await checkedDocker({
    ctx,
    args: [
      "image",
      "inspect",
      CACHED_BUN_IMAGE,
      "--format",
      "{{json .RepoDigests}}",
    ],
  });
  const digests: unknown = JSON.parse(inspected.stdout);
  const image = Array.isArray(digests)
    ? digests.find(
        (value): value is string =>
          typeof value === "string" && value.startsWith("oven/bun@sha256:")
      )
    : undefined;
  expect({
    that: image !== undefined,
    message: `${CACHED_BUN_IMAGE} must already be cached with a repository digest; no pulls`,
  });
  return { arch: arch as string, image: image as string };
}

function patternExample(cardId: string): string {
  const card = PATTERN_CATALOGUE.find((entry) => entry.id === cardId);
  if (!card?.example) {
    throw new Error(`${cardId} has no example fixture`);
  }
  return join(REPO_ROOT, card.example);
}

function withOwner(opts: {
  readonly value: unknown;
  readonly owner: string;
  readonly name: string;
}): Record<string, unknown> {
  const labels = isRecord(opts.value) ? { ...opts.value } : {};
  expect({
    that: opts.value === undefined || isRecord(opts.value),
    message: "pattern fixture labels must be a mapping",
  });
  labels[opts.owner] = opts.name;
  return labels;
}

function rewriteCompose(opts: {
  readonly compose: unknown;
  readonly name: string;
  readonly owner: string;
  readonly engine: PatternEngine;
}): Record<string, unknown> {
  expect({
    that: isRecord(opts.compose) && isRecord(opts.compose.services),
    message: "pattern fixture Compose file must declare services",
  });
  const compose = structuredClone(opts.compose) as Record<string, unknown>;
  compose.name = opts.name;
  for (const service of Object.values(
    compose.services as Record<string, unknown>
  )) {
    expect({
      that: isRecord(service) && service.image === PATTERN_FIXTURE_IMAGE,
      message:
        "pattern fixture image changed; update PATTERN_FIXTURE_IMAGE and the cached CI image together",
    });
    const entry = service as Record<string, unknown>;
    entry.image = opts.engine.image;
    entry.pull_policy = "never";
    if (entry.platform !== undefined) {
      entry.platform = `linux/${opts.engine.arch}`;
    }
    entry.labels = withOwner({
      value: entry.labels,
      owner: opts.owner,
      name: opts.name,
    });
  }
  if (isRecord(compose.volumes)) {
    for (const [volume, definition] of Object.entries(compose.volumes)) {
      const declared = isRecord(definition) ? { ...definition } : {};
      declared.labels = withOwner({
        value: declared.labels,
        owner: opts.owner,
        name: opts.name,
      });
      compose.volumes[volume] = declared;
    }
  }
  return compose;
}

/**
 * Copy a card's example into `ctx.tempRoot`, apply the substitutions listed
 * above, and commit it as the primary checkout of a fresh repository.
 */
export async function copyPatternFixture(opts: {
  readonly ctx: ScenarioContext;
  readonly cardId: string;
  readonly owner: string;
  readonly engine: PatternEngine;
}): Promise<MonorepoFixture> {
  const source = patternExample(opts.cardId);
  const name = randomProjectName();
  const root = join(opts.ctx.tempRoot, name);
  await cp(source, root, {
    recursive: true,
    filter: (path) =>
      !relative(source, path)
        .split(sep)
        .some((part) => UNCOPIED.has(part)),
  });
  const hackDir = join(root, ".hack");
  const devHost = `${name}.hack.local`;
  const config: unknown = await Bun.file(
    join(hackDir, "hack.config.json")
  ).json();
  expect({
    that: isRecord(config),
    message: "pattern fixture hack.config.json must be an object",
  });
  await Bun.write(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({ ...(config as Record<string, unknown>), name, dev_host: devHost }, null, 2)}\n`
  );
  const compose = rewriteCompose({
    compose: YAML.parse(
      await Bun.file(join(hackDir, "docker-compose.yml")).text()
    ),
    name,
    owner: opts.owner,
    engine: opts.engine,
  });
  await writeComposeFile({ root, compose });
  await gitInitAndCommit({ root });
  return { root, name, devHost, hackDir };
}

/** Read a checkout's (already rewritten, JSON-encoded) Compose file. */
export async function readComposeFile(
  root: string
): Promise<Record<string, unknown>> {
  const parsed: unknown = YAML.parse(
    await Bun.file(join(root, ".hack/docker-compose.yml")).text()
  );
  if (!isRecord(parsed)) {
    throw new Error("pattern fixture Compose root must be a mapping");
  }
  return parsed;
}

/** Publish a Compose file on a fresh inode, as Docker bind readers expect. */
export async function writeComposeFile(opts: {
  readonly root: string;
  readonly compose: Record<string, unknown>;
}): Promise<void> {
  await replaceFile({
    path: join(opts.root, ".hack/docker-compose.yml"),
    content: `${JSON.stringify(opts.compose, null, 2)}\n`,
  });
}

/** Write a file by rename so a bind-mounted reader never sees a partial file. */
export async function replaceFile(opts: {
  readonly path: string;
  readonly content: string;
}): Promise<void> {
  const pending = `${opts.path}.pending`;
  await Bun.write(pending, opts.content);
  await rename(pending, opts.path);
}

/** Labels of a container or volume after exact fixture ownership checks. */
export function ownedLabels(opts: {
  readonly resource: DockerResource;
  readonly owner: string;
  readonly name: string;
  readonly projects: readonly string[];
}): Record<string, string> {
  const labels = opts.resource.Config?.Labels ?? opts.resource.Labels ?? {};
  expect({
    that:
      labels[opts.owner] === opts.name &&
      opts.projects.includes(labels["com.docker.compose.project"] ?? ""),
    message: "refuse operation outside exact pattern fixture ownership",
  });
  return labels;
}

/** Inspect owned containers, optionally narrowed to one project and service. */
export async function ownedContainers(opts: {
  readonly ctx: ScenarioContext;
  readonly owner: string;
  readonly name: string;
  readonly projects: readonly string[];
  readonly project?: string;
  readonly service?: string;
}): Promise<DockerResource[]> {
  const listed = await checkedDocker({
    ctx: opts.ctx,
    args: [
      "ps",
      "-aq",
      "--filter",
      `label=${opts.owner}=${opts.name}`,
      ...(opts.project
        ? ["--filter", `label=com.docker.compose.project=${opts.project}`]
        : []),
      ...(opts.service
        ? ["--filter", `label=com.docker.compose.service=${opts.service}`]
        : []),
    ],
  });
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) {
    return [];
  }
  const inspected = await checkedDocker({
    ctx: opts.ctx,
    args: ["inspect", ...ids],
  });
  const resources = JSON.parse(inspected.stdout) as DockerResource[];
  for (const resource of resources) {
    ownedLabels({ ...opts, resource });
  }
  return resources;
}

/** Inspect owned named volumes. */
export async function ownedVolumes(opts: {
  readonly ctx: ScenarioContext;
  readonly owner: string;
  readonly name: string;
  readonly projects: readonly string[];
}): Promise<DockerResource[]> {
  const listed = await checkedDocker({
    ctx: opts.ctx,
    args: [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=${opts.owner}=${opts.name}`,
    ],
  });
  const names = listed.stdout.trim().split(/\s+/).filter(Boolean);
  if (names.length === 0) {
    return [];
  }
  const inspected = await checkedDocker({
    ctx: opts.ctx,
    args: ["volume", "inspect", ...names],
  });
  const resources = JSON.parse(inspected.stdout) as DockerResource[];
  for (const resource of resources) {
    ownedLabels({ ...opts, resource });
  }
  return resources;
}

/** Poll `check` every 200 ms until it holds or `timeoutMs` passes. */
export async function waitFor(opts: {
  readonly check: () => Promise<boolean>;
  readonly timeoutMs: number;
  readonly message: string;
}): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await opts.check()) {
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(opts.message);
}

/**
 * Stop each checkout through Hack, then remove only exactly owned containers,
 * volumes and the projects' Compose networks, and verify their absence.
 */
export async function cleanupPatternFixture(opts: {
  readonly ctx: ScenarioContext;
  readonly owner: string;
  readonly name: string;
  readonly projects: readonly string[];
  readonly checkouts: readonly string[];
}): Promise<void> {
  for (const cwd of opts.checkouts) {
    // Best effort: the owned-resource sweep below is the cleanup authority.
    await opts.ctx.cli({ args: ["down"], cwd, timeoutMs: 180_000 });
  }
  for (const resource of await ownedContainers(opts)) {
    await checkedDocker({
      ctx: opts.ctx,
      args: ["rm", "-f", resource.Id ?? ""],
    });
  }
  for (const volume of await ownedVolumes(opts)) {
    await checkedDocker({
      ctx: opts.ctx,
      args: ["volume", "rm", volume.Name ?? ""],
    });
  }
  for (const project of opts.projects) {
    const networks = await checkedDocker({
      ctx: opts.ctx,
      args: [
        "network",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ],
    });
    for (const id of networks.stdout.trim().split(/\s+/).filter(Boolean)) {
      await checkedDocker({ ctx: opts.ctx, args: ["network", "rm", id] });
    }
  }
  expect({
    that:
      (await ownedContainers(opts)).length === 0 &&
      (await ownedVolumes(opts)).length === 0,
    message: "all owned pattern fixture containers and volumes must be gone",
  });
  opts.ctx.log(
    "owned pattern fixture containers, volumes and networks removed; absence verified"
  );
}
