export type NodeHealth = "healthy" | "stale" | "offline";

export interface TestNode {
  readonly id: string;
  readonly label: string;
  readonly address: string;
  readonly lastSeenAt: string;
}

export interface NodeRegistrySnapshot {
  readonly nodes: readonly TestNode[];
  readonly defaultNodeId: string | null;
}

export interface NodeRegistryStore {
  getSnapshot(): NodeRegistrySnapshot;
  upsert(opts: { readonly node: TestNode }): NodeRegistrySnapshot;
  remove(opts: { readonly id: string }): NodeRegistrySnapshot;
  setDefault(opts: { readonly id: string | null }): NodeRegistrySnapshot;
  touch(opts: {
    readonly id: string;
    readonly nowIso: string;
  }): NodeRegistrySnapshot;
}

export function createNodeRegistryStore(opts: {
  readonly initialNodes?: readonly TestNode[];
  readonly defaultNodeId?: string | null;
}): NodeRegistryStore {
  const nodes = [...(opts.initialNodes ?? [])];
  let defaultNodeId = opts.defaultNodeId ?? null;

  const getSnapshot = () => ({
    nodes: [...nodes],
    defaultNodeId,
  });

  const upsert = ({ node }: { readonly node: TestNode }) => {
    const index = nodes.findIndex((existing) => existing.id === node.id);
    if (index >= 0) {
      nodes[index] = node;
    } else {
      nodes.push(node);
    }
    return getSnapshot();
  };

  const remove = ({ id }: { readonly id: string }) => {
    const index = nodes.findIndex((existing) => existing.id === id);
    if (index >= 0) {
      nodes.splice(index, 1);
    }
    if (defaultNodeId === id) {
      defaultNodeId = null;
    }
    return getSnapshot();
  };

  const setDefault = ({ id }: { readonly id: string | null }) => {
    defaultNodeId = id;
    return getSnapshot();
  };

  const touch = ({
    id,
    nowIso,
  }: {
    readonly id: string;
    readonly nowIso: string;
  }) => {
    const index = nodes.findIndex((existing) => existing.id === id);
    const existing = nodes[index];
    if (index >= 0 && existing) {
      nodes[index] = { ...existing, lastSeenAt: nowIso };
    }
    return getSnapshot();
  };

  return { getSnapshot, upsert, remove, setDefault, touch };
}

export function deriveNodeHealth(opts: {
  readonly lastSeenAt: string;
  readonly nowIso: string;
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
}): NodeHealth {
  const nowMs = Date.parse(opts.nowIso);
  const seenMs = Date.parse(opts.lastSeenAt);
  const ageMs = Math.max(0, nowMs - seenMs);
  if (ageMs >= opts.offlineAfterMs) {
    return "offline";
  }
  if (ageMs >= opts.staleAfterMs) {
    return "stale";
  }
  return "healthy";
}

export type NodeSelectionReason =
  | "explicit"
  | "default"
  | "fallback"
  | "missing"
  | "stale"
  | "offline";

export interface NodeSelection {
  readonly node: TestNode | null;
  readonly reason: NodeSelectionReason;
}

export function selectNode(opts: {
  readonly registry: NodeRegistrySnapshot;
  readonly desiredNodeId?: string | null;
  readonly nowIso: string;
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
}): NodeSelection {
  const resolveStatus = (node: TestNode) =>
    deriveNodeHealth({
      lastSeenAt: node.lastSeenAt,
      nowIso: opts.nowIso,
      staleAfterMs: opts.staleAfterMs,
      offlineAfterMs: opts.offlineAfterMs,
    });

  const selectCandidate = (
    node: TestNode | null,
    reason: NodeSelectionReason
  ): NodeSelection => {
    if (!node) {
      return { node: null, reason: "missing" };
    }
    const status = resolveStatus(node);
    if (status !== "healthy") {
      return { node: null, reason: status };
    }
    return { node, reason };
  };

  if (opts.desiredNodeId) {
    const node =
      opts.registry.nodes.find(
        (candidate) => candidate.id === opts.desiredNodeId
      ) ?? null;
    return selectCandidate(node, "explicit");
  }

  if (opts.registry.defaultNodeId) {
    const node =
      opts.registry.nodes.find(
        (candidate) => candidate.id === opts.registry.defaultNodeId
      ) ?? null;
    return selectCandidate(node, "default");
  }

  const statuses = opts.registry.nodes.map((node) => resolveStatus(node));
  const healthyIndex = statuses.indexOf("healthy");
  if (healthyIndex >= 0) {
    return {
      node: opts.registry.nodes[healthyIndex] ?? null,
      reason: "fallback",
    };
  }

  if (opts.registry.nodes.length === 0) {
    return { node: null, reason: "missing" };
  }
  if (statuses.every((status) => status === "offline")) {
    return { node: null, reason: "offline" };
  }
  return { node: null, reason: "stale" };
}

export type TransportResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export interface TransportCall {
  readonly nodeId: string;
  readonly path: string;
}

export interface FakeTransport {
  readonly calls: readonly TransportCall[];
  request<T>(opts: {
    readonly nodeId: string;
    readonly path: string;
  }): Promise<TransportResponse<T>>;
  setNodeOffline(opts: { readonly nodeId: string }): void;
  setNodeOnline(opts: { readonly nodeId: string }): void;
  setResponse<T>(opts: {
    readonly nodeId: string;
    readonly response: TransportResponse<T>;
  }): void;
}

export function createFakeTransport(opts?: {
  readonly defaultResponse?: TransportResponse<unknown>;
}): FakeTransport {
  const calls: TransportCall[] = [];
  const offline = new Set<string>();
  const responses = new Map<string, TransportResponse<unknown>>();
  const defaultResponse: TransportResponse<unknown> = opts?.defaultResponse ?? {
    ok: true,
    data: null,
  };

  const request = async <T>({
    nodeId,
    path,
  }: {
    readonly nodeId: string;
    readonly path: string;
  }): Promise<TransportResponse<T>> => {
    calls.push({ nodeId, path });
    if (offline.has(nodeId)) {
      return { ok: false, error: "transport offline" };
    }
    const response = responses.get(nodeId) ?? defaultResponse;
    return response as TransportResponse<T>;
  };

  const setNodeOffline = ({ nodeId }: { readonly nodeId: string }) => {
    offline.add(nodeId);
  };

  const setNodeOnline = ({ nodeId }: { readonly nodeId: string }) => {
    offline.delete(nodeId);
  };

  const setResponse = <T>({
    nodeId,
    response,
  }: {
    readonly nodeId: string;
    readonly response: TransportResponse<T>;
  }) => {
    responses.set(nodeId, response as TransportResponse<unknown>);
  };

  return {
    calls,
    request,
    setNodeOffline,
    setNodeOnline,
    setResponse,
  };
}
