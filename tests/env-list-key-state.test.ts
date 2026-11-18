import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * `hack env list --json` reports whether the project env key can be read
 * (`key_state`), names only, and keeps listing names when it cannot.
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const SECRET_VALUE = ["synthetic", "key", "state", "sentinel"].join("-");
const CLI_TEST_TIMEOUT_MS = 60_000;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createProject(opts: { readonly legacy?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-key-state-")));
  roots.push(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "key-state", dev_host: "key-state.hack" })}\n`
  );
  if (opts.legacy) {
    await writeFile(
      resolve(projectDir, "hack.env.json"),
      `${JSON.stringify({
        version: 1,
        vars: [{ key: "LEGACY_KEY", source: "plain_env", required: false }],
      })}\n`
    );
  } else {
    await writeFile(
      resolve(projectDir, "hack.env.default.yaml"),
      "version: 1\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
    );
  }
  return { root, projectRoot, projectDir };
}

type Project = Awaited<ReturnType<typeof createProject>>;

async function runHack(opts: {
  readonly project: Project;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}) {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...opts.args], {
    cwd: opts.project.projectRoot,
    env: privateCliEnv({
      root: opts.project.root,
      env: {
        HACK_GLOBAL_CONFIG_PATH: join(opts.project.root, "hack-config.json"),
        HACK_HOME: join(opts.project.root, "hack-home"),
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        NO_COLOR: "1",
        ...opts.env,
      },
    }),
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** A modern project with one encrypted value and a generated project key. */
async function createSecretProject(): Promise<Project> {
  const project = await createProject();
  const set = await runHack({
    project,
    args: [
      "env",
      "set",
      "API_TOKEN",
      "--secret",
      "--value-stdin",
      "--path",
      project.projectRoot,
    ],
    stdin: SECRET_VALUE,
  });
  expect(set.exitCode).toBe(0);
  return project;
}

async function listJson(opts: {
  readonly project: Project;
  readonly env?: Readonly<Record<string, string | undefined>>;
}) {
  const result = await runHack({
    project: opts.project,
    args: ["env", "list", "--json", "--path", opts.project.projectRoot],
    env: opts.env,
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(output).not.toContain(SECRET_VALUE);
  return {
    exitCode: result.exitCode,
    json: JSON.parse(result.stdout) as {
      readonly format?: string;
      readonly key_state: string;
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly source?: string;
        readonly value?: unknown;
      }>;
    },
  };
}

function keyPath(project: Project): string {
  return resolve(project.projectRoot, ".hack.secret.key");
}

test(
  "env list --json reports a readable project key as ok",
  async () => {
    const project = await createSecretProject();
    const { exitCode, json } = await listJson({ project });
    expect(exitCode).toBe(0);
    expect(json.format).toBe("project_env_config_v1");
    expect(json.key_state).toBe("ok");
    expect(json.vars.map((row) => row.key)).toEqual(["API_TOKEN"]);
    expect(json.vars[0]).not.toHaveProperty("value");
    // Encrypted with the project key in the YAML layer, not a keychain (HACK-2329).
    expect(json.vars[0]?.source).toBe("project_key");
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "env list --json reports a missing key and still lists names",
  async () => {
    const project = await createSecretProject();
    await unlink(keyPath(project));
    const { exitCode, json } = await listJson({ project });
    expect(exitCode).toBe(0);
    expect(json.key_state).toBe("missing");
    expect(json.vars.map((row) => row.key)).toEqual(["API_TOKEN"]);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "env list --json counts HACK_ENV_SECRET_KEY as a readable key",
  async () => {
    const project = await createSecretProject();
    await unlink(keyPath(project));
    const { json } = await listJson({
      project,
      env: { HACK_ENV_SECRET_KEY: "synthetic-fallback-key-text-for-the-probe" },
    });
    expect(json.key_state).toBe("ok");
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "env list --json treats an empty key file as absent, like the runtime",
  async () => {
    const project = await createSecretProject();
    await writeFile(keyPath(project), "  \n");
    expect((await listJson({ project })).json.key_state).toBe("missing");
    const withFallback = await listJson({
      project,
      env: { HACK_ENV_SECRET_KEY: "synthetic-fallback-key-text-for-the-probe" },
    });
    expect(withFallback.json.key_state).toBe("ok");
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "env list --json reports a refused key file as unreadable and still lists names",
  async () => {
    const project = await createSecretProject();
    // A symlinked key is refused by the runtime regardless of the user, so
    // this case does not depend on file permissions or running as root.
    const elsewhere = resolve(project.root, "elsewhere.key");
    await writeFile(elsewhere, "synthetic-key-text-behind-a-symlink\n");
    await unlink(keyPath(project));
    await symlink(elsewhere, keyPath(project));
    const { exitCode, json } = await listJson({ project });
    expect(exitCode).toBe(0);
    expect(json.key_state).toBe("unreadable");
    expect(json.vars.map((row) => row.key)).toEqual(["API_TOKEN"]);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "env list --json does not check the key for the legacy contract",
  async () => {
    const project = await createProject({ legacy: true });
    const { json } = await listJson({ project });
    expect(json.key_state).toBe("not_checked");
  },
  CLI_TEST_TIMEOUT_MS
);
