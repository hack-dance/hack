import { afterAll, beforeAll, expect } from "bun:test";
import { lstat, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUX_ENVIRONMENT_TTL_MS } from "../../src/mux/private-environment.ts";
import { restoreEnv } from "./env.ts";

/**
 * Give this test file its own TMPDIR while it runs: staging a mux
 * environment sweeps the temp directory for stale payloads, and a test must
 * never touch the developer's real ones. A stale-looking sentinel payload is
 * planted in the real temp directory first; it must still be there at the
 * end, which proves the file never swept outside its fixture.
 */
export function isolateMuxTempDir(): void {
  let saved: string | undefined;
  let fixture = "";
  let sentinel = "";
  beforeAll(async () => {
    saved = process.env.TMPDIR;
    sentinel = await mkdtemp(join(tmpdir(), "hack-mux-env-sentinel-"));
    await writeFile(join(sentinel, "env.json"), "{}", { mode: 0o600 });
    const old = new Date(Date.now() - MUX_ENVIRONMENT_TTL_MS - 60_000);
    await utimes(join(sentinel, "env.json"), old, old);
    await utimes(sentinel, old, old);
    fixture = await mkdtemp(join(tmpdir(), "hack-mux-tmp-"));
    process.env.TMPDIR = fixture;
  });
  afterAll(async () => {
    restoreEnv("TMPDIR", saved);
    const survived = await lstat(join(sentinel, "env.json")).catch(() => null);
    await rm(sentinel, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
    expect(survived?.isFile()).toBe(true);
  });
}
