import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runCommand } from "./harness.ts";

/**
 * Scaffolds a disposable turborepo-style Bun monorepo used as the target
 * project for e2e scenarios:
 *
 * - root package.json with workspaces ["apps/*", "packages/*"] + turbo.json
 * - apps/web  — Bun.serve HTTP server answering "ok web" (Dockerfile included)
 * - apps/api  — Bun.serve HTTP server answering JSON (Dockerfile included)
 * - packages/shared — tiny ts lib consumed by both apps via relative import
 *   (so containers can run without a `bun install` step)
 * - optional .hack/ config following the CLI's own templates (compose with
 *   caddy labels on the hack-dev network, hack.config.json, env yaml)
 * - git init + initial commit, plus a helper to add linked worktrees
 */

const WEB_PORT = 3000;
const API_PORT = 3100;

export type MonorepoFixture = {
  /** Repo root of the fixture. */
  readonly root: string;
  /** Project slug (also the compose project name). */
  readonly name: string;
  /** dev_host configured in .hack/hack.config.json (when withHackConfig). */
  readonly devHost: string;
  /** .hack directory path (exists only when withHackConfig was true). */
  readonly hackDir: string;
};

export type LifecycleFixtureOptions = {
  /** Adds a lifecycle.up.before hook that writes this marker file. */
  readonly upBeforeMarkerFile?: string;
  /** Adds a lifecycle.up.before hook that records resolved global/host env. */
  readonly upBeforeEnvMarkerFile?: string;
  /** Adds a long-running lifecycle host process (bun sleep loop). */
  readonly persistentProcess?: boolean;
  /** Makes docker compose reject the fixture after lifecycle startup. */
  readonly composeFailure?: boolean;
  /** Runs fixture containers without a host bind mount. */
  readonly standaloneContainers?: boolean;
  /** Disables global DNS/TLS integration for local lifecycle-only scenarios. */
  readonly disableInternal?: boolean;
  /** Adds a failing lifecycle.down.before hook. */
  readonly downBeforeFailure?: boolean;
};

/** Random, collision-proof project slug (also used for dev_host). */
export function randomProjectName(): string {
  return `e2e-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Create the monorepo fixture inside `parentDir` and commit it.
 */
export async function createMonorepoFixture(opts: {
  readonly parentDir: string;
  readonly withHackConfig: boolean;
  readonly name?: string;
  readonly lifecycle?: LifecycleFixtureOptions;
  readonly oauthEnabled?: boolean;
}): Promise<MonorepoFixture> {
  const name = opts.name ?? randomProjectName();
  const devHost = `${name}.hack`;
  const root = join(opts.parentDir, name);
  const hackDir = join(root, ".hack");

  await writeRootFiles({ root, name });
  await writeSharedPackage({ root });
  await writeApp({
    root,
    app: "web",
    port: WEB_PORT,
    responseKind: "text",
  });
  await writeApp({
    root,
    app: "api",
    port: API_PORT,
    responseKind: "json",
  });

  if (opts.withHackConfig) {
    await writeHackConfig({
      hackDir,
      name,
      devHost,
      lifecycle: opts.lifecycle,
      oauthEnabled: opts.oauthEnabled,
    });
  }

  await gitInitAndCommit({ root });
  return { root, name, devHost, hackDir };
}

/**
 * Add a linked git worktree for a new branch; returns the worktree path
 * (a sibling directory of the fixture root inside the same temp parent).
 */
export async function addLinkedWorktree(opts: {
  readonly fixture: MonorepoFixture;
  readonly branch: string;
}): Promise<string> {
  const worktreePath = resolve(
    opts.fixture.root,
    "..",
    `${opts.fixture.name}-${opts.branch}`
  );
  const result = await runCommand({
    argv: [
      "git",
      "-C",
      opts.fixture.root,
      "worktree",
      "add",
      worktreePath,
      "-b",
      opts.branch,
    ],
    cwd: opts.fixture.root,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git worktree add failed (exit ${result.exitCode}):\n${result.combined}`
    );
  }
  return worktreePath;
}

/** Commit all pending changes in a fixture checkout. */
export async function commitAll(opts: {
  readonly root: string;
  readonly message: string;
}): Promise<void> {
  await git({ root: opts.root, args: ["add", "-A"] });
  await git({
    root: opts.root,
    args: ["commit", "-q", "-m", opts.message],
  });
}

async function writeRootFiles(opts: {
  readonly root: string;
  readonly name: string;
}): Promise<void> {
  await mkdir(opts.root, { recursive: true });

  const packageJson = {
    name: opts.name,
    private: true,
    type: "module",
    workspaces: ["apps/*", "packages/*"],
    scripts: {
      dev: "bunx turbo run dev --parallel",
      build: "bunx turbo run build",
      test: "bunx turbo run test",
    },
  };
  await Bun.write(
    join(opts.root, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );

  const turboJson = {
    $schema: "https://turborepo.com/schema.json",
    tasks: {
      dev: { cache: false, persistent: true },
      build: { dependsOn: ["^build"], outputs: ["dist/**"] },
      test: { dependsOn: ["build"] },
    },
  };
  await Bun.write(
    join(opts.root, "turbo.json"),
    `${JSON.stringify(turboJson, null, 2)}\n`
  );

  await Bun.write(
    join(opts.root, ".gitignore"),
    [
      "node_modules/",
      "dist/",
      "# hack internal (local overrides)",
      ".hack/.internal/",
      ".hack/.env",
      ".hack/.env.state.json",
      ".hack.secret.key",
      "",
    ].join("\n")
  );

  await Bun.write(
    join(opts.root, "README.md"),
    `# ${opts.name}\n\nDisposable e2e fixture monorepo for the hack CLI test harness.\n`
  );
}

async function writeSharedPackage(opts: {
  readonly root: string;
}): Promise<void> {
  const dir = join(opts.root, "packages", "shared");
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "@e2e/shared",
        private: true,
        type: "module",
        module: "index.ts",
      },
      null,
      2
    )}\n`
  );
  await Bun.write(
    join(dir, "index.ts"),
    [
      "/**",
      " * Tiny shared lib consumed by apps/web and apps/api.",
      " */",
      "export function serviceLabel(opts: { readonly service: string }): string {",
      "  return `ok ${opts.service}`",
      "}",
      "",
    ].join("\n")
  );
}

async function writeApp(opts: {
  readonly root: string;
  readonly app: "web" | "api";
  readonly port: number;
  readonly responseKind: "text" | "json";
}): Promise<void> {
  const dir = join(opts.root, "apps", opts.app);
  await mkdir(dir, { recursive: true });

  await Bun.write(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `@e2e/${opts.app}`,
        private: true,
        type: "module",
        scripts: { dev: "bun index.ts" },
      },
      null,
      2
    )}\n`
  );

  const responseLine =
    opts.responseKind === "text"
      ? `    return new Response(serviceLabel({ service: "${opts.app}" }))`
      : `    return Response.json({ ok: true, service: "${opts.app}", label: serviceLabel({ service: "${opts.app}" }) })`;

  await Bun.write(
    join(dir, "index.ts"),
    [
      'import { serviceLabel } from "../../packages/shared/index.ts"',
      "",
      `const port = Number(process.env.PORT ?? "${opts.port}")`,
      "",
      "Bun.serve({",
      "  port,",
      '  hostname: "0.0.0.0",',
      "  fetch() {",
      responseLine,
      "  },",
      "})",
      "",
      `console.log(\`${opts.app} listening on \${port}\`)`,
      "",
    ].join("\n")
  );

  await Bun.write(
    join(dir, "Dockerfile"),
    [
      "FROM oven/bun:1",
      "WORKDIR /app",
      "COPY . .",
      `ENV PORT=${opts.port}`,
      `CMD ["bun", "apps/${opts.app}/index.ts"]`,
      "",
    ].join("\n")
  );
}

async function writeHackConfig(opts: {
  readonly hackDir: string;
  readonly name: string;
  readonly devHost: string;
  readonly lifecycle?: LifecycleFixtureOptions;
  readonly oauthEnabled?: boolean;
}): Promise<void> {
  await mkdir(opts.hackDir, { recursive: true });

  const lifecycle = buildLifecycleConfig({ lifecycle: opts.lifecycle });
  const config = {
    $schema: "https://schemas.hack/hack.config.schema.json",
    name: opts.name,
    dev_host: opts.devHost,
    logs: {
      follow_backend: "compose",
      snapshot_backend: "loki",
      clear_on_down: false,
    },
    internal: {
      dns: opts.lifecycle?.disableInternal !== true,
      tls: opts.lifecycle?.disableInternal !== true,
    },
    oauth: {
      enabled: opts.oauthEnabled === true,
      tld: "gy",
    },
    open: {
      prefer: "auto",
    },
    ...(lifecycle ? { lifecycle } : {}),
  };
  await Bun.write(
    join(opts.hackDir, "hack.config.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );

  await Bun.write(
    join(opts.hackDir, "docker-compose.yml"),
    renderComposeYaml({
      name: opts.name,
      devHost: opts.devHost,
      composeFailure: opts.lifecycle?.composeFailure,
      standaloneContainers: opts.lifecycle?.standaloneContainers,
    })
  );

  await Bun.write(
    join(opts.hackDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    E2E_PLAIN: plain-value",
      "  host:",
      "    E2E_PLAIN: host-value",
      "    E2E_HOST_ONLY: host-only",
      "",
    ].join("\n")
  );
}

function buildLifecycleConfig(opts: {
  readonly lifecycle?: LifecycleFixtureOptions;
}): Record<string, unknown> | null {
  if (!opts.lifecycle) {
    return null;
  }
  const upBefore: Record<string, unknown>[] = [];
  const processes: Record<string, unknown>[] = [];
  const downBefore: Record<string, unknown>[] = [];

  if (opts.lifecycle.upBeforeMarkerFile) {
    upBefore.push({
      name: "e2e-marker",
      command: `printf up-before-ran > "${opts.lifecycle.upBeforeMarkerFile}"`,
      cwd: ".",
    });
  }
  if (opts.lifecycle.upBeforeEnvMarkerFile) {
    upBefore.push({
      name: "e2e-env-marker",
      command: `printf "%s|%s" "$E2E_PLAIN" "$E2E_HOST_ONLY" > "${opts.lifecycle.upBeforeEnvMarkerFile}"`,
      cwd: ".",
    });
  }
  if (opts.lifecycle.persistentProcess === true) {
    processes.push({
      name: "e2e-sleeper",
      command:
        'test "$E2E_PLAIN" = host-value && test "$E2E_HOST_ONLY" = host-only && bun -e \'setInterval(() => {}, 60000)\'',
      cwd: ".",
    });
  }
  if (opts.lifecycle.downBeforeFailure === true) {
    downBefore.push({
      name: "e2e-down-failure",
      command: "exit 23",
      cwd: ".",
    });
  }
  if (upBefore.length === 0 && processes.length === 0) {
    return null;
  }
  return {
    up: { before: upBefore, after: [] },
    down: { before: downBefore, after: [] },
    ...(processes.length > 0 ? { processes } : {}),
  };
}

function renderComposeYaml(opts: {
  readonly name: string;
  readonly devHost: string;
  readonly composeFailure?: boolean;
  readonly standaloneContainers?: boolean;
}): string {
  return [
    `name: ${opts.name}`,
    "services:",
    "  web:",
    ...(opts.composeFailure ? ["    unsupported_e2e_key: true"] : []),
    "    image: oven/bun:1",
    ...(opts.standaloneContainers
      ? ["    command: bun -e 'setInterval(() => {}, 60000)'"]
      : [
          "    working_dir: /app",
          "    volumes:",
          "      - ..:/app",
          "    command: bun apps/web/index.ts",
        ]),
    "    environment:",
    `      PORT: "${WEB_PORT}"`,
    "    labels:",
    `      caddy: "${opts.devHost}"`,
    `      caddy.reverse_proxy: "{{upstreams ${WEB_PORT}}}"`,
    "      caddy.tls: internal",
    "    networks:",
    "      - hack-dev",
    "      - default",
    "  api:",
    "    image: oven/bun:1",
    ...(opts.standaloneContainers
      ? ["    command: bun -e 'setInterval(() => {}, 60000)'"]
      : [
          "    working_dir: /app",
          "    volumes:",
          "      - ..:/app",
          "    command: bun apps/api/index.ts",
        ]),
    "    environment:",
    `      PORT: "${API_PORT}"`,
    "    labels:",
    `      caddy: "api.${opts.devHost}"`,
    `      caddy.reverse_proxy: "{{upstreams ${API_PORT}}}"`,
    "      caddy.tls: internal",
    "    networks:",
    "      - hack-dev",
    "      - default",
    "networks:",
    "  hack-dev:",
    "    external: true",
    "",
  ].join("\n");
}

/** Initialize a repository on `main` and commit every file under `root`. */
export async function gitInitAndCommit(opts: {
  readonly root: string;
}): Promise<void> {
  await git({ root: opts.root, args: ["init", "-q", "-b", "main"] });
  await git({ root: opts.root, args: ["add", "-A"] });
  await git({
    root: opts.root,
    args: ["commit", "-q", "-m", "fixture: initial commit"],
  });
}

async function git(opts: {
  readonly root: string;
  readonly args: readonly string[];
}): Promise<void> {
  const result = await runCommand({
    argv: [
      "git",
      "-C",
      opts.root,
      "-c",
      "user.email=e2e@hack.invalid",
      "-c",
      "user.name=hack-e2e",
      "-c",
      "commit.gpgsign=false",
      ...opts.args,
    ],
    cwd: opts.root,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${opts.args.join(" ")} failed (exit ${result.exitCode}):\n${result.combined}`
    );
  }
}

/** Content hash per path; directories map to "dir" so new empty dirs count. */
export type FileHashSnapshot = ReadonlyMap<string, string>;

export type FileHashDiff = {
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
};

/**
 * Agent client config a default Hack flow must never touch, relative to an
 * isolated HOME. Stale Hack-owned guidance (the most tempting "repair"
 * target) sits next to unrelated user config.
 */
const HOME_CLIENT_SENTINELS: Readonly<Record<string, string>> = {
  ".claude/settings.json": `${JSON.stringify({ env: { HACK_E2E_SENTINEL: "home-claude-settings" } }, null, 2)}\n`,
  ".claude.json": `${JSON.stringify({ mcpServers: { "e2e-sentinel": { command: "true" } } }, null, 2)}\n`,
  ".claude/skills/e2e-sentinel/SKILL.md":
    "---\nname: e2e-sentinel\n---\nhack-e2e sentinel: home claude skill\n",
  ".claude/skills/hack-cli/SKILL.md":
    "---\nname: hack-cli\n---\nhack-e2e sentinel: stale home claude hack skill\n",
  ".codex/config.toml":
    '# hack-e2e sentinel: home codex config\nmodel = "e2e-sentinel"\n',
  ".codex/skills/e2e-sentinel/SKILL.md":
    "---\nname: e2e-sentinel\n---\nhack-e2e sentinel: home codex skill\n",
  ".codex/skills/hack-cli/SKILL.md":
    "---\nname: hack-cli\n---\nhack-e2e sentinel: stale home codex hack skill\n",
  ".cursor/mcp.json": `${JSON.stringify({ mcpServers: { "e2e-sentinel": { command: "true" } } }, null, 2)}\n`,
  ".cursor/rules/e2e-sentinel.mdc": "hack-e2e sentinel: home cursor rule\n",
  ".cursor/rules/hack.mdc": "hack-e2e sentinel: stale home cursor hack rule\n",
  ".ai/skills/e2e-sentinel/SKILL.md":
    "---\nname: e2e-sentinel\n---\nhack-e2e sentinel: home shared skill\n",
  ".ai/skills/hack-cli/SKILL.md":
    "---\nname: hack-cli\n---\nhack-e2e sentinel: stale home shared hack skill\n",
};

/** HOME-relative client roots whose whole tree must stay byte-identical. */
export const HOME_CLIENT_ROOTS: readonly string[] = [
  ".claude",
  ".claude.json",
  ".codex",
  ".cursor",
  ".ai",
  ".agents",
];

/**
 * Customized repo guidance a default Hack flow must never rewrite, relative
 * to a fixture root. None carries Hack's managed markers, so any write is a
 * surprise rewrite rather than an in-place marker refresh.
 */
const REPO_GUIDANCE_SENTINELS: Readonly<Record<string, string>> = {
  "AGENTS.md":
    "# Team agent rules\n\nhack-e2e sentinel: customized AGENTS.md\n",
  "CLAUDE.md":
    "# Team Claude rules\n\nhack-e2e sentinel: customized CLAUDE.md\n",
  ".cursor/rules/hack.mdc": "hack-e2e sentinel: customized repo cursor rule\n",
  ".codex/skills/hack-cli/SKILL.md":
    "---\nname: hack-cli\n---\nhack-e2e sentinel: customized repo codex skill\n",
  ".claude/settings.local.json": `${JSON.stringify({ permissions: { allow: ["Bash(true)"] } }, null, 2)}\n`,
  ".mcp.json": `${JSON.stringify({ mcpServers: { "e2e-sentinel": { command: "true" } } }, null, 2)}\n`,
};

/** Root-relative repo guidance roots whose whole tree must stay byte-identical. */
export const REPO_GUIDANCE_ROOTS: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  ".mcp.json",
  ".claude",
  ".codex",
  ".cursor",
  ".ai",
  ".agents",
];

async function writeSentinels(opts: {
  readonly root: string;
  readonly files: Readonly<Record<string, string>>;
}): Promise<readonly string[]> {
  const written: string[] = [];
  for (const [relative, content] of Object.entries(opts.files)) {
    const path = join(opts.root, relative);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, content);
    written.push(path);
  }
  return written;
}

/** Seed sentinel client config under an isolated HOME; returns the files. */
export async function seedHomeClientSentinels(opts: {
  readonly home: string;
}): Promise<readonly string[]> {
  return await writeSentinels({
    root: opts.home,
    files: HOME_CLIENT_SENTINELS,
  });
}

/** Seed and commit customized repo guidance; returns the files. */
export async function seedRepoGuidanceSentinels(opts: {
  readonly root: string;
}): Promise<readonly string[]> {
  const written = await writeSentinels({
    root: opts.root,
    files: REPO_GUIDANCE_SENTINELS,
  });
  // Force-add: settings.local.json is commonly ignored, but must be tracked
  // here so `git status` would surface any edit.
  await git({ root: opts.root, args: ["add", "-f", "--", ...written] });
  await git({
    root: opts.root,
    args: ["commit", "-q", "-m", "fixture: customized agent guidance"],
  });
  return written;
}

/**
 * Hash every entry under `roots` (files or directories; missing roots add
 * nothing). Symlinks record their target text and are never followed.
 */
export async function snapshotFileHashes(opts: {
  readonly roots: readonly string[];
}): Promise<FileHashSnapshot> {
  const snapshot = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    let info: Stats;
    try {
      info = await lstat(path);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) {
      snapshot.set(path, `link:${await readlink(path)}`);
    } else if (info.isDirectory()) {
      snapshot.set(path, "dir");
      for (const entry of await readdir(path)) {
        await visit(join(path, entry));
      }
    } else {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(await Bun.file(path).arrayBuffer());
      snapshot.set(path, `sha256:${hasher.digest("hex")}`);
    }
  }
  for (const root of opts.roots) {
    await visit(root);
  }
  return snapshot;
}

/** Paths whose hash changed, appeared, or disappeared between snapshots. */
export function diffFileHashes(opts: {
  readonly before: FileHashSnapshot;
  readonly after: FileHashSnapshot;
}): FileHashDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [path, hash] of opts.after) {
    const prior = opts.before.get(path);
    if (prior === undefined) {
      added.push(path);
    } else if (prior !== hash) {
      changed.push(path);
    }
  }
  for (const path of opts.before.keys()) {
    if (!opts.after.has(path)) {
      removed.push(path);
    }
  }
  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
  };
}
