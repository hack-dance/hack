import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { openNativeComposeRouteClaims } from "../src/lib/native-compose-route-claims.ts";
import {
  prepareNativeComposeRouteOwner,
  readNativeComposeRouteMetadata,
} from "../src/lib/native-compose-route-owner.ts";
import type { NativeRoutingResolution } from "../src/lib/native-routing-plan-protocol.ts";
import { composeFixture } from "./helpers/native-compose.ts";

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

async function savedFixture(
  outcome: "complete" | "uncertain" = "complete",
  routed = false
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-saved-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    "invalid authored input must not be parsed on saved operations"
  );
  const owner = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const input = composeFixture();
    if (routed) {
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
    }
    const origin = "https://fixture.dev.test";
    const resolution: NativeRoutingResolution | undefined = routed
      ? {
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
        }
      : undefined;
    const rendered = renderNativeCompose({
      ...input,
      projectRoot: root,
      runtimeIdentity: owner.identity.composeProject,
      generationIdentity: reservation.generationId,
      ownerToken: owner.identity.ownerToken,
      routingResolution: resolution,
      declaredWorkloads: { web: "service" },
    });
    await mkdir(join(root, "home"), { recursive: true });
    const routing = await prepareNativeComposeRouteOwner({
      owner: owner.identity,
      generationId: reservation.generationId,
      document: rendered.document,
      plan: input.plan,
      resolution,
      declared: { web: "service" },
      previous: [],
      io: {
        ingress: async () => ({
          engineId: "fixture-engine:1",
          proxyId: "a".repeat(64),
          networkId: "b".repeat(64),
          proxyIp: "172.29.0.2",
        }),
        inventory: async () => {},
        proxy: async () => {},
        claims: async (options) =>
          await openNativeComposeRouteClaims({
            ...options,
            root: join(root, "home", "compose-routing"),
          }),
      },
    });
    try {
      const generation = await mutation.publish({
        reservation,
        composeJson: JSON.stringify(routing?.document ?? rendered.document),
        profiles: [],
        inputRevision: createHash("sha256").update("fixture").digest("hex"),
        assertFresh: async () => {},
      });
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        ...(routing ? { beforeComplete: () => routing.complete() } : {}),
        effect: async () => {
          await routing?.markEffectsPossible();
          if (outcome === "complete") {
            await routing?.verifyTransition({ deadline: Date.now() + 5000 });
          }
          return { outcome, value: 0 };
        },
      });
    } finally {
      await routing?.close();
    }
  });
  const leases = join(
    root,
    ".hack/.internal/native-compose",
    owner.identity.instanceId,
    "leases"
  );
  const state = await owner.loadCurrent();
  const generation = state.generation ?? (await owner.loadPending());
  if (!generation) {
    throw new Error("Missing saved fixture generation");
  }
  const metadata = readNativeComposeRouteMetadata({
    generationId: generation.generationId,
    document: await owner.readGenerationDocument(generation),
  });
  await owner.close();
  const binary = join(root, "docker");
  await Bun.write(
    binary,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "info") { writeFileSync(${JSON.stringify(join(root, "ingress-read"))}, "unexpected ingress read"); process.exit(23); }
if (args[0] !== "compose") process.exit(0);
writeFileSync(${JSON.stringify(join(root, "started"))}, String(process.pid));
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(join(root, "stopped"))}, "reaped"); process.exit(143); });
await Bun.sleep(60_000);
`
  );
  await chmod(binary, 0o700);
  return {
    root,
    leases,
    identity: owner.identity,
    generationId: generation.generationId,
    routeReference: metadata?.reference,
  };
}

async function verifiedStopTransport(root: string) {
  const proxyId = "a".repeat(64);
  const reader = [
    "exec",
    proxyId,
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
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2), proxyId=${JSON.stringify(proxyId)}, networkId=${JSON.stringify("b".repeat(64))};
appendFileSync(${JSON.stringify(join(root, "commands"))},JSON.stringify(args)+"\\n");
if(args[0]==="compose" && args.includes("down")) process.exit(0);
if(JSON.stringify(args)===${JSON.stringify(JSON.stringify(reader))}) {process.stdout.write('{}\\n200');process.exit(0);}
if(args[0]==="info") console.log(JSON.stringify("fixture-engine:1"));
else if(args[0]==="network" && args[1]==="inspect") console.log(JSON.stringify({id:networkId,name:"hack-dev"}));
else if(args[0]==="container" && args[1]==="ls") {
 if(args.includes("label=com.docker.compose.project=hack-dev-proxy") || !args.includes("--filter")) {
  const format=args[args.indexOf("--format")+1]??"";
  console.log(JSON.stringify(format.includes('"name"')?{id:proxyId,name:"hack-dev-proxy-caddy-1",project:"hack-dev-proxy"}:proxyId));
 }
} else if(args[0]==="container" && args[1]==="inspect") {
 const format=args[args.indexOf("--format")+1]??"";
 console.log(JSON.stringify(format.includes("sites")?{id:proxyId,project:"hack-dev-proxy",owner:null,instance:null,generation:null,sites:[null]}:{id:proxyId,project:"hack-dev-proxy",service:"caddy",running:true,network:networkId,ip:"172.29.0.2"}));
} else if(!(["network","volume"].includes(args[0]) && args[1]==="ls")) process.exit(97);
`
  );
}

async function createdSavedTransport(fixture: {
  root: string;
  identity: { composeProject: string; ownerToken: string };
  generationId: string;
}) {
  const { root, identity, generationId } = fixture;
  const network = `${identity.composeProject}_default`;
  const name = `${identity.composeProject}-web-1`;
  const container = {
    id: "c".repeat(64),
    name: `/${name}`,
    project: identity.composeProject,
    version: "1",
    instance: identity.composeProject,
    owner: identity.ownerToken,
    generation: generationId,
    service: "web",
    oneoff: "False",
    state: "created",
    exitCode: 0,
    health: null,
    networks: { [network]: { NetworkID: "", Aliases: [name, "web"] } },
  };
  const bridge = {
    id: "d".repeat(64),
    name: network,
    project: identity.composeProject,
    version: "1",
    instance: identity.composeProject,
    owner: identity.ownerToken,
    driver: "bridge",
    internal: false,
    containers: {},
  };
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import {writeFileSync} from "node:fs";
const args=process.argv.slice(2), container=${JSON.stringify(container)}, bridge=${JSON.stringify(bridge)};
if (args[0]==="compose" && args.includes("logs")) {console.log("synthetic pending logs");process.exit(0);}
if (["container","network","volume"].includes(args[0]) && ["ls","inspect"].includes(args[1])) {
 const row=args[0]==="container"?container:args[0]==="network"?bridge:null;
 if (row) console.log(JSON.stringify(args[1]==="ls"?{id:row.id,name:row.name.replace(/^\\//,""),project:row.project}:row));
 process.exit(0);
}
writeFileSync(${JSON.stringify(join(root, "unexpected-engine-effect"))},JSON.stringify(args));process.exit(99);
`
  );
}

test.each([
  "ps",
  "logs",
  "exec",
] as const)("saved %s handles created workloads without granting mutation authority", async (operation) => {
  const fixture = await savedFixture(
    operation === "exec" ? "complete" : "uncertain"
  );
  await createdSavedTransport(fixture);
  const args =
    operation === "exec"
      ? ["exec", "web", "--", "true"]
      : operation === "ps"
        ? ["ps", "--json"]
        : ["logs"];
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), ...args],
    {
      cwd: fixture.root,
      env: {
        PATH: `${fixture.root}:/usr/bin:/bin`,
        HOME: join(fixture.root, "home"),
        HACK_HOME: join(fixture.root, "home"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
        HACK_NO_INTERACTIVE: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(operation === "exec" ? 1 : 0);
  const output = await stdout;
  const diagnostic = await stderr;
  if (operation === "ps") {
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      data: {
        pending: true,
        services: [{ service: "web", status: "created" }],
      },
    });
  } else if (operation === "logs") {
    expect(output).toContain("synthetic pending logs");
  } else {
    expect(`${output}\n${diagnostic}`).toContain("E_CONFIG_INVALID");
  }
  expect(diagnostic).not.toContain("invalid authored input");
  expect(await readdir(fixture.leases)).toEqual([]);
  expect(
    await Bun.file(join(fixture.root, "unexpected-engine-effect")).exists()
  ).toBe(false);
}, 20_000);

async function recoverSavedStop(root: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "down",
      "--recover",
      "--json",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return {
    exit: await child.exited,
    outputs: await Promise.all([stdout, stderr]),
  };
}

test("saved ps reports pending state after an incomplete first startup", async () => {
  const { root, leases } = await savedFixture("uncertain");
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), "ps", "--json"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await stdout)).toMatchObject({
    ok: true,
    data: { stopped: true, pending: true, services: [] },
  });
  expect(await stderr).not.toContain("invalid authored input");
  expect(await readdir(leases)).toEqual([]);
}, 20_000);

test.each([
  { operation: "exec", routed: false },
  { operation: "logs", routed: false },
  { operation: "ps", routed: false },
  { operation: "exec", routed: true },
  { operation: "logs", routed: true },
  { operation: "ps", routed: true },
] as const)("saved $operation forwards cancellation with routing $routed and releases the lease", async ({
  operation,
  routed,
}) => {
  const { root, leases } = await savedFixture("complete", routed);
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      operation,
      ...(operation === "exec" ? ["web", "--", "sleep", "60"] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  const deadline = Date.now() + 15_000;
  let pid = 0;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await Bun.file(join(root, "started")).exists()) {
      pid = Number(await readFile(join(root, "started"), "utf8"));
      break;
    }
    await Bun.sleep(20);
  }
  expect(pid).toBeGreaterThan(1);
  expect((await readdir(leases)).length).toBe(1);
  child.kill("SIGTERM");
  const exit = await Promise.race([
    child.exited,
    Bun.sleep(5000).then(() => -1),
  ]);
  const outputs = await Promise.all([stdout, stderr]);
  expect(exit).toBe(143);
  expect(await Bun.file(join(root, "stopped")).text()).toBe("reaped");
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await readdir(leases)).toEqual([]);
  expect(outputs.join("")).not.toContain("invalid authored input");
  expect(await Bun.file(join(root, "ingress-read")).exists()).toBe(false);
}, 20_000);

test.each([
  "complete",
  "uncertain",
  "interrupted-hook",
] as const)("saved routed stop after %s startup runs before retained-claims diagnostics", async (outcome) => {
  const { root, generationId, routeReference } = await savedFixture(
    outcome === "uncertain" ? "uncertain" : "complete",
    true
  );
  if (outcome === "interrupted-hook") {
    const hookOwner = await openNativeComposeGenerationStore({
      projectRoot: root,
      instance: null,
      mode: "prepare",
    });
    try {
      await hookOwner.withMutation((mutation) =>
        mutation.runBeforeHooks({
          assertFresh: async () => {},
          effect: async () => ({ outcome: "uncertain", value: 143 }),
        })
      );
    } finally {
      await hookOwner.close();
    }
  }
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
if (args[0] === "compose") {
  if (!args.includes("down")) process.exit(88);
  writeFileSync(root + "/owned-stop", "complete");
  process.exit(0);
}
if (args[0] === "info") { console.error("private-routing-canary"); process.exit(23); }
process.exit(0);
`
  );
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "down",
      "--json",
      ...(outcome === "uncertain" ? ["--recover"] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  const outputs = await Promise.all([stdout, stderr]);
  expect(outputs.join("")).toContain("Owned native Compose containers stopped");
  expect(outputs.join("")).not.toContain("private-routing-canary");
  expect(outputs.join("")).not.toContain("invalid authored input");
  if (outcome === "interrupted-hook") {
    expect(outputs.join("")).toContain("E_LIFECYCLE_FAILED");
    expect(outputs.join("")).toContain(
      "routing claims and the recovery generation are retained"
    );
    expect(outputs.join("")).toContain("host hook");
  }
  expect(await Bun.file(join(root, "owned-stop")).text()).toBe("complete");
  const commands: string[][] = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const stopped = commands.findIndex(
    (args) => args[0] === "compose" && args.includes("down")
  );
  expect(stopped).toBeGreaterThanOrEqual(0);
  const ingress = commands.findIndex((args) => args[0] === "info");
  if (outcome !== "interrupted-hook") {
    expect(ingress).toBeGreaterThan(stopped);
  } else {
    expect(ingress).toBe(-1);
  }
  expect(commands[stopped]).not.toContain("--volumes");
  const saved = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const current = await saved.loadCurrent();
    expect(current.stopped).toBe(outcome === "uncertain");
    expect(current.pending?.generationId).toBe(generationId);
    const recovery = await saved.loadPending();
    if (!recovery) {
      throw new Error("Lost stop recovery generation");
    }
    expect(
      readNativeComposeRouteMetadata({
        generationId: recovery.generationId,
        document: await saved.readGenerationDocument(recovery),
      })?.reference
    ).toEqual(routeReference);
    expect(current.beforeHooksPending).toBe(outcome === "interrupted-hook");
  } finally {
    await saved.close();
  }
  const foreign = await openNativeComposeRouteClaims({
    root: join(root, "home", "compose-routing"),
    binding: {
      engineId: "fixture-engine:1",
      proxyId: "a".repeat(64),
      networkId: "b".repeat(64),
    },
    owner: {
      composeProject: "foreign-native-fixture",
      ownerToken: "e".repeat(32),
    },
  });
  try {
    await expect(
      foreign.acquire({
        hostnames: ["fixture.dev.test"],
        generationIdentity: "f".repeat(32),
      })
    ).rejects.toThrow();
    await verifiedStopTransport(root);
    const retry = await recoverSavedStop(root);
    expect(retry.exit, retry.outputs.join("")).toBe(
      outcome === "interrupted-hook" ? 1 : 0
    );
    expect(retry.outputs.join("")).not.toContain("invalid authored input");
    if (outcome === "interrupted-hook") {
      expect(retry.outputs.join("")).toContain("E_LIFECYCLE_FAILED");
      await expect(
        foreign.acquire({
          hostnames: ["fixture.dev.test"],
          generationIdentity: "f".repeat(32),
        })
      ).rejects.toThrow();
    } else {
      const replacement = await foreign.acquire({
        hostnames: ["fixture.dev.test"],
        generationIdentity: "f".repeat(32),
      });
      await foreign.rollback(replacement);
    }
    const recovered = await openNativeComposeGenerationStore({
      projectRoot: root,
      instance: null,
      mode: "saved",
    });
    try {
      const current = await recovered.loadCurrent();
      expect(current.generation?.generationId).toBe(generationId);
      expect(current.pending === null).toBe(outcome !== "interrupted-hook");
      expect(current.beforeHooksPending).toBe(outcome === "interrupted-hook");
    } finally {
      await recovered.close();
    }
  } finally {
    await foreign.close();
  }
}, 20_000);
