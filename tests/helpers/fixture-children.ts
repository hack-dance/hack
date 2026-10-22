import { requireFixtureRoot } from "./fixture-root.ts";

/** A fixture child with piped output, as {@link FixtureChildren.run} starts it. */
export type FixtureChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

export type FixtureRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Child processes a test file starts inside its temp fixture (HACK-1343).
 *
 * `Bun.spawn` treats a `null`, `undefined` or empty `cwd` as the current
 * directory, which during `bun test` is the checkout. A test that times out
 * leaves its call running; once `afterEach` has reset the fixture root, that
 * late call would start its child in the repository. `run` therefore reads
 * `cwd` through {@link requireFixtureRoot} at spawn time and refuses, closed,
 * anything but an absolute path. `stopAll` kills and awaits the children that
 * are still running, so `afterEach` can end them before it removes the
 * fixture they work in.
 */
export type FixtureChildren = {
  /** Starts `cmd` in `cwd`, collects its output and waits for it to exit. */
  readonly run: (opts: {
    readonly cmd: readonly string[];
    readonly cwd: unknown;
    readonly env?: Readonly<Record<string, string>>;
  }) => Promise<FixtureRunResult>;
  /** Kills (SIGKILL) and awaits every child that is still running. */
  readonly stopAll: () => Promise<void>;
};

/** Tracks the children of one test file; `owner` names it in refusals. */
export function fixtureChildren(owner: string): FixtureChildren {
  const running = new Set<FixtureChild>();
  return {
    run: async (opts) => {
      const child = Bun.spawn([...opts.cmd], {
        cwd: requireFixtureRoot(opts.cwd, owner),
        ...(opts.env ? { env: { ...opts.env } } : {}),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      running.add(child);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { exitCode, stdout, stderr };
      } finally {
        running.delete(child);
      }
    },
    stopAll: async () => {
      const children = [...running];
      running.clear();
      for (const child of children) {
        child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => child.exited));
    },
  };
}
