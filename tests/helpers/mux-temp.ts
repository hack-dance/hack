import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepObserver } from "../../src/mux/private-environment.ts";
import { restoreEnv } from "./env.ts";

/**
 * Give this test file its own TMPDIR while it runs: staging a mux
 * environment sweeps the temp directory for stale payloads, and a test must
 * never touch the developer's real ones. Every sweep this process runs is
 * recorded, and each must have used the file's own directory. (A stale
 * sentinel in the shared temp directory is not used: on a shared host
 * another process's legitimate sweep can remove it.)
 */
export function isolateMuxTempDir(): void {
  let saved: string | undefined;
  let fixture = "";
  const swept: string[] = [];
  beforeAll(async () => {
    saved = process.env.TMPDIR;
    fixture = await realpath(await mkdtemp(join(tmpdir(), "hack-mux-tmp-")));
    process.env.TMPDIR = fixture;
    sweepObserver.onSweep = (parent) => swept.push(parent);
  });
  afterAll(async () => {
    sweepObserver.onSweep = undefined;
    restoreEnv("TMPDIR", saved);
    await rm(fixture, { recursive: true, force: true });
    const outside = await Promise.all(
      swept.map(async (parent) =>
        (await realpath(parent).catch(() => parent)) === fixture ? null : parent
      )
    );
    expect(outside.filter((parent) => parent !== null)).toEqual([]);
  });
}
