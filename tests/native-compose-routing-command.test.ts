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
  mode: "ordinary" | "source-drift" | "proxy-drift" = "ordinary"
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
const operation = process.argv[2];
if (operation === "--protocol") {
  console.log(JSON.stringify({ transport_version: 1, authored_version: 1, plan_version: 1, resolve_version: 1, local_version: 1, env_plan_version: 1, routing_plan_version: 1 }));
} else {
  const raw = await Bun.stdin.text();
  const request = operation === "compile" ? {} : JSON.parse(raw);
  const result = { transport_version: 1, ok: true, semantic_hash: "a".repeat(64), declared_workloads: { web: "service" }, plan: ${JSON.stringify(input.plan)} };
  if (operation !== "compile") {
    result.local_resolution = { overlay: null, origin: "project", auto_branch: false, inherit_local: true, resolution_hash: "b".repeat(64) };
    if (request.routing_probe === true) result.routing_inputs_required = true;
    else result.routing_resolution = ${JSON.stringify(resolution)};
  }
  if (operation === "plan") result.environment_plan = { plan_version: 1, overlay: null, overlay_exists: false, complete: true, workloads: { web: {} }, warnings: [], diagnostics: [] };
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
if (args[0] === "compose" || args[0] === "exec" || ["rm", "stop", "start", "create", "remove"].includes(args[1])) {
  writeFileSync(root + "/engine-effect", "unexpected engine effect"); process.exit(98);
}
const format = args[args.indexOf("--format") + 1] ?? "";
if (args[0] === "info") {
  const counter = root + "/info-count";
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  if (mode === "source-drift" && count === 0) appendFileSync(${JSON.stringify(source)}, "\\n \\n");
  console.log(JSON.stringify(mode === "proxy-drift" && count >= 2 ? "replaced-engine" : binding.engineId));
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
    expect((await foreign.reopen(attempt.reference)).phase).toBe("reserved");
    await foreign.rollback(attempt);
  } finally {
    await foreign.close();
  }
}, 20_000);

test.each([
  "source-drift",
  "proxy-drift",
] as const)("startup %s refuses before the engine child and rolls back new claims", async (mode) => {
  const root = await fixture(mode);
  const output = await invoke(root, ["up", "--detach", "--json"]);
  expect(output).toContain("E_CONFIG_INVALID");
  const commands: string[][] = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands.some((args) => args[0] === "info")).toBe(true);
  expect(commands.some((args) => args[0] === "compose")).toBe(false);
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
