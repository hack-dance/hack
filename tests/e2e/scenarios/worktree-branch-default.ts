import { addLinkedWorktree, createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  type Scenario,
} from "../harness.ts";

type OpenPayload = { readonly url?: string };

const BRANCH = "e2e-branch-default";

/**
 * In a linked worktree, project commands must default to a branch instance
 * named after the worktree branch. `hack open --json` is the cheapest
 * observable surface: the resolved URL must carry the branch slug and a
 * notice must be emitted (to stderr in --json mode). The primary checkout
 * must be unaffected.
 */
export const worktreeBranchDefaultScenario: Scenario = {
  name: "worktree-branch-default",
  tier: "local",
  summary: "linked worktree defaults to a branch instance (open --json)",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const worktreePath = await addLinkedWorktree({ fixture, branch: BRANCH });

    const primaryOpen = await ctx.cli({
      args: ["open", "--json"],
      cwd: fixture.root,
    });
    expectExit({
      result: primaryOpen,
      codes: [0],
      message: "hack open --json in the primary checkout failed",
    });
    const primaryUrl =
      extractJsonObject<OpenPayload>({ text: primaryOpen.stdout })?.url ?? "";
    expect({
      that: primaryUrl === `https://${fixture.devHost}`,
      message: `primary open --json should resolve https://${fixture.devHost}, got "${primaryUrl}"`,
      result: primaryOpen,
    });
    expect({
      that: !primaryOpen.stderr.includes("Linked worktree detected"),
      message:
        "primary checkout must not emit the linked-worktree branch notice",
      result: primaryOpen,
    });

    const worktreeOpen = await ctx.cli({
      args: ["open", "--json"],
      cwd: worktreePath,
    });
    expectExit({
      result: worktreeOpen,
      codes: [0],
      message: "hack open --json in the linked worktree failed",
    });
    const worktreeUrl =
      extractJsonObject<OpenPayload>({ text: worktreeOpen.stdout })?.url ?? "";
    expect({
      that: worktreeUrl.includes(BRANCH),
      message: `worktree open --json URL should carry the branch slug "${BRANCH}", got "${worktreeUrl}"`,
      result: worktreeOpen,
    });
    expect({
      that: worktreeUrl !== primaryUrl,
      message:
        "worktree URL must differ from the primary URL (branch instance routing)",
      result: worktreeOpen,
    });
    expect({
      that: worktreeOpen.stderr.includes("Linked worktree detected"),
      message:
        "worktree open --json should emit the branch-instance notice on stderr",
      result: worktreeOpen,
    });

    const optOut = await ctx.cli({
      args: ["open", "--json", "--branch", "main-instance"],
      cwd: worktreePath,
    });
    expectExit({
      result: optOut,
      codes: [0],
      message: "hack open --json --branch <name> in the worktree failed",
    });
    const optOutUrl =
      extractJsonObject<OpenPayload>({ text: optOut.stdout })?.url ?? "";
    expect({
      that: optOutUrl.includes("main-instance"),
      message: `explicit --branch should win over the worktree default, got "${optOutUrl}"`,
      result: optOut,
    });
  },
};
