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

/** Qualify pure process planning through a relocated bundle and real Git worktree. */
const root = resolve(import.meta.dir, "..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "hack-process-cli-"))
);
const bundle = join(directory, "bundle");
const home = join(directory, "home");
const primary = join(directory, "primary");
const checkout = join(directory, "checkout");
const marker = join(directory, "hook-must-not-run");
const canary = "private-synthetic-process-value";
const plain = { image: "example/web:1" };
const policy = {
  ...plain,
  command: { exec: ["web", "--port", "3000"] },
  entrypoint: { exec: [] },
  init: false,
  shutdown: { signal: "SIGHUP", grace: "45s" },
  restart: { kind: "on-failure", max_retries: 3 },
};
const project = {
  schema_version: 1,
  name: "process-fixture",
  profiles: ["optional"],
  services: { web: policy, admin: { ...plain, profiles: ["optional"] } },
  jobs: { seed: { ...plain, restart: { kind: "on-failure", max_retries: 2 } } },
  routes: {
    http: { web: { service: "web", port: 3000, hostname: "project" } },
  },
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
    name: "process-fixture",
    services: { web: plain },
  });
  const absent = workload(
    await success(["config", "validate", "--json"], primary),
    "web"
  );
  assert(
    ["entrypoint", "init", "shutdown", "restart"].every(
      (key) => !Object.hasOwn(absent, key)
    ),
    "omission introduces no process defaults"
  );
  await authored(primary, project);
  await metadata(primary);
  const initial = await success(["config", "plan", "--json"], primary);
  const web = workload(initial, "web");
  const entrypointArgs = record(web.entrypoint).exec;
  assert(
    Array.isArray(entrypointArgs) && entrypointArgs.length === 0,
    "empty entrypoint explicitly clears image entrypoint"
  );
  assert(web.init === false, "explicit false survives planning");
  assert(
    record(web.shutdown).signal === "SIGHUP" &&
      record(web.shutdown).grace === "45000ms",
    "shutdown normalizes without a backend grace cap"
  );
  assert(
    record(web.restart).kind === "on-failure" &&
      record(web.restart).max_retries === 3,
    "restart retains its typed retry bound"
  );
  assert(
    record(workload(initial, "seed", "jobs").restart).max_retries === 2,
    "job retry intent survives"
  );
  await authored(primary, {
    ...project,
    services: {
      ...project.services,
      web: { ...policy, shutdown: { signal: "SIGHUP", grace: "45000ms" } },
    },
  });
  assert(
    (await success(["config", "validate", "--json"], primary)).semantic_hash ===
      initial.semantic_hash,
    "equivalent durations have the same semantic hash"
  );
  await authored(primary, project);
  await Bun.write(
    join(primary, ".hack/hack.local.json"),
    JSON.stringify({ schema_version: 1, routes: { domain: "custom.example" } })
  );
  await git(["init", "-b", "main"], primary);
  await git(["add", ".hack/hack.project.json"], primary);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    primary
  );
  await git(["worktree", "add", "-b", "feature/process", checkout], primary);
  const inherited = await success(["config", "plan", "--json"], checkout);
  assert(
    JSON.stringify(workload(inherited, "web")) === JSON.stringify(web),
    "real linked worktree preserves workload process policy"
  );
  assert(
    inherited.semantic_hash === initial.semantic_hash,
    "local domain and branch isolation do not change authored semantics"
  );
  const selected = await success(
    ["config", "plan", "--profile", "optional", "--json"],
    checkout
  );
  const admin = workload(selected, "admin");
  assert(
    !(Object.hasOwn(admin, "restart") || Object.hasOwn(admin, "entrypoint")),
    "selected workloads retain omitted image defaults"
  );
  for (const restart of [{ kind: "always" }, { kind: "unless-stopped" }]) {
    await authored(checkout, {
      ...project,
      jobs: { seed: { ...plain, profiles: ["optional"], restart } },
    });
    await refuses(
      checkout,
      "successful jobs reject service restart policy even when inactive"
    );
  }
  for (const bad of [
    { entrypoint: null },
    { entrypoint: { exec: ["", "arg"] } },
    { entrypoint: { exec: [], shell: canary } },
    { command: { exec: [] } },
    { init: null },
    { init: "false" },
    { shutdown: {} },
    { shutdown: { signal: "SIGPOLL" } },
    { shutdown: { signal: "TERM" } },
    { shutdown: { signal: 15 } },
    { shutdown: { grace: "0s" } },
    { shutdown: { grace: "1.5s" } },
    { shutdown: { grace: "4294967296ms" } },
    { shutdown: { grace: null } },
    { restart: { kind: "on-failure", max_retries: 0 } },
    { restart: { kind: "on-failure", max_retries: null } },
    { restart: { kind: "always", max_retries: 1 } },
    { restart: { kind: canary } },
  ]) {
    await authored(checkout, {
      ...project,
      services: {
        ...project.services,
        admin: { ...plain, profiles: ["optional"], ...bad },
      },
    });
    await refuses(
      checkout,
      "invalid inactive process policy refuses before pruning"
    );
  }
  await authored(checkout, {
    ...project,
    services: {
      ...project.services,
      web: {
        ...policy,
        entrypoint: { shell: "exec web" },
        init: true,
        shutdown: { signal: "SIGSYS", grace: "4294967295ms" },
        restart: { kind: "unless-stopped" },
      },
    },
  });
  const maximum = workload(
    await success(["config", "validate", "--json"], checkout),
    "web"
  );
  assert(
    record(maximum.entrypoint).shell === "exec web" &&
      maximum.init === true &&
      record(maximum.shutdown).signal === "SIGSYS",
    "shell entrypoint and canonical Linux signal survive"
  );
  assert(
    record(maximum.shutdown).grace === "4294967295ms",
    "compiler representation bound is accepted"
  );
  await authored(checkout, project);
  await Bun.write(
    join(checkout, ".hack/hack.local.json"),
    JSON.stringify({
      schema_version: 1,
      services: { web: { entrypoint: { shell: canary } } },
    })
  );
  await refuses(checkout, "local settings cannot inject process definitions");
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
    services: { web: { ...plain, shutdown: { signal: canary } } },
  });
  const invalid = await refuses(
    checkout,
    "authored process validation precedes managed metadata",
    ["config", "plan", "--json"]
  );
  assert(
    Array.isArray(invalid.diagnostics) &&
      record(invalid.diagnostics[0]).code === "invalid_shape",
    "authored diagnostic remains authoritative"
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
  const runtime = await invoke(["up"], checkout, {}, false);
  assert(
    runtime.exit !== 0 &&
      (runtime.stdout + runtime.stderr).includes(
        "E_NATIVE_PROJECT_UNSUPPORTED"
      ),
    "native execution remains fenced"
  );
  assert(
    !(await Bun.file(marker).exists()),
    "planning runs no preparation hook"
  );
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
    `Relocated native process planning: ${checks} checks passed; no hooks/DNS/trust/runtime effects\n`
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
      values: { global: {} },
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
async function success(
  args: readonly string[],
  cwd: string,
  extra: Readonly<Record<string, string>> = {}
) {
  const result = await invoke(args, cwd, extra);
  assert(
    result.exit === 0 && result.value.ok === true,
    `successful process command (${args.join(" ")}): ${result.stdout}${result.stderr}`
  );
  return result.value;
}
async function invoke(
  args: readonly string[],
  cwd: string,
  extra: Readonly<Record<string, string>> = {},
  json = true
) {
  const child = Bun.spawn([join(bundle, "hack"), ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      HACK_LOGGER: "console",
      ...extra,
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
