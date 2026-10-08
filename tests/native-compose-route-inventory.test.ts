import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativeComposeRouteInventory } from "../src/lib/native-compose-route-inventory.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROJECT = "hack-nc-inventory";
const OWNER = "a".repeat(32);
const GENERATION = "b".repeat(32);
const ID = "c".repeat(64);
const OTHER_ID = "d".repeat(64);
const HOST = "app.v5.hack.gy";
const OTHER_HOST = "unrelated.v5.hack.gy";
const CANARY = "synthetic-private-route-inventory-canary";
let root: string;
let path: string | undefined;

function row(sites: unknown[] = [null]) {
  return {
    id: ID,
    project: null,
    owner: null,
    instance: null,
    generation: null,
    sites,
  };
}
function options() {
  return {
    composeProject: PROJECT,
    ownerToken: OWNER,
    hostnames: [HOST],
  };
}

beforeEach(async () => {
  path = process.env.PATH;
  root = await mkdtemp(join(tmpdir(), "native-route-inventory-"));
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
if (!(args[0] === "container" && ["ls", "inspect"].includes(args[1]) && args.includes("--format"))) {
 writeFileSync(root + "/mutated", "unexpected command"); process.exit(99);
}
if (f.mode === "fail") { console.error(${JSON.stringify(CANARY)}); process.exit(23); }
if (f.mode === "malformed") { console.log(${JSON.stringify(CANARY)}); process.exit(0); }
if (f.mode === "hang" || (f.mode === "wait" && !existsSync(root + "/started"))) {
 writeFileSync(root + "/started", String(process.pid));
 await Bun.sleep(f.mode === "hang" ? 60_000 : 75);
}
const counter = root + "/pass";
if (args[1] === "ls") {
 const pass = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 0;
 writeFileSync(counter, String(pass));
 const snapshot = f.snapshots?.[Math.min(pass, f.snapshots.length - 1)] ?? f;
 for (const id of snapshot.ids ?? [${JSON.stringify(ID)}]) console.log(JSON.stringify(id));
} else {
 const pass = Number(readFileSync(counter, "utf8"));
 const snapshot = f.snapshots?.[Math.min(pass, f.snapshots.length - 1)] ?? f;
 const selected = args.slice(args.indexOf("--format") + 2);
 const rows = snapshot.rows ?? [${JSON.stringify(row())}];
 for (const value of snapshot.overrideRows ?? rows.filter(value => selected.includes(value.id))) console.log(JSON.stringify(value));
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
  await rm(join(root, "pass"), { force: true });
  await Bun.write(join(root, "fixture.json"), JSON.stringify(value));
}
async function refusal(
  opts: Parameters<typeof assertNativeComposeRouteInventory>[0] = options()
): Promise<void> {
  try {
    await assertNativeComposeRouteInventory(opts);
    throw new Error("Unexpected inventory acceptance");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NativeComposeRoutingError);
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
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

test("route inventory reads only public site labels in two independent snapshots", async () => {
  await assertNativeComposeRouteInventory(options());
  const commands: string[][] = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands).toHaveLength(4);
  for (const args of commands) {
    expect(args.slice(0, 2)).toEqual([
      "container",
      args[1] === "ls" ? "ls" : "inspect",
    ]);
    const format = args[args.indexOf("--format") + 1] ?? "";
    expect(format).not.toContain(".Config.Env");
    expect(format).not.toContain(".Config.Image");
    expect(format).not.toContain("{{json .}}");
    if (args[1] === "ls") {
      expect(args).toEqual([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--format",
        "{{json .ID}}",
      ]);
    } else {
      expect(args.at(-1)).toBe(ID);
      expect(format).toContain("caddy_ingress_network");
    }
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});
test("foreign exact, wildcard, catchall and multi-site claims refuse", async () => {
  for (const site of [
    HOST,
    `HTTPS://${HOST.toUpperCase()}:443`,
    "*.v5.hack.gy",
    "https://*.v5.hack.gy",
    "*",
    ":443",
    `${OTHER_HOST}, ${HOST}`,
    `https://user:${CANARY}@${HOST}`,
  ]) {
    await prepare({ rows: [row([site, null])] });
    await refusal();
  }
});
test("unrelated new containers between snapshots are accepted; a new collision is refused", async () => {
  const first = { ids: [ID], rows: [row()] };
  const second = {
    ids: [OTHER_ID, ID],
    rows: [row(), { ...row([OTHER_HOST, null]), id: OTHER_ID }],
  };
  await prepare({ snapshots: [first, second] });
  await assertNativeComposeRouteInventory(options());
  await prepare({
    snapshots: [
      first,
      { ...second, rows: [row(), { ...row([HOST, null]), id: OTHER_ID }] },
    ],
  });
  await refusal();
});
test("inventory batches inspect arguments without limiting total observed containers", async () => {
  const selected = Array.from({ length: 65 }, (_, index) =>
    index.toString(16).padStart(64, "0")
  );
  await prepare({
    ids: selected,
    rows: selected.map((id) => ({ ...row(), id })),
  });
  await assertNativeComposeRouteInventory(options());
  const commands: string[][] = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    commands
      .filter((args) => args[1] === "inspect")
      .map((args) => args.length - args.indexOf("--format") - 2)
  ).toEqual([64, 1, 64, 1]);
});
test("same-owner routes require the selected generation and explicit retirement absence", async () => {
  const owned = {
    ...row([HOST, null]),
    project: PROJECT,
    instance: PROJECT,
    owner: OWNER,
    generation: GENERATION,
  };
  await prepare({ rows: [owned] });
  await assertNativeComposeRouteInventory({
    ...options(),
    requireGenerationId: GENERATION,
  });
  await refusal({ ...options(), requireGenerationId: "e".repeat(32) });
  await refusal({ ...options(), requireAbsent: true });
  await prepare({ rows: [{ ...owned, owner: "f".repeat(32) }] });
  await refusal();
});
test("duplicate IDs and malformed or unsolicited inspect rows stay redacted", async () => {
  for (const fixture of [
    { ids: [ID, ID] },
    { ids: ["short"] },
    { ids: [null] },
    { overrideRows: [] },
    { overrideRows: [row(), row()] },
    { ids: [ID, OTHER_ID], overrideRows: [row(), row()] },
    { overrideRows: [null] },
    { overrideRows: [{ ...row(), id: OTHER_ID }] },
    { rows: [{ ...row(), private: CANARY }] },
    { rows: [{ ...row(), project: { private: CANARY } }] },
    { rows: [{ ...row(), owner: [CANARY] }] },
    { rows: [{ ...row(), instance: 17 }] },
    { rows: [{ ...row(), generation: false }] },
    { rows: [row([])] },
    { rows: [row([HOST])] },
    { rows: [row([CANARY, 17, null])] },
    { mode: "fail" },
    { mode: "malformed" },
  ]) {
    await prepare(fixture);
    await refusal();
  }
}, 10_000);
test("inventory snapshots caller hostnames and policy before its first awaited probe", async () => {
  await prepare({ mode: "wait", rows: [row([OTHER_HOST, null])] });
  const selected = options();
  const task = assertNativeComposeRouteInventory(selected);
  await startedPid();
  selected.hostnames[0] = OTHER_HOST;
  selected.composeProject = "changed-project";
  selected.ownerToken = "f".repeat(32);
  await task;
});
test("pre-aborted inventory spawns nothing; active cancellation reaps its read-only probe", async () => {
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
