import { expect, test } from "bun:test";

import type {
  RuntimeContainer,
  RuntimeProject,
} from "../src/lib/runtime-projects.ts";
import {
  buildWorktreeRetargetWarning,
  findSameCheckoutRetargetConflicts,
  findSameCheckoutRuntimeTargets,
  resolveImplicitDownTarget,
} from "../src/lib/worktree-runtime-target.ts";

test("retarget detection finds running and created instances from the same checkout", () => {
  const conflicts = findSameCheckoutRetargetConflicts({
    currentProjectDir: "/repo/.hack",
    targetComposeProject: "demo--new-branch",
    runtime: [
      buildRuntimeProject({
        project: "demo--old-branch",
        workingDir: "/repo/.hack",
        states: ["running"],
      }),
      buildRuntimeProject({
        project: "demo--interrupted",
        workingDir: "/repo/.hack",
        states: ["created"],
      }),
      buildRuntimeProject({
        project: "demo--new-branch",
        workingDir: "/repo/.hack",
        states: ["created"],
      }),
      buildRuntimeProject({
        project: "demo--other-checkout",
        workingDir: "/other/.hack",
        states: ["running"],
      }),
    ],
  });

  expect(conflicts).toEqual([
    { composeProject: "demo--interrupted", states: ["created"] },
    { composeProject: "demo--old-branch", states: ["running"] },
  ]);
});

test("retarget detection ignores terminal instances from the same checkout", () => {
  expect(
    findSameCheckoutRetargetConflicts({
      currentProjectDir: "/repo/.hack",
      targetComposeProject: "demo--new-branch",
      runtime: [
        buildRuntimeProject({
          project: "demo--old-branch",
          workingDir: "/repo/.hack",
          states: ["exited"],
        }),
      ],
    })
  ).toEqual([]);
});

test("retarget warning names existing and new compose projects", () => {
  expect(
    buildWorktreeRetargetWarning({
      targetComposeProject: "demo--new-branch",
      conflicts: [{ composeProject: "demo--old-branch", states: ["running"] }],
    })
  ).toBe(
    'This worktree already owns "demo--old-branch" (running); auto-targeting new instance "demo--new-branch". Pass --branch <name> to target an existing instance explicitly.'
  );
});

test("implicit down keeps the inferred branch when this checkout has no runtime", () => {
  expect(
    resolveImplicitDownTarget({
      baseComposeProject: "demo",
      currentProjectDir: "/repo/.hack",
      inferredBranch: "new-branch",
      runtime: [],
    })
  ).toEqual({
    kind: "inferred",
    branch: "new-branch",
    composeProject: "demo--new-branch",
  });
});

test("implicit down retargets a unique stopped runtime after a branch rename", () => {
  expect(
    resolveImplicitDownTarget({
      baseComposeProject: "demo",
      currentProjectDir: "/repo/.hack",
      inferredBranch: "codex-old-branch",
      runtime: [
        buildRuntimeProject({
          project: "demo--old-branch",
          workingDir: "/repo/.hack",
          states: ["exited"],
        }),
      ],
    })
  ).toEqual({
    kind: "retargeted",
    branch: "old-branch",
    composeProject: "demo--old-branch",
    states: ["exited"],
  });
});

test("implicit down retargets unique running and created runtimes", () => {
  for (const state of ["running", "created"]) {
    expect(
      resolveImplicitDownTarget({
        baseComposeProject: "demo",
        currentProjectDir: "/repo/.hack",
        inferredBranch: "new-branch",
        runtime: [
          buildRuntimeProject({
            project: "demo--old-branch",
            workingDir: "/repo/.hack",
            states: [state],
          }),
        ],
      })
    ).toMatchObject({
      kind: "retargeted",
      branch: "old-branch",
      states: [state],
    });
  }
});

test("implicit down refuses multiple instances from the same checkout", () => {
  expect(
    resolveImplicitDownTarget({
      baseComposeProject: "demo",
      currentProjectDir: "/repo/.hack",
      inferredBranch: "current",
      runtime: [
        buildRuntimeProject({
          project: "demo--current",
          workingDir: "/repo/.hack",
          states: ["running"],
        }),
        buildRuntimeProject({
          project: "demo--old",
          workingDir: "/repo/.hack",
          states: ["exited"],
        }),
      ],
    })
  ).toEqual({
    kind: "ambiguous",
    targets: [
      {
        branch: "current",
        composeProject: "demo--current",
        states: ["running"],
      },
      {
        branch: "old",
        composeProject: "demo--old",
        states: ["exited"],
      },
    ],
  });
});

test("same-checkout target discovery excludes other checkouts and project families", () => {
  expect(
    findSameCheckoutRuntimeTargets({
      baseComposeProject: "demo",
      currentProjectDir: "/repo/.hack",
      runtime: [
        buildRuntimeProject({
          project: "demo--owned",
          workingDir: "/repo/.hack",
          states: ["running"],
        }),
        buildRuntimeProject({
          project: "demo--other-checkout",
          workingDir: "/other/.hack",
          states: ["running"],
        }),
        buildRuntimeProject({
          project: "other--owned",
          workingDir: "/repo/.hack",
          states: ["running"],
        }),
      ],
    })
  ).toEqual([
    {
      branch: "owned",
      composeProject: "demo--owned",
      states: ["running"],
    },
  ]);
});

function buildRuntimeProject(opts: {
  readonly project: string;
  readonly workingDir: string;
  readonly states: readonly string[];
}): RuntimeProject {
  return {
    project: opts.project,
    workingDir: opts.workingDir,
    isGlobal: false,
    services: new Map([
      [
        "app",
        {
          service: "app",
          containers: opts.states.map((state, index) =>
            buildContainer({
              project: opts.project,
              workingDir: opts.workingDir,
              state,
              index,
            })
          ),
        },
      ],
    ]),
  };
}

function buildContainer(opts: {
  readonly project: string;
  readonly workingDir: string;
  readonly state: string;
  readonly index: number;
}): RuntimeContainer {
  return {
    id: `${opts.project}-${opts.index}`,
    project: opts.project,
    service: "app",
    state: opts.state,
    status: opts.state,
    name: `${opts.project}-app-${opts.index}`,
    ports: "",
    workingDir: opts.workingDir,
    image: "alpine:3.20",
    labels: null,
    mounts: [],
    networks: [],
  };
}
