#!/usr/bin/env bun
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

/** Exercises a relocated compiled CLI + sidecar without source/Bun/Rust on PATH. */
const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "hack-config-cli-acceptance-"));
try {
  const bundle = join(directory, "bundle");
  const home = join(directory, "home");
  const cwd = join(directory, "checkout");
  await Promise.all([mkdir(bundle), mkdir(home), mkdir(cwd)]);
  for (const name of ["hack", "hack-config-compiler"]) {
    await copyFile(join(root, "dist", name), join(bundle, name));
  }
  const project = {
    schema_version: 1,
    name: "cli-fixture",
    services: {
      web: {
        image: "example/web:1",
        environment: { TOKEN: { env_ref: "TOKEN" } },
      },
    },
  };
  const file = join(cwd, "project.json");
  await Bun.write(file, JSON.stringify(project));
  const valid = await invoke(["config", "validate", "--file", file, "--json"]);
  const success: unknown = JSON.parse(valid.stdout);
  require(valid.exit === 0 &&
    isRecord(success) &&
    success.ok === true &&
    isRecord(success.plan), "real compiler success");
  require(valid.stdout.includes('"env_ref": "TOKEN"') &&
    !valid.stdout.includes(
      "private-credential-sentinel"
    ), "symbolic references");
  await Bun.write(
    file,
    '{"schema_version":1,"name":"cli-fixture","name":"private-credential-sentinel"}'
  );
  const invalid = await invoke([
    "config",
    "validate",
    "--file",
    file,
    "--json",
  ]);
  const failure: unknown = JSON.parse(invalid.stdout);
  require(invalid.exit === 1 &&
    isRecord(failure) &&
    failure.ok === false &&
    Array.isArray(failure.diagnostics) &&
    isRecord(failure.diagnostics[0]) &&
    failure.diagnostics[0].code ===
      "duplicate_key", "real compiler diagnostic forwarding");
  require(!(
    invalid.stdout.includes("private-credential-sentinel") ||
    invalid.stderr.includes("private-credential-sentinel")
  ), "diagnostic redaction");
  const usage = await invoke(["config", "validate", "--json"]);
  require(usage.exit !== 0 &&
    (usage.stdout + usage.stderr).includes(
      "--file"
    ), "explicit file selection");
  await rm(join(bundle, "hack-config-compiler"));
  const missing = await invoke([
    "config",
    "validate",
    "--file",
    file,
    "--json",
  ]);
  const missingResult: unknown = JSON.parse(missing.stdout);
  require(missing.exit === 1 &&
    isRecord(missingResult) &&
    isRecord(missingResult.error) &&
    missingResult.error.code ===
      "E_COMPILER_MISSING", "missing bundle refusal");
  require((await readdir(home)).length === 0 &&
    JSON.stringify(await readdir(cwd)) ===
      '["project.json"]', "no registry, env, or generated runtime state");
  process.stdout.write(
    "Relocated compiled CLI acceptance: success, diagnostics, symbolic env, explicit file, missing sidecar, no state writes passed\n"
  );

  async function invoke(args: readonly string[]) {
    const child = Bun.spawn([join(bundle, "hack"), ...args], {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        HACK_LOGGER: "console",
        AWS_SECRET_ACCESS_KEY: "private-credential-sentinel",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

function require(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Native configuration CLI acceptance failed: ${label}`);
  }
}
