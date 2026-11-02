import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeNativeComposeIngress } from "../src/lib/native-compose-ingress.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";
import { restoreEnv } from "./helpers/env.ts";

const ENGINE = "synthetic-engine";
const NETWORK = "a".repeat(64);
const PROXY = "b".repeat(64);
const CANARY = "synthetic-private-ingress-canary";
const binding = {
  engineId: ENGINE,
  networkId: NETWORK,
  proxyId: PROXY,
  proxyIp: "172.29.0.2",
};
let root: string;
let path: string | undefined;

beforeEach(async () => {
  path = process.env.PATH;
  root = await mkdtemp(join(tmpdir(), "native-compose-ingress-"));
  process.env.PATH = root;
  await Bun.write(join(root, "fixture.json"), "{}");
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
const f = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const [kind, action] = args;
if (!args.includes("--format") || !(kind === "info" || (kind === "network" && action === "inspect") || (kind === "container" && ["ls", "inspect"].includes(action)))) {
 writeFileSync(root + "/mutated", "unexpected command"); process.exit(99);
}
if (f.mode === "fail") { console.error(${JSON.stringify(CANARY)}); process.exit(23); }
if (f.mode === "malformed") { console.log(${JSON.stringify(CANARY)}); process.exit(0); }
if (f.mode === "overflow") { await Bun.write(Bun.stdout, "x".repeat(9 * 1024 * 1024)); process.exit(0); }
if (f.mode === "hang") { writeFileSync(root + "/started", String(process.pid)); await Bun.sleep(60_000); }
if (kind === "info") {
 const counter = root + "/info-count";
 const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
 writeFileSync(counter, String(count + 1));
 console.log(JSON.stringify(f.engine ?? (f.mode === "replacement" && count > 0 ? "other-engine" : ${JSON.stringify(ENGINE)})));
} else if (kind === "network") {
 console.log(JSON.stringify(f.network ?? {id: ${JSON.stringify(NETWORK)}, name: "hack-dev"}));
} else if (action === "ls") {
 for (const id of f.ids ?? [${JSON.stringify(PROXY)}]) console.log(JSON.stringify(id));
} else {
 console.log(JSON.stringify(f.proxy ?? {id: ${JSON.stringify(PROXY)}, project: "hack-dev-proxy", service: "caddy", running: true, network: ${JSON.stringify(NETWORK)}, ip: "172.29.0.2"}));
}
`
  );
  await chmod(join(root, "docker"), 0o700);
});
afterEach(async () => {
  restoreEnv("PATH", path);
  await rm(root, { recursive: true, force: true });
});

async function prepare(value: unknown) {
  await rm(join(root, "info-count"), { force: true });
  await Bun.write(join(root, "fixture.json"), JSON.stringify(value));
}
async function refusal(signal?: AbortSignal) {
  try {
    await observeNativeComposeIngress({ signal });
    throw new Error("unexpected ingress acceptance");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NativeComposeRoutingError);
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
}

test("binds only a running global proxy on its exact engine and external network", async () => {
  const observed = await observeNativeComposeIngress();
  expect(observed).toEqual(binding);
  expect(Object.isFrozen(observed)).toBe(true);
  const commands: string[][] = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands).toHaveLength(8);
  for (const args of commands) {
    const format = args[args.indexOf("--format") + 1] ?? "";
    expect(format).not.toContain(".Config.Env");
    expect(format).not.toContain(".Config.Image");
    expect(format).not.toContain("{{json .}}");
    if (args[0] === "container" && args[1] === "inspect") {
      expect(args.at(-1)).toBe(PROXY);
    }
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});
test("binding comparisons are field based and refuse changed identities", async () => {
  expect(
    await observeNativeComposeIngress({
      expected: {
        proxyIp: binding.proxyIp,
        proxyId: binding.proxyId,
        networkId: binding.networkId,
        engineId: binding.engineId,
      },
    })
  ).toEqual(binding);
  await expect(
    observeNativeComposeIngress({
      expected: { ...binding, proxyId: "c".repeat(64) },
    })
  ).rejects.toBeInstanceOf(NativeComposeRoutingError);
  await prepare({ mode: "replacement" });
  await refusal();
});
test("missing, ambiguous, stopped, foreign and disconnected proxy selections refuse", async () => {
  for (const fixture of [
    { ids: [] },
    { ids: [PROXY, "c".repeat(64)] },
    { ids: ["short-id"] },
    { engine: "" },
    { network: { id: NETWORK, name: "other" } },
    {
      proxy: {
        id: PROXY,
        project: "other",
        service: "caddy",
        running: true,
        network: NETWORK,
        ip: "172.29.0.2",
      },
    },
    {
      proxy: {
        id: PROXY,
        project: "hack-dev-proxy",
        service: "caddy",
        running: false,
        network: NETWORK,
        ip: "172.29.0.2",
      },
    },
    {
      proxy: {
        id: PROXY,
        project: "hack-dev-proxy",
        service: "caddy",
        running: true,
        network: null,
        ip: null,
      },
    },
  ]) {
    await prepare(fixture);
    await refusal();
  }
});
test("malformed, failed and oversized engine output stays redacted", async () => {
  for (const mode of ["fail", "malformed", "overflow"]) {
    await prepare({ mode });
    await refusal();
  }
});
test("cancellation reaps the owned read-only probe", async () => {
  await prepare({ mode: "hang" });
  const controller = new AbortController();
  const task = refusal(controller.signal);
  const deadline = Date.now() + 5000;
  while (
    !(await Bun.file(join(root, "started")).exists()) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(join(root, "started")).exists()).toBe(true);
  const pid = Number(await readFile(join(root, "started"), "utf8"));
  controller.abort();
  await task;
  expect(() => process.kill(pid, 0)).toThrow();
});
