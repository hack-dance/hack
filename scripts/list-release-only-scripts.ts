#!/usr/bin/env bun
/**
 * List literal repo script entry points used only by release.yml and its
 * reusable workflows. Reads workflow run blocks, local actions and Bun
 * package aliases. Shell substitutions and scripts called from other scripts
 * are outside this inventory.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

const ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS = ".github/workflows";
const RELEASE = `${WORKFLOWS}/release.yml`;
const YAML_FILE = /\.ya?ml$/;
const SCRIPT =
  /(?:^|[;&|][ \t]*|(?:\b(?:bun(?:[ \t]+run)?|bash|sh|python3?|node)|--)[ \t]+)[ \t"']*(?:\.\/|\$\{?\w+\}?\/)?(scripts\/[\w./-]+)(?=$|[\s"';&|])/gm;
const ALIAS =
  /\bbun[ \t]+run[ \t]+(?:--cwd[ \t]+([\w./-]+)[ \t]+)?([\w:-]+)(?=$|[\s;&|])/gm;
const COMMENT = /^[ \t]*#.*$/gm;

function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(objects);
  }
  return isRecord(value)
    ? [value, ...Object.values(value).flatMap(objects)]
    : [];
}

async function readAlias(packageDir: string, name: string): Promise<unknown> {
  const manifest = Bun.file(join(packageDir, "package.json"));
  const pkg: unknown = (await manifest.exists()) ? await manifest.json() : null;
  return isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts[name] : undefined;
}

async function collect(root: string, entrypoints: readonly string[]) {
  const scripts = new Set<string>();
  const workflows = new Set<string>();
  const visited = new Set<string>();
  const aliases = new Set<string>();

  async function run(source: string, cwd = "."): Promise<void> {
    const command = source.replace(COMMENT, "");
    for (const [, path] of command.matchAll(SCRIPT)) {
      if (path) {
        scripts.add(path);
      }
    }
    for (const [, directory, name] of command.matchAll(ALIAS)) {
      const packageDir = directory ? join(cwd, directory) : cwd;
      const key = `${packageDir}:${name}`;
      if (!name || aliases.has(key)) {
        continue;
      }
      aliases.add(key);
      const script = await readAlias(join(root, packageDir), name);
      if (typeof script === "string") {
        await run(script, packageDir);
      }
    }
  }

  async function visit(path: string): Promise<void> {
    if (visited.has(path)) {
      return;
    }
    visited.add(path);
    if (path.startsWith(`${WORKFLOWS}/`)) {
      workflows.add(path);
    }
    const yaml: unknown = Bun.YAML.parse(
      await Bun.file(join(root, path)).text()
    );
    for (const { run: command, uses } of objects(yaml)) {
      if (typeof command === "string") {
        await run(command);
      }
      if (typeof uses !== "string" || !uses.startsWith("./")) {
        continue;
      }
      const relative = uses.slice(2);
      const path = YAML_FILE.test(relative)
        ? relative
        : join(relative, "action.yml");
      if (await Bun.file(join(root, path)).exists()) {
        await visit(path);
      }
    }
  }

  for (const path of entrypoints) {
    await visit(path);
  }
  return { scripts, workflows };
}

export async function listReleaseOnlyScripts(root = ROOT): Promise<string[]> {
  const release = await collect(root, [RELEASE]);
  const other = await collect(
    root,
    (await readdir(join(root, WORKFLOWS)))
      .filter((name) => YAML_FILE.test(name))
      .map((name) => join(WORKFLOWS, name))
      .filter((path) => !release.workflows.has(path))
  );
  return [...release.scripts].filter((path) => !other.scripts.has(path)).sort();
}

if (import.meta.main) {
  for (const path of await listReleaseOnlyScripts()) {
    console.log(path);
  }
}
