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
      "E_NATIVE_PROJECT_UNSUPPORTED"
    ), "no native project refuses");
  await mkdir(join(cwd, ".hack"));
  const native = join(cwd, ".hack/hack.project.json");
  const local = join(cwd, ".hack/hack.local.json");
  await Bun.write(
    native,
    JSON.stringify({ ...project, environment: { default_overlay: "qa" } })
  );
  const projectDefault = await resolved([], "qa", "project");
  await Bun.write(
    local,
    '{"schema_version":1,"environment":{"default_overlay":null}}'
  );
  const localBase = await resolved([], null, "checkout_local");
  require(projectDefault.semantic_hash === localBase.semantic_hash &&
    projectDefault.local_resolution.resolution_hash !==
      localBase.local_resolution
        .resolution_hash, "separate local and authored identities");
  await resolved(["--env", "dev"], "dev", "explicit");
  await resolved(["--env", "base"], null, "explicit");
  await Bun.write(
    local,
    '{"schema_version":1,"environment":{"default_overlay":"qa","default_overlay":"private-credential-sentinel"}}'
  );
  const duplicateLocal = await invoke(["config", "validate", "--json"]);
  const localFailure: unknown = JSON.parse(duplicateLocal.stdout);
  require(duplicateLocal.exit === 1 &&
    isRecord(localFailure) &&
    Array.isArray(localFailure.diagnostics) &&
    isRecord(localFailure.diagnostics[0]) &&
    localFailure.diagnostics[0].code === "duplicate_key" &&
    localFailure.diagnostics[0].document === "checkout_local" &&
    !(duplicateLocal.stdout + duplicateLocal.stderr).includes(
      "private-credential-sentinel"
    ), "local duplicate key and document-role redaction");
  const contextFree = await invoke([
    "config",
    "validate",
    "--file",
    native,
    "--json",
  ]);
  require(contextFree.exit === 0 &&
    !(
      "local_resolution" in JSON.parse(contextFree.stdout)
    ), "explicit file remains context-free with invalid local settings");
  await Bun.write(
    local,
    '\ufeff{"schema_version":1,"environment":{"default_overlay":null}}'
  );
  const bom = await invoke(["config", "validate", "--json"]);
  const bomFailure: unknown = JSON.parse(bom.stdout);
  require(bom.exit === 1 &&
    isRecord(bomFailure) &&
    Array.isArray(bomFailure.diagnostics) &&
    isRecord(bomFailure.diagnostics[0]) &&
    bomFailure.diagnostics[0].code === "invalid_json" &&
    bomFailure.diagnostics[0].document ===
      "checkout_local", "BOM preserved for Rust refusal");
  await Bun.write(
    local,
    '{"schema_version":1,"environment":{"default_overlay":"shared"}}'
  );
  await git(["init", "--quiet"], cwd);
  await git(["add", ".hack/hack.project.json"], cwd);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    cwd
  );
  const worktree = join(directory, "worktree");
  await git(
    ["worktree", "add", "--quiet", "-b", "fixture-linked", worktree],
    cwd
  );
  await resolved([], "shared", "primary_local", worktree);
  await Bun.write(
    join(worktree, ".hack/hack.local.json"),
    '{"schema_version":1,"environment":{"default_overlay":null}}'
  );
  await resolved([], null, "checkout_local", worktree);
  await resolved(["--env", "qa"], "qa", "explicit", worktree);
  await Bun.write(
    native,
    JSON.stringify({ ...project, worktree: { inherit_local: false } })
  );
  await resolved([], "shared", "checkout_local");
  await Bun.write(
    join(worktree, ".hack/hack.project.json"),
    JSON.stringify({ ...project, worktree: { inherit_local: false } })
  );
  await rm(join(worktree, ".hack/hack.local.json"));
  await resolved([], null, "project", worktree);
  await Bun.write(join(cwd, ".hack/hack.config.json"), "{}\n");
  const mixed = await invoke(["config", "validate", "--json"]);
  require(mixed.exit === 1 &&
    JSON.parse(mixed.stdout).error.code ===
      "E_NATIVE_PROJECT_CONFLICT", "mixed input refuses project-aware validation");
  await rm(join(cwd, ".hack/hack.config.json"));
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
    JSON.stringify((await readdir(join(cwd, ".hack"))).sort()) ===
      '["hack.local.json","hack.project.json"]' &&
    JSON.stringify((await readdir(join(worktree, ".hack"))).sort()) ===
      '["hack.project.json"]', "no registry, env, or generated runtime state");
  process.stdout.write(
    "Relocated compiled CLI acceptance: explicit/project validation, local tri-state, linked-worktree precedence/opt-out, separate hashes, role diagnostics, mixed/missing-sidecar refusal, symbolic env and no state writes passed\n"
  );

  async function invoke(args: readonly string[], selectedCwd = cwd) {
    const child = Bun.spawn([join(bundle, "hack"), ...args], {
      cwd: selectedCwd,
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

  async function resolved(
    args: readonly string[],
    overlay: string | null,
    origin: string,
    selectedCwd = cwd
  ) {
    const result = await invoke(
      ["config", "validate", ...args, "--json"],
      selectedCwd
    );
    const value: unknown = JSON.parse(result.stdout);
    require(result.exit === 0 &&
      isRecord(value) &&
      isRecord(value.local_resolution) &&
      typeof value.semantic_hash === "string" &&
      typeof value.local_resolution.resolution_hash === "string" &&
      value.ok === true &&
      value.local_resolution.overlay === overlay &&
      value.local_resolution.origin ===
        origin, "project-aware overlay precedence");
    return {
      semantic_hash: value.semantic_hash,
      local_resolution: {
        resolution_hash: value.local_resolution.resolution_hash,
      },
    };
  }

  async function git(args: readonly string[], selectedCwd: string) {
    const child = Bun.spawn(["/usr/bin/git", "-C", selectedCwd, ...args], {
      env: { PATH: "/usr/bin:/bin", HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    require(exit === 0, `isolated Git fixture: ${stderr}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

function require(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Native configuration CLI acceptance failed: ${label}`);
  }
}
