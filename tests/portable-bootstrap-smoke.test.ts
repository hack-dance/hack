import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runner = resolve(
  import.meta.dir,
  "../scripts/portable-bootstrap-smoke.ts"
);
const entrypoint = resolve(import.meta.dir, "../index.ts");
const roots: string[] = [];

/** Only the wrapper selects source; the portable runner itself imports no repo modules. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), "hack-portable-runner-test-"));
  roots.push(root);
  for (const name of ["home", "tmp", "foreign"]) {
    await mkdir(join(root, name));
  }
  const binary = join(root, "selected-hack");
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o700);
  return { root, binary };
}

async function run(input: { root: string; binary: string }) {
  const child = Bun.spawn(
    [process.execPath, runner, "--hack-bin", input.binary],
    {
      cwd: input.root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(input.root, "home"),
        TMPDIR: join(input.root, "tmp"),
        HACK_HOME: join(input.root, "foreign"),
        HACK_GLOBAL_CONFIG_PATH: join(
          input.root,
          "foreign",
          "must-not-read.json"
        ),
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: "/invalid/unrelated-executor",
        HACK_NATIVE_HOME: join(input.root, "foreign", "native-home"),
        HACK_ENV_SECRET_KEY: "parent-secret-must-not-reach-child",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable runner qualifies real CLI env, HTTP, dev write, restart, and cleanup with inherited selectors poisoned", async () => {
  const f = await fixture(
    `exec ${quote(process.execPath)} ${quote(entrypoint)} "$@"`
  );
  const result = await run(f);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const summary: unknown = JSON.parse(result.stdout);
  expect(summary).toMatchObject({
    ok: true,
    cleanup: true,
    checks: [
      "selected executable",
      "missing and wrong keys refuse child launch",
      "repeat configuration/env reads preserve inputs",
      "loopback readiness",
      "development command",
      "restart retains marker",
      "no key/plaintext files or output",
    ],
  });
  expect(result.stdout).not.toContain("parent-secret");
  expect(await readdir(join(f.root, "tmp"))).toEqual([]);
  expect(await readdir(join(f.root, "foreign"))).toEqual([]);
}, 50_000);

test("a CLI that accepts missing-key launch cannot produce a passing qualification", async () => {
  const f = await fixture(
    'if [ "$1" = --version ]; then echo fake-version; fi\nexit 0'
  );
  const result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Portable bootstrap failed: missing/wrong key refusal\n"
  );
  expect(await readdir(join(f.root, "tmp"))).toEqual([]);
});

test("a CLI that leaks the wrong injected key is refused without forwarding it or retaining capture files", async () => {
  const f = await fixture(
    [
      'if [ "$1" = --version ]; then echo fake-version; exit 0; fi',
      'if [ -n "${HACK_ENV_SECRET_KEY:-}" ]; then printf "%s" "$HACK_ENV_SECRET_KEY" >&2; fi',
      "exit 1",
    ].join("\n")
  );
  const result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Portable bootstrap failed: secret-free command output\n"
  );
  expect(await readdir(join(f.root, "tmp"))).toEqual([]);
});
