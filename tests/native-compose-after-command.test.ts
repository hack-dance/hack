import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture, invoke, state } from "./helpers/native-compose-command.ts";

test("source CLI runs ordered finite after hooks only after exact generation readiness and then commits ready", async () => {
  const root = await fixture(
    'if(!(await Bun.file("engine").exists())||process.env.TOKEN!=="host")process.exit(43); await Bun.write("after-value",process.env.HOST_ONLY??""); await import("node:fs/promises").then(m=>m.appendFile("order","after-exec\\n"));'
  );
  const result = await invoke(root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { status: "ready" },
  });
  expect(await Bun.file(join(root, "order")).text()).toBe(
    "before\nengine-ready\nafter-exec\nafter-shell\n"
  );
  expect(await Bun.file(join(root, "after-value")).text()).toBe("host");
  expect(await Bun.file(join(root, "engine")).json()).toMatchObject({
    services: { web: { environment: { TOKEN: "global" } } },
  });
  expect(await state(root)).toMatchObject({
    pending: false,
    beforeHooksPending: false,
    hostHookPhase: null,
    stopped: false,
  });
}, 20_000);

test("nonzero after hook preserves exit 17, skips later hooks and retains an explicitly stoppable pending engine", async () => {
  const root = await fixture("process.exit(17)");
  const result = await invoke(root);
  expect(result.code).toBe(17);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_LIFECYCLE_FAILED" },
  });
  expect(await Bun.file(join(root, "order")).text()).toBe(
    "before\nengine-ready\n"
  );
  expect(await state(root)).toMatchObject({
    pending: true,
    beforeHooksPending: false,
    hostHookPhase: null,
    stopped: true,
  });
  const down = await invoke(root, ["down", "--recover", "--json"]);
  expect(down.code).toBe(0);
  expect(JSON.parse(down.stdout)).toMatchObject({
    ok: true,
    data: { status: "stopped" },
  });
  expect(await state(root)).toMatchObject({ pending: false, stopped: true });
}, 20_000);

test("failed engine startup never runs after hooks", async () => {
  const root = await fixture('await Bun.write("after-ran","unexpected")', true);
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_STARTUP_INCOMPLETE" },
  });
  expect(await Bun.file(join(root, "after-ran")).exists()).toBe(false);
  expect(await Bun.file(join(root, "order")).text()).toBe("before\n");
}, 20_000);

test("after hook that stops an owned workload cannot commit or report ready", async () => {
  const root = await fixture('await Bun.write("unready","stopped")');
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(await state(root)).toMatchObject({
    pending: true,
    stopped: true,
    beforeHooksPending: false,
  });
}, 20_000);

test.each([
  "env",
  "source",
  "local",
] as const)("after %s changes cannot rebind the running generation or report ready", async (kind) => {
  const change = {
    env: 'await Bun.write(".hack/hack.env.default.yaml",JSON.stringify({version:1,environment:"default",secretsprovider:"project_key",values:{global:{TOKEN:"changed"}}}))',
    source:
      'const source=await Bun.file(".hack/hack.project.json").json();source.name="changed";await Bun.write(".hack/hack.project.json",JSON.stringify(source))',
    local:
      'await Bun.write(".hack/hack.local.json",JSON.stringify({schema_version:1}))',
  };
  const root = await fixture(change[kind]);
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(await state(root)).toMatchObject({
    pending: true,
    stopped: true,
    hostHookPhase: null,
  });
  expect(await Bun.file(join(root, "engine")).json()).toMatchObject({
    services: { web: { environment: { TOKEN: "global" } } },
  });
}, 20_000);

test("source CLI run refuses an after-only host lifecycle before engine or hook effects", async () => {
  const root = await fixture('await Bun.write("after-ran","unexpected")');
  const path = join(root, ".hack/hack.project.json");
  const authored = await Bun.file(path).json();
  authored.host.up.before = [];
  await Bun.write(path, JSON.stringify(authored));
  const result = await invoke(root, ["run", "web", "--", "synthetic"]);
  expect(result.code).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  for (const name of ["order", "after-ran", "engine"]) {
    expect(await Bun.file(join(root, name)).exists()).toBe(false);
  }
}, 30_000);
