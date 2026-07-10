import { expect, test } from "bun:test";

import type {
  RuntimeContainer,
  RuntimeProject,
} from "../src/lib/runtime-projects.ts";
import {
  buildWorktreeRetargetWarning,
  findSameCheckoutRetargetConflicts,
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
