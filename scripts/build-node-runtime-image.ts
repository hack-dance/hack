#!/usr/bin/env bun

import { resolve } from "node:path";

type BuildNodeRuntimeImageArgs = {
  readonly tags: readonly string[];
  readonly platform: string | null;
  readonly push: boolean;
  readonly load: boolean;
  readonly noCache: boolean;
};

type ParseResult =
  | { readonly ok: true; readonly args: BuildNodeRuntimeImageArgs }
  | { readonly ok: false; readonly message: string; readonly exitCode: number };

type MutableParseState = {
  readonly tags: string[];
  platform: string | null;
  push: boolean;
  load: boolean;
  noCache: boolean;
};

type TokenParseResult =
  | { readonly ok: true; readonly nextIndex: number }
  | { readonly ok: false; readonly result: ParseResult };

const parsed = parseArgs({ argv: Bun.argv.slice(2) });

if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n`);
  process.exit(parsed.exitCode);
}

process.exitCode = await main({ args: parsed.args });

/**
 * Build and optionally publish the dedicated node-runtime container image.
 */
async function main({
  args,
}: {
  readonly args: BuildNodeRuntimeImageArgs;
}): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..");
  const packageVersion = await readPackageVersion({ repoRoot });
  if (!packageVersion) {
    process.stderr.write(
      "Unable to resolve package version from package.json.\n"
    );
    return 1;
  }

  const vcsRef =
    process.env.GITHUB_SHA?.trim() ||
    (await readGitRevision({ repoRoot })) ||
    "unknown";
  const buildDate = new Date().toISOString();
  const dockerfile = resolve(repoRoot, "docker/node-runtime/Dockerfile");
  const command = [
    "docker",
    "buildx",
    "build",
    "--file",
    dockerfile,
    ...args.tags.flatMap((tag) => ["--tag", tag]),
    "--build-arg",
    `HACK_VERSION=${packageVersion}`,
    "--build-arg",
    `BUILD_DATE=${buildDate}`,
    "--build-arg",
    `VCS_REF=${vcsRef}`,
  ];

  if (args.platform) {
    command.push("--platform", args.platform);
  }
  if (args.noCache) {
    command.push("--no-cache");
  }
  if (args.push) {
    command.push("--push");
  } else if (args.load) {
    command.push("--load");
  }
  command.push(repoRoot);

  process.stdout.write(
    `${[
      "Building node-runtime image:",
      `  tags: ${args.tags.join(", ")}`,
      `  platform: ${args.platform ?? "docker default"}`,
      `  output: ${args.push ? "push" : args.load ? "load" : "none"}`,
      `  dockerfile: ${dockerfile}`,
    ].join("\n")}\n`
  );

  return await run({ cmd: command, cwd: repoRoot });
}

/**
 * Parse command-line arguments for container image build/publish.
 */
function parseArgs({
  argv,
}: {
  readonly argv: readonly string[];
}): ParseResult {
  const state: MutableParseState = {
    tags: [],
    platform: null,
    push: false,
    load: false,
    noCache: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }
    const token = parseToken({
      argv,
      index,
      token: value,
      state,
    });
    if (!token.ok) {
      return token.result;
    }
    index = token.nextIndex;
  }

  return finalizeParsedArgs({ state });
}

function parseToken({
  argv,
  index,
  token,
  state,
}: {
  readonly argv: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: MutableParseState;
}): TokenParseResult {
  if (token === "--help" || token === "-h") {
    return {
      ok: false,
      result: { ok: false, message: renderHelp(), exitCode: 0 },
    };
  }
  if (token === "--push") {
    state.push = true;
    return { ok: true, nextIndex: index };
  }
  if (token === "--load") {
    state.load = true;
    return { ok: true, nextIndex: index };
  }
  if (token === "--no-cache") {
    state.noCache = true;
    return { ok: true, nextIndex: index };
  }

  const tag = readOptionValue({
    argv,
    index,
    token,
    option: "--tag",
  });
  if (tag.kind === "value") {
    state.tags.push(tag.value);
    return { ok: true, nextIndex: tag.nextIndex };
  }
  if (tag.kind === "error") {
    return {
      ok: false,
      result: { ok: false, message: tag.message, exitCode: 1 },
    };
  }

  const platform = readOptionValue({
    argv,
    index,
    token,
    option: "--platform",
  });
  if (platform.kind === "value") {
    state.platform = platform.value;
    return { ok: true, nextIndex: platform.nextIndex };
  }
  if (platform.kind === "error") {
    return {
      ok: false,
      result: { ok: false, message: platform.message, exitCode: 1 },
    };
  }

  return {
    ok: false,
    result: {
      ok: false,
      message: `Unknown argument: ${token}\n\n${renderHelp()}`,
      exitCode: 1,
    },
  };
}

function readOptionValue({
  argv,
  index,
  token,
  option,
}: {
  readonly argv: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly option: "--tag" | "--platform";
}):
  | { readonly kind: "none" }
  | {
      readonly kind: "value";
      readonly value: string;
      readonly nextIndex: number;
    }
  | { readonly kind: "error"; readonly message: string } {
  if (token === option) {
    const nextValue = argv[index + 1]?.trim();
    if (!nextValue) {
      return { kind: "error", message: `Missing value for ${option}.` };
    }
    return { kind: "value", value: nextValue, nextIndex: index + 1 };
  }
  if (token.startsWith(`${option}=`)) {
    const inlineValue = token.slice(`${option}=`.length).trim();
    if (!inlineValue) {
      return { kind: "error", message: `Invalid ${option} value.` };
    }
    return { kind: "value", value: inlineValue, nextIndex: index };
  }
  return { kind: "none" };
}

function finalizeParsedArgs({
  state,
}: {
  readonly state: MutableParseState;
}): ParseResult {
  if (state.push && state.load) {
    return {
      ok: false,
      message: "Use either --push or --load, not both.",
      exitCode: 1,
    };
  }

  const effectiveTags =
    state.tags.length > 0 ? state.tags : ["hack-node-runtime:dev"];
  const hasMultiPlatform = state.platform?.includes(",") ?? false;
  const effectiveLoad = !state.push && (state.load || !state.push);
  if (effectiveLoad && hasMultiPlatform) {
    return {
      ok: false,
      message:
        "Cannot use --load with multi-platform builds. Use --push or a single --platform value.",
      exitCode: 1,
    };
  }

  return {
    ok: true,
    args: {
      tags: effectiveTags,
      platform: state.platform,
      push: state.push,
      load: effectiveLoad,
      noCache: state.noCache,
    },
  };
}

/**
 * Read CLI package version to stamp the image metadata labels.
 */
async function readPackageVersion({
  repoRoot,
}: {
  readonly repoRoot: string;
}): Promise<string | null> {
  try {
    const packageJson = await Bun.file(
      resolve(repoRoot, "package.json")
    ).json();
    if (
      typeof packageJson === "object" &&
      packageJson !== null &&
      "version" in packageJson &&
      typeof packageJson.version === "string"
    ) {
      return packageJson.version;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve a short git revision for OCI metadata.
 */
async function readGitRevision({
  repoRoot,
}: {
  readonly repoRoot: string;
}): Promise<string | null> {
  const process = Bun.spawn({
    cmd: ["git", "rev-parse", "--short", "HEAD"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const output = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    return null;
  }
  const value = output.trim();
  return value.length > 0 ? value : null;
}

/**
 * Run a command with inherited stdio and return its exit code.
 */
async function run({
  cmd,
  cwd,
}: {
  readonly cmd: readonly string[];
  readonly cwd: string;
}): Promise<number> {
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

function renderHelp(): string {
  return [
    "Build/publish the hack node-runtime container image.",
    "",
    "Usage:",
    "  bun run scripts/build-node-runtime-image.ts [options]",
    "",
    "Options:",
    "  --tag <tag>           Image tag (repeatable, default: hack-node-runtime:dev)",
    "  --platform <value>    Docker platform(s), e.g. linux/amd64,linux/arm64",
    "  --push                Push image to registry",
    "  --load                Load image into local Docker daemon (default when --push is not set)",
    "  --no-cache            Disable Docker build cache",
    "  -h, --help            Show help",
  ].join("\n");
}
