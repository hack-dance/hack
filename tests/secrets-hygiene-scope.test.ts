import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSecretsHygieneScope } from "../src/commands/doctor.ts";
import { STAGING_LEFTOVER_MIN_AGE_MS } from "../src/lib/private-staging.ts";
import { resolveFileSecretStorePaths } from "../src/lib/secret-store.ts";
import {
  applySecretsHygieneFixes,
  inspectSecretsHygiene,
} from "../src/lib/secrets-hygiene.ts";
import { restoreEnv } from "./helpers/env.ts";

// The scope a hygiene removal is authorized against (HACK-2165): a report
// tolerates a configuration it cannot read, but a removal must not, or an
// unreadable or malformed configuration would look like one naming nothing.

const SENTINEL = "synthetic-scope-sentinel";
const UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";
let root = "";
let saved: { home?: string; config?: string } = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-hygiene-scope-"));
  saved = {
    home: process.env.HOME,
    config: process.env.HACK_GLOBAL_CONFIG_PATH,
  };
  process.env.HOME = join(root, "home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "hack.config.json");
  await mkdir(join(root, "home"));
  await mkdir(join(root, "start"));
});

afterEach(async () => {
  restoreEnv("HOME", saved.home);
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", saved.config);
  await chmod(join(root, "hack.config.json"), 0o600).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const config = () => join(root, "hack.config.json");
const strictScope = () =>
  resolveSecretsHygieneScope({ startDir: join(root, "start"), strict: true });

test("a configuration that does not parse is unknown to a removal, not empty", async () => {
  await writeFile(config(), "{ not json", { mode: 0o600 });
  // A report still resolves (with the default paths)...
  await resolveFileSecretStorePaths({});
  await resolveSecretsHygieneScope({ startDir: join(root, "start") });
  // ...but a removal's scope does not.
  await expect(resolveFileSecretStorePaths({ strict: true })).rejects.toThrow(
    "does not parse"
  );
  await expect(strictScope()).rejects.toThrow();
});

test.skipIf(process.getuid?.() === 0)(
  "a configuration that cannot be read is unknown to a removal, not empty",
  async () => {
    await writeFile(config(), "{}\n", { mode: 0o600 });
    await chmod(config(), 0o000);
    await resolveFileSecretStorePaths({});
    await expect(resolveFileSecretStorePaths({ strict: true })).rejects.toThrow(
      "could not be read"
    );
    await expect(strictScope()).rejects.toThrow();
  }
);

test("an absent configuration is confirmed empty, so removals proceed", async () => {
  const scope = await strictScope();
  expect(scope.stores.length).toBeGreaterThan(0);
});

test.skipIf(process.getuid?.() === 0)(
  "--fix removes nothing while the configuration that would name a file cannot be read",
  async () => {
    // A leftover next to the configured key's directory.
    const keyDir = join(root, "keys");
    await mkdir(keyDir, { mode: 0o700 });
    const leftover = join(keyDir, `.secrets-file.key.${UUID}.tmp`);
    await writeFile(leftover, `${SENTINEL}\n`, { mode: 0o600 });
    const old = (Date.now() - STAGING_LEFTOVER_MIN_AGE_MS - 60_000) / 1000;
    await utimes(leftover, old, old);
    const keyPath = join(keyDir, "secrets-file.key");
    await writeFile(
      config(),
      `${JSON.stringify({
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: { path: join(keyDir, "s.enc.json"), keyPath },
          },
        },
      })}\n`,
      { mode: 0o600 }
    );
    const findings = await inspectSecretsHygiene(await strictScope());
    expect(
      findings.some(
        (finding) =>
          finding.fix?.kind === "remove_leftover" && finding.path === leftover
      )
    ).toBe(true);
    // The configuration (which might now name that file) becomes unreadable.
    await chmod(config(), 0o000);
    const result = await applySecretsHygieneFixes({
      findings,
      report: () => undefined,
      currentScope: strictScope,
    });
    expect(result.applied).toBe(0);
    expect(await readFile(leftover, "utf8")).toBe(`${SENTINEL}\n`);
    // Readable again and unchanged: the leftover is removed.
    await chmod(config(), 0o600);
    await applySecretsHygieneFixes({
      findings,
      report: () => undefined,
      currentScope: strictScope,
    });
    expect(await lstat(leftover).catch(() => null)).toBeNull();
  }
);
