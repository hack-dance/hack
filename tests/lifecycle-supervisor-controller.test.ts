import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readLifecycleState,
  resolveLifecycleLogPath,
} from "../src/lib/lifecycle-runtime.ts";
import {
  inspectLifecycleSupervisor,
  resolveLifecycleSupervisorRoot,
} from "../src/lib/lifecycle-supervisor.ts";
import {
  createLifecycleProcessController,
  stopLifecycleProcessController,
} from "../src/lib/project-lifecycle-controller.ts";
import { restoreEnv } from "./helpers/env.ts";

const previous = process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY;
const supervisorBinary =
  process.env.HACK_TEST_SUPERVISOR_BINARY ??
  resolve(
    ".hack-local/target/lifecycle-integration/debug/hack-lifecycle-supervisor"
  );
if (
  process.env.HACK_TEST_REQUIRE_SUPERVISOR === "1" &&
  !existsSync(supervisorBinary)
) {
  throw new Error(
    "The required current-source supervisor executable was not prepared."
  );
}
const nativeTest = existsSync(supervisorBinary) ? test : test.skip;
beforeAll(() => {
  process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY = supervisorBinary;
});
afterAll(() => restoreEnv("HACK_LIFECYCLE_SUPERVISOR_BINARY", previous));

async function fixture(
  run: (project: { projectRoot: string; projectDir: string }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "supervisor-controller-"));
  const projectRoot = join(root, "checkout");
  const project = { projectRoot, projectDir: join(projectRoot, ".hack") };
  await mkdir(project.projectDir, { recursive: true });
  const savedHackHome = process.env.HACK_HOME;
  process.env.HACK_HOME = join(root, "host-home");
  // Fail before any native effect if path resolution reaches the real home.
  expect(
    resolveLifecycleSupervisorRoot({
      ...project,
      composeProject: "fixture",
    }).startsWith(`${process.env.HACK_HOME}/`)
  ).toBe(true);
  try {
    await run(project);
  } finally {
    await stopLifecycleProcessController({
      project,
      projectName: "fixture",
      composeProject: "fixture",
      branch: null,
      definitionHash: "synthetic",
    }).catch(() => undefined);
    restoreEnv("HACK_HOME", savedHackHome);
    await rm(root, { recursive: true, force: true });
  }
}
function controller(
  project: { projectRoot: string; projectDir: string },
  hash = "synthetic"
) {
  return createLifecycleProcessController({
    runner: "supervisor",
    project,
    projectName: "fixture",
    composeProject: "fixture",
    branch: null,
    definitionHash: hash,
    env: { HOME: project.projectRoot, HACK_DAEMON_AUTOSTART_DISABLE: "1" },
    mux: async () => {
      throw new Error("mux must not be consulted");
    },
    installSignalCleanup: () => ({ dispose() {} }),
  });
}
const command = "printf 'controller-ready\\n'; exec sleep 60";
async function eventually(check: () => Promise<boolean>) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() > end) {
      throw new Error("fixture observation timed out");
    }
    await Bun.sleep(20);
  }
}

nativeTest(
  "supervisor controller starts persistent hooks incrementally without mux and keeps common logs",
  () =>
    fixture(async (project) => {
      const owner = controller(project);
      await owner.startFromCommand({
        command: { command, persistent: true },
        serviceName: "first",
      });
      let entries = await readLifecycleState(project);
      expect(entries[0]?.processes.map((p) => p.name)).toEqual(["first"]);
      await owner.startMany({ processes: [{ name: "second", command }] });
      await owner.finalize();
      entries = await readLifecycleState(project);
      expect(entries[0]?.backend).toBe("supervisor");
      expect(entries[0]?.processes.map((p) => p.name).sort()).toEqual([
        "first",
        "second",
      ]);
      const logPath = resolveLifecycleLogPath({
        ...project,
        composeProject: "fixture",
      });
      await eventually(async () =>
        (await readFile(logPath, "utf8")).includes("controller-ready")
      );
      expect(await owner.abort()).toBeUndefined();
      expect(await readLifecycleState(project)).toHaveLength(0);
    }),
  30_000
);

nativeTest(
  "adopting a healthy supervisor retains its token and does not acquire rollback authority",
  () =>
    fixture(async (project) => {
      const first = controller(project);
      await first.startMany({ processes: [{ name: "worker", command }] });
      await first.finalize();
      const original = (await readLifecycleState(project))[0];
      const second = controller(project);
      await second.startMany({ processes: [{ name: "worker", command }] });
      await second.finalize();
      expect((await readLifecycleState(project))[0]?.ownershipToken).toBe(
        original?.ownershipToken
      );
      expect(second.getOperationCleanup()).toBeNull();
      await second.abort();
      expect((await readLifecycleState(project))[0]?.ownershipToken).toBe(
        original?.ownershipToken
      );
    }),
  30_000
);

nativeTest(
  "persisted supervisor stop works after owner SIGKILL and current runner changes",
  () =>
    fixture(async (project) => {
      const owner = controller(project);
      await owner.startMany({ processes: [{ name: "worker", command }] });
      await owner.finalize();
      const entry = (await readLifecycleState(project))[0];
      if (!(entry?.supervisorPid && entry.ownershipToken)) {
        throw new Error("fixture missing owner");
      }
      process.kill(entry.supervisorPid, "SIGKILL");
      const status = await inspectLifecycleSupervisor({
        ...project,
        composeProject: "fixture",
        ownershipToken: entry.ownershipToken,
      });
      expect(status.liveProcessNames).toEqual(["worker"]);
      await stopLifecycleProcessController({
        project,
        projectName: "fixture",
        composeProject: "fixture",
        branch: null,
        definitionHash: "changed",
        mux: async () => {
          throw new Error("mux must not be consulted");
        },
      });
      expect(await readLifecycleState(project)).toHaveLength(0);
    }),
  30_000
);

nativeTest(
  "creator rollback cannot stop a supervisor another operation adopted",
  () =>
    fixture(async (project) => {
      const first = controller(project);
      await first.startMany({ processes: [{ name: "worker", command }] });
      await first.finalize();
      const second = controller(project);
      await second.startMany({ processes: [{ name: "worker", command }] });
      await second.finalize();
      await first.abort();
      const entry = (await readLifecycleState(project))[0];
      if (!entry?.ownershipToken) {
        throw new Error("adopted ownership discarded");
      }
      const status = await inspectLifecycleSupervisor({
        ...project,
        composeProject: "fixture",
        ownershipToken: entry.ownershipToken,
      });
      expect(status.liveProcessNames).toEqual(["worker"]);
    }),
  30_000
);

nativeTest(
  "missing native root is absent while missing executable with retained root stays unknown",
  () =>
    fixture(async (project) => {
      const empty = await inspectLifecycleSupervisor({
        ...project,
        composeProject: "fixture",
        ownershipToken: "synthetic",
      });
      expect(empty.liveProcessNames).toEqual([]);
      const owner = controller(project);
      await owner.startMany({ processes: [{ name: "worker", command }] });
      await owner.finalize();
      const entry = (await readLifecycleState(project))[0];
      if (!entry?.ownershipToken) {
        throw new Error("fixture missing token");
      }
      const binary = process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY;
      process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY =
        "/missing-synthetic-supervisor";
      try {
        await expect(
          inspectLifecycleSupervisor({
            ...project,
            composeProject: "fixture",
            ownershipToken: entry.ownershipToken,
          })
        ).rejects.toThrow("executable");
        expect((await readLifecycleState(project))[0]?.ownershipToken).toBe(
          entry.ownershipToken
        );
      } finally {
        restoreEnv("HACK_LIFECYCLE_SUPERVISOR_BINARY", binary);
      }
    }),
  30_000
);

nativeTest(
  "human service names stay distinct while native state names remain safe",
  () =>
    fixture(async (project) => {
      const owner = controller(project);
      const names = ["service with spaces/../label", "Web", "web"];
      await owner.startMany({
        processes: names.map((name) => ({ name, command })),
      });
      await owner.finalize();
      const entry = (await readLifecycleState(project))[0];
      expect(entry?.processes.map((p) => p.name).sort()).toEqual(
        [...names].sort()
      );
      if (!entry?.ownershipToken) {
        throw new Error("fixture missing token");
      }
      const observed = await inspectLifecycleSupervisor({
        ...project,
        composeProject: "fixture",
        ownershipToken: entry.ownershipToken,
      });
      expect([...observed.liveProcessNames].sort()).toEqual([...names].sort());
      expect(await owner.abort()).toBeUndefined();
    }),
  30_000
);

nativeTest(
  "lost incremental reply publishes the verified late command before failure",
  () =>
    fixture(async (project) => {
      const wrapper = join(project.projectRoot, "drop-add-reply");
      await Bun.write(
        wrapper,
        `#!${process.execPath} --no-env-file
if (process.argv.at(-1) === "--version") {
  const child = Bun.spawn([${JSON.stringify(supervisorBinary)}, "--version"], {env:{},stdin:"ignore",stdout:"inherit",stderr:"ignore"});
  process.exit(await child.exited);
}
const reader = Bun.stdin.stream().getReader();
let frame = Buffer.alloc(0);
while (true) {
  const part = await reader.read();
  if (part.done) process.exit(91);
  frame = Buffer.concat([frame, part.value]);
  if (frame.length >= 4 && frame.length >= frame.readUInt32BE(0) + 4) break;
}
await reader.cancel();
const action = process.argv.at(-1);
const child = Bun.spawn([${JSON.stringify(supervisorBinary)}, action], {env:{},stdin:frame,stdout:"pipe",stderr:"ignore"});
child.unref();
const reply = await new Response(child.stdout).arrayBuffer();
if (action === "add") { await child.exited; process.exit(1); }
await Bun.write(Bun.stdout, reply);
if (action !== "serve") process.exit(await child.exited);
`
      );
      const { chmod } = await import("node:fs/promises");
      await chmod(wrapper, 0o700);
      const saved = process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY;
      process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY = wrapper;
      const owner = controller(project);
      try {
        await owner.startMany({ processes: [{ name: "first", command }] });
        await expect(
          owner.startMany({ processes: [{ name: "late", command }] })
        ).rejects.toThrow("reply was lost");
        const entry = (await readLifecycleState(project))[0];
        expect(entry?.processes.map((p) => p.name).sort()).toEqual([
          "first",
          "late",
        ]);
        if (!entry?.ownershipToken) {
          throw new Error("late ownership missing");
        }
        const status = await inspectLifecycleSupervisor({
          ...project,
          composeProject: "fixture",
          ownershipToken: entry.ownershipToken,
        });
        expect([...status.liveProcessNames].sort()).toEqual(["first", "late"]);
        await owner.abort();
      } finally {
        restoreEnv("HACK_LIFECYCLE_SUPERVISOR_BINARY", saved);
      }
    }),
  30_000
);

nativeTest(
  "a native command published after adoption is refreshed before another add",
  () =>
    fixture(async (project) => {
      const { launchLifecycleSupervisorProcess } = await import(
        "../src/lib/lifecycle-supervisor.ts"
      );
      const creator = controller(project);
      await creator.startMany({ processes: [{ name: "first", command }] });
      await creator.finalize();
      const adopter = controller(project);
      await adopter.startMany({ processes: [{ name: "first", command }] });
      const entry = (await readLifecycleState(project))[0];
      if (!entry?.ownershipToken) {
        throw new Error("fixture missing token");
      }
      // Schedule the protected native effect after the adopter's initial snapshot.
      await launchLifecycleSupervisorProcess({
        ...project,
        composeProject: "fixture",
        ownershipToken: entry.ownershipToken,
        action: "add",
        process: {
          name: "second",
          argv: ["/bin/sh", "-c", command],
          cwd: project.projectRoot,
          env: {
            HOME: project.projectRoot,
            PATH: "/usr/bin:/bin",
            HACK_DAEMON_AUTOSTART_DISABLE: "1",
          },
        },
      });
      await adopter.startMany({
        processes: [{ name: "second", command: "exit 99" }],
      });
      await adopter.finalize();
      expect(
        (await readLifecycleState(project))[0]?.processes
          .map((p) => p.name)
          .sort()
      ).toEqual(["first", "second"]);
    }),
  30_000
);

nativeTest(
  "missing companion fails before ownership and down remains usable",
  () =>
    fixture(async (project) => {
      const saved = process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY;
      process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY = join(
        project.projectRoot,
        "missing-companion"
      );
      try {
        await expect(
          controller(project).startMany({
            processes: [{ name: "worker", command }],
          })
        ).rejects.toThrow("executable");
        expect(await readLifecycleState(project)).toEqual([]);
        await stopLifecycleProcessController({
          project,
          projectName: "fixture",
          composeProject: "fixture",
          branch: null,
          definitionHash: "synthetic",
        });
        expect(await readLifecycleState(project)).toEqual([]);
      } finally {
        restoreEnv("HACK_LIFECYCLE_SUPERVISOR_BINARY", saved);
      }
    }),
  30_000
);

nativeTest(
  "recorded native root survives a changed home and a symlinked checkout",
  () =>
    fixture(async (project) => {
      const { symlink } = await import("node:fs/promises");
      const owner = controller(project);
      await owner.startMany({ processes: [{ name: "worker", command }] });
      await owner.finalize();
      const entry = (await readLifecycleState(project))[0];
      if (!(entry?.ownershipToken && entry.supervisorRoot)) {
        throw new Error("missing fixture identity");
      }
      const savedHome = process.env.HACK_HOME;
      const alias = join(project.projectRoot, "alias");
      await symlink(project.projectDir, alias);
      process.env.HACK_HOME = join(project.projectRoot, "unused-home");
      try {
        const observed = await inspectLifecycleSupervisor({
          projectDir: alias,
          composeProject: "fixture",
          ownershipToken: entry.ownershipToken,
        });
        expect(observed.liveProcessNames).toEqual(["worker"]);
        await stopLifecycleProcessController({
          project: { ...project, projectDir: alias },
          projectName: "fixture",
          composeProject: "fixture",
          branch: null,
          definitionHash: "synthetic",
        });
        expect(await readLifecycleState(project)).toEqual([]);
      } finally {
        restoreEnv("HACK_HOME", savedHome);
      }
    }),
  30_000
);

nativeTest(
  "missing recorded root never grants retirement authority",
  () =>
    fixture(async (project) => {
      const { rename } = await import("node:fs/promises");
      const owner = controller(project);
      await owner.startMany({ processes: [{ name: "worker", command }] });
      await owner.finalize();
      const entry = (await readLifecycleState(project))[0];
      if (!(entry?.ownershipToken && entry.supervisorRoot)) {
        throw new Error("missing fixture identity");
      }
      const moved = `${entry.supervisorRoot}.retained`;
      await rename(entry.supervisorRoot, moved);
      try {
        await expect(
          stopLifecycleProcessController({
            project,
            projectName: "fixture",
            composeProject: "fixture",
            branch: null,
            definitionHash: "synthetic",
          })
        ).rejects.toThrow();
        expect((await readLifecycleState(project))[0]?.ownershipToken).toBe(
          entry.ownershipToken
        );
      } finally {
        await rename(moved, entry.supervisorRoot);
      }
    }),
  30_000
);

nativeTest(
  "never-attempted ownership can be retired without the companion",
  () =>
    fixture(async (project) => {
      const { upsertLifecycleStateEntry } = await import(
        "../src/lib/lifecycle-runtime.ts"
      );
      await upsertLifecycleStateEntry({
        projectDir: project.projectDir,
        entry: {
          composeProject: "fixture",
          projectName: "fixture",
          branch: null,
          sessionName: "fixture-lifecycle",
          backend: "supervisor",
          ownershipToken: "synthetic-never-started",
          cleanupEpoch: "synthetic-epoch",
          processes: [],
          supervisorLaunchAttempted: false,
          updatedAt: new Date().toISOString(),
        },
      });
      const saved = process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY;
      process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY = join(
        project.projectRoot,
        "missing-companion"
      );
      try {
        await stopLifecycleProcessController({
          project,
          projectName: "fixture",
          composeProject: "fixture",
          branch: null,
          definitionHash: "synthetic",
        });
        expect(await readLifecycleState(project)).toEqual([]);
      } finally {
        restoreEnv("HACK_LIFECYCLE_SUPERVISOR_BINARY", saved);
      }
    }),
  30_000
);

nativeTest(
  "incompatible companion fails before command environment delivery",
  () =>
    fixture(async (project) => {
      const { chmod } = await import("node:fs/promises");
      const wrapper = join(project.projectRoot, "wrong-version");
      await Bun.write(
        wrapper,
        `#!${process.execPath} --no-env-file\nconsole.log("synthetic incompatible version");\n`
      );
      await chmod(wrapper, 0o700);
      const saved = process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY;
      process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY = wrapper;
      try {
        await expect(
          controller(project).startMany({
            processes: [{ name: "worker", command }],
          })
        ).rejects.toThrow("incompatible");
        expect(await readLifecycleState(project)).toEqual([]);
      } finally {
        restoreEnv("HACK_LIFECYCLE_SUPERVISOR_BINARY", saved);
      }
    }),
  30_000
);
