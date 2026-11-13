import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  looseEnvLayerWarning,
  reportLooseEnvLayerModes,
} from "../src/lib/env-layer-modes.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SENTINEL = "synthetic-loose-layer-value";

test("loose machine-local env files are reported once, by name and mode only (HACK-2165)", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "hack-layer-modes-"));
  dirs.push(projectDir);
  const files: [string, number][] = [
    ["hack.env.local.yaml", 0o644],
    ["hack.env.qa.local.yaml", 0o600],
    [".env", 0o640],
    [".env.state.json", 0o644],
    ["hack.env.default.yaml", 0o644],
    // Committed templates hold no values and are never reported.
    [".env.example", 0o644],
    [".env.sample", 0o644],
  ];
  for (const [name, mode] of files) {
    await writeFile(join(projectDir, name), `KEY=${SENTINEL}\n`, { mode });
  }
  const written: string[] = [];
  const write = (text: string) => written.push(text);
  await reportLooseEnvLayerModes({ projectDir, write });
  expect(written).toEqual([
    looseEnvLayerWarning({ name: ".env", mode: 0o640 }),
    looseEnvLayerWarning({ name: "hack.env.local.yaml", mode: 0o644 }),
  ]);
  expect(written.join("")).not.toContain(SENTINEL);
  expect(written[1]).toContain("mode 0644");

  await reportLooseEnvLayerModes({ projectDir, write });
  expect(written).toHaveLength(2);
});

test("a loose layer's name never reaches a copyable command or the terminal raw (HACK-2165)", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "hack-layer-modes-names-"));
  dirs.push(projectDir);
  const shell = "hack.env.;printf PWNED>proof;.local.yaml";
  const withEscape = "hack.env.\u001b[31mred.local.yaml";
  for (const name of [shell, withEscape]) {
    await writeFile(join(projectDir, name), "x: 1\n", { mode: 0o644 });
  }
  const written: string[] = [];
  await reportLooseEnvLayerModes({
    projectDir,
    write: (text) => written.push(text),
  });
  const output = written.join("");
  expect(output).not.toContain("chmod");
  expect(output).toContain("hack doctor --fix");
  expect(output).not.toContain("\u001b");
  expect(output).toContain("\\u{1b}[31mred");
});
