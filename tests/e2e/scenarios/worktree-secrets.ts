import { join } from "node:path";

import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  runCommand,
  type Scenario,
} from "../harness.ts";

type EnvListPayload = {
  readonly vars?: readonly {
    readonly key: string;
    readonly value: string;
  }[];
};

const PRIMARY_SECRET_KEY = "E2E_PRIMARY_SECRET";
const PRIMARY_SECRET_VALUE = "primary-secret-value";
const WORKTREE_SECRET_KEY = "E2E_WORKTREE_SECRET";
const WORKTREE_SECRET_VALUE = "worktree-secret-value";
const KEY_FILENAME = ".hack.secret.key";

/**
 * Secrets created in the primary checkout must decrypt from a linked worktree
 * (and vice versa) using the shared/primary key. hack must never silently
 * mint a divergent `.hack.secret.key` inside the linked worktree.
 */
export const worktreeSecretsScenario: Scenario = {
  name: "worktree-secrets",
  tier: "local",
  summary: "shared secret key across primary checkout and linked worktree",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });

    const add = await ctx.cli({
      args: [
        "env",
        "add",
        PRIMARY_SECRET_KEY,
        PRIMARY_SECRET_VALUE,
        "--secret",
      ],
      cwd: fixture.root,
    });
    expectExit({
      result: add,
      codes: [0],
      message: "env add --secret in the primary checkout should succeed",
    });
    await commitAll({
      root: fixture.root,
      message: "fixture: add primary secret",
    });

    const worktreePath = await addLinkedWorktree({
      fixture,
      branch: "e2e-feature",
    });

    const fromWorktree = await ctx.cli({
      args: ["env", "list", "--json", "--show-secrets"],
      cwd: worktreePath,
    });
    expectExit({
      result: fromWorktree,
      codes: [0],
      message:
        "env list --show-secrets from the linked worktree should succeed",
    });
    const worktreePayload = extractJsonObject<EnvListPayload>({
      text: fromWorktree.stdout,
    });
    const primaryVar = worktreePayload?.vars?.find(
      (entry) => entry.key === PRIMARY_SECRET_KEY
    );
    expect({
      that: primaryVar?.value === PRIMARY_SECRET_VALUE,
      message:
        "secret encrypted in the primary checkout must decrypt from the linked worktree",
      result: fromWorktree,
    });

    const addFromWorktree = await ctx.cli({
      args: [
        "env",
        "add",
        WORKTREE_SECRET_KEY,
        WORKTREE_SECRET_VALUE,
        "--secret",
      ],
      cwd: worktreePath,
    });
    expectExit({
      result: addFromWorktree,
      codes: [0],
      message: "env add --secret from the linked worktree should succeed",
    });

    const roundtrip = await ctx.cli({
      args: ["env", "list", "--json", "--show-secrets"],
      cwd: worktreePath,
    });
    const roundtripPayload = extractJsonObject<EnvListPayload>({
      text: roundtrip.stdout,
    });
    const worktreeVar = roundtripPayload?.vars?.find(
      (entry) => entry.key === WORKTREE_SECRET_KEY
    );
    expect({
      that: worktreeVar?.value === WORKTREE_SECRET_VALUE,
      message:
        "secret encrypted from the worktree must decrypt with the shared key",
      result: roundtrip,
    });

    await assertNoDivergentKey({
      primaryRoot: fixture.root,
      worktreeRoot: worktreePath,
    });
  },
};

/**
 * Allowed key locations: the shared git common dir (`.git/.hack.secret.key`)
 * and/or the primary checkout root. A key file inside the linked worktree
 * root is a divergent-key bug. When multiple key files exist their contents
 * must be identical.
 */
async function assertNoDivergentKey(opts: {
  readonly primaryRoot: string;
  readonly worktreeRoot: string;
}): Promise<void> {
  const commonDirResult = await runCommand({
    argv: ["git", "-C", opts.primaryRoot, "rev-parse", "--git-common-dir"],
    cwd: opts.primaryRoot,
  });
  const commonDir = join(
    opts.primaryRoot,
    commonDirResult.stdout.trim() || ".git"
  );

  const worktreeKey = Bun.file(join(opts.worktreeRoot, KEY_FILENAME));
  expect({
    that: !(await worktreeKey.exists()),
    message: `divergent ${KEY_FILENAME} was created inside the linked worktree at ${opts.worktreeRoot}`,
  });

  const candidatePaths = [
    join(commonDir, KEY_FILENAME),
    join(opts.primaryRoot, KEY_FILENAME),
  ];
  const contents: string[] = [];
  for (const path of candidatePaths) {
    const file = Bun.file(path);
    if (await file.exists()) {
      contents.push(await file.text());
    }
  }
  expect({
    that: contents.length > 0,
    message: `expected a secret key at one of: ${candidatePaths.join(", ")}`,
  });
  expect({
    that: new Set(contents).size === 1,
    message:
      "multiple secret key files exist with different contents (divergent keys)",
  });
}
