import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture, invoke, state } from "./helpers/native-compose-command.ts";

const generationLabel = "io.hack.native-config.generation";
async function engine(root: string) {
  return await Bun.file(join(root, "engine")).json();
}
async function generation(root: string) {
  return (await engine(root)).services.web.labels[generationLabel] as string;
}
async function composeStarts(root: string) {
  return (await Bun.file(join(root, "requests")).text())
    .split("\n")
    .filter((line) => line && JSON.parse(line).includes("up"));
}
async function started() {
  const root = await fixture("", false, { noHooks: true });
  expect((await invoke(root)).code).toBe(0);
  return root;
}

test("unchanged source CLI up reuses exact private generation while still executing Compose and readiness", async () => {
  const root = await started();
  const before = await engine(root);
  expect((await invoke(root)).code).toBe(0);
  expect(await engine(root)).toEqual(before);
  expect(await composeStarts(root)).toHaveLength(2);
  expect(await state(root)).toMatchObject({ pending: false, stopped: false });
}, 30_000);

test("source CLI waits through an owned on-failure restart before final strict readiness", async () => {
  const root = await fixture("", false, { noHooks: true });
  const path = join(root, ".hack/hack.project.json");
  const source = await Bun.file(path).json();
  source.services.web.restart = { kind: "on-failure", max_retries: 2 };
  await Bun.write(path, JSON.stringify(source));
  await Bun.write(join(root, "restart-transient"), "selected restart");
  const result = await invoke(root, ["up", "--detach", "--json"], 5000);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { status: "ready" },
  });
  expect(
    Number(await Bun.file(join(root, "restart-network-inspects")).text())
  ).toBeGreaterThanOrEqual(4);
  expect(await state(root)).toMatchObject({ pending: false, stopped: false });
}, 30_000);

test("a restart after readiness cannot pass strict finalization", async () => {
  const root = await fixture("", false, { noHooks: true });
  const path = join(root, ".hack/hack.project.json");
  const source = await Bun.file(path).json();
  source.services.web.restart = { kind: "on-failure", max_retries: 2 };
  await Bun.write(path, JSON.stringify(source));
  await Bun.write(join(root, "restart-finalization-gap"), "selected restart");
  const result = await invoke(root, ["up", "--detach", "--json"], 5000);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_CONFIG_INVALID" },
  });
  expect(await composeStarts(root)).toHaveLength(1);
}, 30_000);

test.each([
  "source",
  "env-values",
] as const)("warm up publishes a new generation for changed %s", async (kind) => {
  const root = await started();
  const before = await generation(root);
  const path = join(
    root,
    kind === "source"
      ? ".hack/hack.project.json"
      : ".hack/hack.env.default.yaml"
  );
  const source = await Bun.file(path).json();
  if (kind === "source") {
    source.services.web.command = { exec: ["changed"] };
  } else if (kind === "env-values") {
    source.values.global.TOKEN = "changed";
  }
  await Bun.write(path, JSON.stringify(source, null, 2));
  expect((await invoke(root)).code).toBe(0);
  expect(await generation(root)).not.toBe(before);
  if (kind === "env-values") {
    expect((await engine(root)).services.web.environment.TOKEN).toBe("changed");
  }
}, 30_000);

test("equivalent managed-env formatting is freshly acquired without replacing exact delivery", async () => {
  const root = await started();
  const before = await engine(root);
  const path = join(root, ".hack/hack.env.default.yaml");
  await Bun.write(path, JSON.stringify(await Bun.file(path).json(), null, 2));
  expect((await invoke(root)).code).toBe(0);
  expect(await engine(root)).toEqual(before);
}, 30_000);

test("canonical profile reorder reuses generation while changed selection publishes a new one", async () => {
  const root = await fixture("", false, { noHooks: true });
  const path = join(root, ".hack/hack.project.json");
  const source = await Bun.file(path).json();
  source.profiles = ["a", "z"];
  await Bun.write(path, JSON.stringify(source));
  const up = (profiles: string) =>
    invoke(root, ["up", "--profile", profiles, "--detach", "--json"]);
  expect((await up("z,a")).code).toBe(0);
  const before = await generation(root);
  expect((await up("a,z")).code).toBe(0);
  expect(await generation(root)).toBe(before);
  expect((await up("a")).code).toBe(0);
  expect(await generation(root)).not.toBe(before);
}, 30_000);

test.each([
  "restart",
  "down-up",
] as const)("%s preserves explicit new-generation behavior", async (operation) => {
  const root = await started();
  const before = await generation(root);
  if (operation === "down-up") {
    expect((await invoke(root, ["down", "--json"])).code).toBe(0);
  }
  const result = await invoke(
    root,
    operation === "restart"
      ? ["restart", "--json"]
      : ["up", "--detach", "--json"]
  );
  expect(result.code).toBe(0);
  expect(await generation(root)).not.toBe(before);
  const requests = await composeStarts(root);
  expect(JSON.parse(requests.at(-1) ?? "[]").includes("--force-recreate")).toBe(
    operation === "restart"
  );
}, 30_000);

test("reuse never bypasses foreign-owner refusal before Compose", async () => {
  const root = await started();
  const document = await engine(root);
  document.services.web.labels["io.hack.native-config.owner"] = "e".repeat(32);
  await Bun.write(join(root, "engine"), JSON.stringify(document));
  expect((await invoke(root)).code).toBe(1);
  expect(await composeStarts(root)).toHaveLength(1);
}, 30_000);

test("uncertain warm readiness remains pending and prevents a second startup effect", async () => {
  const root = await started();
  await Bun.write(join(root, "unready"), "synthetic readiness failure");
  expect((await invoke(root)).code).toBe(1);
  expect(await composeStarts(root)).toHaveLength(2);
  expect(await state(root)).toMatchObject({ pending: true, stopped: false });
  expect((await invoke(root)).code).toBe(1);
  expect(await composeStarts(root)).toHaveLength(2);
}, 30_000);

test("unchanged up still runs ordered finite before and after hooks", async () => {
  const append = (value: string) =>
    `await import("node:fs/promises").then(m=>m.appendFile("order",${JSON.stringify(`${value}\n`)}));`;
  const root = await fixture(append("after"), false, {
    before: append("before"),
  });
  expect((await invoke(root)).code).toBe(0);
  const before = await generation(root);
  expect((await invoke(root)).code).toBe(0);
  expect(await generation(root)).toBe(before);
  expect(await Bun.file(join(root, "order")).text()).toBe(
    "before\nengine-ready\nafter\nafter-shell\n".repeat(2)
  );
}, 30_000);
