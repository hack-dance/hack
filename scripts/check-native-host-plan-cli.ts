#!/usr/bin/env bun
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

/** Actual relocated CLI and sidecar; no Bun/Rust on PATH and no host effects. */
const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "hack-host-plan-cli-"));
const bundle = join(directory, "bundle");
const home = join(directory, "home");
const primary = join(directory, "primary");
const marker = join(directory, "host-command-must-not-run");
const canary = "private-synthetic-host-value";
const secret = { secure: `invalid-ciphertext-${canary}` };
const command = { exec: ["/usr/bin/touch", marker] };
const project = {
  schema_version: 1,
  name: "host-plan-fixture",
  profiles: ["optional"],
  environment: { default_overlay: "qa" },
  services: { web: { image: "example/web:1" } },
  jobs: {
    seed: { image: "example/seed:1", profiles: ["optional"] },
  },
  host: {
    up: {
      before: [
        {
          name: "prepare",
          command: { shell: `touch '${marker}'` },
          cwd: "./scripts//.",
          environment: { HOST: { env_ref: "HOST" } },
        },
        {
          name: "prepare-job",
          command,
          env_target: { kind: "workload", name: "seed" },
          environment: { JOB: { env_ref: "JOB" } },
        },
      ],
    },
    down: { after: [{ name: "cleanup", command }] },
    processes: {
      web: { command },
      tunnel: {
        command,
        env_target: { kind: "workload", name: "web" },
        environment: {
          COPY: { env_ref: "SOURCE" },
          SOURCE: { literal: "authored-public-override" },
          EMPTY: { default: "must-not-replace-empty" },
          ERASE: { unset: true },
          ["__proto__"]: { literal: "authored-own-binding" },
        },
        singleton: { ports: [32_002, 32_001], on_conflict: "fail" },
      },
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
  await authored(primary, project);
  await mkdir(join(primary, ".hack/.hack.secret.key"));
  await layer(primary, "hack.env.default.yaml", {
    global: { SOURCE: secret, EMPTY: "", ERASE: secret },
    host: { HOST: secret, HOST_LAYER: secret },
    web: { WEB_ONLY: secret },
    seed: { JOB: secret },
    retired: { UNUSED: secret },
  });
  const first = await planned(primary);
  const hosts = report(first);
  const sameName = bindings(hosts, "web");
  const tunnel = bindings(hosts, "tunnel");
  assert(
    Object.hasOwn(sameName, "HOST") && !Object.hasOwn(sameName, "WEB_ONLY"),
    "matching names grant no workload scope"
  );
  assert(
    record(tunnel.COPY).key === "SOURCE" &&
      record(tunnel.COPY).secret === true &&
      record(tunnel.SOURCE).kind === "literal" &&
      record(tunnel.EMPTY).kind === "managed" &&
      !Object.hasOwn(tunnel, "ERASE"),
    "immutable baseline and directives for explicit target"
  );
  assert(
    Object.hasOwn(tunnel, "__proto__") &&
      record(tunnel.__proto__).value === "authored-own-binding",
    "own prototype destination survives"
  );
  assert(
    record(bindings(hosts, "prepare-job").JOB).scope === "seed" &&
      !Object.hasOwn(record(first.plan).jobs, "seed") &&
      record(first.declared_workloads).seed === "job",
    "inactive job remains an explicit owner target"
  );
  assert(
    JSON.stringify(first.host_env_targets) ===
      JSON.stringify({ include_default: true, workloads: ["seed", "web"] }),
    "Rust target projection"
  );
  const hostPlan = record(record(first.plan).host);
  const before = record(hostPlan.up).before;
  assert(
    Array.isArray(before) &&
      record(before[0]).name === "prepare" &&
      record(before[1]).name === "prepare-job" &&
      record(before[0]).cwd === "scripts",
    "hook order and checkout-relative cwd normalization"
  );
  const processPlan = record(record(hostPlan.processes).tunnel);
  assert(
    processPlan.startup === "up" &&
      processPlan.exit === "stop_on_down" &&
      JSON.stringify(record(processPlan.singleton).ports) === "[32001,32002]",
    "startup/exit and singleton intent preserved"
  );
  const defaultPath = join(primary, ".hack/hack.env.default.yaml");
  const original = await Bun.file(defaultPath).text();
  await Bun.write(defaultPath, `invalid: [${canary}`);
  const offline = await invoke(["config", "validate", "--json"], primary);
  assert(
    offline.exit === 0 &&
      offline.value.ok === true &&
      offline.value.semantic_hash === first.semantic_hash,
    "validation never reads managed documents"
  );
  const invalid = await invoke(["config", "plan", "--json"], primary);
  assert(
    invalid.exit === 1 &&
      record(invalid.value.error).code === "E_CONFIG_METADATA",
    "invalid selected metadata refuses redacted"
  );
  await Bun.write(
    defaultPath,
    original.replaceAll(canary, `${canary}-changed`)
  );
  const changed = await planned(primary);
  assert(
    changed.semantic_hash === first.semantic_hash &&
      record(changed.local_resolution).resolution_hash ===
        record(first.local_resolution).resolution_hash,
    "managed values do not enter portable identities"
  );
  await layer(primary, "hack.env.qa.yaml", { host: { HOST: null } }, "qa");
  const incomplete = await planned(primary, false);
  assert(
    JSON.stringify(record(incomplete.environment_plan).diagnostics).includes(
      "/host/up/before/0/environment/HOST"
    ),
    "missing host reference has original hook pointer"
  );
  await rm(join(primary, ".hack/hack.env.qa.yaml"));
  await layer(primary, "hack.env.local.yaml", { host: { COPY: secret } });
  const collision = await planned(primary, false);
  assert(
    JSON.stringify(record(collision.environment_plan).diagnostics).includes(
      "env_reference_collision"
    ),
    "host remap refuses occupied owner destination"
  );
  await rm(join(primary, ".hack/hack.env.local.yaml"));
  await authored(primary, {
    ...project,
    services: { ...project.services, host: { image: "example/host:1" } },
  });
  const namedHost = await planned(primary, false);
  assert(
    !(
      Object.hasOwn(bindings(report(namedHost), "web"), "HOST") ||
      Object.hasOwn(bindings(report(namedHost), "tunnel"), "HOST")
    ) &&
      Object.hasOwn(
        record(record(record(namedHost.environment_plan).workloads).host),
        "HOST"
      ),
    "declared workload named host blocks generic host override"
  );
  await authored(primary, {
    ...project,
    host: {
      ...project.host,
      processes: {
        ...project.host.processes,
        tunnel: { command, env_target: { kind: "workload", name: "unknown" } },
      },
    },
  });
  const unknown = await invoke(["config", "validate", "--json"], primary);
  assert(
    unknown.exit === 1 && unknown.value.ok === false,
    "undeclared host target refuses offline"
  );
  await authored(primary, project);
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
    ["worktree", "add", "--quiet", "-b", "host-fixture", checkout],
    primary
  );
  await layer(primary, "hack.env.local.yaml", { host: { PRIMARY: secret } });
  await layer(
    primary,
    "hack.env.qa.local.yaml",
    { web: { SOURCE: secret } },
    "qa"
  );
  await layer(checkout, "hack.env.local.yaml", { host: { SOURCE: "" } });
  await layer(
    checkout,
    "hack.env.qa.local.yaml",
    { host: { CURRENT: secret } },
    "qa"
  );
  const linked = await planned(checkout);
  const linkedTunnel = bindings(report(linked), "tunnel");
  assert(
    Object.hasOwn(linkedTunnel, "PRIMARY") &&
      Object.hasOwn(linkedTunnel, "CURRENT") &&
      record(linkedTunnel.COPY).scope === "host" &&
      record(linkedTunnel.COPY).secret === false,
    "six layers preserve host overlay precedence"
  );
  for (const extra of [{ CI: "1" }, { HACK_EXECUTION_MODE: "codex" }]) {
    const excluded = await planned(checkout, true, extra);
    assert(
      !Object.hasOwn(bindings(report(excluded), "tunnel"), "PRIMARY"),
      "CI/slim excludes primary host metadata"
    );
  }
  await authored(checkout, { ...project, worktree: { inherit_local: false } });
  const optedOut = await planned(checkout);
  assert(
    !Object.hasOwn(bindings(report(optedOut), "tunnel"), "PRIMARY"),
    "opt-out excludes primary host metadata"
  );
  await authored(checkout, project);
  await Bun.write(
    join(checkout, ".hack/hack.local.json"),
    JSON.stringify({
      schema_version: 1,
      host: project.host,
    })
  );
  const injection = await invoke(["config", "validate", "--json"], checkout);
  assert(
    injection.exit === 1 && injection.value.ok === false,
    "local settings cannot inject host commands"
  );
  await rm(join(checkout, ".hack/hack.local.json"));
  const runtime = await invoke(["up", "--detach", "--json"], checkout, {
    HACK_RUNTIME_BACKEND: "native",
  });
  assert(
    runtime.exit !== 0 &&
      (runtime.stdout + runtime.stderr).includes(
        "E_NATIVE_PROJECT_UNSUPPORTED"
      ),
    "unsupported native detached up refuses before input or runtime work"
  );
  assert(
    !(await Bun.file(marker).exists()) &&
      (await readdir(home)).length === 0 &&
      !(await readdir(join(checkout, ".hack"))).some(
        (name) => name === ".internal" || name === ".branch"
      ),
    "no hooks, process, registry or runtime effects"
  );
  process.stdout.write(
    `Relocated native host planning: ${checks} checks passed; no host execution or secret delivery\n`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function invoke(
  args: readonly string[],
  cwd: string,
  extra: Readonly<Record<string, string>> = {}
) {
  const child = Bun.spawn([join(bundle, "hack"), ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      HACK_LOGGER: "console",
      AWS_SECRET_ACCESS_KEY: canary,
      ...extra,
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
    assert(
      !(stdout + stderr).includes(canary),
      "no managed values or ciphertext in output"
    );
    const value = args[0] === "config" ? record(JSON.parse(stdout)) : {};
    return { stdout, stderr, exit, value };
  } finally {
    clearTimeout(timer);
  }
}
async function planned(
  cwd: string,
  complete = true,
  extra: Readonly<Record<string, string>> = {}
) {
  const result = await invoke(["config", "plan", "--json"], cwd, extra);
  assert(
    result.value.ok === true &&
      result.exit === (complete ? 0 : 1) &&
      record(result.value.environment_plan).complete === complete,
    "plan completeness and exit"
  );
  // Authored commands intentionally contain the marker path; metadata reports do not.
  assert(
    !JSON.stringify(result.value.environment_plan).includes(directory),
    "metadata report excludes private paths"
  );
  return result.value;
}
function report(value: Record<string, unknown>) {
  return record(record(value.environment_plan).host);
}
function bindings(hosts: Record<string, unknown>, name: string) {
  return record(record(hosts[name]).bindings);
}
async function authored(cwd: string, value: unknown) {
  await Bun.write(join(cwd, ".hack/hack.project.json"), JSON.stringify(value));
}
async function layer(
  cwd: string,
  name: string,
  values: unknown,
  environment = "default"
) {
  await Bun.write(
    join(cwd, ".hack", name),
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
  assert(exit === 0, `isolated Git fixture: ${stderr}`);
}
function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), "expected report object");
  return value;
}
function assert(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Native host plan CLI acceptance failed: ${label}`);
  }
  checks += 1;
}
