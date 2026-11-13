import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STAGING_LEFTOVER_MIN_AGE_MS } from "../src/lib/private-staging.ts";
import {
  applySecretsHygieneFixes,
  inspectSecretsHygiene,
  type SecretsHygieneFinding,
  type SecretsHygieneScope,
} from "../src/lib/secrets-hygiene.ts";
import { stageMuxEnvironment } from "../src/mux/private-environment.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const SENTINEL = "synthetic-hygiene-sentinel";

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: fixtureGitEnv({
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-secrets-hygiene-"));
  dirs.push(root);
  const projectRoot = join(root, "repo");
  const projectDir = join(projectRoot, ".hack");
  const home = join(root, "home");
  const muxDir = join(root, "mux");
  await mkdir(projectDir, { recursive: true });
  await mkdir(home);
  await mkdir(muxDir);
  await git(projectRoot, ["init", "-q", "-b", "main"]);
  await writeFile(
    join(projectDir, ".gitignore"),
    ".env\nhack.env.local.yaml\nhack.env.*.local.yaml\n"
  );
  await writeFile(join(projectRoot, ".gitignore"), ".hack.secret.key\n");
  const scope: SecretsHygieneScope = {
    project: { projectRoot, projectDir },
    sharedKeyPath: null,
    stores: [
      {
        storePath: join(home, "secrets.enc.json"),
        keyPath: join(home, "secrets-file.key"),
      },
    ],
    tmpDir: muxDir,
    storeKeyFromEnvironment: false,
  };
  return { root, projectRoot, projectDir, home, muxDir, scope };
}

async function backdate(path: string): Promise<void> {
  const old = (Date.now() - STAGING_LEFTOVER_MIN_AGE_MS - 60_000) / 1000;
  await utimes(path, old, old);
}

const paths = (findings: readonly SecretsHygieneFinding[]) =>
  findings.map((finding) => finding.path).sort();

test("a clean project and home report nothing", async () => {
  const f = await fixture();
  await writeFile(join(f.projectDir, "hack.env.local.yaml"), "x: 1\n", {
    mode: 0o600,
  });
  expect(await inspectSecretsHygiene(f.scope)).toEqual([]);
});

test("loose modes on env layers, plaintext env, keys and stores are tightened by --fix", async () => {
  const f = await fixture();
  const files = [
    join(f.projectDir, "hack.env.local.yaml"),
    join(f.projectDir, ".env"),
    join(f.projectRoot, ".hack.secret.key"),
    join(f.home, "secrets.enc.json"),
    join(f.home, "secrets-file.key"),
  ];
  for (const path of files) {
    await writeFile(path, `${SENTINEL}\n`);
    await chmod(path, 0o644);
  }
  const findings = await inspectSecretsHygiene(f.scope);
  expect(paths(findings)).toEqual([...files].sort());
  for (const finding of findings) {
    expect(finding.status).toBe("warn");
    expect(finding.message).toContain("mode 0644");
    expect(finding.message).not.toContain(SENTINEL);
  }
  const lines: string[] = [];
  expect(
    await applySecretsHygieneFixes({ findings, report: (l) => lines.push(l) })
  ).toEqual({ applied: files.length, skipped: 0 });
  for (const path of files) {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe(`${SENTINEL}\n`);
  }
  expect(lines).toHaveLength(files.length);
  expect(lines.join("\n")).not.toContain(SENTINEL);
  expect(await inspectSecretsHygiene(f.scope)).toEqual([]);
});

test("an unignored overlay gets an ignore entry; a tracked layer and a link are errors without a fix", async () => {
  const f = await fixture();
  const overlay = join(f.projectDir, ".env.qa");
  await writeFile(overlay, `QA=${SENTINEL}\n`, { mode: 0o600 });
  const tracked = join(f.projectDir, "hack.env.qa.local.yaml");
  await writeFile(tracked, "x: 1\n", { mode: 0o600 });
  await git(f.projectRoot, ["add", "-f", "--", tracked]);
  const outside = join(f.root, "outside.env");
  await writeFile(outside, `OUT=${SENTINEL}\n`, { mode: 0o600 });
  await symlink(outside, join(f.projectDir, "hack.env.local.yaml"));

  const findings = await inspectSecretsHygiene(f.scope);
  const byPath = new Map(findings.map((finding) => [finding.path, finding]));
  expect(byPath.get(overlay)?.fix).toMatchObject({
    kind: "ignore",
    gitignorePath: join(f.projectDir, ".gitignore"),
    entry: ".env.qa",
  });
  expect(byPath.get(tracked)).toMatchObject({ status: "error", fix: null });
  expect(byPath.get(join(f.projectDir, "hack.env.local.yaml"))).toMatchObject({
    status: "error",
    fix: null,
  });

  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(await readFile(join(f.projectDir, ".gitignore"), "utf8")).toContain(
    "\n.env.qa\n"
  );
  // The link and its target are left alone.
  expect(
    (await lstat(join(f.projectDir, "hack.env.local.yaml"))).isSymbolicLink()
  ).toBe(true);
  expect(await readFile(outside, "utf8")).toBe(`OUT=${SENTINEL}\n`);
  expect(paths(await inspectSecretsHygiene(f.scope))).toEqual(
    [tracked, join(f.projectDir, "hack.env.local.yaml")].sort()
  );
});

test("old staging leftovers are removed; recent ones and user files are kept", async () => {
  const f = await fixture();
  const oldEnvCopy = join(f.projectDir, `..env.${UUID}.tmp`);
  const oldLayerCopy = join(f.projectDir, `.hack.env.local.yaml.${UUID}.tmp`);
  const oldKeyCopy = join(f.projectRoot, `..hack.secret.key.${UUID}.tmp`);
  const oldStoreCopy = join(f.home, `.secrets-file.key.${UUID}.tmp`);
  const recentCopy = join(f.projectDir, `..env.qa.${UUID}.tmp`);
  const userFile = join(f.projectDir, `.notes.${UUID}.tmp`);
  for (const path of [
    oldEnvCopy,
    oldLayerCopy,
    oldKeyCopy,
    oldStoreCopy,
    recentCopy,
    userFile,
  ]) {
    await writeFile(path, `${SENTINEL}\n`, { mode: 0o600 });
  }
  for (const path of [
    oldEnvCopy,
    oldLayerCopy,
    oldKeyCopy,
    oldStoreCopy,
    userFile,
  ]) {
    await backdate(path);
  }
  const findings = await inspectSecretsHygiene(f.scope);
  expect(paths(findings)).toEqual(
    [oldEnvCopy, oldLayerCopy, oldKeyCopy, oldStoreCopy].sort()
  );
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  for (const path of [oldEnvCopy, oldLayerCopy, oldKeyCopy, oldStoreCopy]) {
    expect(await lstat(path).catch(() => null)).toBeNull();
  }
  expect(await readFile(recentCopy, "utf8")).toBe(`${SENTINEL}\n`);
  expect(await readFile(userFile, "utf8")).toBe(`${SENTINEL}\n`);
});

test("a store whose key is missing is reported and never deleted", async () => {
  const f = await fixture();
  const store = join(f.home, "secrets.enc.json");
  await writeFile(store, `{"sentinel":"${SENTINEL}"}\n`, { mode: 0o644 });

  const findings = await inspectSecretsHygiene(f.scope);
  const missing = findings.find((finding) =>
    finding.message.includes("store present, key missing, cannot be read")
  );
  expect(missing).toMatchObject({ status: "error", path: store, fix: null });
  expect(missing?.message).not.toContain(SENTINEL);

  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(await readFile(store, "utf8")).toContain(SENTINEL);
  expect((await stat(store)).mode & 0o777).toBe(0o600);

  const withEnvKey = await inspectSecretsHygiene({
    ...f.scope,
    storeKeyFromEnvironment: true,
  });
  expect(
    withEnvKey.some((finding) => finding.message.includes("key missing"))
  ).toBe(false);
});

test("a stale terminal-session payload is reported and removed", async () => {
  const f = await fixture();
  const payload = await stageMuxEnvironment(
    { FAKE_KEY: SENTINEL },
    { tmpDir: f.muxDir }
  );
  const root = payload.path.slice(0, payload.path.lastIndexOf("/"));
  expect(await inspectSecretsHygiene(f.scope)).toEqual([]);
  const old = (Date.now() - 11 * 60_000) / 1000;
  await utimes(root, old, old);
  const findings = await inspectSecretsHygiene(f.scope);
  expect(paths(findings)).toEqual([root]);
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(await lstat(root).catch(() => null)).toBeNull();
});

test("a store and key configured inside the project are checked against git", async () => {
  const f = await fixture();
  const secrets = join(f.projectRoot, "secrets");
  await mkdir(secrets);
  const storePath = join(secrets, "store.enc.json");
  const keyPath = join(secrets, "store.key");
  await writeFile(storePath, `{"sentinel":"${SENTINEL}"}\n`, { mode: 0o600 });
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  await git(f.projectRoot, ["add", "-f", "--", keyPath]);
  const scope: SecretsHygieneScope = {
    ...f.scope,
    stores: [{ storePath, keyPath }],
  };
  const findings = await inspectSecretsHygiene(scope);
  const byPath = new Map(findings.map((finding) => [finding.path, finding]));
  expect(byPath.get(keyPath)).toMatchObject({ status: "error", fix: null });
  expect(byPath.get(storePath)?.fix).toMatchObject({
    kind: "ignore",
    gitignorePath: join(f.projectRoot, ".gitignore"),
    entry: "/secrets/store.enc.json",
  });
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(paths(await inspectSecretsHygiene(scope))).toEqual([keyPath]);
  // Neither file is changed or removed.
  expect(await readFile(keyPath, "utf8")).toBe(`${SENTINEL}\n`);
  expect(await readFile(storePath, "utf8")).toContain(SENTINEL);
});

test("a .hack linked outside the project is reported and nothing behind it is inspected or fixed", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside-hack");
  await mkdir(outside);
  const outsideEnv = join(outside, ".env");
  const outsideLeftover = join(outside, `..env.${UUID}.tmp`);
  await writeFile(outsideEnv, `${SENTINEL}\n`);
  await chmod(outsideEnv, 0o644);
  await writeFile(outsideLeftover, `${SENTINEL}\n`, { mode: 0o600 });
  await backdate(outsideLeftover);
  await rm(f.projectDir, { recursive: true });
  await symlink(outside, f.projectDir);

  const findings = await inspectSecretsHygiene(f.scope);
  expect(findings).toEqual([
    expect.objectContaining({ status: "error", path: f.projectDir, fix: null }),
  ]);
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect((await stat(outsideEnv)).mode & 0o777).toBe(0o644);
  expect(await readFile(outsideLeftover, "utf8")).toBe(`${SENTINEL}\n`);
});

test("a fix is skipped when its directory was replaced after inspection", async () => {
  const f = await fixture();
  // An unignored overlay: the fix appends to .hack/.gitignore.
  const overlay = join(f.projectDir, ".env.qa");
  await writeFile(overlay, `QA=${SENTINEL}\n`, { mode: 0o600 });
  const findings = await inspectSecretsHygiene(f.scope);
  expect(findings.map((finding) => finding.fix?.kind)).toEqual(["ignore"]);

  // Before --fix, .hack is swapped for a link to a directory elsewhere with
  // its own .gitignore. A file-identity check alone would not notice: the
  // ignore file is found by path.
  const elsewhere = join(f.root, "elsewhere-hack");
  await mkdir(elsewhere);
  const otherIgnore = join(elsewhere, ".gitignore");
  await writeFile(otherIgnore, "kept\n");
  await rm(f.projectDir, { recursive: true });
  await symlink(elsewhere, f.projectDir);

  expect(
    await applySecretsHygieneFixes({ findings, report: () => undefined })
  ).toEqual({ applied: 0, skipped: 1 });
  expect(await readFile(otherIgnore, "utf8")).toBe("kept\n");
});

test("an in-project store under a name starting with '..' is still checked against git", async () => {
  const f = await fixture();
  const dir = join(f.projectRoot, "..secrets");
  await mkdir(dir);
  const storePath = join(dir, "store.enc.json");
  const keyPath = join(dir, "store.key");
  await writeFile(storePath, "{}\n", { mode: 0o600 });
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  await git(f.projectRoot, ["add", "-f", "--", keyPath, storePath]);
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    stores: [{ storePath, keyPath }],
  });
  expect(paths(findings)).toEqual([keyPath, storePath].sort());
  for (const finding of findings) {
    expect(finding).toMatchObject({ status: "error", fix: null });
  }
});

test("project-configured store paths outside the checkout and the Hack home are reported, never fixed", async () => {
  const f = await fixture();
  const victim = join(f.root, "victim");
  await mkdir(victim);
  const victimKey = join(victim, "id.key");
  const victimLeftover = join(victim, `.id.key.${UUID}.tmp`);
  await writeFile(victimKey, `${SENTINEL}\n`);
  await chmod(victimKey, 0o644);
  await writeFile(victimLeftover, `${SENTINEL}\n`, { mode: 0o600 });
  await backdate(victimLeftover);
  // The same directory reached through a link inside the project.
  await symlink(victim, join(f.projectRoot, "linked"));
  const roots = [f.projectRoot, f.home];
  for (const keyPath of [victimKey, join(f.projectRoot, "linked", "id.key")]) {
    const scope: SecretsHygieneScope = {
      ...f.scope,
      stores: [
        {
          storePath: join(victim, "absent.enc.json"),
          keyPath,
          fixRoots: roots,
        },
      ],
    };
    const findings = await inspectSecretsHygiene(scope);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fix: null });
    expect(findings[0]?.message).toContain(
      "outside the project and the Hack home"
    );
    await applySecretsHygieneFixes({ findings, report: () => undefined });
    expect((await stat(victimKey)).mode & 0o777).toBe(0o644);
    expect(await readFile(victimLeftover, "utf8")).toBe(`${SENTINEL}\n`);
  }

  // Inside the Hack home, the same project-configured store is fixed.
  const homeKey = join(f.home, "project.key");
  await writeFile(homeKey, `${SENTINEL}\n`);
  await chmod(homeKey, 0o644);
  const inside = await inspectSecretsHygiene({
    ...f.scope,
    stores: [
      {
        storePath: join(f.home, "absent.enc.json"),
        keyPath: homeKey,
        fixRoots: roots,
      },
    ],
  });
  expect(inside.map((finding) => finding.fix?.kind)).toEqual(["chmod"]);
});

test("an in-checkout store configured through an alias spelling is still checked against git", async () => {
  const f = await fixture();
  const secrets = join(f.projectRoot, "secrets");
  await mkdir(secrets);
  const keyPath = join(secrets, "store.key");
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  await git(f.projectRoot, ["add", "-f", "--", keyPath]);
  // A link outside the checkout that names the checkout root.
  const alias = join(f.root, "alias");
  await symlink(f.projectRoot, alias);
  const aliasedKey = join(alias, "secrets", "store.key");
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    stores: [
      {
        storePath: join(f.home, "absent.enc.json"),
        keyPath: aliasedKey,
      },
    ],
  });
  expect(findings).toEqual([
    expect.objectContaining({ status: "error", path: aliasedKey, fix: null }),
  ]);
  // The untrack command names the path git tracks, relative to the root.
  expect(findings[0]?.message).toContain(
    "git rm --cached -- 'secrets/store.key'"
  );
});

test("an ignore entry for a path with glob characters is literal and verified (git ignores the file after --fix)", async () => {
  const f = await fixture();
  const dir = join(f.projectRoot, "secrets[prod]");
  await mkdir(dir);
  const keyPath = join(dir, "store.key");
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  const scope: SecretsHygieneScope = {
    ...f.scope,
    stores: [{ storePath: join(f.home, "absent.enc.json"), keyPath }],
  };
  const findings = await inspectSecretsHygiene(scope);
  expect(findings.map((finding) => finding.fix)).toEqual([
    expect.objectContaining({
      kind: "ignore",
      entry: "/secrets\\[prod\\]/store.key",
    }),
  ]);
  expect(
    await applySecretsHygieneFixes({ findings, report: () => undefined })
  ).toEqual({ applied: 1, skipped: 0 });
  expect(await inspectSecretsHygiene(scope)).toEqual([]);
});

test("a store whose name ends with a space is reported with no automatic ignore entry", async () => {
  const f = await fixture();
  const keyPath = join(f.projectRoot, "store.key ");
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    stores: [{ storePath: join(f.home, "absent.enc.json"), keyPath }],
  });
  expect(findings).toEqual([
    expect.objectContaining({ status: "warn", path: keyPath, fix: null }),
  ]);
  expect(findings[0]?.message).toContain("by hand");
  const before = await readFile(join(f.projectRoot, ".gitignore"), "utf8");
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(await readFile(join(f.projectRoot, ".gitignore"), "utf8")).toBe(
    before
  );
});

test("a configured path with a line break never becomes an ignore entry", async () => {
  const f = await fixture();
  const dir = join(f.projectRoot, "secret");
  await mkdir(dir);
  await writeFile(join(dir, "store.key"), `${SENTINEL}\n`, { mode: 0o600 });
  await writeFile(
    join(f.projectRoot, ".gitignore"),
    ".hack.secret.key\n/secret/store.key\n"
  );
  // An in-project name that would add a negating line for the real key.
  const crafted = join(f.projectRoot, "x\n!", "secret", "store.key");
  await mkdir(dirname(crafted), { recursive: true });
  await writeFile(crafted, `${SENTINEL}\n`, { mode: 0o600 });
  const before = await readFile(join(f.projectRoot, ".gitignore"), "utf8");
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    stores: [{ storePath: join(f.home, "absent.enc.json"), keyPath: crafted }],
  });
  expect(findings).toEqual([
    expect.objectContaining({ path: crafted, fix: null }),
  ]);
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(await readFile(join(f.projectRoot, ".gitignore"), "utf8")).toBe(
    before
  );
});

test("names in findings are shell-quoted in commands and never printed with control characters", async () => {
  const f = await fixture();
  const quoted = join(f.projectDir, "hack.env.it's;x.local.yaml");
  const escaped = join(f.projectDir, "hack.env.\u001b]0;t\u0007.local.yaml");
  for (const path of [quoted, escaped]) {
    await writeFile(path, "x: 1\n", { mode: 0o600 });
    await git(f.projectRoot, ["add", "-f", "--", path]);
  }
  const findings = await inspectSecretsHygiene(f.scope);
  const text = findings.map((finding) => finding.message).join("\n");
  expect(text).toContain(
    "git rm --cached -- '.hack/hack.env.it'\\''s;x.local.yaml'"
  );
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\u0007");
  expect(text).toContain("no command is printed");
});

test("an in-checkout store and key that do not exist yet are ignored before first use", async () => {
  const f = await fixture();
  // Configured relative to the checkout; neither the files nor their
  // directory exist yet.
  const storePath = join(f.projectRoot, "secrets", "store.enc.json");
  const keyPath = join(f.projectRoot, "secrets", "store.key");
  const scope: SecretsHygieneScope = {
    ...f.scope,
    stores: [{ storePath, keyPath }],
  };
  const findings = await inspectSecretsHygiene(scope);
  expect(findings.map((finding) => finding.fix?.kind).sort()).toEqual([
    "ignore",
    "ignore",
  ]);
  expect(
    await applySecretsHygieneFixes({ findings, report: () => undefined })
  ).toEqual({ applied: 2, skipped: 0 });
  expect(await inspectSecretsHygiene(scope)).toEqual([]);
  // A file created there later is already ignored.
  await mkdir(join(f.projectRoot, "secrets"));
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  expect(await inspectSecretsHygiene(scope)).toEqual([]);
});
