import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import { inspectSecretIntegrity } from "../src/lib/doctor-secret-integrity.ts";
import {
  PROJECT_ENV_SECRET_KEY_ENV,
  resolveProjectEnvConfig,
  resolveProjectEnvConfigPath,
  resolveProjectEnvValue,
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";
import { runFixtureGit } from "./helpers/fixture-git.ts";

/**
 * HACK-2169: `hack doctor` reports stores and env layers whose secrets cannot
 * all be read, with recovery steps and never a value. Synthetic values only.
 */

const tempDirs = new Set<string>();
/**
 * Every variable these tests set or clear. The global Hack config, Hack
 * home and keychain fallback point into each test's own root, and both key
 * variables start cleared, so no test reads the developer's real global
 * secret store or key (second-family review).
 */
const ISOLATED_ENV = [
  PROJECT_ENV_SECRET_KEY_ENV,
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "CI",
  "HACK_EXECUTION_MODE",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  for (const key of ISOLATED_ENV) {
    savedEnv.set(key, process.env[key]);
  }
  const home = await mkdtemp(join(tmpdir(), "hack-secret-integrity-home-"));
  tempDirs.add(home);
  process.env.HOME = home;
  process.env.HACK_HOME = join(home, ".hack");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(home, ".hack", "hack.config.json");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  Reflect.deleteProperty(process.env, PROJECT_ENV_SECRET_KEY_ENV);
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
});

afterEach(async () => {
  for (const key of ISOLATED_ENV) {
    restoreEnv(key, savedEnv.get(key));
  }
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

type Repo = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envFile: string;
  readonly keyFile: string;
};

async function createRepo(config: Record<string, unknown> = {}): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-secret-integrity-"));
  tempDirs.add(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "integrity", dev_host: "integrity.hack", ...config }, null, 2)}\n`
  );
  await writeFile(
    resolve(projectRoot, ".gitignore"),
    `${PROJECT_ENV_KEY_FILENAME}\n`
  );
  return {
    projectRoot,
    projectDir,
    envFile: resolveProjectEnvConfigPath({ projectDir, envName: null }),
    keyFile: resolve(projectRoot, PROJECT_ENV_KEY_FILENAME),
  };
}

async function setSecret(repo: Repo, key: string, value: string) {
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key,
    value,
    secret: true,
  });
}

async function inspect(repo: Repo) {
  return await inspectSecretIntegrity({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: "integrity",
  });
}

function globalValues(text: string): Record<string, unknown> {
  const parsed = YAML.parse(text) as {
    values?: { global?: Record<string, unknown> };
  };
  return parsed.values?.global ?? {};
}

test("a layer holding secrets under two keys is reported, value-free", async () => {
  // The F8 aftermath: one secret under the current key, two under another.
  const repo = await createRepo();
  await setSecret(repo, "FIRST", "synthetic-first-a19c");
  const other = await createRepo();
  await setSecret(other, "SECOND", "synthetic-second-77d0");
  await setSecret(other, "THIRD", "synthetic-third-e5b9");
  const text = await readFile(repo.envFile, "utf8");
  const parsed = YAML.parse(text) as {
    values: { global: Record<string, unknown> };
  };
  const otherValues = globalValues(await readFile(other.envFile, "utf8"));
  parsed.values.global.SECOND = otherValues.SECOND;
  parsed.values.global.THIRD = otherValues.THIRD;
  await writeFile(repo.envFile, YAML.stringify(parsed));

  const findings = await inspect(repo);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.status).toBe("error");
  expect(findings[0]?.message).toContain("more than one key: 1 of 3");
  expect(findings[0]?.message).toContain("hack env set <name> --secret");
  const keyText = (await readFile(repo.keyFile, "utf8")).trim();
  for (const secret of [
    "synthetic-first-a19c",
    "synthetic-second-77d0",
    "synthetic-third-e5b9",
    keyText,
  ]) {
    expect(findings[0]?.message).not.toContain(secret);
  }
  // It names the secrets that do not open, and its advice works end to
  // end: read them with the key that encrypted them (here the other
  // checkout's key file), set refuses while the layer mixes keys, unset
  // needs no key, and the re-entered values leave one key.
  expect(findings[0]?.message).toContain(
    "Secrets that do not open: SECOND, THIRD."
  );
  const currentKey = await readFile(repo.keyFile, "utf8");
  await writeFile(repo.keyFile, await readFile(other.keyFile, "utf8"), {
    mode: 0o600,
  });
  const recovered = new Map<string, string | null>();
  for (const key of ["SECOND", "THIRD"]) {
    const read = await resolveProjectEnvValue({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      serviceNames: ["api"],
      key,
    });
    recovered.set(key, read?.value ?? null);
  }
  await writeFile(repo.keyFile, currentKey, { mode: 0o600 });
  expect(recovered.get("SECOND")).toBe("synthetic-second-77d0");
  expect(recovered.get("THIRD")).toBe("synthetic-third-e5b9");
  await expect(
    setSecret(repo, "SECOND", recovered.get("SECOND") ?? "")
  ).rejects.toThrow("nothing was written");
  for (const key of ["SECOND", "THIRD"]) {
    await unsetProjectEnvValue({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      scope: "global",
      key,
    });
  }
  await setSecret(repo, "SECOND", recovered.get("SECOND") ?? "");
  await setSecret(repo, "THIRD", recovered.get("THIRD") ?? "");
  expect(await inspect(repo)).toEqual([]);
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  expect(resolved?.globalEnv.FIRST).toBe("synthetic-first-a19c");
  expect(resolved?.globalEnv.SECOND).toBe("synthetic-second-77d0");
  expect(resolved?.globalEnv.THIRD).toBe("synthetic-third-e5b9");
});

test("the local default layer --local writes is the one inspected, legacy-compatible included", async () => {
  // A legacy hack.env.local.yaml (environment: local) is an overlay; the
  // machine-local default layer is then hack.env.default.local.yaml.
  const repo = await createRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.local.yaml"),
    "version: 1\nenvironment: local\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "FIRST",
    value: "synthetic-first-6c0d",
    secret: true,
    local: true,
  });
  const localPath = resolve(repo.projectDir, "hack.env.default.local.yaml");
  const other = await createRepo();
  await setSecret(other, "SECOND", "synthetic-second-d81f");
  await setSecret(other, "THIRD", "synthetic-third-27aa");
  const parsed = YAML.parse(await readFile(localPath, "utf8")) as {
    values: { global: Record<string, unknown> };
  };
  const otherValues = globalValues(await readFile(other.envFile, "utf8"));
  parsed.values.global.SECOND = otherValues.SECOND;
  parsed.values.global.THIRD = otherValues.THIRD;
  await writeFile(localPath, YAML.stringify(parsed));

  const findings = await inspect(repo);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain(
    ".hack/hack.env.default.local.yaml holds secrets under more than one key"
  );
  expect(findings[0]?.message).toContain("SECOND (--local), THIRD (--local)");
});

test("an overlay that exists only as its machine-local layer is inspected", async () => {
  const repo = await createRepo();
  await setSecret(repo, "FIRST", "synthetic-first-3e70");
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "staging",
    scope: "global",
    key: "STAGE",
    value: "synthetic-stage-91b2",
    secret: true,
    local: true,
  });
  const localPath = resolve(repo.projectDir, "hack.env.staging.local.yaml");
  expect(await readFile(localPath, "utf8")).toContain("STAGE");
  expect(await inspect(repo)).toEqual([]);

  const other = await createRepo();
  await setSecret(other, "SECOND", "synthetic-second-0c4a");
  const parsed = YAML.parse(await readFile(localPath, "utf8")) as {
    values: { global: Record<string, unknown> };
  };
  parsed.values.global.SECOND = globalValues(
    await readFile(other.envFile, "utf8")
  ).SECOND;
  await writeFile(localPath, YAML.stringify(parsed));

  const findings = await inspect(repo);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain(
    ".hack/hack.env.staging.local.yaml holds secrets under more than one key"
  );
  expect(findings[0]?.message).toContain("SECOND (--env staging --local)");
});

test("a symlinked overlay layer inside the project is inspected", async () => {
  const repo = await createRepo();
  await setSecret(repo, "FIRST", "synthetic-first-8a2e");
  const other = await createRepo();
  await setSecret(other, "SECOND", "synthetic-second-f310");
  await setSecret(other, "THIRD", "synthetic-third-4b6d");
  // The layer lives elsewhere in the project; the overlay name is a link.
  const layers = resolve(repo.projectRoot, "env-layers");
  await mkdir(layers);
  const target = resolve(layers, "staging.local.yaml");
  const parsed = YAML.parse(await readFile(repo.envFile, "utf8")) as {
    values: { global: Record<string, unknown> };
  };
  const otherValues = globalValues(await readFile(other.envFile, "utf8"));
  parsed.values.global.SECOND = otherValues.SECOND;
  parsed.values.global.THIRD = otherValues.THIRD;
  await writeFile(target, YAML.stringify(parsed));
  await symlink(
    target,
    resolve(repo.projectDir, "hack.env.staging.local.yaml")
  );

  const findings = await inspect(repo);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain(
    ".hack/hack.env.staging.local.yaml holds secrets under more than one key"
  );
  expect(findings[0]?.message).toContain(
    "SECOND (--env staging --local), THIRD (--env staging --local)"
  );
});

test("a stray hack.env.local.local.yaml never changes the local default layer's advice", async () => {
  // In a non-legacy project `local` is not an overlay (runtime ignores this
  // file too), so the local default layer keeps its --local advice.
  const repo = await createRepo();
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "FIRST",
    value: "synthetic-first-5d17",
    secret: true,
    local: true,
  });
  const localPath = resolve(repo.projectDir, "hack.env.local.yaml");
  await writeFile(
    resolve(repo.projectDir, "hack.env.local.local.yaml"),
    "version: 1\nenvironment: local\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  const other = await createRepo();
  await setSecret(other, "SECOND", "synthetic-second-a3c8");
  const parsed = YAML.parse(await readFile(localPath, "utf8")) as {
    values: { global: Record<string, unknown> };
  };
  parsed.values.global.SECOND = globalValues(
    await readFile(other.envFile, "utf8")
  ).SECOND;
  await writeFile(localPath, YAML.stringify(parsed));

  const findings = await inspect(repo);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain("SECOND (--local)");
  expect(findings[0]?.message).not.toContain("--env local");
});

test("a layer whose key is missing, or the wrong one, is reported", async () => {
  const repo = await createRepo();
  await setSecret(repo, "FIRST", "synthetic-first-0b4e");
  expect(await inspect(repo)).toEqual([]);
  await rm(repo.keyFile);
  const missing = await inspect(repo);
  expect(missing[0]?.message).toContain("no project env key is available here");
  process.env[PROJECT_ENV_SECRET_KEY_ENV] = "synthetic-unrelated-key-material";
  const wrong = await inspect(repo);
  expect(wrong[0]?.message).toContain("None of the 1 secret(s)");
});

test("an unreadable store and a store whose key is missing are reported", async () => {
  if (process.getuid?.() === 0) {
    return;
  }
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  const repo = await createRepo({
    controlPlane: {
      secrets: {
        backend: "encrypted_file",
        encryptedFile: {
          path: ".hack-secrets.enc.json",
          keyPath: ".hack-secrets-file.key",
        },
      },
    },
  });
  const store = await resolveSecretStore({
    projectName: "integrity",
    projectDir: repo.projectDir,
  });
  await store.set({ key: "TOKEN", value: "synthetic-store-5e61" });
  expect(await inspect(repo)).toEqual([]);
  const storePath = resolve(repo.projectRoot, ".hack-secrets.enc.json");
  const keyPath = resolve(repo.projectRoot, ".hack-secrets-file.key");

  await chmod(storePath, 0o000);
  try {
    const unreadable = await inspect(repo);
    expect(unreadable[0]?.message).toContain(
      ".hack-secrets.enc.json exists but cannot be read"
    );
  } finally {
    await chmod(storePath, 0o600);
  }

  // A symlinked store: use refuses it, and so does the doctor.
  const target = `${storePath}.target`;
  await rename(storePath, target);
  await symlink(target, storePath);
  try {
    const linked = await inspect(repo);
    expect(linked[0]?.message).toContain(
      ".hack-secrets.enc.json is a symlink, not a regular file"
    );
    await expect(store.get({ key: "TOKEN" })).rejects.toThrow(
      "Refused to read the encrypted secret store"
    );
  } finally {
    await rm(storePath);
    await rename(target, storePath);
  }

  const keyText = await readFile(keyPath, "utf8");
  await rm(keyPath);
  const keyMissing = await inspect(repo);
  expect(keyMissing[0]?.message).toContain(
    "its key .hack-secrets-file.key is missing"
  );
  for (const secret of ["synthetic-store-5e61", keyText.trim()]) {
    expect(keyMissing[0]?.message).not.toContain(secret);
  }
});

test("a linked worktree's inherited primary local layer is inspected", async () => {
  // Runtime reads the primary checkout's local layers in a linked worktree
  // (outside CI and slim mode), so the doctor inspects them too.
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  const primary = await createRepo();
  const git = async (cwd: string, args: readonly string[]) => {
    const result = await runFixtureGit({ cwd, args });
    expect(result.exitCode).toBe(0);
  };
  await git(primary.projectRoot, ["init", "-q", "-b", "main"]);
  await git(primary.projectRoot, ["add", "."]);
  await git(primary.projectRoot, ["commit", "-q", "-m", "fixture"]);
  const linkedRoot = resolve(primary.projectRoot, "..", "linked");
  await git(primary.projectRoot, [
    "worktree",
    "add",
    "-q",
    "-b",
    "linked",
    linkedRoot,
  ]);
  const linked = {
    projectRoot: linkedRoot,
    projectDir: resolve(linkedRoot, ".hack"),
  };
  await setProjectEnvValue({
    projectRoot: primary.projectRoot,
    projectDir: primary.projectDir,
    envName: null,
    scope: "global",
    key: "FIRST",
    value: "synthetic-first-c18e",
    secret: true,
    local: true,
  });
  const inspectLinked = async () =>
    await inspectSecretIntegrity({ ...linked, projectName: "integrity" });
  expect(await inspectLinked()).toEqual([]);

  const other = await createRepo();
  await setSecret(other, "SECOND", "synthetic-second-6f93");
  await setSecret(other, "THIRD", "synthetic-third-b07a");
  const localPath = resolve(primary.projectDir, "hack.env.local.yaml");
  const parsed = YAML.parse(await readFile(localPath, "utf8")) as {
    values: { global: Record<string, unknown> };
  };
  const otherValues = globalValues(await readFile(other.envFile, "utf8"));
  parsed.values.global.SECOND = otherValues.SECOND;
  parsed.values.global.THIRD = otherValues.THIRD;
  await writeFile(localPath, YAML.stringify(parsed));

  const findings = await inspectLinked();
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain(
    "(in the primary checkout, which this worktree inherits"
  );
  expect(findings[0]?.message).toContain('the "worktree keys" check');
  expect(findings[0]?.message).toContain("more than one key: 1 of 3");
  expect(findings[0]?.message).toContain("SECOND (--local), THIRD (--local)");

  // The primary's local default as a link leading outside its project:
  // runtime refuses it, so the inspection reports it, never "absent".
  const outside = resolve(primary.projectRoot, "..", "outside.yaml");
  await writeFile(outside, await readFile(localPath, "utf8"));
  await rm(localPath);
  await symlink(outside, localPath);
  const refused = await inspectLinked();
  expect(refused).toHaveLength(1);
  expect(refused[0]?.status).toBe("error");
  expect(refused[0]?.message).toContain("exists but could not be read");
  expect(refused[0]?.message).toContain("in the primary checkout");
});

test("a layer that exists but cannot be read or parsed is an error, not success", async () => {
  // Second-family review: a discovered layer whose read failed was
  // dropped, and the check reported every secret fine.
  const repo = await createRepo();
  await setSecret(repo, "FIRST", "synthetic-first-77aa");
  const staging = resolve(repo.projectDir, "hack.env.staging.yaml");
  await writeFile(staging, "values: [unterminated\n");
  const unparsed = await inspect(repo);
  expect(unparsed).toHaveLength(1);
  expect(unparsed[0]?.status).toBe("error");
  expect(unparsed[0]?.message).toContain(
    ".hack/hack.env.staging.yaml exists but could not be read or parsed"
  );
  if (process.getuid?.() === 0) {
    return;
  }
  await writeFile(
    staging,
    "version: 1\nenvironment: staging\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await chmod(staging, 0o000);
  try {
    const unreadable = await inspect(repo);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.message).toContain("exists but could not be read");
  } finally {
    await chmod(staging, 0o600);
  }
  // A layer name that is not a regular file (a directory), with no
  // committed overlay beside it: runtime refuses it, so it is reported.
  await rm(staging);
  const notAFile = resolve(repo.projectDir, "hack.env.review.local.yaml");
  await mkdir(notAFile);
  const nonRegular = await inspect(repo);
  expect(nonRegular).toHaveLength(1);
  expect(nonRegular[0]?.message).toContain(
    ".hack/hack.env.review.local.yaml exists but could not be read"
  );
  await rm(notAFile, { recursive: true });
  // A project directory whose layers cannot be listed is an error too.
  await chmod(repo.projectDir, 0o300);
  try {
    const unlisted = await inspect(repo);
    expect(
      unlisted.some((finding) =>
        finding.message.includes("could not be listed")
      )
    ).toBe(true);
  } finally {
    await chmod(repo.projectDir, 0o755);
  }
});
