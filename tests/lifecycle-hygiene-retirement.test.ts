import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateLifecycleLog,
  type LifecycleStateEntry,
  readLifecycleState,
  upsertLifecycleStateEntry,
} from "../src/lib/lifecycle-runtime.ts";
import { quoteShellWord } from "../src/lib/logs.ts";
import { readProcessIdentities } from "../src/lib/process-tree.ts";
import { wrapLifecyclePersistentCommand } from "../src/lib/project-lifecycle-controller.ts";
import {
  type LifecycleHygieneInspection,
  repairProjectLifecycleSessions,
} from "../src/lib/project-lifecycle-hygiene.ts";
import type { MuxBackend } from "../src/mux/mux-backend.ts";
import { restoreEnv } from "./helpers/env.ts";

/** Only mux effects and orphan discovery are faked; state and retirement are real. */
async function fixture(opts: {
  readonly root: string;
  readonly stop?: () => void;
  readonly processes?: LifecycleStateEntry["processes"];
}) {
  const entry: LifecycleStateEntry = {
    composeProject: "repair-fixture",
    projectName: "repair-fixture",
    branch: null,
    sessionName: "repair-fixture--lifecycle",
    backend: "tmux",
    ownershipToken: "repair-owner",
    definitionHash: "repair-definition",
    updatedAt: "2026-04-01T14:00:00.000Z",
    processes: opts.processes ?? [],
  };
  await upsertLifecycleStateEntry({ projectDir: opts.root, entry });
  let stopped = false;
  const unused = () => {
    throw new Error("Unexpected mux effect in repair fixture");
  };
  const backend: MuxBackend = {
    name: "tmux",
    available: true,
    listSessions: unused,
    createSession: unused,
    execInSession: unused,
    sendInput: unused,
    readLifecycleOwnerToken: () =>
      Promise.resolve(stopped ? null : (entry.ownershipToken ?? null)),
    killSession: () => {
      opts.stop?.();
      stopped = true;
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  const inspection: LifecycleHygieneInspection = {
    staleEntries: [],
    orphanedProcessGroups: [],
    orphanedSessions: [{ entry, classification: "owned-healthy" }],
    unverifiedSessions: [],
    runtimeAvailable: true,
  };
  const boundary = {
    inspect: () => Promise.resolve(inspection),
    backends: () => new Map([["tmux" as const, backend]]),
    readPanes: () =>
      Promise.resolve(
        entry.processes.flatMap((process) =>
          process.panePid
            ? [{ panePid: process.panePid, windowName: process.windowName }]
            : []
        )
      ),
    inspectSession: (args: { readonly entry: LifecycleStateEntry | null }) => {
      if (!args.entry) {
        throw new Error("Repair must inspect its recorded entry");
      }
      return Promise.resolve({
        classification: "owned-healthy" as const,
        decision: { kind: "adopt" as const, entry: args.entry },
        session: null,
        observedOwnershipToken: args.entry.ownershipToken ?? null,
      });
    },
  };
  return { entry, boundary, stopped: () => stopped };
}

for (const mode of ["survivor", "shell-only", "failed", "malformed"] as const) {
  test(`doctor repair uses complete live pane inventory (${mode})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-repair-inventory-"));
    const originalPath = process.env.PATH;
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const output =
        mode === "survivor"
          ? `printf '%s\\t%s\\n' ${process.pid} writer ${process.pid} shell`
          : `printf '%s\\t%s\\n' ${process.pid} shell`;
      const response =
        mode === "failed"
          ? "exit 1"
          : mode === "malformed"
            ? "printf 'invalid-inventory\\n'"
            : output;
      await writeFile(
        join(bin, "tmux"),
        `#!/bin/sh
[ "$1" = list-panes ] && [ "$2" = -s ] && [ "$3" = -t ] && [ "$4" = '=repair-fixture--lifecycle' ] || exit 93
${response}
`,
        { mode: 0o700 }
      );
      process.env.PATH = `${bin}:${originalPath ?? "/usr/bin:/bin"}`;
      const f = await fixture({
        root,
        processes: ["already-exited", "writer"].map((name) => ({
          name,
          windowName: name,
          logPath: join(root, `${name}.log`),
          panePid: process.pid,
        })),
      });
      let retirementCalls = 0;
      const result = await repairProjectLifecycleSessions({
        projectDir: root,
        projectRoot: root,
        boundary: {
          ...f.boundary,
          // Exercise the production mux query/parser, not the injected inventory.
          readPanes: undefined,
          retireSession: async (opts) => {
            retirementCalls += 1;
            expect(opts.processes.map((pane) => pane.panePid)).toEqual(
              mode === "survivor" ? [process.pid] : []
            );
            for (const pane of opts.processes) {
              expect(pane.paneBirth).toBeString();
            }
            await opts.assertFresh?.();
            return await opts.stopSession();
          },
        },
      });
      if (mode === "failed" || mode === "malformed") {
        expect(retirementCalls).toBe(0);
        expect(f.stopped()).toBe(false);
        expect(result.repairedSessions).toEqual([]);
        expect(result.failures[0]).toContain(
          mode === "failed"
            ? "Could not read current lifecycle pane identity"
            : "Current lifecycle pane inventory is invalid"
        );
        expect(await readLifecycleState({ projectDir: root })).toEqual([
          f.entry,
        ]);
      } else {
        expect(retirementCalls).toBe(1);
        expect(f.stopped()).toBe(true);
        expect(result).toEqual({
          repairedSessions: [f.entry.sessionName],
          failures: [],
        });
        expect(await readLifecycleState({ projectDir: root })).toEqual([]);
      }
    } finally {
      restoreEnv("PATH", originalPath);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("doctor repair keeps a matching live identity after its mux window disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-repair-lost-window-"));
  try {
    const birth = (await readProcessIdentities()).find(
      (row) => row.pid === process.pid
    )?.birth;
    expect(birth).toBeString();
    const f = await fixture({
      root,
      processes: [
        {
          name: "lost",
          windowName: "lost",
          logPath: join(root, "lost.log"),
          processGroupId: process.pid,
          processGroupBirth: birth,
        },
      ],
    });
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: { ...f.boundary, readPanes: () => Promise.resolve([]) },
    });
    expect(f.stopped()).toBe(false);
    expect(result.repairedSessions).toEqual([]);
    expect(result.failures[0]).toContain(
      "Recorded lifecycle identity remains alive outside current mux windows"
    );
    expect(await readLifecycleState({ projectDir: root })).toEqual([f.entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor repair cannot remove ownership or return before ordered retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-repair-gate-"));
  const f = await fixture({ root });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let completed = false;
  const repair = repairProjectLifecycleSessions({
    projectDir: root,
    projectRoot: root,
    boundary: {
      ...f.boundary,
      retireSession: async (opts) => {
        expect(opts.processes).toEqual(f.entry.processes);
        expect(await opts.stopSession()).toBe(true);
        entered.resolve();
        await release.promise;
        await opts.assertFresh?.();
        return true;
      },
    },
  }).then((result) => {
    completed = true;
    return result;
  });
  try {
    await Promise.race([
      entered.promise,
      repair.then(() => {
        throw new Error("Repair bypassed ordered retirement");
      }),
    ]);
    expect(f.stopped()).toBe(true);
    expect(completed).toBe(false);
    expect(await readLifecycleState({ projectDir: root })).toEqual([f.entry]);
    release.resolve();
    expect(await repair).toEqual({
      repairedSessions: [f.entry.sessionName],
      failures: [],
    });
    expect(await readLifecycleState({ projectDir: root })).toEqual([]);
  } finally {
    release.resolve();
    await repair;
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor repair ignores matching zombie pane and leader identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-repair-zombie-"));
  try {
    const f = await fixture({
      root,
      processes: [
        {
          name: "exited",
          windowName: "exited",
          logPath: join(root, "exited.log"),
          panePid: 42,
          paneBirth: "exited",
          processGroupId: 42,
          processGroupBirth: "exited",
        },
      ],
    });
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: {
        ...f.boundary,
        readIdentities: async () => [
          {
            pid: 42,
            parentPid: 1,
            processGroupId: 42,
            birth: "exited",
            zombie: true,
          },
        ],
      },
    });
    expect(result).toEqual({
      repairedSessions: [f.entry.sessionName],
      failures: [],
    });
    expect(await readLifecycleState({ projectDir: root })).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor repair reports unconfirmed retirement and keeps ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-repair-unknown-"));
  try {
    const f = await fixture({ root });
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: {
        ...f.boundary,
        retireSession: async (opts) => {
          await opts.stopSession();
          throw new Error("retirement remains unknown");
        },
      },
    });
    expect(result.repairedSessions).toEqual([]);
    expect(result.failures).toEqual([
      `${f.entry.sessionName}: retirement remains unknown; kept ownership state`,
    ]);
    expect(await readLifecycleState({ projectDir: root })).toEqual([f.entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unconfirmed doctor repair does not skip subsequent orphan candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-repair-continue-"));
  try {
    const f = await fixture({ root });
    const next: LifecycleStateEntry = {
      ...f.entry,
      composeProject: "repair-second",
      sessionName: "repair-second--lifecycle",
    };
    await upsertLifecycleStateEntry({ projectDir: root, entry: next });
    let attempts = 0;
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: {
        ...f.boundary,
        inspect: async () => ({
          ...(await f.boundary.inspect()),
          orphanedSessions: [f.entry, next].map((entry) => ({
            entry,
            classification: "owned-healthy" as const,
          })),
        }),
        retireSession: async (opts) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("process inspection unavailable");
          }
          return await opts.stopSession();
        },
      },
    });
    expect(attempts).toBe(2);
    expect(result.repairedSessions).toEqual([next.sessionName]);
    expect(result.failures).toEqual([
      `${f.entry.sessionName}: process inspection unavailable; kept ownership state`,
    ]);
    expect(await readLifecycleState({ projectDir: root })).toEqual([f.entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const legacy of [false, true]) {
  test(`doctor repair reaps a TERM-resistant FIFO command before its wrapper (${legacy ? "old record without birth" : "current record"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-repair-fifo-"));
    const logPath = join(root, "lifecycle.log");
    const commandPidPath = join(root, "command.pid");
    const ready = join(root, "ready");
    await ensurePrivateLifecycleLog({ root, logPath });
    const code = `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(ready)}, "yes"); setInterval(() => {}, 1000);`;
    const child = Bun.spawn(
      [
        "sh",
        "-c",
        wrapLifecyclePersistentCommand({
          command: `${quoteShellWord(process.execPath)} --no-env-file -e ${quoteShellWord(code)}`,
          commandPidPath,
          logPath,
          serviceName: "writer",
        }),
      ],
      {
        detached: true,
        env: { PATH: "/usr/bin:/bin", TMPDIR: root },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    let group: number | undefined;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 25_000);
    try {
      const deadline = performance.now() + 10_000;
      while (
        !(await Bun.file(ready).exists()) &&
        child.exitCode === null &&
        performance.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(ready).exists()).toBe(true);
      group = Number.parseInt(await Bun.file(commandPidPath).text(), 10);
      expect(group).toBeGreaterThan(1);
      expect(
        (await readProcessIdentities()).find((row) => row.pid === group)
          ?.processGroupId,
        "the fixture requires a real dedicated command process group"
      ).toBe(group);
      const paneBirth = (await readProcessIdentities()).find(
        (row) => row.pid === child.pid
      )?.birth;
      expect(paneBirth).toBeDefined();
      const f = await fixture({
        root,
        stop: () => process.kill(-child.pid, "SIGHUP"),
        processes: [
          {
            name: "writer",
            windowName: "writer",
            logPath,
            panePid: child.pid,
            ...(legacy ? {} : { paneBirth }),
            processGroupId: group,
          },
        ],
      });
      expect(
        await repairProjectLifecycleSessions({
          projectDir: root,
          projectRoot: root,
          boundary: f.boundary,
        })
      ).toEqual({ repairedSessions: [f.entry.sessionName], failures: [] });
      expect(await child.exited).toBe(130);
      expect(() => process.kill(-(group ?? 0), 0)).toThrow();
      expect(() => process.kill(-child.pid, 0)).toThrow();
      expect(await readLifecycleState({ projectDir: root })).toEqual([]);
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith("hack-lifecycle.")
        )
      ).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      if (group !== undefined && group > 1) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {
          /* already absent */
        }
      }
      if (child.exitCode === null) {
        await Promise.race([child.exited, Bun.sleep(1000)]);
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
