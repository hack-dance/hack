import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  entrypoint,
  portableBootstrapHarness,
  quote,
} from "./helpers/portable-bootstrap-fixture.ts";

const { fixture, run, cleanup } = portableBootstrapHarness();
afterEach(cleanup);

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
    selectedExecutableSha256: createHash("sha256")
      .update(await readFile(f.binary))
      .digest("hex"),
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
    "Portable bootstrap failed: step=env reason=missing_wrong_key_refusal\n"
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
    "Portable bootstrap failed: step=env reason=secret_free_command_output\n"
  );
  expect(await readdir(join(f.root, "tmp"))).toEqual([]);
});

test("a selected file that changes during version discovery produces no receipt", async () => {
  const f = await fixture(
    'printf "\\n# changed\\n" >> "$0"\n echo fake-version'
  );
  const result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Portable bootstrap failed: step=identity reason=cli_identity\n"
  );
});
