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
import { prepareNativeComposeRouteOwner } from "../src/lib/native-compose-route-owner.ts";
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
        effect: async () => {
          await routing?.markEffectsPossible();
          if (outcome === "complete") {
            await routing?.verifyTransition({ deadline: Date.now() + 5000 });
          }
          return { outcome, value: 0 };
        },
      });
      if (outcome === "complete") {
        await routing?.complete();
      }
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
  return { root, leases, identity: owner.identity };
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
] as const)("saved routed stop after %s startup runs before retained-claims diagnostics", async (outcome) => {
  const { root } = await savedFixture(outcome, true);
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
  if (outcome === "complete") {
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
    expect(current.stopped).toBe(true);
    expect(current.pending).toBeNull();
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
  } finally {
    await foreign.close();
  }
}, 20_000);
