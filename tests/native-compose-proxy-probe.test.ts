import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeProxyAccess,
  assertNativeComposeProxyRoutes,
  NativeComposeProxyAccessError,
} from "../src/lib/native-compose-proxy-routes.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";
import { restoreEnv } from "./helpers/env.ts";

const ENGINE = "synthetic-route-engine";
const NETWORK = "a".repeat(64);
const PROXY = "b".repeat(64);
const WEB = "c".repeat(64);
const REPLICA = "d".repeat(64);
const REPLACEMENT = "e".repeat(64);
const PROJECT = "hack-nc-proxy-probe";
const OWNER = "f".repeat(32);
const GENERATION = "1".repeat(32);
const HOST = "app.v5.hack.gy";
const OLD = "old.v5.hack.gy";
const CANARY = "synthetic-private-active-proxy-canary";
const ADMIN_GET = "http://127.0.0.1:2019/config/apps/http/servers";
const ADMIN_COMMAND = [
  "exec",
  PROXY,
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
  ADMIN_GET,
] as const;
const ACCESS_MESSAGE =
  "Native Compose routing needs the verified live Caddy API reader. Refresh the global runtime template with hack global install or the guided hack doctor --fix repair, retaining caddy_data, before restarting it. Values omitted.";
const BINDING = {
  engineId: ENGINE,
  networkId: NETWORK,
  proxyId: PROXY,
  proxyIp: "172.29.0.2",
};
let root: string;
let path: string | undefined;

function workload() {
  return {
    id: WEB,
    project: PROJECT,
    owner: OWNER,
    instance: PROJECT,
    generation: GENERATION,
    service: "web",
    oneoff: "False",
    running: true,
    network: NETWORK,
    ip: "172.29.0.3",
  };
}
function active(hosts = [HOST], dials = ["172.29.0.3:3000"]) {
  return {
    srv0: {
      routes: [
        {
          match: [{ host: hosts }],
          handle: [
            {
              handler: "reverse_proxy",
              upstreams: dials.map((dial) => ({ dial })),
            },
          ],
        },
      ],
    },
  };
}
function options() {
  return {
    binding: { ...BINDING },
    composeProject: PROJECT,
    ownerToken: OWNER,
    generationId: GENERATION,
    routes: [
      {
        hostnames: [HOST],
        service: "web",
        port: 3000,
        protocol: "http" as const,
      },
    ],
    absentHostnames: [OLD],
    deadline: Date.now() + 5000,
  };
}

beforeEach(async () => {
  path = process.env.PATH;
  root = await mkdtemp(join(tmpdir(), "native-proxy-probe-"));
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
const permitted = kind === "exec"
 ? JSON.stringify(args) === JSON.stringify(${JSON.stringify(ADMIN_COMMAND)})
 : args.includes("--format") && (kind === "info" || (kind === "network" && action === "inspect") || (kind === "container" && ["ls", "inspect"].includes(action)));
if (!permitted) { writeFileSync(root + "/mutated", "unexpected command"); process.exit(99); }
function count(key) {
 const file = root + "/" + key;
 const value = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
 writeFileSync(file, String(value + 1)); return value;
}
if (f.mode === "hang" || (f.mode === "wait" && !existsSync(root + "/started"))) {
 writeFileSync(root + "/started", String(process.pid));
 await Bun.sleep(f.mode === "hang" ? 60_000 : 75);
}
if (kind === "info") console.log(JSON.stringify(${JSON.stringify(ENGINE)}));
else if (kind === "network") console.log(JSON.stringify({id: ${JSON.stringify(NETWORK)}, name: "hack-dev"}));
else if (kind === "exec") {
 if (f.mode === "access-hang") { writeFileSync(root + "/started", String(process.pid)); await Bun.sleep(60_000); }
 if (f.mode === "active-fail") { console.error(${JSON.stringify(CANARY)}); process.exit(23); }
 if (f.mode === "active-malformed") { console.log(${JSON.stringify(CANARY)}); process.exit(0); }
 const index = count("active-count");
 const servers = f.activeSnapshots?.[Math.min(index, f.activeSnapshots.length - 1)] ?? f.active ?? ${JSON.stringify(active())};
 process.stdout.write(f.rawOutput ?? JSON.stringify(servers) + String.fromCharCode(10) + (f.status ?? "200"));
} else if (action === "ls" && args.includes("label=com.docker.compose.project=hack-dev-proxy")) {
 const replaced = f.mode === "replacement" && count("proxy-lists") >= 2;
 console.log(JSON.stringify(replaced ? ${JSON.stringify(REPLACEMENT)} : ${JSON.stringify(PROXY)}));
} else if (action === "ls") {
 const index = count("workload-lists");
 writeFileSync(root + "/selected-workload-index", String(index));
 const selected = f.workloadSnapshots?.[Math.min(index, f.workloadSnapshots.length - 1)] ?? f;
 for (const id of selected.ids ?? [${JSON.stringify(WEB)}]) console.log(JSON.stringify(id));
} else if ([${JSON.stringify(PROXY)}, ${JSON.stringify(REPLACEMENT)}].includes(args.at(-1))) {
 console.log(JSON.stringify({id: args.at(-1), project: "hack-dev-proxy", service: "caddy", running: true, network: ${JSON.stringify(NETWORK)}, ip: "172.29.0.2"}));
} else {
 const index = Number(readFileSync(root + "/selected-workload-index", "utf8"));
 const selected = f.workloadSnapshots?.[Math.min(index, f.workloadSnapshots.length - 1)] ?? f;
 const ids = args.slice(args.indexOf("--format") + 2);
 const rows = selected.rows ?? [${JSON.stringify(workload())}];
 for (const row of selected.overrideRows ?? rows.filter(value => ids.includes(value.id))) console.log(JSON.stringify(row));
}
`
  );
  await chmod(join(root, "docker"), 0o700);
});
afterEach(async () => {
  restoreEnv("PATH", path);
  await rm(root, { recursive: true, force: true });
});

async function prepare(value: unknown): Promise<void> {
  for (const counter of [
    "active-count",
    "proxy-lists",
    "workload-lists",
    "selected-workload-index",
  ]) {
    await rm(join(root, counter), { force: true });
  }
  await Bun.write(join(root, "fixture.json"), JSON.stringify(value));
}
async function refusal(
  opts: Parameters<typeof assertNativeComposeProxyRoutes>[0] = options()
): Promise<void> {
  try {
    await assertNativeComposeProxyRoutes(opts);
    throw new Error("Unexpected proxy acceptance");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NativeComposeRoutingError);
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
}
async function accessRefusal(
  opts: Parameters<typeof assertNativeComposeProxyAccess>[0] = {
    binding: BINDING,
  }
): Promise<void> {
  let reachedProjectEffect = false;
  try {
    await assertNativeComposeProxyAccess(opts);
    reachedProjectEffect = true;
    throw new Error("Unexpected proxy access acceptance");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NativeComposeProxyAccessError);
    expect(error).toMatchObject({
      code: "E_NATIVE_COMPOSE_PROXY_ACCESS",
      name: "NativeComposeProxyAccessError",
      message: ACCESS_MESSAGE,
    });
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
  expect(reachedProjectEffect).toBe(false);
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
}
async function commands(): Promise<string[][]> {
  return (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function readOnlyCommands(): Promise<string[][]> {
  const observed = await commands();
  expect(observed.flat()).not.toContain("wget");
  for (const args of observed) {
    if (args[0] === "exec") {
      expect(args).toEqual([...ADMIN_COMMAND]);
    } else {
      expect(args.includes("--format")).toBe(true);
      expect(
        args[0] === "info" ||
          (args[0] === "network" && args[1] === "inspect") ||
          (args[0] === "container" && ["ls", "inspect"].includes(args[1] ?? ""))
      ).toBe(true);
    }
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
  return observed;
}
async function startedPid(): Promise<number> {
  const deadline = Date.now() + 2000;
  while (
    !(await Bun.file(join(root, "started")).exists()) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(join(root, "started")).exists()).toBe(true);
  return Number(await readFile(join(root, "started"), "utf8"));
}

test("proxy confirmation uses exact read-only GET and two current workload/upstream observations", async () => {
  await assertNativeComposeProxyRoutes(options());
  const observed = await commands();
  const reads = observed.filter((args) => args[0] === "exec");
  expect(reads).toEqual([[...ADMIN_COMMAND], [...ADMIN_COMMAND]]);
  expect(
    observed.filter(
      (args) =>
        args[0] === "container" &&
        args[1] === "ls" &&
        args.includes(`label=com.docker.compose.project=${PROJECT}`)
    )
  ).toHaveLength(2);
  for (const args of observed.filter((args) => args[0] !== "exec")) {
    const format = args[args.indexOf("--format") + 1] ?? "";
    expect(format).not.toContain(".Config.Env");
    expect(format).not.toContain(".Config.Image");
    expect(format).not.toContain("{{json .}}");
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});
test("curl completion must include exact 200 status; redirects and malformed suffixes refuse", async () => {
  for (const fixture of [
    { status: "204" },
    { status: "301" },
    { status: "302" },
    { status: "307" },
    { status: "401" },
    { status: "500" },
    { status: "0200" },
    { status: "200\n" },
    { status: `200 ${CANARY}` },
    { rawOutput: JSON.stringify(active()) },
    { rawOutput: `${JSON.stringify(active())}200` },
    { rawOutput: "\n200" },
    { rawOutput: "null\n200" },
    { rawOutput: `${CANARY}\n200` },
  ]) {
    await prepare(fixture);
    await refusal();
  }
  await readOnlyCommands();
}, 10_000);
test("proxy access preflight reads the exact live API without workload queries or mutation", async () => {
  await prepare({
    active: { srv0: { ...active().srv0, unselected_private: CANARY } },
  });
  expect(
    await assertNativeComposeProxyAccess({ binding: BINDING })
  ).toBeUndefined();
  const observed = await readOnlyCommands();
  expect(observed.filter((args) => args[0] === "exec")).toEqual([
    [...ADMIN_COMMAND],
  ]);
  expect(observed.filter((args) => args[0] === "info")).toHaveLength(4);
  for (const args of observed.filter((args) => args[1] === "ls")) {
    expect(args).toContain("label=com.docker.compose.project=hack-dev-proxy");
    expect(args).not.toContain(`label=com.docker.compose.project=${PROJECT}`);
  }
});
test("proxy access failures stay fixed and redacted before the caller can perform project effects", async () => {
  for (const fixture of [
    { mode: "active-fail" },
    { mode: "active-malformed" },
    { mode: "replacement" },
    { status: "301" },
    { status: "403" },
    { status: `200 ${CANARY}` },
    { rawOutput: `${CANARY}\n200` },
    { active: { srv0: { routes: CANARY } } },
  ]) {
    await prepare(fixture);
    await accessRefusal();
  }
  await readOnlyCommands();
}, 10_000);
test("proxy access snapshots its binding before probing", async () => {
  await prepare({ mode: "wait" });
  const selected = { binding: { ...BINDING } };
  const task = assertNativeComposeProxyAccess(selected);
  await startedPid();
  selected.binding.proxyId = REPLACEMENT;
  selected.binding.proxyIp = "172.29.0.99";
  await task;
  await readOnlyCommands();
});
test("proxy access pre-abort spawns nothing and cancellation reaps the exact API reader", async () => {
  const aborted = new AbortController();
  aborted.abort();
  await accessRefusal({ binding: BINDING, signal: aborted.signal });
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
  await prepare({ mode: "access-hang" });
  const controller = new AbortController();
  const task = accessRefusal({ binding: BINDING, signal: controller.signal });
  const pid = await startedPid();
  controller.abort();
  await task;
  expect(() => process.kill(pid, 0)).toThrow();
  const observed = await readOnlyCommands();
  expect(observed.at(-1)).toEqual([...ADMIN_COMMAND]);
});
test("all exact current replica IPs must appear in the active proxy dial pool", async () => {
  await prepare({
    ids: [REPLICA, WEB],
    rows: [workload(), { ...workload(), id: REPLICA, ip: "172.29.0.4" }],
    active: active([HOST], ["172.29.0.4:3000", "172.29.0.3:3000"]),
  });
  await assertNativeComposeProxyRoutes(options());
});
test("replacement global proxy during confirmation refuses after the first successful active read", async () => {
  await prepare({ mode: "replacement" });
  await refusal();
  expect((await commands()).filter((args) => args[0] === "exec")).toHaveLength(
    1
  );
});
test("current replica ownership, generation, network and running state are required", async () => {
  for (const changed of [
    { owner: "0".repeat(32) },
    { generation: "2".repeat(32) },
    { project: "foreign-project" },
    { instance: "foreign-instance" },
    { network: REPLACEMENT },
    { running: false },
    { ip: "::1" },
    { ip: CANARY },
    { oneoff: "True" },
    { service: "other" },
  ]) {
    await prepare({ rows: [{ ...workload(), ...changed }] });
    await refusal();
  }
}, 10_000);
test("second workload snapshot cannot replace the selected generation with an old one", async () => {
  await prepare({
    workloadSnapshots: [
      { rows: [workload()] },
      { rows: [{ ...workload(), generation: "2".repeat(32) }] },
    ],
  });
  await refusal();
  expect((await commands()).filter((args) => args[0] === "exec")).toHaveLength(
    1
  );
});
test("missing replicas, duplicate IDs, duplicate rows and unsolicited fields refuse redacted", async () => {
  for (const fixture of [
    { ids: [] },
    { ids: [WEB, WEB] },
    { ids: [CANARY] },
    { ids: [null] },
    { overrideRows: [] },
    { overrideRows: [workload(), workload()] },
    {
      ids: [WEB, REPLICA],
      overrideRows: [workload(), workload()],
    },
    { overrideRows: [{ ...workload(), id: REPLICA }] },
    { rows: [{ ...workload(), private: CANARY }] },
    { mode: "active-fail" },
    { mode: "active-malformed" },
    { active: { srv0: { routes: CANARY } } },
  ]) {
    await prepare(fixture);
    await refusal();
  }
}, 10_000);
test("wrong active upstream and still-active obsolete hosts refuse within the caller deadline", async () => {
  for (const servers of [
    active([HOST], ["172.29.0.9:3000"]),
    active([HOST, OLD]),
    active(["*.v5.hack.gy"]),
  ]) {
    await prepare({ active: servers });
    await refusal({ ...options(), deadline: Date.now() + 600 });
  }
});
test("retirement without selected routes still checks the active proxy host set", async () => {
  await prepare({ active: {} });
  await assertNativeComposeProxyRoutes({
    ...options(),
    routes: [],
    absentHostnames: [HOST],
  });
  expect((await commands()).some((args) => args.at(-1) === WEB)).toBe(false);
  await prepare({ active: active() });
  await refusal({
    ...options(),
    routes: [],
    absentHostnames: [HOST],
    deadline: Date.now() + 600,
  });
});
test("proxy snapshots binding, route hostnames and retirement policy before await", async () => {
  await prepare({ mode: "wait" });
  const selected = options();
  const task = assertNativeComposeProxyRoutes(selected);
  await startedPid();
  selected.binding.proxyId = REPLACEMENT;
  selected.binding.proxyIp = "172.29.0.99";
  selected.composeProject = "changed-project";
  selected.ownerToken = "0".repeat(32);
  selected.generationId = "2".repeat(32);
  selected.absentHostnames.push(HOST);
  const route = selected.routes[0];
  if (!route) {
    throw new Error("Snapshot fixture route is missing");
  }
  route.hostnames[0] = OLD;
  route.port = 9999;
  await task;
});
test("expired deadline and pre-abort spawn nothing; active cancellation reaps the probe", async () => {
  await refusal({ ...options(), deadline: Date.now() - 1 });
  const aborted = new AbortController();
  aborted.abort();
  await refusal({ ...options(), signal: aborted.signal });
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
  await prepare({ mode: "hang" });
  const controller = new AbortController();
  const task = refusal({ ...options(), signal: controller.signal });
  const pid = await startedPid();
  controller.abort();
  await task;
  expect(() => process.kill(pid, 0)).toThrow();
});
