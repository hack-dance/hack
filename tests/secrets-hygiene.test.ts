import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { STAGING_LEFTOVER_MIN_AGE_MS } from "../src/lib/private-staging.ts";
import { projectEnvLiveInputPaths } from "../src/lib/project-env-config.ts";
import {
  applySecretsHygieneFixes,
  inspectSecretsHygiene,
  type SecretsHygieneFinding,
  type SecretsHygieneScope,
} from "../src/lib/secrets-hygiene.ts";
import * as shell from "../src/lib/shell.ts";
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
  // A tracked key is an error; a tracked store is ciphertext only, so a
  // warning (some projects commit it), never repaired automatically.
  const byPath = new Map(findings.map((finding) => [finding.path, finding]));
  expect(byPath.get(keyPath)).toMatchObject({ status: "error", fix: null });
  expect(byPath.get(storePath)).toMatchObject({ status: "warn", fix: null });
  expect(byPath.get(storePath)?.message).toContain("keep its key out of git");
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
    "git --literal-pathspecs rm --cached -- 'secrets/store.key'"
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
    "git --literal-pathspecs rm --cached -- '.hack/hack.env.it'\\''s;x.local.yaml'"
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

test("a project-configured store path not created yet keeps its ignore fix (fix roots)", async () => {
  const f = await fixture();
  const storePath = join(f.projectRoot, "secrets", "s.enc.json");
  const keyPath = join(f.projectRoot, "secrets", "s.key");
  const scope: SecretsHygieneScope = {
    ...f.scope,
    stores: [{ storePath, keyPath, fixRoots: [f.projectRoot, f.home] }],
  };
  const findings = await inspectSecretsHygiene(scope);
  expect(findings.map((finding) => finding.fix?.kind)).toEqual([
    "ignore",
    "ignore",
  ]);
  for (const finding of findings) {
    expect(finding.message).not.toContain("outside the project");
  }
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(await inspectSecretsHygiene(scope)).toEqual([]);
});

test("a configured key named like a staging leftover is live and never offered for removal", async () => {
  const f = await fixture();
  // Recovery pointed the backend at an old staging copy that still works.
  const liveKey = join(f.projectRoot, `..hack.secret.key.${UUID}.tmp`);
  const store = join(f.home, "secrets.enc.json");
  await writeFile(liveKey, `${SENTINEL}\n`, { mode: 0o600 });
  await writeFile(store, `{"sentinel":"${SENTINEL}"}\n`, { mode: 0o600 });
  await backdate(liveKey);
  // The same name reached through a link is the same live file.
  const alias = join(f.root, "alias-key");
  await symlink(liveKey, alias);
  for (const keyPath of [liveKey, alias]) {
    const findings = await inspectSecretsHygiene({
      ...f.scope,
      stores: [{ storePath: store, keyPath }],
    });
    expect(
      findings.some((finding) => finding.fix?.kind === "remove_leftover")
    ).toBe(false);
    await applySecretsHygieneFixes({ findings, report: () => undefined });
    expect(await readFile(liveKey, "utf8")).toBe(`${SENTINEL}\n`);
  }
  // Without that configuration the same file is an ordinary leftover.
  const unconfigured = await inspectSecretsHygiene(f.scope);
  expect(paths(unconfigured)).toContain(liveKey);
});

test.skipIf(process.getuid?.() === 0)(
  "an ignore file the user cannot read is never rewritten",
  async () => {
    const f = await fixture();
    const overlay = join(f.projectDir, ".env.qa");
    await writeFile(overlay, "QA=1\n", { mode: 0o600 });
    const ignore = join(f.projectDir, ".gitignore");
    const before = await readFile(ignore, "utf8");
    const findings = await inspectSecretsHygiene(f.scope);
    expect(findings.map((finding) => finding.fix?.kind)).toEqual(["ignore"]);
    // Write-only: the repair could append nothing without losing the rules.
    await chmod(ignore, 0o200);
    try {
      expect(
        await applySecretsHygieneFixes({ findings, report: () => undefined })
      ).toEqual({ applied: 0, skipped: 1 });
    } finally {
      await chmod(ignore, 0o644);
    }
    expect(await readFile(ignore, "utf8")).toBe(before);
  }
);

test.skipIf(process.getuid?.() === 0)(
  "a store or project directory that cannot be inspected is an error, never a clean result",
  async () => {
    const f = await fixture();
    const locked = join(f.root, "locked");
    await mkdir(locked);
    const storePath = join(locked, "secrets.enc.json");
    const keyPath = join(locked, "secrets-file.key");
    await writeFile(storePath, "{}\n", { mode: 0o600 });
    await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
    await chmod(locked, 0o000);
    await chmod(f.projectDir, 0o000);
    try {
      const findings = await inspectSecretsHygiene({
        ...f.scope,
        stores: [{ storePath, keyPath }],
      });
      const byPath = new Map(
        findings.map((finding) => [finding.path, finding])
      );
      for (const path of [storePath, keyPath, f.projectDir]) {
        expect(byPath.get(path)).toMatchObject({ status: "error", fix: null });
        expect(byPath.get(path)?.message).toContain("could not be inspected");
      }
      // Never reported as a store whose key is missing.
      expect(
        findings.some((finding) => finding.message.includes("key missing"))
      ).toBe(false);
    } finally {
      await chmod(locked, 0o700);
      await chmod(f.projectDir, 0o755);
    }
  }
);

test("an ignore file whose read fails while it is merged keeps its rules", async () => {
  const f = await fixture();
  const overlay = join(f.projectDir, ".env.qa");
  await writeFile(overlay, "QA=1\n", { mode: 0o600 });
  const ignore = join(f.projectDir, ".gitignore");
  const before = await readFile(ignore, "utf8");
  const findings = await inspectSecretsHygiene(f.scope);
  expect(findings.map((finding) => finding.fix?.kind)).toEqual(["ignore"]);
  // Every path-based read of the ignore file fails (an I/O error, say); a
  // reader that turned that into "absent" would replace the rules.
  const original = Bun.file;
  const failing = ((path: unknown, ...rest: unknown[]) => {
    const file = Reflect.apply(original, Bun, [path, ...rest]) as ReturnType<
      typeof Bun.file
    >;
    if (String(path) !== ignore) {
      return file;
    }
    const error = Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    return Object.assign(Object.create(file), {
      text: async () => {
        throw error;
      },
    });
  }) as typeof Bun.file;
  Bun.file = failing;
  let result: { applied: number; skipped: number };
  try {
    result = await applySecretsHygieneFixes({
      findings,
      report: () => undefined,
    });
  } finally {
    Bun.file = original;
  }
  expect(await readFile(ignore, "utf8")).toStartWith(before);
  expect(result.applied + result.skipped).toBe(1);
});

test("ignore repair publishes onto the admitted file, never through a link swapped in after", async () => {
  const f = await fixture();
  const overlay = join(f.projectDir, ".env.qa");
  await writeFile(overlay, "QA=1\n", { mode: 0o600 });
  const ignore = join(f.projectDir, ".gitignore");
  const before = await readFile(ignore, "utf8");
  // A file outside the project with the same text, so a compare on content
  // alone would accept it.
  const outside = join(f.root, "outside.txt");
  await writeFile(outside, before);
  const findings = await inspectSecretsHygiene(f.scope);
  expect(findings.map((finding) => finding.fix?.kind)).toEqual(["ignore"]);
  // The admission read uses a descriptor; the writer's own read of the path
  // comes after it. Swap the entry for a link at that point, as another user
  // with write access to a shared directory could.
  const original = Bun.file;
  let swapped = false;
  const swapping = ((path: unknown, ...rest: unknown[]) => {
    const file = Reflect.apply(original, Bun, [path, ...rest]) as ReturnType<
      typeof Bun.file
    >;
    if (String(path) !== ignore || swapped) {
      return file;
    }
    return Object.assign(Object.create(file), {
      text: async () => {
        swapped = true;
        await rm(ignore);
        await symlink(outside, ignore);
        return before;
      },
    });
  }) as typeof Bun.file;
  Bun.file = swapping;
  try {
    await applySecretsHygieneFixes({ findings, report: () => undefined });
  } finally {
    Bun.file = original;
  }
  expect(swapped).toBe(true);
  expect(await readFile(outside, "utf8")).toBe(before);
});

test("an env input current resolution reads is never removed, even when its real file looks like a leftover", async () => {
  const f = await fixture();
  // A YAML layer whose real file has a staging-shaped name (left by a
  // recovery that linked the layer to an old staging copy).
  const real = join(f.projectDir, `.hack.env.yaml.${UUID}.tmp`);
  await writeFile(real, `values:\n  SENTINEL: ${SENTINEL}\n`, { mode: 0o600 });
  await backdate(real);
  // Without the layer it is an ordinary leftover.
  const before = await inspectSecretsHygiene(f.scope);
  expect(
    before.some(
      (finding) =>
        finding.fix?.kind === "remove_leftover" && finding.path === real
    )
  ).toBe(true);
  // The layer appears between inspection and --fix: the removal asks again.
  await symlink(real, join(f.projectDir, "hack.env.yaml"));
  await applySecretsHygieneFixes({ findings: before, report: () => undefined });
  expect(await readFile(real, "utf8")).toContain(SENTINEL);
  // And a fresh inspection never offers it.
  const after = await inspectSecretsHygiene(f.scope);
  expect(
    after.some(
      (finding) =>
        finding.fix?.kind === "remove_leftover" && finding.path === real
    )
  ).toBe(false);
});

test("when the project's env inputs cannot be inspected, no leftover is removed", async () => {
  const f = await fixture();
  const leftover = join(f.projectRoot, `..hack.secret.key.${UUID}.tmp`);
  await writeFile(leftover, `${SENTINEL}\n`, { mode: 0o600 });
  await backdate(leftover);
  // A configuration path that cannot be resolved (a link to itself).
  const config = join(f.projectDir, "hack.config.json");
  await symlink(config, config);
  const findings = await inspectSecretsHygiene(f.scope);
  expect(
    findings.some((finding) => finding.fix?.kind === "remove_leftover")
  ).toBe(false);
  await rm(config);
  // Once it can, the same file is an ordinary leftover again.
  const later = await inspectSecretsHygiene(f.scope);
  expect(paths(later)).toContain(leftover);
});

test("a configured key inside a stale terminal payload directory is never removed", async () => {
  const f = await fixture();
  const tmpDir = f.scope.tmpDir ?? "";
  const payload = await stageMuxEnvironment(
    { FAKE_KEY: "synthetic-mux" },
    { tmpDir }
  );
  // Recovery pointed the backend at that file as its key.
  const store = join(f.home, "secrets.enc.json");
  await writeFile(store, `{"sentinel":"${SENTINEL}"}\n`, { mode: 0o600 });
  await backdate(dirname(payload.path));
  const configured = {
    ...f.scope,
    stores: [{ storePath: store, keyPath: payload.path }],
  };
  // Inspected with that configuration: no removal is offered.
  const findings = await inspectSecretsHygiene(configured);
  expect(findings.some((finding) => finding.fix?.kind === "remove_mux")).toBe(
    false
  );
  // Inspected before the configuration chose it: --fix asks the current
  // configuration again and keeps the file.
  const earlier = await inspectSecretsHygiene(f.scope);
  expect(earlier.some((finding) => finding.fix?.kind === "remove_mux")).toBe(
    true
  );
  await applySecretsHygieneFixes({
    findings: earlier,
    report: () => undefined,
    currentScope: async () => configured,
  });
  expect(JSON.parse(await readFile(payload.path, "utf8"))).toEqual({
    FAKE_KEY: "synthetic-mux",
  });
  await payload.cleanup();
});

test("a leftover the configuration selects after inspection is kept by --fix", async () => {
  const f = await fixture();
  const leftover = join(f.projectRoot, `..hack.secret.key.${UUID}.tmp`);
  await writeFile(leftover, `${SENTINEL}\n`, { mode: 0o600 });
  await backdate(leftover);
  const findings = await inspectSecretsHygiene(f.scope);
  expect(paths(findings)).toContain(leftover);
  // A configuration edit between inspection and --fix makes it the key.
  const store = join(f.home, "secrets.enc.json");
  const current = {
    ...f.scope,
    stores: [{ storePath: store, keyPath: leftover }],
  };
  await applySecretsHygieneFixes({
    findings,
    report: () => undefined,
    currentScope: async () => current,
  });
  expect(await readFile(leftover, "utf8")).toBe(`${SENTINEL}\n`);
  // A configuration that cannot be resolved now refuses the removal too.
  await applySecretsHygieneFixes({
    findings,
    report: () => undefined,
    currentScope: () => Promise.reject(new Error("synthetic config error")),
  });
  expect(await readFile(leftover, "utf8")).toBe(`${SENTINEL}\n`);
  // With the configuration unchanged, the leftover is removed.
  await applySecretsHygieneFixes({
    findings,
    report: () => undefined,
    currentScope: async () => f.scope,
  });
  expect(await lstat(leftover).catch(() => null)).toBeNull();
});

test("in a checkout whose git cannot name its shared inputs, no leftover is removed", async () => {
  const f = await fixture();
  const leftover = join(f.projectRoot, `..hack.secret.key.${UUID}.tmp`);
  await writeFile(leftover, `${SENTINEL}\n`, { mode: 0o600 });
  await backdate(leftover);
  expect(paths(await inspectSecretsHygiene(f.scope))).toContain(leftover);
  // Still a checkout (a .git marker), but git cannot read it.
  await rm(join(f.projectRoot, ".git"), { recursive: true, force: true });
  await writeFile(
    join(f.projectRoot, ".git"),
    `gitdir: ${join(f.root, "missing-git-dir")}\n`
  );
  const findings = await inspectSecretsHygiene(f.scope);
  expect(
    findings.some((finding) => finding.fix?.kind === "remove_leftover")
  ).toBe(false);
  await applySecretsHygieneFixes({ findings, report: () => undefined });
  expect(await readFile(leftover, "utf8")).toBe(`${SENTINEL}\n`);
});

test("a configured name that looks like git pathspec magic is checked as a literal path", async () => {
  const f = await fixture();
  // `:(literal)…` would be pathspec magic if passed as is: check-ignore
  // refuses it (unknown) and ls-files matches nothing.
  const storePath = join(f.projectRoot, ":(literal)store.enc.json");
  const keyPath = join(f.projectRoot, ":(literal)legacy.key");
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
  // Tracked under that name: reported as tracked, never as clean.
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  await git(f.projectRoot, ["add", "-f", "--", `./${":(literal)legacy.key"}`]);
  const tracked = await inspectSecretsHygiene(scope);
  expect(
    tracked.some(
      (finding) => finding.path === keyPath && finding.status === "error"
    )
  ).toBe(true);
});

test("git lookups that fail after the first ones never shrink the live set", async () => {
  const f = await fixture();
  const project = f.scope.project;
  if (!project) {
    throw new Error("Missing project");
  }
  const sharedKey = join(
    await realpath(join(f.projectRoot, ".git")),
    ".hack.secret.key"
  );
  expect(await projectEnvLiveInputPaths(project)).toContain(sharedKey);
  // Let the first two git calls answer, then fail every later one (a
  // transient child failure): the set either names the shared key or the
  // call rejects, never a smaller set.
  const original = shell.exec;
  let gitCalls = 0;
  const spy = spyOn(shell, "exec").mockImplementation((async (
    cmd: readonly string[],
    options?: Parameters<typeof shell.exec>[1]
  ) => {
    if (cmd[0] === "git") {
      gitCalls += 1;
      if (gitCalls > 2) {
        return { exitCode: 128, stdout: "", stderr: "" };
      }
    }
    return await original(cmd, options);
  }) as typeof shell.exec);
  try {
    const live = await projectEnvLiveInputPaths(project).catch(() => null);
    expect(gitCalls).toBeGreaterThan(0);
    if (live !== null) {
      expect(live).toContain(sharedKey);
    }
  } finally {
    spy.mockRestore();
  }
});

test("a store and key in another git work tree are checked there and reported, never repaired", async () => {
  const f = await fixture();
  // A home directory kept in git, say: outside the project, inside a tree.
  const outer = join(f.root, "dotfiles");
  await mkdir(outer);
  await git(outer, ["init", "-q", "-b", "main"]);
  const storePath = join(outer, "secrets", "store.enc.json");
  const keyPath = join(outer, "secrets", "store.key");
  const scope: SecretsHygieneScope = {
    ...f.scope,
    stores: [{ storePath, keyPath }],
  };
  const unignored = await inspectSecretsHygiene(scope);
  expect(paths(unignored)).toEqual([keyPath, storePath].sort());
  for (const finding of unignored) {
    expect(finding).toMatchObject({ status: "warn", fix: null });
    expect(finding.message).toContain("by hand");
  }
  // Ignored there by hand: clean.
  await writeFile(join(outer, ".gitignore"), "/secrets/\n");
  expect(await inspectSecretsHygiene(scope)).toEqual([]);
  // Tracked there: an error.
  await mkdir(join(outer, "secrets"));
  await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
  await git(outer, ["add", "-f", "--", "secrets/store.key"]);
  const tracked = await inspectSecretsHygiene(scope);
  expect(
    tracked.some(
      (finding) => finding.path === keyPath && finding.status === "error"
    )
  ).toBe(true);
  // A checkout git cannot name: an error, never clean.
  await rm(join(outer, ".git"), { recursive: true, force: true });
  await writeFile(
    join(outer, ".git"),
    `gitdir: ${join(f.root, "missing-git-dir")}\n`
  );
  const unknown = await inspectSecretsHygiene(scope);
  expect(
    unknown.some(
      (finding) =>
        finding.path === storePath &&
        finding.status === "error" &&
        finding.message.includes("could not name")
    )
  ).toBe(true);
});

test("a store inside a git directory itself is not in a work tree", async () => {
  const f = await fixture();
  const gitDir = join(f.root, "bare.git");
  await mkdir(gitDir);
  await git(gitDir, ["init", "-q", "--bare"]);
  const scope: SecretsHygieneScope = {
    ...f.scope,
    stores: [
      {
        storePath: join(gitDir, "store.enc.json"),
        keyPath: join(gitDir, "store.key"),
      },
    ],
  };
  expect(await inspectSecretsHygiene(scope)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "a backslash in a configured name is part of it, never a separator, when git is asked",
  async () => {
    const f = await fixture();
    // Tracked under its literal name; a slash spelling would be a different,
    // ignored path (the decoy).
    const keyPath = join(f.projectRoot, "key\\prod.key");
    await writeFile(keyPath, `${SENTINEL}\n`, { mode: 0o600 });
    await writeFile(
      join(f.projectRoot, ".gitignore"),
      ".hack.secret.key\n/key/\n"
    );
    await git(f.projectRoot, ["add", "-f", "--", "./key\\prod.key"]);
    const findings = await inspectSecretsHygiene({
      ...f.scope,
      stores: [{ storePath: join(f.home, "secrets.enc.json"), keyPath }],
    });
    expect(
      findings.some(
        (finding) => finding.path === keyPath && finding.status === "error"
      )
    ).toBe(true);
  }
);

test("a containing repository whose root cannot be resolved is unknown, never skipped", async () => {
  const f = await fixture();
  const outer = join(f.root, "dotfiles");
  await mkdir(outer);
  await git(outer, ["init", "-q", "-b", "main"]);
  const storePath = join(outer, "secrets", "store.enc.json");
  const keyPath = join(outer, "secrets", "store.key");
  // Resolving the repository root fails (an I/O error, say); its parent and
  // everything else still resolve.
  const original = fsPromises.realpath;
  const spy = spyOn(fsPromises, "realpath").mockImplementation((async (
    path: Parameters<typeof original>[0],
    ...rest: unknown[]
  ) => {
    if (String(path) === outer) {
      throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    }
    return await Reflect.apply(original, fsPromises, [path, ...rest]);
  }) as typeof original);
  let findings: readonly SecretsHygieneFinding[];
  try {
    findings = await inspectSecretsHygiene({
      ...f.scope,
      stores: [{ storePath, keyPath }],
    });
  } finally {
    spy.mockRestore();
  }
  for (const path of [storePath, keyPath]) {
    expect(
      findings.some(
        (finding) => finding.path === path && finding.status === "error"
      )
    ).toBe(true);
  }
});

test("the printed untrack command removes only the named file, even one that looks like a pathspec", async () => {
  const f = await fixture();
  const name = ":(glob)*.key";
  const keyPath = join(f.projectRoot, name);
  const other = join(f.projectRoot, "other.key");
  for (const path of [keyPath, other]) {
    await writeFile(path, `${SENTINEL}\n`, { mode: 0o600 });
  }
  await git(f.projectRoot, ["add", "-f", "--", `./${name}`, "other.key"]);
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    stores: [{ storePath: join(f.home, "secrets.enc.json"), keyPath }],
  });
  const message =
    findings.find(
      (finding) => finding.path === keyPath && finding.status === "error"
    )?.message ?? "";
  const command = /untrack it with (git .*?) \(from the project root\)/.exec(
    message
  )?.[1];
  expect(command).toStartWith("git --literal-pathspecs rm --cached -- ");
  const proc = Bun.spawn(["sh", "-c", command ?? "false"], {
    cwd: f.projectRoot,
    env: fixtureGitEnv(),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
  const listed = Bun.spawn(["git", "ls-files"], {
    cwd: f.projectRoot,
    env: fixtureGitEnv(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const tracked = (await new Response(listed.stdout).text()).split("\n");
  expect(tracked).toContain("other.key");
  expect(tracked).not.toContain(name);
});

async function caseInsensitive(dir: string): Promise<boolean> {
  const probe = join(dir, "CaseProbe");
  await writeFile(probe, "");
  const folded = await lstat(join(dir, "caseprobe")).then(
    () => true,
    () => false
  );
  await rm(probe);
  return folded;
}

test("in another work tree an existing key is checked under its stored case", async () => {
  const f = await fixture();
  const outer = join(f.root, "dotfiles");
  await mkdir(join(outer, "secrets"), { recursive: true });
  if (!(await caseInsensitive(outer))) {
    // Needs a case-insensitive filesystem (macOS by default).
    return;
  }
  await git(outer, ["init", "-q", "-b", "main"]);
  await writeFile(join(outer, "secrets", "Store.Key"), `${SENTINEL}\n`, {
    mode: 0o600,
  });
  await git(outer, ["add", "-f", "--", "secrets/Store.Key"]);
  await writeFile(join(outer, ".gitignore"), "/secrets/store.key\n");
  const keyPath = join(outer, "secrets", "store.key");
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    stores: [{ storePath: join(f.home, "secrets.enc.json"), keyPath }],
  });
  expect(
    findings.some(
      (finding) => finding.path === keyPath && finding.status === "error"
    )
  ).toBe(true);
});

test("a store in a repository nested inside the project is checked against that repository", async () => {
  const f = await fixture();
  const inner = join(f.projectRoot, "vendor-app");
  await mkdir(inner);
  await git(inner, ["init", "-q", "-b", "main"]);
  // The project ignores the nested repository; the nested one ignores
  // nothing, so its own `git add -A` would collect the store and key.
  await writeFile(
    join(f.projectRoot, ".gitignore"),
    ".hack.secret.key\n/vendor-app/\n"
  );
  const storePath = join(inner, "secrets", "store.enc.json");
  const keyPath = join(inner, "secrets", "store.key");
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    stores: [{ storePath, keyPath }],
  });
  expect(paths(findings)).toEqual([keyPath, storePath].sort());
  for (const finding of findings) {
    expect(finding).toMatchObject({ status: "warn", fix: null });
    expect(finding.message).toContain("by hand");
  }
});

test("a project inside a larger repository keeps its own ignore repair", async () => {
  const f = await fixture();
  const mono = join(f.root, "mono");
  const app = join(mono, "apps", "web");
  await mkdir(join(app, ".hack"), { recursive: true });
  await git(mono, ["init", "-q", "-b", "main"]);
  const keyPath = join(app, "secrets", "store.key");
  const findings = await inspectSecretsHygiene({
    ...f.scope,
    project: { projectRoot: app, projectDir: join(app, ".hack") },
    stores: [{ storePath: join(app, "secrets", "store.enc.json"), keyPath }],
  });
  const key = findings.find((finding) => finding.path === keyPath);
  expect(key?.fix?.kind).toBe("ignore");
});

test("a configured key in a stale payload reached through a linked temp directory is never removed", async () => {
  const f = await fixture();
  // The temporary directory is reached through a link (macOS: /var ->
  // /private/var); the key is configured by the linked spelling, while
  // hygiene names payloads by the resolved one.
  const linked = join(f.root, "tmp-link");
  await symlink(f.muxDir, linked);
  const payload = await stageMuxEnvironment(
    { FAKE_KEY: "synthetic-linked" },
    { tmpDir: linked }
  );
  await backdate(dirname(payload.path));
  const store = join(f.home, "secrets.enc.json");
  await writeFile(store, `{"sentinel":"${SENTINEL}"}\n`, { mode: 0o600 });
  const keyByLink = join(linked, basename(dirname(payload.path)), "env.json");
  const configured = {
    ...f.scope,
    tmpDir: linked,
    stores: [{ storePath: store, keyPath: keyByLink }],
  };
  expect(
    (await inspectSecretsHygiene(configured)).some(
      (finding) => finding.fix?.kind === "remove_mux"
    )
  ).toBe(false);
  const earlier = await inspectSecretsHygiene({ ...f.scope, tmpDir: linked });
  expect(
    earlier
      .filter((finding) => finding.fix?.kind === "remove_mux")
      .map((finding) => finding.path)
  ).toEqual([dirname(payload.path)]);
  await applySecretsHygieneFixes({
    findings: earlier,
    report: () => undefined,
    currentScope: async () => configured,
  });
  expect(await readFile(payload.path, "utf8")).toContain("synthetic-linked");
  await payload.cleanup();
});
