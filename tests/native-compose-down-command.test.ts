import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture, invoke, state } from "./helpers/native-compose-command.ts";

const append = (line: string) =>
  `await import("node:fs/promises").then(m=>m.appendFile("order",${JSON.stringify(`${line}\n`)}));`;
async function started(after: string, before = append("down-before")) {
  const root = await fixture(after, false, { phase: "down", before });
  const up = await invoke(root);
  expect(up.code).toBe(0);
  expect(JSON.parse(up.stdout).data.status).toBe("ready");
  return root;
}
async function stops(root: string) {
  return (await Bun.file(join(root, "requests")).text())
    .split("\n")
    .filter((line) => line && JSON.parse(line).includes("down")).length;
}
const down = (root: string, recover = false) =>
  invoke(root, ["down", ...(recover ? ["--recover"] : []), "--json"]);

test("source CLI orders down before, exact engine stop, after exec/shell; stopped calls never replay or acquire inputs", async () => {
  const root = await started(
    `if(await Bun.file("engine").exists()||process.env.TOKEN!=="host")process.exit(41);${append("down-after")}`,
    `if(!(await Bun.file("engine").exists())||process.env.TOKEN!=="host")process.exit(42);${append("down-before")}`
  );
  const result = await down(root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { status: "stopped", dataRetained: true },
  });
  expect(await Bun.file(join(root, "order")).text()).toBe(
    "engine-ready\ndown-before\nengine-stopped\ndown-after\nafter-shell\n"
  );
  expect(await state(root)).toMatchObject({
    stopped: true,
    pending: false,
    beforeHooksPending: false,
  });
  const compiler = await Bun.file(join(root, "compiler-requests")).text();
  await Bun.write(join(root, ".hack/hack.project.json"), "malformed source");
  await Bun.write(join(root, ".hack/hack.env.default.yaml"), "malformed env");
  expect((await down(root)).code).toBe(0);
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  expect(
    (await Bun.file(join(root, "order")).text()).match(/down-before/g)
  ).toHaveLength(1);
}, 30_000);

test.each([
  "before",
  "after",
] as const)("known down %s exit17 retains pending; normal retry refuses before acquisition; explicit recovery skips hooks", async (phase) => {
  const root = await started(
    phase === "after" ? "process.exit(17)" : append("down-after"),
    phase === "before" ? "process.exit(17)" : append("down-before")
  );
  const result = await down(root);
  expect(result.code).toBe(17);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_LIFECYCLE_FAILED" },
  });
  expect(await stops(root)).toBe(phase === "before" ? 0 : 1);
  expect(await state(root)).toMatchObject({
    pending: true,
    beforeHooksPending: false,
    stopped: false,
    hostHookPhase: null,
  });
  const compiler = await Bun.file(join(root, "compiler-requests")).text();
  const retried = await down(root);
  expect(retried.code).toBe(1);
  expect(await stops(root)).toBe(phase === "before" ? 0 : 1);
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  await Bun.write(join(root, ".hack/hack.project.json"), "malformed source");
  await Bun.write(join(root, ".hack/hack.env.default.yaml"), "malformed env");
  const recovered = await down(root, true);
  expect(recovered.code).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({
    ok: true,
    data: { status: "stopped", hostHooksSkipped: true },
  });
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  expect(await state(root)).toMatchObject({
    stopped: true,
    pending: false,
    beforeHooksPending: false,
  });
  expect(await Bun.file(join(root, "order")).text()).not.toContain(
    "after-shell"
  );
}, 30_000);

test.each([
  "before",
  "after",
] as const)("down %s changed managed env keeps pending and cannot finalize or rebind", async (phase) => {
  const change =
    'await Bun.write(".hack/hack.env.default.yaml",JSON.stringify({version:1,environment:"default",secretsprovider:"project_key",values:{global:{TOKEN:"changed"}}}));';
  const root = await started(
    phase === "after" ? change : append("down-after"),
    phase === "before" ? change : append("down-before")
  );
  const result = await down(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(await stops(root)).toBe(phase === "before" ? 0 : 1);
  expect(await state(root)).toMatchObject({
    stopped: false,
    pending: true,
    beforeHooksPending: false,
  });
  expect((await down(root, true)).code).toBe(0);
}, 30_000);

test("after hook resurrecting exact owned workload cannot complete stop", async () => {
  const root = await started(
    'await Bun.write("engine",await Bun.file("engine-backup").text());'
  );
  await Bun.write(
    join(root, "engine-backup"),
    await Bun.file(join(root, "engine")).text()
  );
  const result = await down(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(await state(root)).toMatchObject({
    stopped: false,
    pending: true,
    beforeHooksPending: false,
  });
  expect((await down(root, true)).code).toBe(0);
}, 30_000);

test("changed source selection refuses hook-enabled normal down; saved explicit recovery never invokes compiler or hook values", async () => {
  const root = await started(append("down-after"));
  const source = await Bun.file(join(root, ".hack/hack.project.json")).json();
  source.name = "changed";
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(source)
  );
  expect((await down(root)).code).toBe(1);
  expect(await stops(root)).toBe(0);
  expect(await state(root)).toMatchObject({ stopped: false, pending: false });
  const compiler = await Bun.file(join(root, "compiler-requests")).text();
  await Bun.write(join(root, ".hack/hack.project.json"), "malformed source");
  await Bun.write(join(root, ".hack/hack.env.default.yaml"), "malformed env");
  expect((await down(root, true)).code).toBe(0);
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  expect(await Bun.file(join(root, "order")).text()).toBe(
    "engine-ready\nengine-stopped\n"
  );
}, 30_000);

test("saved generation without a down binding ignores later authored hooks and malformed env", async () => {
  const root = await fixture("", false, { noHooks: true });
  expect(await invoke(root)).toMatchObject({ code: 0 });
  const compiler = await Bun.file(join(root, "compiler-requests")).text();
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({
      host: {
        down: { before: [{ name: "new", command: { shell: "exit 17" } }] },
      },
    })
  );
  await Bun.write(join(root, ".hack/hack.env.default.yaml"), "malformed env");
  expect((await down(root)).code).toBe(0);
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  expect(await state(root)).toMatchObject({ stopped: true, pending: false });
}, 30_000);

test("oneoff run refuses authored down hooks before any engine request", async () => {
  const root = await fixture("", false, { phase: "down" });
  const result = await invoke(root, ["run", "web"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "run with authored host hooks is not supported"
  );
  expect(await Bun.file(join(root, "requests")).exists()).toBe(false);
}, 20_000);

test("saved down selection uses canonical authored profiles even when startup flags were reordered", async () => {
  const root = await fixture(append("down-after"), false, {
    phase: "down",
    before: append("down-before"),
  });
  const source = await Bun.file(join(root, ".hack/hack.project.json")).json();
  source.profiles = ["a", "z"];
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(source)
  );
  const result = await invoke(root, [
    "up",
    "--profile",
    "z,a",
    "--detach",
    "--json",
  ]);
  expect(result).toMatchObject({ code: 0 });
  const document = await Bun.file(join(root, "engine")).json();
  expect(document["x-hack-native-down-hooks"].profiles).toEqual(["a", "z"]);
  expect(document["x-hack-native-down-hooks"].overlay).toBeNull();
  expect((await down(root)).code).toBe(0);
}, 30_000);

test.each([
  "source",
  "local",
] as const)("down after %s drift retains exact pending and prevents final stop receipt", async (kind) => {
  const change =
    kind === "source"
      ? 'const source=await Bun.file(".hack/hack.project.json").json();source.worktree.inherit_local=true;await Bun.write(".hack/hack.project.json",JSON.stringify(source));'
      : 'await Bun.write(".hack/hack.local.json",JSON.stringify({version:1,auto_branch:false}));';
  const root = await started(change);
  expect((await down(root)).code).toBe(1);
  expect(await state(root)).toMatchObject({
    pending: true,
    stopped: false,
    beforeHooksPending: false,
  });
  expect((await down(root, true)).code).toBe(0);
}, 30_000);

test("finite before timeout returns124 with descendant absence, no engine stop and exact pending recovery", async () => {
  const program =
    'const child=Bun.spawn([process.execPath,"-e",\'process.on("SIGTERM",()=>{});await Bun.sleep(60000)\'],{stdout:"inherit",stderr:"inherit"});await Bun.write("host-pid",String(child.pid));process.on("SIGTERM",()=>{});await Bun.sleep(60000);';
  const root = await started(append("down-after"), program);
  const result = await down(root);
  expect(result.code).toBe(124);
  expect(await stops(root)).toBe(0);
  expect(await state(root)).toMatchObject({
    pending: true,
    beforeHooksPending: false,
    hostHookPhase: null,
  });
  const pid = Number(await Bun.file(join(root, "host-pid")).text());
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await down(root, true)).code).toBe(0);
}, 30_000);

test("an orphan before hook remains durable unknown even after later process absence and explicit saved engine stop", async () => {
  const program =
    'const child=Bun.spawn(["/bin/sleep","3"],{stdout:"ignore",stderr:"ignore"});await Bun.write("host-pid",String(child.pid));process.exit(0);';
  const root = await started(append("down-after"), program);
  const result = await down(root);
  expect(result.code).toBe(1);
  expect(await stops(root)).toBe(0);
  expect(await state(root)).toMatchObject({
    pending: true,
    beforeHooksPending: true,
    hostHookPhase: "down.before",
  });
  const pid = Number(await Bun.file(join(root, "host-pid")).text());
  const deadline = Date.now() + 5000;
  let absent = false;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      absent =
        error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    if (absent) {
      break;
    }
    await Bun.sleep(20);
  }
  expect(absent).toBe(true);
  const compiler = await Bun.file(join(root, "compiler-requests")).text();
  expect((await down(root, true)).code).toBe(1);
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  expect(await state(root)).toMatchObject({
    pending: true,
    stopped: false,
    beforeHooksPending: true,
    hostHookPhase: "down.before",
  });
  expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
}, 30_000);
