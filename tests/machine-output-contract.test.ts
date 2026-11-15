import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineOutputFixtures } from "../scripts/lib/machine-output-fixtures.ts";
import {
  JSON_COMMAND_SHAPES,
  SCHEMA_JSON_VARIANTS,
} from "../src/cli/json-contracts.ts";
import {
  jsonCommandPaths,
  renderJsonInventory,
} from "../src/cli/json-reference.ts";
import { runCli } from "../src/cli/run.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { MACHINE_SCHEMAS } from "../src/lib/machine-output.ts";
import { machineError } from "./helpers/machine-output.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const runtime = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/runtime-projects.ts",
  overrides: { readRuntimeProjects: async () => ({ ok: true, runtime: [] }) },
});
beforeAll(() => runtime.activate());
afterAll(() => runtime.deactivate());

let root: string;
let original: Record<string, string | undefined>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-json-contract-"));
  original = Object.fromEntries(
    ["HOME", "HACK_HOME", "HACK_LOGGER", "HACK_DAEMON_AUTOSTART_DISABLE"].map(
      (key) => [key, process.env[key]]
    )
  );
  process.env.HOME = root;
  process.env.HACK_HOME = join(root, "state");
  process.env.HACK_LOGGER = "console";
  process.env.HACK_DAEMON_AUTOSTART_DISABLE = "1";
});
afterEach(async () => {
  mock.restore();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  await rm(root, { recursive: true, force: true });
});

test("every canonical JSON command has an explicit inventory shape decision", () => {
  expect(Object.keys(JSON_COMMAND_SHAPES).sort()).toEqual([
    ...jsonCommandPaths(CLI_SPEC),
  ]);
  for (const variant of SCHEMA_JSON_VARIANTS) {
    expect(JSON_COMMAND_SHAPES).toHaveProperty(variant.command);
  }
});

test.each([
  { flags: [] },
  { flags: ["--dry-run"] },
])("projects prune %j matches its envelope inventory", async ({ flags }) => {
  let stdout = "";
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const code = await runCli(["projects", "prune", "--json", ...flags]);
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(JSON_COMMAND_SHAPES["projects prune"]).toBe("envelope");
  expect(Object.keys(result).sort()).toEqual(["data", "ok"]);
  expect(result.ok).toBe(true);
  expect(result.data).toBeObject();
});

test("machine-readable reference table is generated from the command inventory", async () => {
  const doc = await Bun.file(
    join(import.meta.dir, "..", "docs/reference/machine-readable-output.md")
  ).text();
  const table = doc
    .split("<!-- json-inventory:start -->\n")[1]
    ?.split("<!-- json-inventory:end -->")[0];
  expect(table).toBe(renderJsonInventory(CLI_SPEC));
});

test.each(
  Object.keys(JSON_COMMAND_SHAPES)
)("%s keeps its pre-handler JSON usage-error contract", async (command) => {
  let stdout = "";
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  spyOn(process.stderr, "write").mockReturnValue(true);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("contract probe entered a runtime handler");
  });
  const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("contract probe entered a synchronous handler");
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        throw new Error("contract probe entered a network handler");
      },
      {
        preconnect: () => {
          throw new Error("unexpected preconnect");
        },
      }
    )
  );
  const code = await runCli([
    ...command.split(" "),
    "--json",
    "--__contract_refuse",
  ]);
  expect(code).not.toBe(0);
  machineError(stdout, "E_USAGE");
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("desktop boundary fixtures and schema inventory agree with CLI producers", async () => {
  expect(
    [...new Set(SCHEMA_JSON_VARIANTS.map((variant) => variant.schema))].sort()
  ).toEqual(Object.values(MACHINE_SCHEMAS).sort());
  for (const [name, fixture] of Object.entries(machineOutputFixtures())) {
    const text = await Bun.file(
      join(
        import.meta.dir,
        "..",
        "apps/desktop/core/tests/fixtures/machine-output",
        name
      )
    ).text();
    expect(text).toBe(`${JSON.stringify(fixture, null, 2)}\n`);
  }
});
