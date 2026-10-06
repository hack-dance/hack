import { expect, test } from "bun:test";

import type { LifecycleStateEntry } from "../src/lib/lifecycle-runtime.ts";
import {
  classifyLifecycleSession,
  inspectLifecycleSession,
  killInspectedLifecycleSession,
  killLifecycleSessionWithOwnership,
  resolveLifecycleDefinitionHash,
  resolveLifecycleEnvironmentFingerprint,
} from "../src/lib/project-lifecycle-sessions.ts";
import type { MuxBackend, MuxSession } from "../src/mux/mux-backend.ts";

const ownershipToken = ["test", "lifecycle", "owner"].join("-");
const definitionHash = resolveLifecycleDefinitionHash({
  definitions: [{ name: "proxy", command: "bun proxy.ts" }],
});
const session: MuxSession = {
  backend: "tmux",
  name: "event-agent--lifecycle",
  attached: false,
  path: "/tmp/event-agent",
  windows: 2,
  createdAt: "2026-07-09T12:00:00.000Z",
};
const entry: LifecycleStateEntry = {
  composeProject: "event-agent",
  projectName: "event-agent",
  branch: null,
  sessionName: session.name,
  backend: "tmux",
  ownershipToken,
  definitionHash,
  updatedAt: "2026-07-09T12:00:01.000Z",
  processes: [
    {
      name: "proxy",
      windowName: "proxy",
      logPath: "/tmp/event-agent.log",
    },
  ],
};

test("resolveLifecycleEnvironmentFingerprint is stable without exposing env data", () => {
  const first = resolveLifecycleEnvironmentFingerprint({
    effectiveEnvName: "qa",
    env: { SECOND: "two", FIRST: "one" },
  });
  const reordered = resolveLifecycleEnvironmentFingerprint({
    effectiveEnvName: "qa",
    env: { FIRST: "one", SECOND: "two" },
  });

  expect(first).toBe(reordered);
  expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(first).not.toContain("qa");
  expect(first).not.toContain("FIRST");
  expect(first).not.toContain("one");
});

test("resolveLifecycleEnvironmentFingerprint changes with overlay or values", () => {
  const base = resolveLifecycleEnvironmentFingerprint({
    effectiveEnvName: "qa",
    env: { SERVICE_URL: "https://qa.invalid" },
  });
  const changedValue = resolveLifecycleEnvironmentFingerprint({
    effectiveEnvName: "qa",
    env: { SERVICE_URL: "https://prod.invalid" },
  });
  const changedOverlay = resolveLifecycleEnvironmentFingerprint({
    effectiveEnvName: "prod",
    env: { SERVICE_URL: "https://qa.invalid" },
  });

  expect(changedValue).not.toBe(base);
  expect(changedOverlay).not.toBe(base);
});

test("classifyLifecycleSession creates when the expected session is absent", () => {
  const inspection = classifyLifecycleSession({
    session: null,
    entry,
    observedOwnershipToken: null,
    expectedBackend: "tmux",
    expectedSessionName: session.name,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: definitionHash,
    liveWindowNames: null,
  });

  expect(inspection.classification).toBe("absent");
  expect(inspection.decision).toEqual({ kind: "create" });
});

test("classifyLifecycleSession adopts a token-owned healthy session", () => {
  const inspection = classifyLifecycleSession({
    session,
    entry,
    observedOwnershipToken: ownershipToken,
    expectedBackend: "tmux",
    expectedSessionName: session.name,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: definitionHash,
    liveWindowNames: new Set(["shell", "proxy"]),
  });

  expect(inspection.classification).toBe("owned-healthy");
  expect(inspection.decision.kind).toBe("adopt");
});

test("classifyLifecycleSession replaces a token-owned stale session", () => {
  const inspection = classifyLifecycleSession({
    session,
    entry,
    observedOwnershipToken: ownershipToken,
    expectedBackend: "tmux",
    expectedSessionName: session.name,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: definitionHash,
    liveWindowNames: new Set(["shell"]),
  });

  expect(inspection.classification).toBe("owned-stale");
  expect(inspection.decision).toMatchObject({ kind: "replace" });
});

test("classifyLifecycleSession replaces a legacy tmux session only with path and timestamp proof", () => {
  const legacyEntry = { ...entry, ownershipToken: undefined };
  const inspection = classifyLifecycleSession({
    session,
    entry: legacyEntry,
    observedOwnershipToken: null,
    expectedBackend: "tmux",
    expectedSessionName: session.name,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: definitionHash,
    liveWindowNames: new Set(["shell", "proxy"]),
  });

  expect(inspection.classification).toBe("legacy-owned");
  expect(inspection.decision).toMatchObject({ kind: "replace" });
});

test("classifyLifecycleSession blocks same-name sessions without ownership proof", () => {
  const inspection = classifyLifecycleSession({
    session: { ...session, path: "/tmp/unrelated" },
    entry: { ...entry, ownershipToken: undefined },
    observedOwnershipToken: null,
    expectedBackend: "tmux",
    expectedSessionName: session.name,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: definitionHash,
    liveWindowNames: new Set(["shell", "proxy"]),
  });

  expect(inspection.classification).toBe("foreign");
  expect(inspection.decision).toMatchObject({ kind: "block" });
});

function inspectionBackend(overrides: Partial<MuxBackend> = {}): MuxBackend {
  return {
    name: "tmux",
    available: true,
    listSessions: async () => [session],
    createSession: async () => ({ ok: true, session }),
    killSession: async () => {
      throw new Error("Inspection must not kill a session");
    },
    readLifecycleOwnerToken: async () => null,
    listSessionWindowNames: async () => null,
    execInSession: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sendInput: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

function inspectFixture(backend: MuxBackend) {
  return inspectLifecycleSession({
    backend,
    entry,
    expectedSessionName: session.name,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: definitionHash,
  });
}

test("inspection accepts exact-owned cleanup between session listing and owner read", async () => {
  let live = true;
  let kills = 0;
  const presenceQueries: string[] = [];
  const backend = inspectionBackend({
    listSessions: async () => {
      const snapshot = live ? [session] : [];
      // The foreground finalizer retires its session after down took a snapshot.
      expect(
        await killLifecycleSessionWithOwnership({
          backend,
          sessionName: session.name,
          ownershipToken,
        })
      ).toBe(true);
      return snapshot;
    },
    readLifecycleOwnerToken: async () => (live ? ownershipToken : null),
    readSessionPresence: async ({ name }) => {
      presenceQueries.push(name);
      return live ? "present" : "absent";
    },
    killSession: async () => {
      kills += 1;
      live = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const inspection = await inspectFixture(backend);
  expect(inspection.classification).toBe("absent");
  expect(inspection.decision).toEqual({ kind: "create" });
  expect(inspection.session).toBeNull();
  expect(presenceQueries).toEqual([session.name]);
  expect(await killInspectedLifecycleSession({ backend, inspection })).toBe(
    false
  );
  expect(kills).toBe(1);
});

test.each([
  "present",
  "unknown",
] as const)("inspection refuses missing ownership when fresh session presence is %s", async (presence) => {
  const backend = inspectionBackend({
    readSessionPresence: async () => presence,
  });
  const inspection = await inspectFixture(backend);
  expect(inspection.classification).toBe("foreign");
  expect(inspection.decision.kind).toBe("block");
});

test("inspection refuses missing ownership without an explicit presence query", async () => {
  expect((await inspectFixture(inspectionBackend())).decision.kind).toBe(
    "block"
  );
});

test("inspection propagates a presence query failure", async () => {
  const backend = inspectionBackend({
    readSessionPresence: async () => {
      throw new Error("Presence query unavailable");
    },
  });
  await expect(inspectFixture(backend)).rejects.toThrow(
    "Presence query unavailable"
  );
});

test("inspection never excuses a changed token with subsequent absence", async () => {
  const backend = inspectionBackend({
    readLifecycleOwnerToken: async () => "foreign-token",
    readSessionPresence: async () => {
      throw new Error(
        "A changed token must refuse without an absence fallback"
      );
    },
  });
  const inspection = await inspectFixture(backend);
  expect(inspection.classification).toBe("foreign");
  expect(inspection.decision.kind).toBe("block");
});

test("inspection does not reinterpret unrelated persisted ownership", async () => {
  const backend = inspectionBackend({
    readSessionPresence: async () => {
      throw new Error("Mismatched state must not use an absence fallback");
    },
  });
  const inspection = await inspectLifecycleSession({
    backend,
    entry: { ...entry, sessionName: "another-session" },
    expectedSessionName: session.name,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: definitionHash,
  });
  expect(inspection.classification).toBe("foreign");
  expect(inspection.decision.kind).toBe("block");
});

test("killLifecycleSessionWithOwnership cleans up only an exact token match", async () => {
  const killed: string[] = [];
  let observedToken: string | null = ownershipToken;
  const backend: MuxBackend = {
    name: "tmux",
    available: true,
    listSessions: async () => [session],
    createSession: async () => ({ ok: true, session }),
    killSession: async ({ name }) => {
      killed.push(name);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readLifecycleOwnerToken: async () => observedToken,
    execInSession: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sendInput: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };

  expect(
    await killLifecycleSessionWithOwnership({
      backend,
      sessionName: session.name,
      ownershipToken,
    })
  ).toBe(true);
  observedToken = "different-token";
  expect(
    await killLifecycleSessionWithOwnership({
      backend,
      sessionName: session.name,
      ownershipToken,
    })
  ).toBe(false);
  expect(killed).toEqual([session.name]);
});

test("lifecycle retirement requires explicit absence when a concurrent finalizer removed ownership", async () => {
  const killed: string[] = [];
  let presence: "present" | "absent" | "unknown" = "absent";
  let observedToken: string | null = null;
  const backend: MuxBackend = {
    name: "tmux",
    available: true,
    listSessions: async () => [],
    createSession: async () => ({ ok: true, session }),
    killSession: async ({ name }) => {
      killed.push(name);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readLifecycleOwnerToken: async () => observedToken,
    readSessionPresence: async () => presence,
    execInSession: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sendInput: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  const retire = () =>
    killLifecycleSessionWithOwnership({
      backend,
      sessionName: session.name,
      ownershipToken,
    });

  expect(await retire()).toBe(true);
  presence = "present";
  expect(await retire()).toBe(false);
  presence = "unknown";
  expect(await retire()).toBe(false);
  presence = "absent";
  observedToken = "foreign-token";
  expect(await retire()).toBe(false);
  expect(killed).toEqual([]);
});

test("lifecycle retirement rechecks absence after a failed kill", async () => {
  let presence: "present" | "absent" | "unknown" = "absent";
  let kills = 0;
  const backend: MuxBackend = {
    name: "tmux",
    available: true,
    listSessions: async () => [session],
    createSession: async () => ({ ok: true, session }),
    killSession: async () => {
      kills += 1;
      return { exitCode: 1, stdout: "", stderr: "session disappeared" };
    },
    readLifecycleOwnerToken: async () => ownershipToken,
    readSessionPresence: async () => presence,
    execInSession: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sendInput: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  const retire = () =>
    killLifecycleSessionWithOwnership({
      backend,
      sessionName: session.name,
      ownershipToken,
    });

  expect(await retire()).toBe(true);
  presence = "present";
  expect(await retire()).toBe(false);
  presence = "unknown";
  expect(await retire()).toBe(false);
  expect(kills).toBe(3);
});
