import { realpath } from "node:fs/promises";

import { addLinkedWorktree, createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  findFilesByName,
  type Scenario,
} from "../harness.ts";

type ProjectsPayload = {
  readonly projects?: readonly {
    readonly name?: string;
    readonly repo_root?: string | null;
    readonly worktrees?: readonly { readonly path?: string }[] | null;
  }[];
};

type RegistryFile = {
  readonly projects?: readonly {
    readonly name?: string;
    readonly repoRoot?: string;
    readonly worktrees?: readonly { readonly path?: string }[];
  }[];
};

/**
 * Registry-touching commands run from the primary checkout and then from a
 * linked worktree (same HACK_HOME) must produce exactly ONE registration for
 * the repo family — the worktree must not register as a second project.
 */
export const worktreeRegistryScenario: Scenario = {
  name: "worktree-registry",
  tier: "local",
  summary: "primary + linked worktree register as a single project",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });

    const fromPrimary = await ctx.cli({
      args: ["config", "get", "name"],
      cwd: fixture.root,
    });
    expectExit({
      result: fromPrimary,
      codes: [0],
      message: "registry-touching command from the primary checkout failed",
    });

    const worktreePath = await addLinkedWorktree({
      fixture,
      branch: "e2e-registry",
    });
    const fromWorktree = await ctx.cli({
      args: ["config", "get", "name"],
      cwd: worktreePath,
    });
    expectExit({
      result: fromWorktree,
      codes: [0],
      message: "registry-touching command from the linked worktree failed",
    });

    const registryPaths = await findFilesByName({
      root: ctx.hackHome,
      basename: "projects.json",
    });
    expect({
      that: registryPaths.length > 0,
      message: `no projects.json registry found under HACK_HOME (${ctx.hackHome})`,
    });

    let matching = 0;
    for (const path of registryPaths) {
      const parsed = extractJsonObject<RegistryFile>({
        text: await Bun.file(path).text(),
      });
      matching +=
        parsed?.projects?.filter((entry) => entry.name === fixture.name)
          .length ?? 0;
    }
    expect({
      that: matching === 1,
      message: `expected exactly 1 registry entry for "${fixture.name}", found ${matching} (worktree double-registration?)`,
    });

    const projects = await ctx.cli({
      args: ["projects", "--json"],
      cwd: fixture.root,
    });
    expectExit({
      result: projects,
      codes: [0],
      message: "hack projects --json failed",
    });
    const payload = extractJsonObject<ProjectsPayload>({
      text: projects.stdout,
    });
    const entries =
      payload?.projects?.filter((entry) => entry.name === fixture.name) ?? [];
    expect({
      that: entries.length === 1,
      message: `hack projects --json should list exactly one project named "${fixture.name}", got ${entries.length}`,
      result: projects,
    });

    const realWorktreePath = await realpath(worktreePath);
    const worktrees = entries[0]?.worktrees ?? null;
    expect({
      that: worktrees?.some((entry) => entry.path === realWorktreePath) === true,
      message:
        "worktree checkout should be recorded on the registration (worktrees array)",
      result: projects,
    });
  },
};
