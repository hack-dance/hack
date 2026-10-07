#!/usr/bin/env bun
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

/** Qualify pure acquisition intent in a relocated bundle and a real linked worktree. */
const root = resolve(import.meta.dir, "..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "hack-acquisition-cli-"))
);
const bundle = join(directory, "bundle");
const home = join(directory, "home");
const primary = join(directory, "primary");
const checkout = join(directory, "checkout");
const marker = join(directory, "hook-must-not-run");
const canary = "private-synthetic-acquisition-value";
const image = { image: "example/web:1" };
const build = { build: { context: "./app//.", dockerfile: "./Dockerfile" } };
const project = {
  schema_version: 1,
  name: "acquisition-fixture",
  profiles: ["optional"],
  services: {
    web: { ...image, pull_policy: "missing" },
    builder: { ...build, pull_policy: "build" },
    admin: { ...image, profiles: ["optional"], pull_policy: "always" },
    omitted: image,
  },
  jobs: { seed: { ...image, pull_policy: "never" } },
  host: {
    up: {
      before: [
        { name: "prepare", command: { exec: ["/usr/bin/touch", marker] } },
      ],
    },
  },
};
let checks = 0;
try {
  await Promise.all([
    mkdir(bundle),
    mkdir(home),
    mkdir(join(primary, ".hack"), { recursive: true }),
  ]);
  for (const name of ["hack", "hack-config-compiler"]) {
    await copyFile(join(root, "dist", name), join(bundle, name));
  }
  await authored(primary, {
    schema_version: 1,
    name: "acquisition-fixture",
    services: { web: image },
  });
  const plain = await success(["config", "validate", "--json"], primary);
  assert(
    !Object.hasOwn(workload(plain, "web"), "pull_policy"),
    "omitted policy introduces no acquisition default"
  );
  const hash = plain.semantic_hash;
  for (const pull_policy of ["always", "never", "missing"]) {
    await authored(primary, {
      schema_version: 1,
      name: "acquisition-fixture",
      services: { web: { ...image, pull_policy } },
    });
    const selected = await success(["config", "validate", "--json"], primary);
    assert(
      workload(selected, "web").pull_policy === pull_policy,
      "canonical image policy survives"
    );
    assert(
      selected.semantic_hash !== hash,
      "explicit policy participates in authored identity"
    );
  }
  await authored(primary, project);
  await metadata(primary);
  const planned = await success(["config", "plan", "--json"], primary);
  assert(
    workload(planned, "web").pull_policy === "missing",
    "image acquisition intent survives metadata planning"
  );
  assert(
    workload(planned, "builder").pull_policy === "build",
    "build-only acquisition intent survives"
  );
  assert(
    record(workload(planned, "builder").build).context === "app",
    "Rust retains build path normalization ownership"
  );
  assert(
    !Object.hasOwn(workload(planned, "builder"), "image"),
    "build-only source stays build-only"
  );
  assert(
    workload(planned, "seed", "jobs").pull_policy === "never",
    "job policy stays in job namespace"
  );
  assert(
    !Object.hasOwn(workload(planned, "omitted"), "pull_policy"),
    "field-free sibling preserves policy omission"
  );
  assert(
    !Object.hasOwn(record(record(planned.plan).services), "admin"),
    "inactive policy-bearing workload stays inactive"
  );
  await git(["init", "-b", "main"], primary);
  await git(["add", ".hack/hack.project.json"], primary);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    primary
  );
  await git(
    ["worktree", "add", "-b", "feature/acquisition", checkout],
    primary
  );
  await Bun.write(
    join(primary, ".hack/hack.local.json"),
    JSON.stringify({ schema_version: 1 })
  );
  const inherited = await success(["config", "plan", "--json"], checkout);
  assert(
    inherited.semantic_hash === planned.semantic_hash,
    "linked worktree preserves authored acquisition identity"
  );
  assert(
    JSON.stringify(workload(inherited, "web")) ===
      JSON.stringify(workload(planned, "web")),
    "linked worktree preserves acquisition intent"
  );
  const optional = await success(
    ["config", "plan", "--profile", "optional", "--json"],
    checkout
  );
  assert(
    workload(optional, "admin").pull_policy === "always",
    "selected profile includes its exact acquisition policy"
  );
  for (const pull_policy of [
    null,
    false,
    1,
    {},
    { always: null },
    "",
    "Always",
    "if_not_present",
    "daily",
    "weekly",
    "every_12h",
    canary,
  ]) {
    await authored(checkout, {
      ...project,
      services: {
        ...project.services,
        admin: { ...image, profiles: ["optional"], pull_policy },
      },
    });
    const invalid = await refuses(
      checkout,
      "invalid inactive policies refuse before selection"
    );
    assert(
      record(invalid.diagnostics[0]).code === "invalid_shape",
      "invalid strings and policy types remain authoritative Rust shape diagnostics"
    );
  }
  for (const source of [
    { ...image, pull_policy: "build" },
    { ...build, pull_policy: "always" },
    { ...build, pull_policy: "never" },
    { ...build, pull_policy: "missing" },
  ]) {
    await authored(checkout, {
      ...project,
      jobs: { seed: { ...source, profiles: ["optional"] } },
    });
    const invalid = await refuses(
      checkout,
      "source-policy mismatch refuses even for inactive jobs"
    );
    assert(
      record(invalid.diagnostics[0]).code === "invalid_pull_policy_source",
      "source-policy combination remains a Rust diagnostic"
    );
  }
  for (const source of [
    { ...image, ...build, pull_policy: "always" },
    { pull_policy: "missing" },
  ]) {
    await authored(checkout, {
      ...project,
      services: { ...project.services, web: source },
    });
    const invalid = await refuses(
      checkout,
      "exactly one image or build remains mandatory"
    );
    assert(
      record(invalid.diagnostics[0]).code === "image_build_exclusive",
      "source exclusivity diagnostic retains precedence"
    );
  }
  await authored(checkout, project);
  await Bun.write(
    join(checkout, ".hack/hack.local.json"),
    JSON.stringify({
      schema_version: 1,
      services: { web: { pull_policy: "never" } },
    })
  );
  await refuses(checkout, "local settings cannot inject acquisition policy");
  await rm(join(checkout, ".hack/hack.local.json"));
  await Bun.write(
    join(checkout, ".hack/hack.env.default.yaml"),
    `broken [${canary}`
  );
  await success(["config", "validate", "--json"], checkout);
  await refuses(checkout, "metadata planning refuses poisoned managed data", [
    "config",
    "plan",
    "--json",
  ]);
  await authored(checkout, {
    ...project,
    services: { web: { ...image, pull_policy: canary } },
  });
  const precedence = await refuses(
    checkout,
    "authored policy validation precedes poisoned metadata",
    ["config", "plan", "--json"]
  );
  assert(
    record(precedence.diagnostics[0]).code === "invalid_shape",
    "Rust authored diagnostics remain authoritative"
  );
  await authored(checkout, project);
  await rm(join(checkout, ".hack/hack.env.default.yaml"));
  await success(
    [
      "config",
      "validate",
      "--file",
      join(checkout, ".hack/hack.project.json"),
      "--json",
    ],
    checkout
  );
  const runtime = await invoke(["up"], checkout, false, {
    HACK_RUNTIME_BACKEND: "native",
  });
  assert(
    runtime.exit !== 0 &&
      (runtime.stdout + runtime.stderr).includes(
        "E_NATIVE_PROJECT_UNSUPPORTED"
      ),
    "explicit native VM backend remains fenced before engine acquisition"
  );
  assert(!(await Bun.file(marker).exists()), "planning executes no hook");
  for (const cwd of [primary, checkout]) {
    assert(
      !(await readdir(join(cwd, ".hack"))).some(
        (name) => name === ".internal" || name === ".branch"
      ),
      "planning creates no runtime state"
    );
  }
  assert(
    (await readdir(join(home, ".hack")).catch(() => [])).length === 0,
    "planning creates no registry or runtime home state"
  );
  process.stdout.write(
    `Relocated native acquisition planning: ${checks} checks passed; no hooks/pulls/builds/decryption/runtime effects\n`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function authored(cwd: string, value: unknown) {
  await Bun.write(join(cwd, ".hack/hack.project.json"), JSON.stringify(value));
}
async function metadata(cwd: string) {
  await Bun.write(
    join(cwd, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: { secure: `invalid-ciphertext-${canary}` } } },
    })
  );
}
function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), "expected report object");
  return value;
}
function workload(
  value: Record<string, unknown>,
  name: string,
  kind = "services"
) {
  return record(record(record(value.plan)[kind])[name]);
}
async function refuses(
  cwd: string,
  message: string,
  args = ["config", "validate", "--json"]
) {
  const result = await invoke(args, cwd);
  assert(result.exit === 1 && result.value.ok === false, message);
  return result.value;
}
async function success(args: readonly string[], cwd: string) {
  const result = await invoke(args, cwd);
  assert(
    result.exit === 0 && result.value.ok === true,
    `successful acquisition command (${args.join(" ")}): ${result.stdout}${result.stderr}`
  );
  return result.value;
}
async function invoke(
  args: readonly string[],
  cwd: string,
  json = true,
  extraEnv: Readonly<Record<string, string>> = {}
) {
  const child = Bun.spawn([join(bundle, "hack"), ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      HACK_LOGGER: "console",
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert(
      !(stdout + stderr).includes(canary),
      "synthetic managed value is redacted"
    );
    const value: unknown = json ? JSON.parse(stdout) : {};
    return { exit, stdout, stderr, value: record(value) };
  } finally {
    clearTimeout(timer);
  }
}
async function git(args: readonly string[], cwd: string) {
  const child = Bun.spawn(["/usr/bin/git", ...args], {
    cwd,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert(exit === 0, `isolated Git fixture ${args[0]}: ${stdout}${stderr}`);
}
function assert(condition: unknown, message: string): asserts condition {
  checks += 1;
  if (!condition) {
    throw new Error(message);
  }
}
