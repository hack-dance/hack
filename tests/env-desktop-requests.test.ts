import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Contracts for the desktop Env tab (HACK-2287, requests R24 to R27):
 * every overlay in one read, plaintext values without secrets, the key
 * source and a one-run key override, and overlay creation. No secret value
 * or key may reach stdout or stderr on any of these paths, and none is
 * ever passed on argv (values go through stdin, keys through a file or a
 * variable NAME).
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const SECRET_VALUE = ["synthetic", "desktop", "secret", "sentinel"].join("-");
const PLAIN_VALUE = "plain-visible-value";
const SERVICE_PLAIN_VALUE = "service-plain-value";
const OVERRIDE_KEY = ["synthetic", "override", "key", "material"].join("-");
const OTHER_KEY = ["synthetic", "other", "key", "material"].join("-");
const CLI_TEST_TIMEOUT_MS = 60_000;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createProject() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-env-desktop-"))
  );
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
    `${JSON.stringify({ name: "env-desktop", dev_host: "env-desktop.hack" })}\n`
  );
  await writeFile(
    resolve(projectDir, "hack.env.default.yaml"),
    "version: 1\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
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

/** Never on argv: every key and secret value in these tests is a sentinel. */
function expectNoSecretOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
}) {
  const output = `${result.stdout}${result.stderr}`;
  expect(output).not.toContain(SECRET_VALUE);
  expect(output).not.toContain(OVERRIDE_KEY);
  expect(output).not.toContain(OTHER_KEY);
}

async function setValue(opts: {
  readonly project: Project;
  readonly key: string;
  readonly value: string;
  readonly secret?: boolean;
  readonly extraArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}) {
  const result = await runHack({
    project: opts.project,
    args: [
      "env",
      "set",
      opts.key,
      ...(opts.secret ? ["--secret"] : []),
      "--value-stdin",
      ...(opts.extraArgs ?? []),
    ],
    stdin: opts.value,
    env: opts.env,
  });
  expectNoSecretOutput(result);
  return result;
}

type ListedVar = {
  readonly key: string;
  readonly value?: unknown;
  readonly storage: { readonly kind: string };
};

type ListPayload = {
  readonly key_state: string;
  readonly key_source: Record<string, unknown> | null;
  readonly overlays: readonly Record<string, unknown>[];
  readonly vars: readonly ListedVar[];
};

async function listJson(opts: {
  readonly project: Project;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly exitCode: number; readonly json: ListPayload }> {
  const result = await runHack({
    project: opts.project,
    args: ["env", "list", "--json", ...(opts.args ?? [])],
    env: opts.env,
  });
  expectNoSecretOutput(result);
  return {
    exitCode: result.exitCode,
    json: JSON.parse(result.stdout) as ListPayload,
  };
}

function byKey(json: ListPayload): Record<string, ListedVar> {
  return Object.fromEntries(json.vars.map((entry) => [entry.key, entry]));
}

describe("R25: plaintext values in one pipe-safe read", () => {
  test(
    "--plaintext-values includes plaintext values only, never secrets",
    async () => {
      const project = await createProject();
      expect(
        (await setValue({ project, key: "PLAIN", value: PLAIN_VALUE })).exitCode
      ).toBe(0);
      expect(
        (
          await setValue({
            project,
            key: "API_TOKEN",
            value: SECRET_VALUE,
            secret: true,
          })
        ).exitCode
      ).toBe(0);

      const plain = await listJson({
        project,
        args: ["--plaintext-values"],
      });
      expect(plain.exitCode).toBe(0);
      const vars = byKey(plain.json);
      expect(vars.PLAIN?.value).toBe(PLAIN_VALUE);
      expect(vars.API_TOKEN?.storage.kind).toBe("secret");
      expect(vars.API_TOKEN && "value" in vars.API_TOKEN).toBe(false);

      // Without the flag the listing stays names-only.
      const names = await listJson({ project });
      for (const entry of names.json.vars) {
        expect("value" in entry).toBe(false);
      }
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "plaintext values do not need the project key",
    async () => {
      const project = await createProject();
      await setValue({ project, key: "PLAIN", value: PLAIN_VALUE });
      await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
      });
      await rm(resolve(project.projectRoot, ".hack.secret.key"));

      const listed = await listJson({
        project,
        args: ["--plaintext-values"],
      });
      expect(listed.exitCode).toBe(0);
      expect(listed.json.key_state).toBe("missing");
      expect(byKey(listed.json).PLAIN?.value).toBe(PLAIN_VALUE);
      expect("value" in (byKey(listed.json).API_TOKEN ?? {})).toBe(false);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "--service selects the service scope's winning plaintext values",
    async () => {
      const project = await createProject();
      await setValue({ project, key: "PLAIN", value: PLAIN_VALUE });
      await setValue({
        project,
        key: "PLAIN",
        value: SERVICE_PLAIN_VALUE,
        extraArgs: ["--service", "api"],
      });

      const service = await listJson({
        project,
        args: ["--plaintext-values", "--service", "api"],
      });
      expect(byKey(service.json).PLAIN?.value).toBe(SERVICE_PLAIN_VALUE);
      const global = await listJson({
        project,
        args: ["--plaintext-values"],
      });
      expect(byKey(global.json).PLAIN?.value).toBe(PLAIN_VALUE);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "legacy contract: only stored dotenv values, never ambient ones",
    async () => {
      const project = await createProject();
      await rm(resolve(project.projectDir, "hack.env.default.yaml"));
      await writeFile(
        resolve(project.projectDir, "hack.env.json"),
        `${JSON.stringify({
          version: 1,
          vars: [
            { key: "STORED_PLAIN", source: "plain_env", required: false },
            { key: "AMBIENT_PLAIN", source: "plain_env", required: false },
          ],
        })}\n`
      );
      await writeFile(
        resolve(project.projectDir, ".env"),
        `STORED_PLAIN=${PLAIN_VALUE}\n`
      );
      const ambient = "ambient-process-value";
      const result = await runHack({
        project,
        args: ["env", "list", "--json", "--plaintext-values"],
        env: { AMBIENT_PLAIN: ambient },
      });
      expect(result.stdout).not.toContain(ambient);
      const vars = byKey(JSON.parse(result.stdout) as ListPayload);
      expect(vars.STORED_PLAIN?.value).toBe(PLAIN_VALUE);
      expect("value" in (vars.AMBIENT_PLAIN ?? {})).toBe(false);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "--plaintext-values without --json is a usage error",
    async () => {
      const project = await createProject();
      await setValue({ project, key: "PLAIN", value: PLAIN_VALUE });
      const result = await runHack({
        project,
        args: ["env", "list", "--plaintext-values"],
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain(PLAIN_VALUE);
      expect(result.stderr).toContain("--plaintext-values requires --json");
    },
    CLI_TEST_TIMEOUT_MS
  );
});

describe("R24: every overlay", () => {
  test(
    "env list --json and env overlay list --json list every overlay",
    async () => {
      const project = await createProject();
      await writeFile(
        resolve(project.projectDir, "hack.config.json"),
        `${JSON.stringify({
          name: "env-desktop",
          dev_host: "env-desktop.hack",
          env: { default_overlay: "dev" },
        })}\n`
      );
      await setValue({
        project,
        key: "PLAIN",
        value: PLAIN_VALUE,
        extraArgs: ["--env", "qa"],
      });
      await setValue({
        project,
        key: "PLAIN",
        value: PLAIN_VALUE,
        extraArgs: ["--env", "staging", "--local"],
      });

      const expected = [
        {
          name: "dev",
          path: resolve(project.projectDir, "hack.env.dev.yaml"),
          exists: false,
          local_path: resolve(project.projectDir, "hack.env.dev.local.yaml"),
          local_exists: false,
          default: true,
        },
        {
          name: "qa",
          path: resolve(project.projectDir, "hack.env.qa.yaml"),
          exists: true,
          local_path: resolve(project.projectDir, "hack.env.qa.local.yaml"),
          local_exists: false,
          default: false,
        },
        {
          name: "staging",
          path: resolve(project.projectDir, "hack.env.staging.yaml"),
          exists: false,
          local_path: resolve(
            project.projectDir,
            "hack.env.staging.local.yaml"
          ),
          local_exists: true,
          default: false,
        },
      ];
      const listed = await listJson({ project });
      expect(listed.json.overlays).toEqual(expected);

      const overlays = await runHack({
        project,
        args: ["env", "overlay", "list", "--json"],
      });
      expect(overlays.exitCode).toBe(0);
      expect(JSON.parse(overlays.stdout)).toEqual({
        ok: true,
        data: {
          project: "env-desktop",
          overlays: expected,
          schema: "hack.env-overlays.v1",
        },
      });
    },
    CLI_TEST_TIMEOUT_MS
  );
});

describe("R26: key source and one-run override", () => {
  test(
    "key_source names the checkout key file, the variable, or none",
    async () => {
      const project = await createProject();
      expect((await listJson({ project })).json.key_source).toEqual({
        kind: "none",
      });

      const fromEnv = await listJson({
        project,
        env: { HACK_ENV_SECRET_KEY: OTHER_KEY },
      });
      expect(fromEnv.json.key_state).toBe("ok");
      expect(fromEnv.json.key_source).toEqual({
        kind: "env",
        origin: "default",
        name: "HACK_ENV_SECRET_KEY",
      });

      await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
      });
      expect((await listJson({ project })).json.key_source).toEqual({
        kind: "file",
        origin: "checkout",
        path: resolve(project.projectRoot, ".hack.secret.key"),
        relative_path: ".hack.secret.key",
      });
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "--key-file and --key-env override discovery for one run",
    async () => {
      const project = await createProject();
      const keyFile = resolve(project.root, "chosen.key");
      await writeFile(keyFile, `${OVERRIDE_KEY}\n`, { mode: 0o600 });
      // Encrypt with the override key; no key file may be created.
      const set = await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
        extraArgs: ["--key-file", keyFile],
      });
      expect(set.exitCode).toBe(0);
      expect(
        await stat(resolve(project.projectRoot, ".hack.secret.key")).catch(
          () => null
        )
      ).toBeNull();

      const listed = await listJson({
        project,
        args: ["--key-file", keyFile],
      });
      expect(listed.json.key_state).toBe("ok");
      expect(listed.json.key_source).toEqual({
        kind: "file",
        origin: "override",
        path: keyFile,
        relative_path: null,
      });

      const get = await runHack({
        project,
        args: ["env", "get", "API_TOKEN", "--key-file", keyFile],
      });
      expect(get.exitCode).toBe(0);
      expect(get.stdout).toBe(SECRET_VALUE);
      expect(get.stderr).not.toContain(OVERRIDE_KEY);

      const byName = await runHack({
        project,
        args: ["env", "get", "API_TOKEN", "--key-env", "CHOSEN_KEY"],
        env: { CHOSEN_KEY: OVERRIDE_KEY },
      });
      expect(byName.exitCode).toBe(0);
      expect(byName.stdout).toBe(SECRET_VALUE);

      const listedByName = await listJson({
        project,
        args: ["--key-env", "CHOSEN_KEY"],
        env: { CHOSEN_KEY: OVERRIDE_KEY },
      });
      expect(listedByName.json.key_source).toEqual({
        kind: "env",
        origin: "override",
        name: "CHOSEN_KEY",
      });
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "an override never falls back to discovered keys",
    async () => {
      const project = await createProject();
      await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
      });
      const missing = resolve(project.root, "missing.key");
      const get = await runHack({
        project,
        args: ["env", "get", "API_TOKEN", "--key-file", missing],
      });
      expect(get.exitCode).not.toBe(0);
      expectNoSecretOutput(get);

      const unset = await runHack({
        project,
        args: ["env", "get", "API_TOKEN", "--key-env", "UNSET_KEY_NAME"],
        env: { HACK_ENV_SECRET_KEY: OTHER_KEY },
      });
      expect(unset.exitCode).not.toBe(0);
      expectNoSecretOutput(unset);

      const listed = await listJson({
        project,
        args: ["--key-file", missing],
      });
      expect(listed.json.key_state).toBe("missing");
      // A path that names nothing is never echoed: it may be a pasted key.
      expect(listed.json.key_source).toEqual({
        kind: "file",
        origin: "override",
        path: null,
        relative_path: null,
      });
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "a missing --key-file argument is not echoed back",
    async () => {
      const project = await createProject();
      const result = await runHack({
        project,
        args: ["env", "list", "--json", "--key-file", OVERRIDE_KEY],
      });
      expect(result.exitCode).toBe(0);
      expectNoSecretOutput(result);
      const display = await runHack({
        project,
        args: ["env", "list", "--key-file", OVERRIDE_KEY],
      });
      expectNoSecretOutput(display);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "an override cannot encrypt with a git-tracked key file",
    async () => {
      const project = await createProject();
      const init = Bun.spawnSync(["git", "init", "-q", project.projectRoot], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);
      const keyFile = resolve(project.projectRoot, "committed.key");
      await writeFile(keyFile, `${OVERRIDE_KEY}\n`, { mode: 0o600 });
      const add = Bun.spawnSync(
        ["git", "-C", project.projectRoot, "add", "--", "committed.key"],
        { stdout: "ignore", stderr: "ignore" }
      );
      expect(add.exitCode).toBe(0);
      const set = await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
        extraArgs: ["--key-file", keyFile],
      });
      expect(set.exitCode).not.toBe(0);
      expect(`${set.stdout}${set.stderr}`).toContain("git-tracked");
      expect(
        await readFile(
          resolve(project.projectDir, "hack.env.default.yaml"),
          "utf8"
        )
      ).not.toContain("API_TOKEN");
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "an override key file inside a checkout must be ignored by git",
    async () => {
      const project = await createProject();
      const init = Bun.spawnSync(["git", "init", "-q", project.projectRoot], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);
      const keyFile = resolve(project.projectRoot, "chosen.key");
      await writeFile(keyFile, `${OVERRIDE_KEY}\n`, { mode: 0o600 });
      // Untracked but not ignored: a later `git add .` would publish it.
      const refused = await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
        extraArgs: ["--key-file", keyFile],
      });
      expect(refused.exitCode).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain(
        "does not ignore it"
      );
      expect(
        await readFile(
          resolve(project.projectDir, "hack.env.default.yaml"),
          "utf8"
        )
      ).not.toContain("API_TOKEN");
      // The override never edits ignore rules itself.
      expect(
        await stat(resolve(project.projectRoot, ".gitignore")).catch(() => null)
      ).toBeNull();

      await writeFile(
        resolve(project.projectRoot, ".gitignore"),
        "chosen.key\n"
      );
      const accepted = await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
        extraArgs: ["--key-file", keyFile],
      });
      expect(accepted.exitCode).toBe(0);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "an override key file in a linked worktree's common git dir is accepted",
    async () => {
      const project = await createProject();
      const git = (args: readonly string[], cwd = project.projectRoot) =>
        Bun.spawnSync(
          [
            "git",
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=fixture@example.invalid",
            ...args,
          ],
          { cwd, stdout: "ignore", stderr: "ignore" }
        ).exitCode;
      expect(git(["init", "-q"])).toBe(0);
      expect(git(["add", "."])).toBe(0);
      expect(git(["commit", "-q", "-m", "fixture"])).toBe(0);
      const worktree = resolve(project.root, "wt");
      expect(git(["worktree", "add", "-q", "-b", "feat", worktree])).toBe(0);
      // The shared key location discovery reports for linked worktrees.
      const keyFile = resolve(project.projectRoot, ".git", ".hack.secret.key");
      await writeFile(keyFile, `${OVERRIDE_KEY}\n`, { mode: 0o600 });
      const set = await runHack({
        project,
        args: [
          "env",
          "set",
          "API_TOKEN",
          "--secret",
          "--value-stdin",
          "--path",
          worktree,
          "--key-file",
          keyFile,
        ],
        stdin: SECRET_VALUE,
      });
      expectNoSecretOutput(set);
      expect(set.exitCode).toBe(0);
      const get = await runHack({
        project,
        args: ["env", "get", "API_TOKEN", "--path", worktree],
      });
      expect(get.stdout).toBe(SECRET_VALUE);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "an override cannot split the project across two keys",
    async () => {
      const project = await createProject();
      await setValue({
        project,
        key: "API_TOKEN",
        value: SECRET_VALUE,
        secret: true,
      });
      const keyFile = resolve(project.root, "other.key");
      await writeFile(keyFile, `${OVERRIDE_KEY}\n`, { mode: 0o600 });
      // An overlay with no secrets yet: only the discovered-key check stops it.
      const set = await setValue({
        project,
        key: "OTHER_TOKEN",
        value: SECRET_VALUE,
        secret: true,
        extraArgs: ["--env", "qa", "--key-file", keyFile],
      });
      expect(set.exitCode).not.toBe(0);
      expect(
        await stat(resolve(project.projectDir, "hack.env.qa.yaml")).catch(
          () => null
        )
      ).toBeNull();
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "refusals never echo a key passed where a NAME belongs",
    async () => {
      const project = await createProject();
      const keyLike = `${OVERRIDE_KEY}=x`;
      const result = await runHack({
        project,
        args: ["env", "list", "--json", "--key-env", keyLike],
      });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(OVERRIDE_KEY);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Invalid --key-env value"
      );

      const both = await runHack({
        project,
        args: [
          "env",
          "list",
          "--json",
          "--key-env",
          "A_KEY",
          "--key-file",
          "x.key",
        ],
      });
      expect(both.exitCode).not.toBe(0);
      expect(`${both.stdout}${both.stderr}`).toContain(
        "either --key-file or --key-env"
      );
    },
    CLI_TEST_TIMEOUT_MS
  );
});

describe("R27: overlay creation", () => {
  test(
    "env overlay add creates an empty overlay and refuses an existing one",
    async () => {
      const project = await createProject();
      const git = Bun.spawnSync(["git", "init", "-q", project.projectRoot], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(git.exitCode).toBe(0);

      const created = await runHack({
        project,
        args: ["env", "overlay", "add", "qa", "--json"],
      });
      expect(created.exitCode).toBe(0);
      const path = resolve(project.projectDir, "hack.env.qa.yaml");
      expect(JSON.parse(created.stdout)).toEqual({
        ok: true,
        data: {
          project: "env-desktop",
          created: {
            name: "qa",
            path,
            exists: true,
            local_path: resolve(project.projectDir, "hack.env.qa.local.yaml"),
            local_exists: false,
            default: false,
          },
          committed_path_ignored: false,
          local_path_ignored: true,
          schema: "hack.env-overlays.v1",
        },
      });
      const text = await readFile(path, "utf8");
      expect(text).toContain("environment: qa");
      expect(text).toContain("secretsprovider: project_key");
      expect((await stat(path)).mode & 0o077).toBe(
        (await stat(resolve(project.projectDir, "hack.env.default.yaml")))
          .mode & 0o077
      );

      // The new overlay is selectable and listed.
      const listed = await listJson({ project, args: ["--env", "qa"] });
      expect(listed.exitCode).toBe(0);
      expect(listed.json.overlays.map((entry) => entry.name)).toEqual(["qa"]);

      const again = await runHack({
        project,
        args: ["env", "overlay", "add", "qa", "--json"],
      });
      expect(again.exitCode).not.toBe(0);
      expect(again.stdout).toContain("E_PATH_CONFLICT");
      expect(await readFile(path, "utf8")).toBe(text);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "env overlay add migrates a legacy project before creating the overlay",
    async () => {
      const project = await createProject();
      await rm(resolve(project.projectDir, "hack.env.default.yaml"));
      await writeFile(
        resolve(project.projectDir, "hack.env.json"),
        `${JSON.stringify({
          version: 1,
          vars: [{ key: "STORED_PLAIN", source: "plain_env", required: false }],
        })}\n`
      );
      await writeFile(
        resolve(project.projectDir, ".env"),
        `STORED_PLAIN=${PLAIN_VALUE}\n`
      );
      const created = await runHack({
        project,
        args: ["env", "overlay", "add", "qa"],
      });
      expect(created.exitCode).toBe(0);
      // The legacy value is still reachable through the new overlay.
      const get = await runHack({
        project,
        args: ["env", "get", "STORED_PLAIN", "--env", "qa"],
      });
      expect(get.exitCode).toBe(0);
      expect(get.stdout).toBe(PLAIN_VALUE);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "overlays include in-project symlinked layers",
    async () => {
      const project = await createProject();
      const target = resolve(project.projectDir, "layers");
      await mkdir(target);
      await writeFile(
        resolve(target, "qa.yaml"),
        "version: 1\nenvironment: qa\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
      );
      await symlink(
        "layers/qa.yaml",
        resolve(project.projectDir, "hack.env.qa.yaml")
      );
      await symlink(
        "layers/qa.yaml",
        resolve(project.projectDir, "hack.env.review.local.yaml")
      );
      const listed = await listJson({ project });
      expect(
        listed.json.overlays.map((entry) => [
          entry.name,
          entry.exists,
          entry.local_exists,
        ])
      ).toEqual([
        ["qa", true, false],
        ["review", false, true],
      ]);
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    "env overlay add refuses reserved and invalid names without echoing them",
    async () => {
      const project = await createProject();
      for (const name of [
        "default",
        "base",
        "local",
        "Qa",
        `x=${SECRET_VALUE}`,
      ]) {
        const result = await runHack({
          project,
          args: ["env", "overlay", "add", name],
        });
        expect(result.exitCode).not.toBe(0);
        expectNoSecretOutput(result);
        expect(result.stderr).toContain("Invalid overlay name");
      }
      expect(
        await stat(resolve(project.projectDir, "hack.env.local.yaml")).catch(
          () => null
        )
      ).toBeNull();
    },
    CLI_TEST_TIMEOUT_MS
  );
});
