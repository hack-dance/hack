import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type {
  MuxBackend,
  MuxBackendName,
  MuxSession,
} from "../mux/mux-backend.ts";
import type { LifecycleStateEntry } from "./lifecycle-runtime.ts";

export type LifecycleSessionClassification =
  | "absent"
  | "owned-healthy"
  | "owned-stale"
  | "legacy-owned"
  | "foreign";

export type LifecycleSessionDecision =
  | { readonly kind: "create" }
  | { readonly kind: "adopt"; readonly entry: LifecycleStateEntry }
  | {
      readonly kind: "replace";
      readonly entry: LifecycleStateEntry;
      readonly classification: "owned-stale" | "legacy-owned";
    }
  | { readonly kind: "block"; readonly reason: string };

export type LifecycleSessionInspection = {
  readonly classification: LifecycleSessionClassification;
  readonly decision: LifecycleSessionDecision;
  readonly session: MuxSession | null;
  readonly observedOwnershipToken: string | null;
};

export function createLifecycleOwnershipToken(): string {
  return randomUUID();
}

export function resolveLifecycleDefinitionHash(opts: {
  readonly definitions: readonly unknown[];
}): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(opts.definitions))
    .digest("hex");
}

export function classifyLifecycleSession(opts: {
  readonly session: MuxSession | null;
  readonly entry: LifecycleStateEntry | null;
  readonly observedOwnershipToken: string | null;
  readonly expectedBackend: MuxBackendName;
  readonly expectedSessionName: string;
  readonly expectedProjectRoot: string;
  readonly expectedDefinitionHash: string;
  readonly liveWindowNames: ReadonlySet<string> | null;
}): LifecycleSessionInspection {
  if (!opts.session) {
    return {
      classification: "absent",
      decision: { kind: "create" },
      session: null,
      observedOwnershipToken: null,
    };
  }

  const entryMatchesSession =
    opts.entry?.backend === opts.expectedBackend &&
    opts.entry.sessionName === opts.expectedSessionName;
  if (!(entryMatchesSession && opts.entry)) {
    return foreignInspection({
      session: opts.session,
      observedOwnershipToken: opts.observedOwnershipToken,
      reason: `Lifecycle session "${opts.expectedSessionName}" already exists without matching Hack lifecycle state. Refusing to replace it without ownership proof.`,
    });
  }

  if (opts.entry.ownershipToken) {
    if (opts.observedOwnershipToken !== opts.entry.ownershipToken) {
      return foreignInspection({
        session: opts.session,
        observedOwnershipToken: opts.observedOwnershipToken,
        reason: `Lifecycle session "${opts.expectedSessionName}" ownership metadata does not match persisted Hack state. Refusing destructive recovery.`,
      });
    }

    const definitionMatches =
      opts.entry.definitionHash === opts.expectedDefinitionHash;
    const windowsHealthy =
      opts.entry.processes.length > 0 &&
      opts.liveWindowNames !== null &&
      opts.entry.processes.every((process) =>
        opts.liveWindowNames?.has(process.windowName)
      );
    if (definitionMatches && windowsHealthy) {
      return {
        classification: "owned-healthy",
        decision: { kind: "adopt", entry: opts.entry },
        session: opts.session,
        observedOwnershipToken: opts.observedOwnershipToken,
      };
    }

    return {
      classification: "owned-stale",
      decision: {
        kind: "replace",
        entry: opts.entry,
        classification: "owned-stale",
      },
      session: opts.session,
      observedOwnershipToken: opts.observedOwnershipToken,
    };
  }

  if (
    hasLegacyTmuxOwnershipProof({
      entry: opts.entry,
      session: opts.session,
      expectedProjectRoot: opts.expectedProjectRoot,
    })
  ) {
    return {
      classification: "legacy-owned",
      decision: {
        kind: "replace",
        entry: opts.entry,
        classification: "legacy-owned",
      },
      session: opts.session,
      observedOwnershipToken: null,
    };
  }

  return foreignInspection({
    session: opts.session,
    observedOwnershipToken: null,
    reason: `Lifecycle session "${opts.expectedSessionName}" predates ownership metadata and cannot be proven to belong to this project. Refusing destructive recovery.`,
  });
}

export async function inspectLifecycleSession(opts: {
  readonly backend: MuxBackend;
  readonly entry: LifecycleStateEntry | null;
  readonly expectedSessionName: string;
  readonly expectedProjectRoot: string;
  readonly expectedDefinitionHash: string;
}): Promise<LifecycleSessionInspection> {
  const sessions = await opts.backend.listSessions();
  const session =
    sessions.find((candidate) => candidate.name === opts.expectedSessionName) ??
    null;
  if (!session) {
    return classifyLifecycleSession({
      session: null,
      entry: opts.entry,
      observedOwnershipToken: null,
      expectedBackend: opts.backend.name,
      expectedSessionName: opts.expectedSessionName,
      expectedProjectRoot: opts.expectedProjectRoot,
      expectedDefinitionHash: opts.expectedDefinitionHash,
      liveWindowNames: null,
    });
  }

  const [observedOwnershipToken, liveWindowNames] = await Promise.all([
    opts.backend.readLifecycleOwnerToken?.({
      name: opts.expectedSessionName,
    }) ?? Promise.resolve(null),
    opts.backend.listSessionWindowNames?.({ name: opts.expectedSessionName }) ??
      Promise.resolve(null),
  ]);
  return classifyLifecycleSession({
    session,
    entry: opts.entry,
    observedOwnershipToken,
    expectedBackend: opts.backend.name,
    expectedSessionName: opts.expectedSessionName,
    expectedProjectRoot: await normalizePath(opts.expectedProjectRoot),
    expectedDefinitionHash: opts.expectedDefinitionHash,
    liveWindowNames,
  });
}

export async function killLifecycleSessionWithOwnership(opts: {
  readonly backend: MuxBackend;
  readonly sessionName: string;
  readonly ownershipToken: string;
}): Promise<boolean> {
  const observedToken =
    (await opts.backend.readLifecycleOwnerToken?.({
      name: opts.sessionName,
    })) ?? null;
  if (observedToken !== opts.ownershipToken) {
    return false;
  }
  const result = await opts.backend.killSession({ name: opts.sessionName });
  return result.exitCode === 0;
}

export async function killInspectedLifecycleSession(opts: {
  readonly backend: MuxBackend;
  readonly inspection: LifecycleSessionInspection;
}): Promise<boolean> {
  if (
    opts.inspection.decision.kind === "create" ||
    opts.inspection.decision.kind === "block"
  ) {
    return false;
  }
  const entry = opts.inspection.decision.entry;
  if (entry.ownershipToken) {
    return await killLifecycleSessionWithOwnership({
      backend: opts.backend,
      sessionName: entry.sessionName,
      ownershipToken: entry.ownershipToken,
    });
  }
  const result = await opts.backend.killSession({ name: entry.sessionName });
  return result.exitCode === 0;
}

function hasLegacyTmuxOwnershipProof(opts: {
  readonly entry: LifecycleStateEntry;
  readonly session: MuxSession;
  readonly expectedProjectRoot: string;
}): boolean {
  if (
    opts.entry.backend !== "tmux" ||
    opts.session.backend !== "tmux" ||
    !opts.session.path ||
    !opts.session.createdAt
  ) {
    return false;
  }
  const createdAt = Date.parse(opts.session.createdAt);
  const stateUpdatedAt = Date.parse(opts.entry.updatedAt);
  const enoughWindows =
    opts.session.windows !== null &&
    opts.session.windows >= opts.entry.processes.length + 1;
  return (
    opts.session.path === opts.expectedProjectRoot &&
    Number.isFinite(createdAt) &&
    Number.isFinite(stateUpdatedAt) &&
    createdAt <= stateUpdatedAt &&
    enoughWindows
  );
}

function foreignInspection(opts: {
  readonly session: MuxSession;
  readonly observedOwnershipToken: string | null;
  readonly reason: string;
}): LifecycleSessionInspection {
  return {
    classification: "foreign",
    decision: { kind: "block", reason: opts.reason },
    session: opts.session,
    observedOwnershipToken: opts.observedOwnershipToken,
  };
}

async function normalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
