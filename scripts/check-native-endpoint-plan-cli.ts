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

/** Exercise pure endpoint planning through the relocated CLI and real Git linkage. */
const root = resolve(import.meta.dir, "..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "hack-endpoint-cli-"))
);
const bundle = join(directory, "bundle");
const home = join(directory, "home");
const primary = join(directory, "primary");
const checkout = join(directory, "checkout");
const marker = join(directory, "hook-must-not-run");
const canary = "private-synthetic-endpoint-value";
const hostTarget = { kind: "host", port: 9200, protocol: "http" };
const externalTarget = {
  kind: "external",
  hostname: "search.example.invalid",
  port: 9443,
  protocol: "https",
};
const project = {
  schema_version: 1,
  name: "endpoint-fixture",
  profiles: ["optional"],
  host_bindings: { search: hostTarget },
  services: {
    web: {
      image: "example/web:1",
      environment: {
        API: {
          endpoint: {
            kind: "service",
            name: "api",
            port: 3000,
            protocol: "http",
          },
        },
        ORIGIN: { endpoint: { kind: "route", name: "web" } },
        SEARCH: { endpoint: { kind: "host_binding", name: "search" } },
      },
    },
    api: { image: "example/api:1" },
    admin: { image: "example/admin:1", profiles: ["optional"] },
  },
  jobs: {
    seed: {
      image: "example/seed:1",
      environment: {
        SEARCH: { endpoint: { kind: "host_binding", name: "search" } },
      },
    },
  },
  routes: {
    domain: "project.example",
    http: { web: { service: "web", port: 3000, hostname: "project" } },
  },
  host: {
    up: {
      before: [
        {
          name: "prepare",
          command: { exec: ["/usr/bin/touch", marker] },
          environment: {
            SEARCH: { endpoint: { kind: "host_binding", name: "search" } },
            ORIGIN: { endpoint: { kind: "route", name: "web" } },
          },
        },
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
  await authored(primary, project);
  await metadata(primary, {});
  const initial = await success(["config", "plan", "--json"], primary);
  const initialBindings = record(record(initial.environment_plan).workloads);
  const web = record(initialBindings.web);
  assert(
    record(web.API).kind === "endpoint" &&
      record(record(web.API).target).name === "api",
    "service endpoint stays typed"
  );
  assert(
    record(record(web.SEARCH).target).context === "workload",
    "guest host target stays symbolic in workload context"
  );
  assert(
    record(record(web.ORIGIN).target).origin ===
      "https://endpoint-fixture.project.example",
    "route endpoint derives centrally"
  );
  const host = Object.values(record(record(initial.environment_plan).host)).map(
    record
  );
  assert(
    host.some(
      (entry) =>
        record(record(record(entry.bindings).SEARCH).target).context === "host"
    ),
    "host invocation retains its own endpoint context"
  );
  const offline = await success(["config", "validate", "--json"], primary);
  assert(
    offline.semantic_hash === initial.semantic_hash &&
      record(offline.local_resolution).resolution_hash ===
        record(initial.local_resolution).resolution_hash,
    "validate and plan identities agree"
  );
  await local(primary, { search: externalTarget, unused: hostTarget });
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
  await git(["worktree", "add", "-b", "feature/endpoints", checkout], primary);
  const inherited = await success(["config", "plan", "--json"], checkout);
  const inheritedSearch = binding(inherited, "search");
  assert(
    inheritedSearch.origin === "primary_local" &&
      record(inheritedSearch.target).hostname === externalTarget.hostname,
    "verified linked worktree inherits typed primary binding"
  );
  assert(
    inherited.semantic_hash === initial.semantic_hash &&
      record(inherited.local_resolution).resolution_hash !==
        record(initial.local_resolution).resolution_hash,
    "local inheritance changes only resolution identity"
  );
  await local(checkout, {
    search: { ...externalTarget, port: 9555 },
    unused: null,
  });
  const overridden = await success(["config", "plan", "--json"], checkout);
  assert(
    binding(overridden, "search").origin === "checkout_local" &&
      record(binding(overridden, "search").target).port === 9555,
    "current checkout overrides inherited target"
  );
  assert(
    record(record(overridden.host_binding_resolution).removed).unused ===
      "checkout_local",
    "local removal retains provenance"
  );
  await local(checkout, { search: null });
  await Bun.write(
    join(checkout, ".hack/hack.env.default.yaml"),
    `broken [${canary}`
  );
  const tombstone = await invoke(["config", "plan", "--json"], checkout);
  assert(
    tombstone.exit === 1 && tombstone.value.ok === false,
    "removed referenced binding refuses before poisoned managed documents"
  );
  await rm(join(checkout, ".hack/hack.local.json"));
  await rm(join(checkout, ".hack/hack.env.default.yaml"));
  for (const extra of [{ CI: "1" }, { HACK_EXECUTION_MODE: "codex" }]) {
    const restricted = await success(
      ["config", "plan", "--json"],
      checkout,
      extra
    );
    assert(
      binding(restricted, "search").origin === "project" &&
        record(binding(restricted, "search").target).kind === "host",
      "CI/slim does not inherit primary bindings"
    );
  }
  await authored(checkout, { ...project, worktree: { inherit_local: false } });
  const optedOut = await success(["config", "plan", "--json"], checkout);
  assert(
    binding(optedOut, "search").origin === "project",
    "explicit opt-out excludes primary binding"
  );
  await authored(checkout, project);
  await metadata(checkout, {
    ORIGIN: { secure: `invalid-ciphertext-${canary}` },
  });
  const collision = await invoke(["config", "plan", "--json"], checkout);
  assert(
    collision.exit === 1 &&
      collision.value.ok === true &&
      record(collision.value.environment_plan).complete === false,
    "managed destination collision makes plan incomplete"
  );
  const collidingWorkloads = record(
    record(collision.value.environment_plan).workloads
  );
  assert(
    record(record(collidingWorkloads.web).ORIGIN).kind === "managed",
    "endpoint cannot replace managed destination"
  );
  await metadata(checkout, {});
  const unsupported = {
    ...project,
    host: {
      processes: {
        tunnel: {
          command: { exec: ["must-not-run"] },
          environment: {
            API: {
              endpoint: {
                kind: "service",
                name: "api",
                port: 3000,
                protocol: "http",
              },
            },
          },
        },
      },
    },
  };
  await authored(checkout, unsupported);
  assert(
    (await success(["config", "validate", "--json"], checkout)).ok === true,
    "context-free service reference remains symbolic"
  );
  const hostService = await invoke(["config", "plan", "--json"], checkout);
  assert(
    hostService.exit === 1 &&
      hostService.value.ok === true &&
      record(hostService.value.environment_plan).complete === false,
    "host service DNS cannot be guessed during planning"
  );
  for (const [label, directive] of [
    [
      "unknown service",
      {
        endpoint: {
          kind: "service",
          name: "missing",
          port: 3000,
          protocol: "http",
        },
      },
    ],
    [
      "job used as service",
      {
        endpoint: {
          kind: "service",
          name: "seed",
          port: 3000,
          protocol: "http",
        },
      },
    ],
    ["unknown route", { endpoint: { kind: "route", name: "missing" } }],
    [
      "inactive target",
      {
        endpoint: {
          kind: "service",
          name: "admin",
          port: 3000,
          protocol: "http",
        },
      },
    ],
    ["mixed tags", { endpoint: { kind: "route", name: "web" }, unset: true }],
    [
      "unsupported protocol",
      {
        endpoint: { kind: "service", name: "api", port: 3000, protocol: "udp" },
      },
    ],
  ] as const) {
    await authored(checkout, {
      ...project,
      services: {
        ...project.services,
        web: { ...project.services.web, environment: { TEST: directive } },
      },
    });
    const invalid = await invoke(["config", "validate", "--json"], checkout);
    assert(
      invalid.exit === 1 && invalid.value.ok === false,
      `${label} refuses`
    );
  }
  await authored(checkout, {
    ...project,
    services: {
      ...project.services,
      web: {
        ...project.services.web,
        environment: {
          ADMIN: {
            endpoint: {
              kind: "service",
              name: "admin",
              port: 3000,
              protocol: "http",
            },
          },
        },
      },
    },
  });
  await success(
    ["config", "plan", "--profile", "optional", "--json"],
    checkout
  );
  await authored(checkout, project);
  for (const bindings of [
    { search: { command: { exec: [canary] } } },
    { search: { ...externalTarget, hostname: `${canary}@example.invalid` } },
    { "bad name": hostTarget },
  ]) {
    await local(checkout, bindings);
    const refused = await invoke(["config", "validate", "--json"], checkout);
    assert(
      refused.exit === 1 && refused.value.ok === false,
      "local command/credential/name injection refuses"
    );
  }
  await rm(join(checkout, ".hack/hack.local.json"));
  const localOnly = { ...project };
  Reflect.deleteProperty(localOnly, "host_bindings");
  await authored(checkout, localOnly);
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
  // The inherited primary supplies a missing authored logical binding at actual resolution.
  await success(["config", "plan", "--json"], checkout);
  const missing = await invoke(["config", "validate", "--json"], checkout, {
    CI: "1",
  });
  assert(
    missing.exit === 1 && missing.value.ok === false,
    "actual resolution rejects unbound logical reference"
  );
  await authored(checkout, project);
  const runtime = await invoke(
    ["up"],
    checkout,
    { HACK_RUNTIME_BACKEND: "native" },
    false
  );
  assert(
    runtime.exit !== 0 &&
      (runtime.stdout + runtime.stderr).includes(
        "E_NATIVE_PROJECT_UNSUPPORTED"
      ),
    "explicit native VM backend remains fenced"
  );
  assert(
    !(await Bun.file(marker).exists()),
    "planning runs no preparation hook"
  );
  for (const dir of [primary, checkout]) {
    assert(
      !(await readdir(join(dir, ".hack"))).some(
        (name) => name === ".internal" || name === ".branch"
      ),
      "no generated runtime state"
    );
  }
  const homeEntries = await readdir(join(home, ".hack")).catch(() => []);
  assert(homeEntries.length === 0, "no registry or runtime home writes");
  process.stdout.write(
    `Relocated native endpoint planning: ${checks} checks passed; no hooks/DNS/trust/runtime effects\n`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function authored(cwd: string, value: unknown) {
  await Bun.write(join(cwd, ".hack/hack.project.json"), JSON.stringify(value));
}
async function local(cwd: string, hostBindings: unknown) {
  await Bun.write(
    join(cwd, ".hack/hack.local.json"),
    JSON.stringify({ schema_version: 1, host_bindings: hostBindings })
  );
}
async function metadata(cwd: string, values: unknown) {
  await Bun.write(
    join(cwd, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: values },
    })
  );
}
function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), "expected report object");
  return value;
}
function binding(value: Record<string, unknown>, name: string) {
  return record(record(record(value.host_binding_resolution).bindings)[name]);
}
async function success(
  args: readonly string[],
  cwd: string,
  extra: Readonly<Record<string, string>> = {}
) {
  const result = await invoke(args, cwd, extra);
  assert(
    result.exit === 0 && result.value.ok === true,
    "successful endpoint command"
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
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert(!(stdout + stderr).includes(canary), "synthetic secret is redacted");
  const value: unknown = json ? JSON.parse(stdout) : {};
  return { exit, stdout, stderr, value: record(value) };
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
