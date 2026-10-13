import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDoctorJsonData,
  envKeyCheckResult,
} from "../src/commands/doctor.ts";
import {
  classifyEnvKeyText,
  type EnvKeyCandidate,
  type EnvKeyInspection,
  gitListTrackedKeyPaths,
  type InspectEnvKeyOptions,
  inspectProjectEnvKey,
} from "../src/lib/doctor-env-key.ts";

const KEY_FILE = ".hack.secret.key";
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-key-"));
  roots.push(root);
  return root;
}

function generatedKey(): string {
  return randomBytes(32).toString("base64url");
}

async function writeKey(opts: {
  readonly path: string;
  readonly text: string;
  readonly mode: number;
}): Promise<void> {
  await writeFile(opts.path, `${opts.text}\n`, { mode: opts.mode });
  await chmod(opts.path, opts.mode);
}

function localCandidate(root: string): EnvKeyCandidate {
  return { role: "local", path: join(root, KEY_FILE) };
}

async function inspect(
  root: string,
  overrides: Partial<InspectEnvKeyOptions> = {}
): Promise<EnvKeyInspection> {
  return await inspectProjectEnvKey({
    projectRoot: root,
    candidates: [localCandidate(root)],
    env: {},
    uid,
    listTrackedKeyPaths: async () => [],
    ...overrides,
  });
}

function codes(inspection: EnvKeyInspection): readonly string[] {
  return inspection.findings.map((finding) => finding.code);
}

/** Serialized doctor output (human message plus JSON) for leak assertions. */
function serialized(inspection: EnvKeyInspection): string {
  const check = envKeyCheckResult(inspection);
  return `${check.message}\n${JSON.stringify(
    buildDoctorJsonData({ results: [{ ...check, durationMs: 0 }] })
  )}`;
}

function expectValueFree(opts: {
  readonly output: string;
  readonly root: string;
  readonly secrets: readonly string[];
}): void {
  expect(opts.output).not.toContain(opts.root);
  for (const secret of opts.secrets) {
    expect(opts.output).not.toContain(secret);
  }
}

describe("env key doctor diagnostic", () => {
  test("a private generated key reports env-key-ok without key bytes", async () => {
    const root = await tempProject();
    const key = generatedKey();
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });

    const inspection = await inspect(root);

    expect(inspection.status).toBe("ok");
    expect(codes(inspection)).toEqual(["env-key-ok"]);
    expectValueFree({
      output: serialized(inspection),
      root,
      secrets: [key],
    });
  });

  test("negative control: a 0644 key reports weak permissions", async () => {
    const root = await tempProject();
    const key = generatedKey();
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o644 });

    const inspection = await inspect(root);

    expect(inspection.status).toBe("warn");
    expect(codes(inspection)).toEqual(["env-key-weak-permissions"]);
    expect(inspection.findings[0]).toEqual({
      code: "env-key-weak-permissions",
      status: "warn",
      subject: KEY_FILE,
      remedy: `chmod 600 ${KEY_FILE}`,
    });
    expectValueFree({ output: serialized(inspection), root, secrets: [key] });
  });

  test("negative control: a symlinked key reports symlink and is not followed", async () => {
    const root = await tempProject();
    const target = join(root, "elsewhere.key");
    // A weak target would add a strength finding if the link were followed.
    await writeKey({ path: target, text: "short", mode: 0o600 });
    await symlink(target, join(root, KEY_FILE));

    const inspection = await inspect(root);

    expect(inspection.status).toBe("error");
    expect(codes(inspection)).toEqual(["env-key-symlink"]);
    expect(inspection.findings[0]?.remedy).toContain(
      `cp -L ${KEY_FILE} ${KEY_FILE}.new && mv -f ${KEY_FILE}.new ${KEY_FILE} && chmod 600 ${KEY_FILE}`
    );
    expectValueFree({
      output: serialized(inspection),
      root,
      secrets: ["elsewhere.key"],
    });
  });

  test("a dangling symlink still reports symlink", async () => {
    const root = await tempProject();
    await symlink(join(root, "missing.key"), join(root, KEY_FILE));

    expect(codes(await inspect(root))).toEqual(["env-key-symlink"]);
  });

  test("a directory at the key path reports not-regular", async () => {
    const root = await tempProject();
    await mkdir(join(root, KEY_FILE));

    const inspection = await inspect(root);
    expect(inspection.status).toBe("error");
    expect(codes(inspection)).toEqual(["env-key-not-regular"]);
  });

  test("a short key reports wrong length and suggests rotation", async () => {
    const root = await tempProject();
    const key = "hunter2-hunter2";
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });

    const inspection = await inspect(root);

    expect(codes(inspection)).toEqual(["env-key-wrong-length"]);
    expect(inspection.findings[0]?.remedy).toContain(
      `mv ${KEY_FILE} ${KEY_FILE}.old`
    );
    expectValueFree({ output: serialized(inspection), root, secrets: [key] });
  });

  test("a whitespace-only key reports wrong length", async () => {
    const root = await tempProject();
    await writeKey({ path: join(root, KEY_FILE), text: "   ", mode: 0o600 });

    expect(codes(await inspect(root))).toEqual(["env-key-wrong-length"]);
  });

  test("a long repetitive key reports low entropy", async () => {
    const root = await tempProject();
    const key = "password".repeat(8);
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });

    const inspection = await inspect(root);

    expect(codes(inspection)).toEqual(["env-key-low-entropy"]);
    expectValueFree({ output: serialized(inspection), root, secrets: [key] });
  });

  test("invalid UTF-8 key material reports unreadable", async () => {
    const root = await tempProject();
    const path = join(root, KEY_FILE);
    await writeFile(path, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });

    const inspection = await inspect(root);
    expect(inspection.status).toBe("error");
    expect(codes(inspection)).toEqual(["env-key-unreadable"]);
  });

  test.skipIf(uid === null)(
    "a key owned by another user reports wrong owner",
    async () => {
      const root = await tempProject();
      await writeKey({
        path: join(root, KEY_FILE),
        text: generatedKey(),
        mode: 0o600,
      });

      const inspection = await inspect(root, { uid: (uid ?? 0) + 1 });

      expect(codes(inspection)).toEqual(["env-key-wrong-owner"]);
      expect(inspection.findings[0]?.remedy).toBe(
        `sudo chown "$(id -u)" ${KEY_FILE}`
      );
    }
  );

  test("tracked key copies are errors with project-relative subjects only", async () => {
    const root = await tempProject();
    await writeKey({
      path: join(root, KEY_FILE),
      text: generatedKey(),
      mode: 0o600,
    });

    const inspection = await inspect(root, {
      listTrackedKeyPaths: async () => [
        KEY_FILE,
        `config/${KEY_FILE}`,
        `weird\u001b[31mdir/${KEY_FILE}`,
      ],
    });

    expect(inspection.status).toBe("error");
    expect(
      inspection.findings.map((finding) => [finding.code, finding.subject])
    ).toEqual([
      ["env-key-tracked", KEY_FILE],
      ["env-key-tracked", `config/${KEY_FILE}`],
      ["env-key-tracked", `<unprintable-path>/${KEY_FILE}`],
    ]);
    expect(inspection.findings[0]?.remedy).toContain(
      `git rm --cached -- ${KEY_FILE}`
    );
    expect(serialized(inspection)).not.toContain("\u001b");
  });

  test("an unavailable git listing is not reported as tracked", async () => {
    const root = await tempProject();
    await writeKey({
      path: join(root, KEY_FILE),
      text: generatedKey(),
      mode: 0o600,
    });

    const inspection = await inspect(root, {
      listTrackedKeyPaths: () => Promise.reject(new Error("git exploded")),
    });
    expect(codes(inspection)).toEqual(["env-key-ok"]);
  });

  test("a key copy in a public artifact directory is an error", async () => {
    const root = await tempProject();
    const key = generatedKey();
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });
    await mkdir(join(root, "public"));
    await writeKey({
      path: join(root, "public", KEY_FILE),
      text: key,
      mode: 0o600,
    });

    const inspection = await inspect(root);

    expect(inspection.status).toBe("error");
    expect(inspection.findings).toEqual([
      {
        code: "env-key-public-path",
        status: "error",
        subject: `public/${KEY_FILE}`,
        remedy: `rm -- public/${KEY_FILE}, then rotate the key: a published copy is not secret.`,
      },
    ]);
  });

  test("nested monorepo public artifact copies are errors with project-relative subjects", async () => {
    const root = await tempProject();
    const key = generatedKey();
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });
    for (const dir of [
      ["apps", "web", "public"],
      ["packages", "site", "dist"],
      ["apps", "docs", ".next"],
    ]) {
      await mkdir(join(root, ...dir), { recursive: true });
      await writeKey({
        path: join(root, ...dir, KEY_FILE),
        text: key,
        mode: 0o600,
      });
    }

    const inspection = await inspect(root);

    expect(inspection.status).toBe("error");
    expect(
      inspection.findings.map((finding) => [finding.code, finding.subject])
    ).toEqual([
      ["env-key-public-path", `apps/docs/.next/${KEY_FILE}`],
      ["env-key-public-path", `apps/web/public/${KEY_FILE}`],
      ["env-key-public-path", `packages/site/dist/${KEY_FILE}`],
    ]);
    expect(inspection.findings[1]?.remedy).toBe(
      `rm -- apps/web/public/${KEY_FILE}, then rotate the key: a published copy is not secret.`
    );
    expectValueFree({ output: serialized(inspection), root, secrets: [key] });
  });

  test("negative control: the nested walk skips node_modules, .git and symlinked directories", async () => {
    const root = await tempProject();
    const key = generatedKey();
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });
    for (const dir of [
      ["node_modules", "pkg", "dist"],
      [".git", "public"],
      ["apps", "web", "node_modules", "lib", "public"],
      ["outside", "public"],
    ]) {
      await mkdir(join(root, ...dir), { recursive: true });
      await writeKey({
        path: join(root, ...dir, KEY_FILE),
        text: key,
        mode: 0o600,
      });
    }
    await mkdir(join(root, "apps", "linked"), { recursive: true });
    await symlink(
      join(root, "outside", "public"),
      join(root, "apps", "linked", "public")
    );
    // A key directly in a non-artifact directory is not a public copy.
    await writeKey({
      path: join(root, "apps", "web", KEY_FILE),
      text: key,
      mode: 0o600,
    });

    const inspection = await inspect(root);

    expect(
      inspection.findings.map((finding) => [finding.code, finding.subject])
    ).toEqual([["env-key-public-path", `outside/public/${KEY_FILE}`]]);
  });

  test("the nested walk is depth bounded", async () => {
    const root = await tempProject();
    const key = generatedKey();
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });
    const deepest = ["a", "b", "c", "d", "e", "public"];
    const tooDeep = ["a", "b", "c", "d", "e", "f", "public"];
    for (const dir of [deepest, tooDeep]) {
      await mkdir(join(root, ...dir), { recursive: true });
      await writeKey({
        path: join(root, ...dir, KEY_FILE),
        text: key,
        mode: 0o600,
      });
    }

    const inspection = await inspect(root);

    expect(inspection.findings.map((finding) => finding.subject)).toEqual([
      `a/b/c/d/e/public/${KEY_FILE}`,
    ]);
  });

  test("an unprintable nested path is reported without echoing it", async () => {
    const root = await tempProject();
    const key = generatedKey();
    await writeKey({ path: join(root, KEY_FILE), text: key, mode: 0o600 });
    const odd = "we ird$(x)";
    await mkdir(join(root, odd, "public"), { recursive: true });
    await writeKey({
      path: join(root, odd, "public", KEY_FILE),
      text: key,
      mode: 0o600,
    });

    const inspection = await inspect(root);

    expect(inspection.findings).toEqual([
      {
        code: "env-key-public-path",
        status: "error",
        subject: `<unprintable-path>/${KEY_FILE}`,
        remedy:
          "Remove the key copy from the public artifact directory, then rotate the key: a published copy is not secret.",
      },
    ]);
    expect(serialized(inspection)).not.toContain(odd);
  });

  test("findings are ordered most severe first", async () => {
    const root = await tempProject();
    await writeKey({ path: join(root, KEY_FILE), text: "short", mode: 0o644 });

    const inspection = await inspect(root, {
      listTrackedKeyPaths: async () => [KEY_FILE],
    });

    expect(codes(inspection)).toEqual([
      "env-key-tracked",
      "env-key-weak-permissions",
      "env-key-wrong-length",
    ]);
  });

  test("no key anywhere reports env-key-absent", async () => {
    const root = await tempProject();

    const inspection = await inspect(root);
    expect(inspection.status).toBe("ok");
    expect(codes(inspection)).toEqual(["env-key-absent"]);
  });

  test("the HACK_ENV_SECRET_KEY fallback is classified without echoing it", async () => {
    const root = await tempProject();
    const weak = "not-a-real-key";

    const weakInspection = await inspect(root, {
      env: { HACK_ENV_SECRET_KEY: weak },
    });
    expect(weakInspection.findings.map((f) => [f.code, f.subject])).toEqual([
      ["env-key-wrong-length", "$HACK_ENV_SECRET_KEY"],
    ]);
    expectValueFree({
      output: serialized(weakInspection),
      root,
      secrets: [weak],
    });

    const strong = await inspect(root, {
      env: { HACK_ENV_SECRET_KEY: generatedKey() },
    });
    expect(codes(strong)).toEqual(["env-key-ok"]);
  });

  test("a key file takes precedence over the environment fallback", async () => {
    const root = await tempProject();
    await writeKey({
      path: join(root, KEY_FILE),
      text: generatedKey(),
      mode: 0o600,
    });

    const inspection = await inspect(root, {
      env: { HACK_ENV_SECRET_KEY: "weak" },
    });
    expect(codes(inspection)).toEqual(["env-key-ok"]);
  });

  test("shared and primary keys use fixed labels and safe remedies", async () => {
    const root = await tempProject();
    const sharedDir = join(root, "common");
    const primaryDir = join(root, "primary");
    await mkdir(sharedDir);
    await mkdir(primaryDir);
    await writeKey({
      path: join(sharedDir, KEY_FILE),
      text: generatedKey(),
      mode: 0o640,
    });
    await writeKey({
      path: join(primaryDir, KEY_FILE),
      text: generatedKey(),
      mode: 0o604,
    });

    const inspection = await inspect(root, {
      candidates: [
        localCandidate(root),
        { role: "shared", path: join(sharedDir, KEY_FILE) },
        { role: "primary", path: join(primaryDir, KEY_FILE) },
      ],
    });

    expect(inspection.findings).toEqual([
      {
        code: "env-key-weak-permissions",
        status: "warn",
        subject: `<git-common-dir>/${KEY_FILE}`,
        remedy: `chmod 600 "$(git rev-parse --git-common-dir)/${KEY_FILE}"`,
      },
      {
        code: "env-key-weak-permissions",
        status: "warn",
        subject: `<primary-checkout>/${KEY_FILE}`,
        remedy:
          "Run 'hack doctor' in the primary checkout and follow its env key guidance.",
      },
    ]);
    expectValueFree({ output: serialized(inspection), root, secrets: [] });
  });

  test("permission and ownership checks are skipped without a POSIX uid", async () => {
    const root = await tempProject();
    await writeKey({
      path: join(root, KEY_FILE),
      text: generatedKey(),
      mode: 0o644,
    });

    expect(codes(await inspect(root, { uid: null }))).toEqual(["env-key-ok"]);
  });

  test("doctor JSON carries the closed envKey payload", async () => {
    const root = await tempProject();
    await writeKey({
      path: join(root, KEY_FILE),
      text: generatedKey(),
      mode: 0o644,
    });
    const check = envKeyCheckResult(await inspect(root));

    const data = buildDoctorJsonData({
      results: [{ ...check, durationMs: 3 }],
    });

    expect(data.checks[0]?.id).toBe("env key");
    expect(data.checks[0]?.status).toBe("warn");
    expect(data.checks[0]?.detail).toContain("env-key-weak-permissions");
    expect(data.checks[0]?.envKey?.findings.map((f) => f.code)).toEqual([
      "env-key-weak-permissions",
    ]);
  });
});

describe("classifyEnvKeyText", () => {
  test("accepts generated keys and other 256-bit encodings", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(classifyEnvKeyText(generatedKey())).toBeNull();
      expect(classifyEnvKeyText(randomBytes(32).toString("base64"))).toBeNull();
      expect(classifyEnvKeyText(randomBytes(32).toString("hex"))).toBeNull();
    }
  });

  test("rejects short and repetitive text", () => {
    expect(classifyEnvKeyText("")).toBe("env-key-wrong-length");
    expect(classifyEnvKeyText(generatedKey().slice(0, 42))).toBe(
      "env-key-wrong-length"
    );
    expect(classifyEnvKeyText("a".repeat(64))).toBe("env-key-low-entropy");
    expect(classifyEnvKeyText("abcdefg".repeat(10))).toBe(
      "env-key-low-entropy"
    );
  });
});

describe("gitListTrackedKeyPaths", () => {
  test("lists tracked key copies at any depth in a temp repository", async () => {
    const root = await tempProject();
    const gitEnv = {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = async (args: readonly string[]) => {
      const proc = Bun.spawn(["git", "-C", root, ...args], {
        env: gitEnv,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await proc.exited).toBe(0);
    };
    await git(["init", "-q"]);
    await mkdir(join(root, "nested", "deeper"), { recursive: true });
    await writeFile(join(root, KEY_FILE), "x");
    await writeFile(join(root, "nested", "deeper", KEY_FILE), "x");
    await writeFile(join(root, "nested", `not${KEY_FILE}`), "x");
    await git(["add", "-f", "--", "."]);

    expect(await gitListTrackedKeyPaths({ projectRoot: root })).toEqual([
      KEY_FILE,
      `nested/deeper/${KEY_FILE}`,
    ]);
  });

  test("returns null outside a git work tree", async () => {
    const root = await tempProject();
    expect(await gitListTrackedKeyPaths({ projectRoot: root })).toBeNull();
  });
});
