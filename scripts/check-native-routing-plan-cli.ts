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

/** Exercise the relocated executable/sidecar with isolated policy and real linked Git worktrees. */
const root = resolve(import.meta.dir, "..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "hack-routing-cli-"))
);
const bundle = join(directory, "bundle");
const home = join(directory, "home");
const primary = join(directory, "primary");
const checkout = join(directory, "checkout");
const marker = join(directory, "hook-must-not-run");
const canary = "private-synthetic-routing-value";
const project = {
  schema_version: 1,
  name: "routing-fixture",
  profiles: ["optional"],
  services: {
    web: { image: "example/web:1" },
    admin: { image: "example/admin:1", profiles: ["optional"] },
  },
  host: {
    up: {
      before: [
        { name: "prepare", command: { exec: ["/usr/bin/touch", marker] } },
      ],
    },
  },
  routes: {
    domain: "project.example",
    aliases: {
      oauth: { domain: "hack.gy" },
      loopback: { origin: "http://localhost:3044" },
    },
    oauth_alias: "oauth",
    http: {
      web: { service: "web", port: 3000, hostname: "project" },
      admin: {
        service: "admin",
        port: 4000,
        protocol: "https",
        hostname: "admin",
      },
    },
  },
};
let checks = 0;
try {
  await Promise.all([
    mkdir(bundle),
    mkdir(join(home, ".hack"), { recursive: true }),
    mkdir(join(primary, ".hack"), { recursive: true }),
  ]);
  for (const name of ["hack", "hack-config-compiler"]) {
    await copyFile(join(root, "dist", name), join(bundle, name));
  }
  const globalPath = join(home, ".hack/hack.config.json");
  await Bun.write(
    globalPath,
    JSON.stringify({
      default_domain: "global.example",
      ignored_private_field: canary,
    })
  );
  await authored(primary, project);
  await Bun.write(
    join(primary, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: { secure: canary } } },
    })
  );
  await mkdir(join(primary, ".hack/.hack.secret.key"));
  const first = await validate(primary);
  const firstRoute = routing(first);
  assert(
    firstRoute.domain === "project.example" &&
      firstRoute.domain_origin === "project",
    "project domain beats global policy"
  );
  assert(
    firstRoute.project_origin === "https://routing-fixture.project.example" &&
      firstRoute.open_origin === "https://routing-fixture.hack.gy",
    "explicit OAuth alias selection controls auto open"
  );
  assert(
    Object.keys(record(firstRoute.routes)).join() === "web",
    "inactive route omitted from selected report"
  );
  assert(
    record(record(record(firstRoute.routes).web).aliases).loopback ===
      "http://localhost:3044",
    "explicit loopback alias preserved"
  );
  const profiles = await validate(primary, ["--profile", "optional"]);
  assert(
    record(record(routing(profiles).routes).admin).origin ===
      "https://admin.routing-fixture.project.example",
    "profiled named route expands centrally"
  );
  const planned = await invoke(["config", "plan", "--json"], primary);
  assert(
    planned.exit === 0 &&
      JSON.stringify(planned.value.routing_resolution) ===
        JSON.stringify(first.routing_resolution) &&
      record(planned.value.local_resolution).resolution_hash ===
        record(first.local_resolution).resolution_hash,
    "plan and validate use identical policy generation"
  );
  // This alias collides only with the provisional built-in domain. Actual global
  // selection must be acquired before Rust decides generated-origin collisions.
  await authored(primary, {
    ...project,
    routes: {
      aliases: { local: { domain: "hack.local" } },
      http: project.routes.http,
    },
  });
  const globalCollisionResolved = await validate(primary);
  assert(
    routing(globalCollisionResolved).domain === "global.example" &&
      routing(globalCollisionResolved).project_origin ===
        "https://routing-fixture.global.example" &&
      record(routing(globalCollisionResolved).aliases).local ===
        "https://routing-fixture.hack.local",
    "selected global domain resolves provisional built-in-domain alias collision"
  );
  const globalCollisionPlan = await invoke(
    ["config", "plan", "--json"],
    primary
  );
  assert(
    globalCollisionPlan.exit === 0 &&
      JSON.stringify(globalCollisionPlan.value.routing_resolution) ===
        JSON.stringify(globalCollisionResolved.routing_resolution),
    "planning uses actual global selection before collision validation"
  );
  await authored(primary, project);
  await local(primary, "primary.example", "dev");
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
  await git(["worktree", "add", "-b", "feature/routing", checkout], primary);
  const inherited = await validate(checkout);
  assert(
    routing(inherited).domain === "primary.example" &&
      routing(inherited).domain_origin === "primary_local" &&
      routing(inherited).branch === "feature-routing",
    "verified linked primary settings and branch namespace"
  );
  assert(
    routing(inherited).project_origin ===
      "https://feature-routing.routing-fixture.primary.example",
    "linked origins remain isolated"
  );
  // The pinned alias equals the unbranched origin, but is distinct from this
  // verified linked worktree's generated origin. Probe must not reject it early.
  await authored(checkout, {
    ...project,
    routes: {
      domain: "project.example",
      aliases: { base: { origin: "https://routing-fixture.primary.example" } },
      http: project.routes.http,
    },
  });
  const branchCollisionResolved = await validate(checkout);
  assert(
    routing(branchCollisionResolved).branch === "feature-routing" &&
      routing(branchCollisionResolved).project_origin ===
        "https://feature-routing.routing-fixture.primary.example" &&
      record(routing(branchCollisionResolved).aliases).base ===
        "https://routing-fixture.primary.example",
    "verified branch resolves provisional unbranched pinned-alias collision"
  );
  const branchCollisionPlan = await invoke(
    ["config", "plan", "--json"],
    checkout
  );
  assert(
    branchCollisionPlan.exit === 0 &&
      JSON.stringify(branchCollisionPlan.value.routing_resolution) ===
        JSON.stringify(branchCollisionResolved.routing_resolution),
    "planning uses verified branch selection before collision validation"
  );
  await authored(checkout, project);
  await local(checkout, "current.example", "alias");
  const current = await validate(checkout);
  assert(
    routing(current).domain === "current.example" &&
      routing(current).domain_origin === "checkout_local",
    "current local replaces inherited domain"
  );
  const explicit = await validate(checkout, ["--domain", "cli.example"]);
  assert(
    routing(explicit).domain === "cli.example" &&
      routing(explicit).domain_origin === "explicit" &&
      explicit.semantic_hash === current.semantic_hash &&
      record(explicit.local_resolution).resolution_hash !==
        record(current.local_resolution).resolution_hash,
    "CLI override changes local generation only"
  );
  const explicitPlan = await invoke(
    ["config", "plan", "--json", "--domain", "cli.example"],
    checkout
  );
  assert(
    explicitPlan.exit === 0 &&
      JSON.stringify(explicitPlan.value.routing_resolution) ===
        JSON.stringify(explicit.routing_resolution),
    "CLI planning forwards explicit domain"
  );
  for (const extra of [{ CI: "1" }, { HACK_EXECUTION_MODE: "codex" }]) {
    const excluded = await validate(checkout, [], extra);
    assert(
      routing(excluded).branch === undefined &&
        routing(excluded).domain === "current.example",
      "runner exclusions retain checkout policy without branch inheritance"
    );
  }
  await authored(checkout, {
    ...project,
    worktree: { inherit_local: false, auto_branch: false },
  });
  await rm(join(checkout, ".hack/hack.local.json"));
  const optedOut = await validate(checkout);
  assert(
    routing(optedOut).branch === undefined &&
      routing(optedOut).domain === "project.example",
    "worktree opt-out excludes inherited settings and auto branch"
  );
  const pinnedProject = {
    ...project,
    routes: { ...project.routes, origin: "https://fixed.example:19443" },
  };
  await authored(checkout, pinnedProject);
  const pinned = await validate(checkout, ["--domain", "cli.example"]);
  assert(
    routing(pinned).project_origin === "https://fixed.example:19443" &&
      record(routing(pinned).aliases).oauth ===
        "https://feature-routing.routing-fixture.hack.gy",
    "explicit project origin wins while generated aliases use verified namespace"
  );
  await authored(checkout, project);
  await git(["checkout", "--detach"], checkout);
  const detached = await invoke(["config", "validate", "--json"], checkout);
  assert(
    detached.exit === 1 &&
      record(detached.value.error).code === "E_CONFIG_INVALID",
    "detached linked checkout refuses implicit base collision"
  );
  await git(["checkout", "feature/routing"], checkout);
  const poisoned = `invalid: [${canary}`;
  await Bun.write(join(checkout, ".hack/hack.env.default.yaml"), poisoned);
  const offline = await validate(checkout);
  assert(offline.ok === true, "offline validation never reads managed YAML");
  const metadata = await invoke(["config", "plan", "--json"], checkout);
  assert(
    metadata.exit === 1 &&
      record(metadata.value.error).code === "E_CONFIG_METADATA",
    "selected malformed managed document fails privately"
  );
  await Bun.write(globalPath, poisoned);
  const contextFree = await invoke(
    [
      "config",
      "validate",
      "--file",
      join(checkout, ".hack/hack.project.json"),
      "--json",
    ],
    checkout
  );
  assert(
    contextFree.exit === 0 &&
      contextFree.value.routing_resolution === undefined,
    "explicit-file validation is independent of global/local context"
  );
  const badPolicy = await invoke(["config", "validate", "--json"], checkout);
  assert(
    badPolicy.exit === 1 &&
      record(badPolicy.value.error).code === "E_CONFIG_INPUT",
    "malformed global policy fails privately"
  );
  await Bun.write(
    globalPath,
    JSON.stringify({ default_domain: "global.example" })
  );
  for (const [label, value] of [
    [
      "inactive collision",
      {
        ...project,
        routes: {
          ...project.routes,
          http: {
            ...project.routes.http,
            admin: { ...project.routes.http.admin, hostname: "project" },
          },
        },
      },
    ],
    [
      "undeclared target",
      {
        ...project,
        routes: {
          ...project.routes,
          http: {
            web: { service: "missing", port: 3000, hostname: "project" },
          },
        },
      },
    ],
    [
      "credential origin",
      {
        ...project,
        routes: {
          ...project.routes,
          origin: `https://${canary}@fixed.example`,
        },
      },
    ],
    [
      "duplicate normalized alias",
      {
        ...project,
        routes: {
          ...project.routes,
          aliases: {
            first: { origin: "HTTPS://fixed.example:443" },
            second: { origin: "https://fixed.example" },
          },
          oauth_alias: "first",
        },
      },
    ],
  ] as const) {
    await authored(checkout, value);
    const invalid = await invoke(["config", "validate", "--json"], checkout);
    assert(
      invalid.exit === 1 && invalid.value.ok === false,
      `${label} refused independent of profile`
    );
  }
  await authored(checkout, project);
  await Bun.write(
    join(checkout, ".hack/hack.local.json"),
    JSON.stringify({ schema_version: 1, routes: { http: project.routes.http } })
  );
  const injection = await invoke(["config", "validate", "--json"], checkout);
  assert(
    injection.exit === 1 && injection.value.ok === false,
    "local route injection refused"
  );
  await rm(join(checkout, ".hack/hack.local.json"));
  const runtime = await invoke(["up", "--json"], checkout, {
    HACK_RUNTIME_BACKEND: "native",
  });
  assert(
    runtime.exit !== 0 &&
      (runtime.stdout + runtime.stderr).includes(
        "E_NATIVE_PROJECT_UNSUPPORTED"
      ),
    "explicit native VM backend remains fenced"
  );
  assert(
    !(
      (await Bun.file(marker).exists()) ||
      (await readdir(join(checkout, ".hack"))).some(
        (name) => name === ".internal" || name === ".branch"
      )
    ) && (await readdir(join(home, ".hack"))).join() === "hack.config.json",
    "no hook, registry, route publication or generated-state effects"
  );
  process.stdout.write(
    `Relocated native routing planning: ${checks} checks passed; no DNS/trust/runtime effects\n`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function authored(cwd: string, value: unknown) {
  await Bun.write(join(cwd, ".hack/hack.project.json"), JSON.stringify(value));
}
async function local(cwd: string, domain: string, prefer: string) {
  await Bun.write(
    join(cwd, ".hack/hack.local.json"),
    JSON.stringify({ schema_version: 1, routes: { domain }, open: { prefer } })
  );
}
async function validate(
  cwd: string,
  args: readonly string[] = [],
  extra: Readonly<Record<string, string>> = {}
) {
  const result = await invoke(
    ["config", "validate", "--json", ...args],
    cwd,
    extra
  );
  assert(
    result.exit === 0 && result.value.ok === true,
    "project-aware validation success"
  );
  return result.value;
}
function routing(value: Record<string, unknown>) {
  return record(value.routing_resolution);
}
function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), "expected report object");
  return value;
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
      "private values omitted from output"
    );
    return {
      stdout,
      stderr,
      exit,
      value: args[0] === "config" ? record(JSON.parse(stdout)) : {},
    };
  } finally {
    clearTimeout(timer);
  }
}
async function git(args: readonly string[], cwd: string) {
  const child = Bun.spawn(["/usr/bin/git", "-C", cwd, ...args], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
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
function assert(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Native routing CLI acceptance failed: ${label}`);
  }
  checks += 1;
}
