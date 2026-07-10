import { addLinkedWorktree, createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  runCommand,
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
      oauthEnabled: true,
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
      that: primaryUrl === `https://${fixture.devHost}.gy`,
      message: `primary open --json should prefer https://${fixture.devHost}.gy, got "${primaryUrl}"`,
      result: primaryOpen,
    });
    expect({
      that: !primaryOpen.stderr.includes("Linked worktree detected"),
      message:
        "primary checkout must not emit the linked-worktree branch notice",
      result: primaryOpen,
    });

    const serviceOpen = await ctx.cli({
      args: ["open", "api", "--json"],
      cwd: fixture.root,
    });
    expectExit({
      result: serviceOpen,
      codes: [0],
      message: "hack open service shorthand should succeed",
    });
    const serviceUrl =
      extractJsonObject<OpenPayload>({ text: serviceOpen.stdout })?.url ?? "";
    expect({
      that: serviceUrl === `https://api.${fixture.devHost}.gy`,
      message: `service shorthand should prefer the OAuth alias, got "${serviceUrl}"`,
      result: serviceOpen,
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
      that: worktreeUrl === `https://${BRANCH}.${fixture.devHost}.gy`,
      message: `worktree open --json should prefer the branch alias URL, got "${worktreeUrl}"`,
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

    const devOverride = await ctx.cli({
      args: ["open", "--json", "--prefer", "dev"],
      cwd: fixture.root,
    });
    expectExit({
      result: devOverride,
      codes: [0],
      message: "hack open --prefer dev should succeed",
    });
    const devOverrideUrl =
      extractJsonObject<OpenPayload>({ text: devOverride.stdout })?.url ?? "";
    expect({
      that: devOverrideUrl === `https://${fixture.devHost}`,
      message: `--prefer dev should select the primary dev host, got "${devOverrideUrl}"`,
      result: devOverride,
    });

    const setProjectPreference = await ctx.cli({
      args: ["config", "set", "open.prefer", "dev"],
      cwd: fixture.root,
    });
    expectExit({
      result: setProjectPreference,
      codes: [0],
      message: "hack config set open.prefer dev should succeed",
    });
    const configuredOpen = await ctx.cli({
      args: ["open", "--json"],
      cwd: fixture.root,
    });
    expectExit({
      result: configuredOpen,
      codes: [0],
      message: "hack open should honor open.prefer from project config",
    });
    const configuredUrl =
      extractJsonObject<OpenPayload>({ text: configuredOpen.stdout })?.url ??
      "";
    expect({
      that: configuredUrl === `https://${fixture.devHost}`,
      message: `open.prefer=dev should select the primary host, got "${configuredUrl}"`,
      result: configuredOpen,
    });

    const aliasOverride = await ctx.cli({
      args: ["open", "--json", "--prefer", "alias"],
      cwd: fixture.root,
    });
    expectExit({
      result: aliasOverride,
      codes: [0],
      message: "CLI alias preference should override project config",
    });
    const aliasOverrideUrl =
      extractJsonObject<OpenPayload>({ text: aliasOverride.stdout })?.url ?? "";
    expect({
      that: aliasOverrideUrl === `https://${fixture.devHost}.gy`,
      message: `--prefer alias should override open.prefer=dev, got "${aliasOverrideUrl}"`,
      result: aliasOverride,
    });

    const disableOauth = await ctx.cli({
      args: ["config", "set", "oauth.enabled", "false"],
      cwd: fixture.root,
    });
    expectExit({
      result: disableOauth,
      codes: [0],
      message: "hack config set oauth.enabled false should succeed",
    });
    const unavailableAlias = await ctx.cli({
      args: ["open", "--json", "--prefer", "alias"],
      cwd: fixture.root,
    });
    expectExit({
      result: unavailableAlias,
      codes: [1],
      message: "explicit alias preference should fail without OAuth aliasing",
    });
    expect({
      that:
        unavailableAlias.combined.includes("OAuth alias host is unavailable") &&
        unavailableAlias.combined.includes("--prefer dev"),
      message: "unavailable alias failure should include recovery guidance",
      result: unavailableAlias,
    });

    const invalidPreference = await ctx.cli({
      args: ["open", "--json", "--prefer", "primary"],
      cwd: fixture.root,
    });
    expectExit({
      result: invalidPreference,
      codes: [1],
      message: "invalid browser host preference should fail",
    });
    expect({
      that: invalidPreference.combined.includes(
        "--prefer must be 'auto', 'alias', or 'dev'"
      ),
      message: "invalid preference should list supported values",
      result: invalidPreference,
    });

    const explicitUrl = "https://example.com/callback?source=hack";
    const explicit = await ctx.cli({
      args: ["open", explicitUrl, "--json", "--prefer", "dev"],
      cwd: fixture.root,
    });
    expectExit({
      result: explicit,
      codes: [0],
      message: "hack open should preserve an explicit URL",
    });
    const preservedUrl =
      extractJsonObject<OpenPayload>({ text: explicit.stdout })?.url ?? "";
    expect({
      that: preservedUrl === explicitUrl,
      message: `explicit URL should remain unchanged, got "${preservedUrl}"`,
      result: explicit,
    });

    const explicitHost = await ctx.cli({
      args: ["open", fixture.devHost, "--json"],
      cwd: worktreePath,
    });
    expectExit({
      result: explicitHost,
      codes: [0],
      message: "hack open should preserve an explicit fully qualified host",
    });
    const preservedHostUrl =
      extractJsonObject<OpenPayload>({ text: explicitHost.stdout })?.url ?? "";
    expect({
      that: preservedHostUrl === `https://${fixture.devHost}`,
      message: `explicit fully qualified host should remain unchanged, got "${preservedHostUrl}"`,
      result: explicitHost,
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

    const detach = await runCommand({
      argv: ["git", "checkout", "--detach"],
      cwd: worktreePath,
    });
    expectExit({
      result: detach,
      codes: [0],
      message: "failed to detach the linked worktree fixture",
    });

    const detachedOpen = await ctx.cli({
      args: ["open", "--json"],
      cwd: worktreePath,
    });
    expectExit({
      result: detachedOpen,
      codes: [1],
      message: "detached linked worktree must refuse an implicit base instance",
    });
    expect({
      that:
        detachedOpen.combined.includes("Detached linked worktree") &&
        detachedOpen.combined.includes("--branch <name>"),
      message:
        "detached worktree failure must explain the safe explicit override",
      result: detachedOpen,
    });

    const detachedExplicit = await ctx.cli({
      args: ["open", "--json", "--branch", "detached-review"],
      cwd: worktreePath,
    });
    expectExit({
      result: detachedExplicit,
      codes: [0],
      message:
        "explicit branch should remain available from detached worktrees",
    });
    const detachedExplicitUrl =
      extractJsonObject<OpenPayload>({ text: detachedExplicit.stdout })?.url ??
      "";
    expect({
      that: detachedExplicitUrl.includes("detached-review"),
      message: `explicit detached branch URL should carry the requested slug, got "${detachedExplicitUrl}"`,
      result: detachedExplicit,
    });
  },
};
