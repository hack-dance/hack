import { afterEach, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  entrypoint,
  portableBootstrapHarness,
  quote,
} from "./helpers/portable-bootstrap-fixture.ts";

const { fixture, run, cleanup } = portableBootstrapHarness();
afterEach(cleanup);

test("readiness publication stays invisible until the entire document is written", async () => {
  const f = await fixture(
    `\n${quote(process.execPath)} "${"${0%/*}"}/delay-ready.ts"\nexec ${quote(process.execPath)} ${quote(entrypoint)} "$@"`
  );
  await writeFile(
    join(f.root, "delay-ready.ts"),
    `const file = Bun.file("app.ts");
const source = await file.text();
if (!source.includes("const originalWrite = Bun.write;")) {
  await Bun.write("app.ts", \`const originalWrite = Bun.write;
Bun.write = async (destination, data, options) => {
  if (typeof destination === "string" && destination.startsWith("ready.json")) {
    await originalWrite(destination, "");
    await Bun.sleep(200);
  }
  return originalWrite(destination, data, options);
};
\` + source);
}
`
  );
  const result = await run(f);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, cleanup: true });
  expect(await readdir(join(f.root, "tmp"))).toEqual([]);
}, 50_000);

test.each([
  {
    name: "identity",
    script: "echo private-child-canary >&2; exit 1",
    reason: "cli_identity",
  },
  {
    name: "env",
    script: 'if [ "$1" = env ]; then echo private-json-canary; exit 0; fi',
    reason: "invalid_json",
  },
  {
    name: "dev-write",
    script:
      'for last in "$@"; do :; done\nif [ "$last" = dev.ts ]; then echo private-child-canary >&2; exit 1; fi',
    reason: "development_command",
  },
  {
    name: "restart",
    script:
      'for last in "$@"; do :; done\nif [ "$last" = app.ts ]; then\nif [ -f started-once ]; then exit 1; fi\ntouch started-once\nfi',
    reason: "application_readiness",
  },
])("$name failures emit only closed labels", async ({
  name,
  script,
  reason,
}) => {
  const f = await fixture(
    `${script}\nexec ${quote(process.execPath)} ${quote(entrypoint)} "$@"`
  );
  const result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    `Portable bootstrap failed: step=${name} reason=${reason}\n`
  );
  expect(result.stderr).not.toContain("private-");
  expect(result.stderr).not.toContain(f.root);
  expect(await readdir(join(f.root, "tmp"))).toEqual([]);
}, 50_000);

test("setup failures omit the failing executable path", async () => {
  const f = await fixture("exit 0");
  const result = await run({
    root: f.root,
    binary: join(f.root, "private-missing-executable"),
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Portable bootstrap failed: step=setup reason=io_error\n"
  );
});

test.each([
  {
    step: "http",
    action:
      'await Bun.write("ready.json", "private-json-canary"); await Bun.sleep(1000);',
    reason: "invalid_json",
  },
  { step: "cleanup", action: "", reason: "application_stop_status" },
])("$step failure keeps raw data private", async ({ step, action, reason }) => {
  const f = await fixture(
    `${quote(process.execPath)} "${"${0%/*}"}/fault.ts" "$@"\nexec ${quote(process.execPath)} ${quote(entrypoint)} "$@"`
  );
  await writeFile(
    join(f.root, "fault.ts"),
    `
if (Bun.argv.at(-1) === "app.ts") {
  const started = Bun.file("started-once");
  const source = await Bun.file("app.ts").text();
  if (${JSON.stringify(step)} === "http") {
    await Bun.write("app.ts", ${JSON.stringify(action)} + source);
  } else if (await started.exists()) {
    await Bun.write("app.ts", source.replace("process.exit(0)", "process.exit(9)"));
  }
  await Bun.write("started-once", "yes");
}
`
  );
  const result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    `Portable bootstrap failed: step=${step} reason=${reason}\n`
  );
  expect(await readdir(join(f.root, "tmp"))).toEqual([]);
}, 50_000);

test("a cleanup deadline preserves the first failure and retains the fixture", async () => {
  const f = await fixture(
    `for last in "$@"; do :; done
if [ "$last" = app.ts ]; then exec ${quote(process.execPath)} "${"${0%/*}"}/uncooperative.ts"; fi
exec ${quote(process.execPath)} ${quote(entrypoint)} "$@"`
  );
  await writeFile(
    join(f.root, "uncooperative.ts"),
    `
process.on("SIGTERM", () => {});
await Bun.write("ready.json", "private-readiness-canary");
setInterval(() => {}, 1000);
`
  );
  const result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Portable bootstrap failed: step=http reason=invalid_json cleanup=owned_cleanup_failed\n"
  );
  expect(await readdir(join(f.root, "tmp"))).toHaveLength(1);
}, 50_000);
