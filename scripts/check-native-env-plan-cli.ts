#!/usr/bin/env bun
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

/** Real compiled CLI/sidecar, isolated HOME and Git worktrees, no source or toolchain on PATH. */
const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "hack-env-plan-cli-"));
const bundle = join(directory, "bundle");
const home = join(directory, "home");
const primary = join(directory, "primary");
const sentinel = "private-synthetic-managed-value";
const secret = { secure: `invalid-ciphertext-${sentinel}` };
const project = {
  schema_version: 1,
  name: "env-plan-fixture",
  profiles: ["dev"],
  environment: { default_overlay: "qa" },
  services: {
    web: {
      image: "example/web:1",
      environment: {
        TOKEN: { env_ref: "TOKEN" },
        COPY: { env_ref: "SOURCE" },
        PUBLIC: { literal: "authored public text" },
        FALLBACK: { default: "authored fallback" },
        EMPTY: { default: "must not replace empty" },
        ERASE: { unset: true },
        ["__proto__"]: { literal: "authored own binding" },
      },
    },
    host: { image: "example/host:1" },
    optional: {
      image: "example/optional:1",
      profiles: ["dev"],
      environment: { REQUIRED: { env_ref: "ABSENT" } },
    },
  },
  jobs: {
    init: {
      image: "example/init:1",
      environment: { JOB: { env_ref: "JOB" } },
    },
  },
};
try {
  await Promise.all([
    mkdir(bundle),
    mkdir(home),
    mkdir(join(primary, ".hack"), { recursive: true }),
  ]);
  for (const name of ["hack", "hack-config-compiler"]) {
    await copyFile(join(root, "dist", name), join(bundle, name));
  }
  const authored = join(primary, ".hack/hack.project.json");
  await Bun.write(authored, JSON.stringify(project));
  // These sentinels must never be opened by validation/planning.
  await mkdir(join(primary, ".hack/.hack.secret.key"));
  await Bun.write(join(primary, ".hack/.env"), `UNMANAGED=${sentinel}`);
  const base = join(primary, ".hack/hack.env.default.yaml");
  await Bun.write(base, `invalid: [${sentinel}`);
  const offline = await invoke(["config", "validate", "--json"]);
  require(offline.exit === 0 &&
    offline.value.ok === true, "validation does not parse managed YAML");
  await refused([], "E_CONFIG_METADATA");
  await layer(primary, "hack.env.default.yaml", {
    global: { TOKEN: secret, SOURCE: secret, EMPTY: "", ERASE: secret },
    init: { JOB: secret },
    host: { HOST_ONLY: secret },
    retired: { OLD: secret },
  });
  const first = await planned();
  const report = record(first.value.environment_plan);
  const workloads = record(report.workloads);
  const web = record(workloads.web);
  require(report.complete === true &&
    report.overlay_exists === false &&
    JSON.stringify(report.warnings).includes("missing_overlay") &&
    JSON.stringify(report.warnings).includes(
      "inactive_env_scope"
    ), "missing overlay fallback and inactive scope warnings");
  require(record(web.TOKEN).secret === true &&
    record(web.COPY).key === "SOURCE" &&
    record(web.EMPTY).kind === "managed" &&
    record(web.FALLBACK).kind === "default" &&
    record(web.PUBLIC).value === "authored public text" &&
    !Object.hasOwn(web, "ERASE") &&
    !Object.hasOwn(
      web,
      "HOST_ONLY"
    ), "immutable baseline, empty presence, literal/default/unset and host separation");
  require(Object.hasOwn(web, "__proto__") &&
    record(web.__proto__).value ===
      "authored own binding", "prototype-named authored destination survives report projection");
  require(record(record(workloads.host).HOST_ONLY).scope === "host" &&
    record(record(workloads.init).JOB).scope === "init" &&
    !Object.hasOwn(workloads, "optional") &&
    record(first.value.declared_workloads).optional ===
      "service", "jobs, inactive declarations and workload named host");
  require(first.value.semantic_hash === offline.value.semantic_hash &&
    record(first.value.local_resolution).resolution_hash ===
      record(offline.value.local_resolution)
        .resolution_hash, "metadata leaves both identities unchanged");
  await layer(primary, "hack.env.default.yaml", {
    global: {
      TOKEN: `${sentinel}-changed`,
      SOURCE: secret,
      EMPTY: "",
      ERASE: secret,
    },
    init: { JOB: secret },
    host: { HOST_ONLY: secret },
    retired: { OLD: secret },
  });
  const changed = await planned();
  require(record(record(record(changed.value.environment_plan).workloads).web)
    .TOKEN !== undefined &&
    changed.value.semantic_hash === first.value.semantic_hash &&
    record(changed.value.local_resolution).resolution_hash ===
      record(first.value.local_resolution)
        .resolution_hash, "changed managed values cannot change identities");
  await layer(primary, "hack.env.qa.yaml", { global: { TOKEN: null } }, "qa");
  const tombstone = await planned([], primary, false);
  require(JSON.stringify(
    record(tombstone.value.environment_plan).diagnostics
  ).includes(
    "missing_env_reference"
  ), "tombstone removes a required baseline key");
  await rm(join(primary, ".hack/hack.env.qa.yaml"));
  const inactive = await planned(["--profile", "dev"], primary, false);
  require(JSON.stringify(
    record(inactive.value.environment_plan).diagnostics
  ).includes(
    "/services/optional/environment/REQUIRED"
  ), "selected profile enforces required references");
  await layer(primary, "hack.env.local.yaml", {
    web: { COPY: "existing destination" },
  });
  const collision = await planned([], primary, false);
  require(JSON.stringify(
    record(collision.value.environment_plan).diagnostics
  ).includes(
    "env_reference_collision"
  ), "remap into an existing managed destination refuses");
  await rm(join(primary, ".hack/hack.env.local.yaml"));
  await git(["init", "--quiet"], primary);
  await git(
    ["add", ".hack/hack.project.json", ".hack/hack.env.default.yaml"],
    primary
  );
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    primary
  );
  const checkout = join(directory, "linked");
  await git(
    ["worktree", "add", "--quiet", "-b", "fixture-linked", checkout],
    primary
  );
  await layer(primary, "hack.env.local.yaml", {
    web: { TOKEN: secret, PRIMARY: secret },
  });
  await layer(
    primary,
    "hack.env.qa.local.yaml",
    { web: { SOURCE: secret } },
    "qa"
  );
  await layer(checkout, "hack.env.local.yaml", { web: { TOKEN: "" } });
  await layer(
    checkout,
    "hack.env.qa.local.yaml",
    { web: { CURRENT: secret } },
    "qa"
  );
  const inherited = await planned([], checkout);
  const inheritedWeb = record(
    record(record(inherited.value.environment_plan).workloads).web
  );
  require(record(inheritedWeb.TOKEN).secret === false &&
    Object.hasOwn(inheritedWeb, "PRIMARY") &&
    Object.hasOwn(inheritedWeb, "CURRENT") &&
    record(inheritedWeb.COPY).scope ===
      "web", "six-layer linked-worktree precedence");
  const ci = await planned([], checkout, true, { CI: "1" });
  const slim = await planned([], checkout, true, {
    HACK_EXECUTION_MODE: "codex",
  });
  for (const excluded of [ci, slim]) {
    require(!Object.hasOwn(
      record(record(record(excluded.value.environment_plan).workloads).web),
      "PRIMARY"
    ), "CI/slim excludes primary metadata");
  }
  await Bun.write(
    join(checkout, ".hack/hack.project.json"),
    JSON.stringify({ ...project, worktree: { inherit_local: false } })
  );
  const optedOut = await planned([], checkout);
  require(!Object.hasOwn(
    record(record(record(optedOut.value.environment_plan).workloads).web),
    "PRIMARY"
  ), "authored opt-out excludes primary metadata");
  await Bun.write(
    join(checkout, ".hack/hack.project.json"),
    JSON.stringify(project)
  );
  const selectedBase = await planned(["--env", "base"], checkout);
  require(record(selectedBase.value.environment_plan).overlay === null &&
    !Object.hasOwn(
      record(record(record(selectedBase.value.environment_plan).workloads).web),
      "CURRENT"
    ), "explicit base excludes named local layer");
  await Bun.write(
    join(checkout, ".hack/hack.local.json"),
    '{"schema_version":1,"environment":{"default_overlay":"other"}}'
  );
  const localSelected = await planned([], checkout);
  require(record(localSelected.value.environment_plan).overlay === "other" &&
    JSON.stringify(
      record(localSelected.value.environment_plan).warnings
    ).includes(
      "checkout_local"
    ), "missing-overlay warning identifies local origin");
  await rm(join(checkout, ".hack/hack.local.json"));
  await rm(join(checkout, ".hack/hack.env.qa.local.yaml"));
  await symlink(base, join(checkout, ".hack/hack.env.qa.local.yaml"));
  await refused([], "E_CONFIG_METADATA", checkout);
  await rm(join(checkout, ".hack/hack.env.qa.local.yaml"));
  await Bun.write(join(checkout, ".hack/hack.config.json"), "{}");
  await refused([], "E_NATIVE_PROJECT_CONFLICT", checkout);
  await rm(join(checkout, ".hack/hack.config.json"));
  const unsupported = await invoke(["up", "--detach", "--json"], checkout, {
    HACK_RUNTIME_BACKEND: "native",
  });
  require(unsupported.exit !== 0 &&
    (unsupported.stdout + unsupported.stderr).includes(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    ), "unsupported native detached up refuses before input or runtime work");
  require((await readdir(home)).length === 0 &&
    !(await readdir(join(checkout, ".hack"))).some(
      (name) => name === ".internal" || name === ".branch"
    ), "no registry or generated runtime state");
  process.stdout.write(
    "Relocated native env plan acceptance: offline validation, metadata-only output, missing overlays/refs, immutable directives, separate hashes, real linked-worktree layers, CI/slim/opt-out, unsafe-input and runtime refusal passed\n"
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function invoke(
  args: readonly string[],
  cwd = primary,
  extraEnv: Readonly<Record<string, string>> = {}
) {
  const child = Bun.spawn([join(bundle, "hack"), ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      HACK_LOGGER: "console",
      AWS_SECRET_ACCESS_KEY: sentinel,
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    require(!(
      (stdout + stderr).includes(sentinel) ||
      (stdout + stderr).includes(directory)
    ), "redacted managed values and private paths");
    let value: Record<string, unknown> = {};
    if (args[0] === "config") {
      value = record(JSON.parse(stdout));
    }
    return { stdout, stderr, exit, value };
  } finally {
    clearTimeout(timer);
  }
}

async function planned(
  args: readonly string[] = [],
  cwd = primary,
  complete = true,
  extraEnv: Readonly<Record<string, string>> = {}
) {
  const result = await invoke(
    ["config", "plan", ...args, "--json"],
    cwd,
    extraEnv
  );
  require(result.value.ok === true &&
    result.exit === (complete ? 0 : 1) &&
    record(result.value.environment_plan).complete ===
      complete, "binding completeness and exit status");
  return result;
}
async function refused(args: readonly string[], code: string, cwd = primary) {
  const result = await invoke(["config", "plan", ...args, "--json"], cwd);
  require(result.exit === 1 &&
    result.value.ok === false &&
    record(result.value.error).code === code, "fixed refusal code");
}
async function layer(
  cwd: string,
  filename: string,
  values: Record<string, unknown>,
  environment = "default"
) {
  await Bun.write(
    join(cwd, ".hack", filename),
    JSON.stringify({
      version: 1,
      environment,
      secretsprovider: "project_key",
      values,
    })
  );
}
async function git(args: readonly string[], cwd: string) {
  const child = Bun.spawn(["/usr/bin/git", "-C", cwd, ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exit] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  require(exit === 0, `isolated Git fixture: ${stderr}`);
}
function record(value: unknown): Record<string, unknown> {
  require(isRecord(value), "expected report object");
  return value;
}
function require(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Native env plan CLI acceptance failed: ${label}`);
  }
}
