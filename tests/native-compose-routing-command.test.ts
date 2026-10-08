import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNativeComposeRouteClaims } from "../src/lib/native-compose-route-claims.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const BINDING = {
  engineId: "fixture-engine:1",
  proxyId: "a".repeat(64),
  networkId: "b".repeat(64),
};
const FOREIGN = {
  composeProject: "foreign-command-fixture",
  ownerToken: "e".repeat(32),
};
const CADDY_READ = [
  "exec",
  BINDING.proxyId,
  "curl",
  "--disable",
  "--silent",
  "--show-error",
  "--fail",
  "--proxy",
  "",
  "--noproxy",
  "*",
  "--proto",
  "=http",
  "--max-time",
  "10",
  "--max-redirs",
  "0",
  "--write-out",
  "\n%{http_code}",
  "--url",
  "http://127.0.0.1:2019/config/apps/http/servers",
];
const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** Substitute compiler transport and Docker observation; all command owners and private stores are real. */
async function fixture(
  mode:
    | "ordinary"
    | "source-drift"
    | "proxy-drift"
    | "hook-source-drift"
    | "hook-proxy-drift"
    | "hook-route-change"
    | "proxy-reader-missing" = "ordinary"
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-routing-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await mkdir(join(root, "home"));
  const source = join(root, ".hack", "hack.project.json");
  await Bun.write(
    source,
    JSON.stringify({
      schema_version: 1,
      name: "fixture",
      services: { web: { image: "fixture/web:1" } },
      worktree: { auto_branch: false },
    })
  );
  const input = composeFixture();
  input.plan.worktree = { auto_branch: false, inherit_local: true };
  const hooks = mode.startsWith("hook-");
  if (hooks) {
    const update =
      mode === "hook-route-change"
        ? 'const source=await Bun.file(".hack/hack.project.json").json();source.routes={domain:"renamed.test"};await Bun.write(".hack/hack.project.json",JSON.stringify(source));'
        : "";
    input.plan.host = {
      up: {
        before: [
          {
            name: "before-routing",
            command: {
              exec: [
                process.execPath,
                "-e",
                `${update}await Bun.write("hook-complete","complete");`,
              ],
            },
            env_target: { kind: "host" },
          },
        ],
      },
    };
  }
  input.plan.routes = {
    domain: "dev.test",
    aliases: {},
    http: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        hostname: "project",
      },
    },
  };
  const origin = "https://fixture.dev.test";
  const resolution = {
    domain: "dev.test",
    domain_origin: "project",
    project_origin: origin,
    aliases: {},
    oauth_alias: null,
    open_preference: "auto",
    open_preference_origin: "default",
    open_origin: origin,
    routes: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        origin,
        aliases: {},
      },
    },
  };
  await Bun.write(
    join(root, "compiler"),
    `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)}, hooks = ${JSON.stringify(hooks)};
const operation = process.argv[2];
if (operation === "--protocol") {
  console.log(JSON.stringify({ transport_version: 1, authored_version: 1, plan_version: 1, resolve_version: 1, local_version: 1, env_plan_version: 1, host_env_plan_version: 1, routing_plan_version: 1 }));
} else {
  const raw = await Bun.stdin.text();
  const request = operation === "compile" ? {} : JSON.parse(raw);
  const result = { transport_version: 1, ok: true, semantic_hash: "a".repeat(64), declared_workloads: { web: "service" }, plan: ${JSON.stringify(input.plan)} };
  const afterHook = existsSync(root + "/hook-complete");
  const resolution = ${JSON.stringify(resolution)};
  if (mode === "hook-route-change" && afterHook) {
    result.plan.routes.domain = "renamed.test";
    resolution.domain = "renamed.test";
    resolution.project_origin = resolution.open_origin = resolution.routes.app.origin = "https://fixture.renamed.test";
  }
  appendFileSync(root + "/compiler-requests", JSON.stringify({operation, afterHook, domain: resolution.domain}) + "\\n");
  if (hooks) result.host_env_targets = {include_default: true, workloads: []};
  if (operation !== "compile") {
    result.local_resolution = { overlay: null, origin: "project", auto_branch: false, inherit_local: true, resolution_hash: "b".repeat(64) };
    if (request.routing_probe === true) result.routing_inputs_required = true;
    else result.routing_resolution = resolution;
  }
  if (operation === "plan") {
    result.environment_plan = { plan_version: 1, overlay: null, overlay_exists: false, complete: true, workloads: { web: {} }, warnings: [], diagnostics: [] };
    if (hooks) result.environment_plan.host = {"before-routing": {env_target: {kind: "host"}, bindings: {}}};
  }
  console.log(JSON.stringify(result));
}
`
  );
  await chmod(join(root, "compiler"), 0o700);
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)}, binding = ${JSON.stringify(BINDING)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
if (args[0] === "exec") {
  if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(CADDY_READ))}) {
    writeFileSync(root + "/engine-effect", "unexpected exec"); process.exit(98);
  }
  if (mode === "proxy-reader-missing") { console.error("private-command-canary"); process.exit(127); }
  process.stdout.write(JSON.stringify({ srv0: { listen: [":443"], tls_connection_policies: [{}], routes: [
    { match: [{host: ["control.fixture.test"]}], handle: [{handler: "subroute", routes: [
      {handle: [{handler: "reverse_proxy", upstreams: [{dial: "172.29.0.3:3000"}]}], terminal: true}
    ]}], terminal: true }
  ] } }) + "\\n200");
  process.exit(0);
}
if (args[0] === "compose" || ["rm", "stop", "start", "create", "remove"].includes(args[1])) {
  writeFileSync(root + "/engine-effect", "unexpected engine effect"); process.exit(98);
}
const format = args[args.indexOf("--format") + 1] ?? "";
if (args[0] === "info") {
  const counter = root + "/info-count";
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  if (["source-drift", "hook-source-drift"].includes(mode) && count === 0) appendFileSync(${JSON.stringify(source)}, "\\n \\n");
  console.log(JSON.stringify(["proxy-drift", "hook-proxy-drift"].includes(mode) && count >= 6 ? "replaced-engine" : binding.engineId));
} else if (args[0] === "network" && args[1] === "inspect") {
  console.log(JSON.stringify({ id: binding.networkId, name: "hack-dev" }));
} else if (args[0] === "container" && args[1] === "ls") {
  if (args.includes("label=com.docker.compose.project=hack-dev-proxy") || !args.includes("--filter")) console.log(JSON.stringify(binding.proxyId));
} else if (args[0] === "container" && args[1] === "inspect") {
  if (format.includes("sites")) console.log(JSON.stringify({ id: binding.proxyId, project: "hack-dev-proxy", owner: null, instance: null, generation: null, sites: [null] }));
  else console.log(JSON.stringify({ id: binding.proxyId, project: "hack-dev-proxy", service: "caddy", running: true, network: binding.networkId, ip: "172.29.0.2" }));
} else if (!(["network", "volume"].includes(args[0]) && args[1] === "ls")) {
  console.error("private-command-canary"); process.exit(97);
}
`
  );
  await chmod(join(root, "docker"), 0o700);
  return root;
}

async function invoke(root: string, args: readonly string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../index.ts"),
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_GLOBAL_CONFIG_PATH: join(root, "home", "hack.config.json"),
        HACK_CONFIG_COMPILER_BINARY: join(root, "compiler"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
        GIT_DIR: "",
        GIT_WORK_TREE: "",
        GIT_COMMON_DIR: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  const exit = await child.exited;
  const outputs = await Promise.all([stdout, stderr]);
  expect(exit).toBe(1);
  expect(outputs.join("")).not.toContain("private-command-canary");
  expect(await Bun.file(join(root, "engine-effect")).exists()).toBe(false);
  return outputs.join("");
}

test("routed run refuses before any Docker observation or effect", async () => {
  const root = await fixture();
  const output = await invoke(root, ["run", "web", "--", "true"]);
  expect(output).toContain("one-off label projection");
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
}, 20_000);

test("foreign hostname claims refuse the startup command before Docker mutation", async () => {
  const root = await fixture();
  const foreign = await openNativeComposeRouteClaims({
    root: join(root, "home", "compose-routing"),
    binding: BINDING,
    owner: FOREIGN,
  });
  try {
    const attempt = await foreign.acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: "f".repeat(32),
    });
    const output = await invoke(root, ["up", "--detach", "--json"]);
    expect(output).toContain("routing admission");
    expect(output).not.toContain("E_NATIVE_COMPOSE_PROXY_ACCESS");
    const commands: string[][] = (
      await readFile(join(root, "commands"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands).toContainEqual(CADDY_READ);
    expect((await foreign.reopen(attempt.reference)).phase).toBe("reserved");
    await foreign.rollback(attempt);
  } finally {
    await foreign.close();
  }
}, 20_000);

test.each([
  "source-drift",
  "proxy-drift",
  "hook-source-drift",
  "hook-proxy-drift",
] as const)("startup %s refuses before the engine child and rolls back new claims", async (mode) => {
  const root = await fixture(mode);
  const output = await invoke(root, ["up", "--detach", "--json"]);
  expect(output).toContain("E_CONFIG_INVALID");
  expect(output).not.toContain("E_NATIVE_COMPOSE_PROXY_ACCESS");
  const commands: string[][] = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands.some((args) => args[0] === "info")).toBe(true);
  expect(commands.some((args) => args[0] === "compose")).toBe(false);
  expect(commands).toContainEqual(CADDY_READ);
  if (mode.startsWith("hook-")) {
    expect(await Bun.file(join(root, "hook-complete")).text()).toBe("complete");
    const requests = (await Bun.file(join(root, "compiler-requests")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toContainEqual({
      operation: "plan",
      afterHook: false,
      domain: "dev.test",
    });
    expect(requests).toContainEqual({
      operation: "plan",
      afterHook: true,
      domain: "dev.test",
    });
  }
  const foreign = await openNativeComposeRouteClaims({
    root: join(root, "home", "compose-routing"),
    binding: BINDING,
    owner: FOREIGN,
  });
  try {
    const attempt = await foreign.acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: "f".repeat(32),
    });
    await foreign.rollback(attempt);
  } finally {
    await foreign.close();
  }
}, 20_000);

test("completed hook route changes use fresh hostname claims before any engine effect", async () => {
  const root = await fixture("hook-route-change");
  const foreign = await openNativeComposeRouteClaims({
    root: join(root, "home", "compose-routing"),
    binding: BINDING,
    owner: FOREIGN,
  });
  try {
    const occupied = await foreign.acquire({
      hostnames: ["fixture.renamed.test"],
      generationIdentity: "f".repeat(32),
    });
    const output = await invoke(root, ["up", "--detach", "--json"]);
    expect(output).toContain("routing admission");
    expect(output).not.toContain("E_NATIVE_COMPOSE_PROXY_ACCESS");
    expect(await Bun.file(join(root, "hook-complete")).text()).toBe("complete");
    const requests = (await Bun.file(join(root, "compiler-requests")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toContainEqual({
      operation: "plan",
      afterHook: true,
      domain: "renamed.test",
    });
    const available = await foreign.acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: "d".repeat(32),
    });
    await foreign.rollback(available);
    expect((await foreign.reopen(occupied.reference)).phase).toBe("reserved");
    await foreign.rollback(occupied);
  } finally {
    await foreign.close();
  }
}, 20_000);

test("missing fixed Caddy reader preserves the actionable public refusal", async () => {
  const root = await fixture("proxy-reader-missing");
  const output = await invoke(root, ["up", "--detach", "--json"]);
  expect(output).toContain("E_NATIVE_COMPOSE_PROXY_ACCESS");
  expect(output).toContain("hack global install");
  expect(output).toContain("hack doctor --fix");
  expect(output).toContain("retaining caddy_data");
  expect(output).not.toContain("routing admission or verification failed");
}, 20_000);
