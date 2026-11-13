import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { envParseDiagnostic } from "../src/lib/env-parse-diagnostic.ts";
import { readHackEnvContract } from "../src/lib/hack-env.ts";
import {
  resolveProjectEnvConfig,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const SENTINEL = "synthetic-parser-value-sentinel";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-env-parse-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "hack.config.json"), '{"name":"fixture"}\n');
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  app:\n    image: alpine:3.22\n"
  );
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    "version: 1\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  return { root, projectDir };
}

for (const format of ["YAML", "JSON"] as const) {
  test(`${format} diagnostics preserve coordinates without source text`, () => {
    const text =
      format === "YAML"
        ? `values:\n  global: [${SENTINEL}\n`
        : `{\n "TOKEN": "${SENTINEL}" invalid\n}`;
    const message = envParseDiagnostic({ format, text });
    expect(message).toMatch(
      new RegExp(`^Invalid ${format} syntax at line \\d+, column \\d+$`)
    );
    expect(message).not.toContain(SENTINEL);
  });
}

for (const layer of [
  "hack.env.default.yaml",
  "hack.env.qa.yaml",
  "hack.env.local.yaml",
  "hack.env.qa.local.yaml",
]) {
  test(`malformed ${layer} is redacted in resolution, writes and CLI text/JSON`, async () => {
    const { root, projectDir } = await fixture();
    const path = join(projectDir, layer);
    await writeFile(path, `version: 1\nvalues:\n  global: [${SENTINEL}\n`);
    for (const operation of [
      () =>
        resolveProjectEnvConfig({
          projectRoot: root,
          projectDir,
          envName: "qa",
          serviceNames: ["app"],
        }),
      () =>
        setProjectEnvValue({
          projectRoot: root,
          projectDir,
          envName: layer.includes("qa") ? "qa" : null,
          scope: "global",
          key: "TOKEN",
          value: "replacement",
          secret: false,
          local: layer.includes("local"),
        }),
    ]) {
      const error = await operation().then(
        () => null,
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(SENTINEL);
      expect(String(error)).toContain(path);
    }
    for (const json of [false, true]) {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "..", "index.ts"),
          "env",
          "list",
          "--env",
          "qa",
          ...(json ? ["--json"] : []),
        ],
        {
          cwd: root,
          env: privateCliEnv({ root }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).not.toContain(SENTINEL);
      expect(stdout + stderr).toContain(path);
      if (json) {
        expect(() => JSON.parse(stdout)).not.toThrow();
      }
    }
  });
}

test("legacy contract JSON parse diagnostics carry no source value", async () => {
  const { projectDir } = await fixture();
  await writeFile(
    join(projectDir, "hack.env.json"),
    `{\n "vars": ["${SENTINEL}"\n}`
  );
  const result = await readHackEnvContract({ projectDir });
  expect(result.parseError).toMatch(
    /^Invalid JSON syntax at line \d+, column \d+$/
  );
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
});
