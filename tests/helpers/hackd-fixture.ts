import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import type { DaemonIdentityExpectation } from "../../src/daemon/process.ts";

/**
 * Starts a process whose command line is exactly a dev-tree hackd
 * (`bun <dir>/hack-fixture.ts daemon start --foreground`) and that serves the
 * given socket, then writes `ready`. Socket and ready paths go through the
 * environment so the argv stays a real daemon start.
 */
export async function spawnHackdLikeFixture(opts: {
  /** Temp directory owned by the test; the fixture files go in a subdirectory. */
  readonly dir: string;
  readonly socket: string;
  readonly ready: string;
  /**
   * Run as `bun hack-fixture.ts ...` from the fixture directory, the way
   * `bun index.ts daemon start --foreground` runs from a checkout.
   */
  readonly relativeEntry?: boolean;
  /** Launch as `bun run <entry> ...`, like the package `dev` script. */
  readonly viaRun?: boolean;
}): Promise<{
  readonly child: ReturnType<typeof Bun.spawn>;
  /** Accepts this fixture's entry file as "this checkout's" entry. */
  readonly expectation: DaemonIdentityExpectation;
}> {
  const dir = await mkdtemp(join(opts.dir, "fixture-"));
  const runtime = join(dir, "bun");
  const script = join(dir, "hack-fixture.ts");
  await symlink(process.execPath, runtime);
  await Bun.write(
    script,
    'Bun.serve({ unix: process.env.FIXTURE_SOCKET ?? "", fetch() { return new Response("x"); } });\nawait Bun.write(process.env.FIXTURE_READY ?? "", "ready");\n'
  );
  const entry = opts.relativeEntry === true ? "hack-fixture.ts" : script;
  const run = opts.viaRun === true ? ["run"] : [];
  const child = Bun.spawn(
    [runtime, ...run, entry, "daemon", "start", "--foreground"],
    {
      cwd: dir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        FIXTURE_SOCKET: opts.socket,
        FIXTURE_READY: opts.ready,
      },
    }
  );
  return {
    child,
    expectation: { entryFiles: new Set([script, await realpath(script)]) },
  };
}
