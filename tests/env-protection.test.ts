import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjectEnvPlaintextEntries,
  protectProjectEnvEntries,
  resolveProjectEnvConfig,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const SENTINEL = "synthetic-protection-value";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "hack-protect-"));
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "hack.config.json"), '{"name":"fixture"}\n');
  const layers = {
    "hack.env.default.yaml": `version: 1\nsecretsprovider: project_key\nvalues:\n  global:\n    TOKEN: ${SENTINEL}-base\n    KEEP: unchanged\n    FLAG: true\n    EMPTY: ""\n  app:\n    TOKEN: ${SENTINEL}-service\n`,
    "hack.env.qa.yaml": `version: 1\nsecretsprovider: project_key\nenvironment: qa\nvalues:\n  global:\n    TOKEN: ${SENTINEL}-overlay\n`,
    "hack.env.local.yaml": `version: 1\nsecretsprovider: project_key\nvalues:\n  global:\n    TOKEN: ${SENTINEL}-local\n`,
    "hack.env.qa.local.yaml": `version: 1\nsecretsprovider: project_key\nenvironment: qa\nvalues:\n  app:\n    TOKEN: ${SENTINEL}-overlay-local\n    ABSENT: null\n`,
  };
  for (const [file, text] of Object.entries(layers)) {
    await writeFile(join(projectDir, file), text);
  }
  return { projectRoot, projectDir };
}
async function resolved(
  options: { projectRoot: string; projectDir: string },
  envName: string | null
) {
  const value = await resolveProjectEnvConfig({
    ...options,
    envName,
    serviceNames: ["app"],
  });
  return { global: value?.globalEnv, service: value?.serviceEnv };
}

test("inventory contains only names and metadata and protect preserves values/scopes/layers", async () => {
  const options = await fixture();
  const saved = process.env.HACK_ENV_SECRET_KEY;
  process.env.HACK_ENV_SECRET_KEY = "synthetic-environment-only-protection-key";
  try {
    const inventory = await listProjectEnvPlaintextEntries(options);
    expect(inventory.filter((entry) => entry.key === "TOKEN")).toHaveLength(5);
    expect(JSON.stringify(inventory)).not.toContain(SENTINEL);
    expect(inventory.some((entry) => entry.key === "ABSENT")).toBe(false);
    const before = await Promise.all([
      resolved(options, null),
      resolved(options, "qa"),
    ]);
    const changed = await protectProjectEnvEntries({
      ...options,
      targets: [{ key: "TOKEN" }, { key: "FLAG" }, { key: "EMPTY" }],
    });
    expect(changed).toHaveLength(7);
    expect(
      await Promise.all([resolved(options, null), resolved(options, "qa")])
    ).toEqual(before);
    for (const file of [...new Set(changed.map((entry) => entry.filePath))]) {
      expect(await readFile(file, "utf8")).not.toContain(SENTINEL);
      expect(await readFile(file, "utf8")).toContain("secure:");
    }
    expect(
      await Bun.file(join(options.projectRoot, ".hack.secret.key")).exists()
    ).toBe(false);
    const bytes = await readFile(
      join(options.projectDir, "hack.env.default.yaml"),
      "utf8"
    );
    expect(
      await protectProjectEnvEntries({
        ...options,
        targets: [{ key: "TOKEN" }, { key: "FLAG" }, { key: "EMPTY" }],
      })
    ).toEqual([]);
    expect(
      await readFile(join(options.projectDir, "hack.env.default.yaml"), "utf8")
    ).toBe(bytes);
    expect(
      (await listProjectEnvPlaintextEntries(options)).map((entry) => entry.key)
    ).toEqual(["KEEP"]);
  } finally {
    restoreEnv("HACK_ENV_SECRET_KEY", saved);
  }
});

test("protection restricts overlay and scope and does not overwrite a concurrent writer", async () => {
  const options = await fixture();
  const saved = process.env.HACK_ENV_SECRET_KEY;
  process.env.HACK_ENV_SECRET_KEY = "synthetic-protection-key";
  try {
    const before = await readFile(
      join(options.projectDir, "hack.env.default.yaml"),
      "utf8"
    );
    await Promise.all([
      protectProjectEnvEntries({
        ...options,
        envName: "qa",
        targets: [{ key: "TOKEN", scope: "app" }],
      }),
      setProjectEnvValue({
        ...options,
        envName: "qa",
        scope: "app",
        key: "CONCURRENT",
        value: "preserved",
        secret: false,
        local: true,
      }),
    ]);
    expect(
      await readFile(join(options.projectDir, "hack.env.default.yaml"), "utf8")
    ).toBe(before);
    expect(
      (
        await listProjectEnvPlaintextEntries({ ...options, envName: "qa" })
      ).some((entry) => entry.key === "TOKEN" && entry.scope === "global")
    ).toBe(true);
    expect(
      (
        await listProjectEnvPlaintextEntries({ ...options, envName: "qa" })
      ).some((entry) => entry.key === "TOKEN" && entry.scope === "app")
    ).toBe(false);
    const state = await resolveProjectEnvConfig({
      ...options,
      envName: "qa",
      serviceNames: ["app"],
    });
    expect(state?.serviceEnv.app?.CONCURRENT).toBe("preserved");
    expect(state?.serviceEnv.app?.TOKEN).toBe(`${SENTINEL}-overlay-local`);
  } finally {
    restoreEnv("HACK_ENV_SECRET_KEY", saved);
  }
});

test("a malformed layer refuses all protection before another layer changes", async () => {
  const options = await fixture();
  const path = join(options.projectDir, "hack.env.default.yaml");
  const before = await readFile(path, "utf8");
  await writeFile(
    join(options.projectDir, "hack.env.qa.yaml"),
    `broken: [${SENTINEL}`
  );
  const error = await protectProjectEnvEntries({
    ...options,
    targets: [{ key: "TOKEN" }],
  }).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(SENTINEL);
  expect(await readFile(path, "utf8")).toBe(before);
});

test("protection uses the encryption owner's refusal for a tracked key", async () => {
  const options = await fixture();
  const saved = process.env.HACK_ENV_SECRET_KEY;
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  try {
    const keyPath = join(options.projectRoot, ".hack.secret.key");
    await writeFile(keyPath, "synthetic-tracked-protection-key\n");
    for (const args of [
      ["init", "--quiet"],
      ["add", "-f", ".hack.secret.key"],
    ]) {
      const child = Bun.spawn(["git", ...args], {
        cwd: options.projectRoot,
        env: fixtureGitEnv(),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
    }
    const file = join(options.projectDir, "hack.env.default.yaml");
    const before = await readFile(file, "utf8");
    const error = await protectProjectEnvEntries({
      ...options,
      targets: [{ key: "TOKEN" }],
    }).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("tracked");
    expect(String(error)).not.toContain("synthetic-tracked-protection-key");
    expect(await readFile(file, "utf8")).toBe(before);
  } finally {
    restoreEnv("HACK_ENV_SECRET_KEY", saved);
  }
});
