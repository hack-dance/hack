import { join } from "node:path";

import { addLinkedWorktree } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  type Scenario,
} from "../harness.ts";
import {
  cleanupPatternFixture,
  copyPatternFixture,
  ownedVolumes,
  replaceFile,
  requirePatternEngine,
} from "./pattern-fixture.ts";

const OWNER = "hack.e2e.pattern-p02-owner";
const BRANCH = "p02-linked";
const COMMAND_MS = 180_000;
const CACHE_VOLUMES = ["toolchain_dependencies", "toolchain_bun_cache"];
/**
 * Prints which checkout the toolchain mounted. In a linked worktree `/app/.git`
 * is a pointer file whose host `gitdir` target does not exist in the
 * container, so a check that assumed a `.git` directory would fail there.
 */
const CHECKOUT_PROBE = `set -eu
if [ -d /app/.git ]; then
  echo "git=directory"
else
  test -f /app/.git
  IFS= read -r pointer < /app/.git
  case "$pointer" in "gitdir: "*) ;; *) exit 3;; esac
  test ! -e "\${pointer#gitdir: }"
  echo "git=pointer-unresolved"
fi
cat /app/.e2e-checkout`;
const FAILING_TEST = `import { expect, test } from "bun:test";
import { sum } from "./sum.ts";

test("a deliberately failing check in the linked worktree", () => {
  expect(sum([1, 2])).toBe(4);
});
`;

/**
 * HACK-P02 (HACK-1146): the checked-in portable-toolchain fixture against a
 * real engine, from the primary checkout and a linked worktree. A failing
 * check must exit non-zero through `hack run`, and the linked worktree's
 * `.git` pointer must not be mistaken for a repository directory.
 */
export const patternP02PortableToolchainScenario: Scenario = {
  name: "pattern-p02-portable-toolchain",
  tier: "docker",
  summary:
    "P02 fixture: hack run --profile from primary and linked worktree, exit status",
  run: async (ctx) => {
    const engine = await requirePatternEngine(ctx);
    const fixture = await copyPatternFixture({
      ctx,
      cardId: "HACK-P02",
      owner: OWNER,
      engine,
    });
    const linked = await addLinkedWorktree({ fixture, branch: BRANCH });
    const primaryProject = fixture.name;
    const linkedProject = `${fixture.name}--${BRANCH}`;
    const owned = {
      ctx,
      owner: OWNER,
      name: fixture.name,
      projects: [primaryProject, linkedProject],
    };
    // Untracked checkout identities: each run must mount its own source.
    await Bun.write(join(fixture.root, ".e2e-checkout"), "checkout=primary\n");
    await Bun.write(join(linked, ".e2e-checkout"), "checkout=linked\n");
    const run = async (cwd: string, command: readonly string[]) =>
      await ctx.cli({
        cwd,
        args: ["run", "--profile", "toolchain", "toolchain", "--", ...command],
        timeoutMs: COMMAND_MS,
      });
    const passes = async (cwd: string, command: readonly string[]) => {
      const result = await run(cwd, command);
      expectExit({
        result,
        codes: [0],
        message: `hack run toolchain -- ${command.join(" ")} (P02 fixture)`,
      });
      return result;
    };
    const checksPass = async (cwd: string, count: number) => {
      const result = await passes(cwd, ["bun", "test"]);
      expect({
        that:
          result.combined.includes(`${count} pass`) &&
          result.combined.includes("0 fail"),
        message: `bun test must report ${count} passing and no failing checks`,
        result,
      });
    };
    const failed = (result: CliResult, message: string) =>
      expect({
        that: !result.timedOut && result.exitCode !== 0,
        message,
        result,
      });
    const checkout = async (cwd: string, expected: string) => {
      const result = await passes(cwd, ["sh", "-c", CHECKOUT_PROBE]);
      expect({
        that: result.stdout.trim() === expected,
        message: "toolchain must mount the invoking checkout",
        result,
      });
    };
    const cacheVolumes = async () =>
      new Set(
        (await ownedVolumes(owned)).map(
          (volume) =>
            `${volume.Labels?.["com.docker.compose.project"]}/${volume.Labels?.["com.docker.compose.volume"]}`
        )
      );
    const expectCaches = async (message: string) => {
      const present = await cacheVolumes();
      for (const project of owned.projects) {
        for (const volume of CACHE_VOLUMES) {
          expect({ that: present.has(`${project}/${volume}`), message });
        }
      }
    };
    try {
      // The fixture README's two commands, from the primary checkout.
      await passes(fixture.root, ["bun", "install", "--frozen-lockfile"]);
      await checksPass(fixture.root, 1);
      await checkout(fixture.root, "git=directory\ncheckout=primary");
      ctx.log("primary checkout installed and passed its checks");

      // The same commands from a linked worktree with a .git pointer file.
      await passes(linked, ["bun", "install", "--frozen-lockfile"]);
      await checksPass(linked, 1);
      await checkout(linked, "git=pointer-unresolved\ncheckout=linked");
      await expectCaches(
        "each instance must keep its own named toolchain cache volumes"
      );
      ctx.log("linked worktree ran its own source with its own caches");

      // A failing check in the linked worktree propagates its exit status.
      await replaceFile({
        path: join(linked, "src/regression.test.ts"),
        content: FAILING_TEST,
      });
      failed(
        await run(linked, ["bun", "test"]),
        "a failing check must make hack run exit non-zero"
      );
      const exact = await run(linked, ["sh", "-c", "exit 7"]);
      expect({
        that: !exact.timedOut && exact.exitCode === 7,
        message: "hack run must return the toolchain command's exit status",
        result: exact,
      });
      // Negative control: a pipe filter hides the failure, as the README warns.
      const filtered = await run(linked, [
        "sh",
        "-c",
        "bun test 2>&1 | tail -n 3",
      ]);
      expectExit({
        result: filtered,
        codes: [0],
        message: "a pipe filter reports the filter's status, not the check's",
      });
      await checksPass(fixture.root, 1);
      ctx.log(
        "failing check exited non-zero; exact status propagated; primary still passes"
      );

      // Ordinary down keeps both instances' cache volumes.
      for (const cwd of [fixture.root, linked]) {
        expectExit({
          result: await ctx.cli({ cwd, args: ["down"], timeoutMs: COMMAND_MS }),
          codes: [0],
          message: "hack down of the one-shot toolchain project",
        });
      }
      await expectCaches("hack down must keep the named toolchain caches");
      ctx.log("hack down kept the named cache volumes");
    } finally {
      await cleanupPatternFixture({
        ...owned,
        checkouts: [fixture.root, linked],
      });
    }
  },
};
