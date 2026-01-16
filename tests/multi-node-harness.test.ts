import { expect, test } from "bun:test"

import {
  createFakeTransport,
  createNodeRegistryStore,
  deriveNodeHealth,
  selectNode
} from "./helpers/multi-node.ts"

const nowIso = "2026-01-14T00:00:00.000Z"
const staleAfterMs = 10_000
const offlineAfterMs = 60_000

const isoOffset = ({ baseIso, offsetMs }: { readonly baseIso: string; readonly offsetMs: number }) =>
  new Date(Date.parse(baseIso) + offsetMs).toISOString()

test("deriveNodeHealth classifies healthy/stale/offline", () => {
  expect(
    deriveNodeHealth({
      lastSeenAt: isoOffset({ baseIso: nowIso, offsetMs: -2_000 }),
      nowIso,
      staleAfterMs,
      offlineAfterMs
    })
  ).toBe("healthy")

  expect(
    deriveNodeHealth({
      lastSeenAt: isoOffset({ baseIso: nowIso, offsetMs: -20_000 }),
      nowIso,
      staleAfterMs,
      offlineAfterMs
    })
  ).toBe("stale")

  expect(
    deriveNodeHealth({
      lastSeenAt: isoOffset({ baseIso: nowIso, offsetMs: -120_000 }),
      nowIso,
      staleAfterMs,
      offlineAfterMs
    })
  ).toBe("offline")
})

test("node registry store supports upsert and default selection", () => {
  const store = createNodeRegistryStore({})
  store.upsert({
    node: {
      id: "node-a",
      label: "Alpha",
      address: "100.64.0.1",
      lastSeenAt: nowIso
    }
  })
  store.setDefault({ id: "node-a" })

  const snapshot = store.getSnapshot()
  expect(snapshot.nodes.length).toBe(1)
  expect(snapshot.defaultNodeId).toBe("node-a")
})

test("selectNode returns explicit node when healthy", () => {
  const store = createNodeRegistryStore({
    initialNodes: [
      {
        id: "node-a",
        label: "Alpha",
        address: "100.64.0.1",
        lastSeenAt: nowIso
      }
    ]
  })

  const result = selectNode({
    registry: store.getSnapshot(),
    desiredNodeId: "node-a",
    nowIso,
    staleAfterMs,
    offlineAfterMs
  })

  expect(result.node?.id).toBe("node-a")
  expect(result.reason).toBe("explicit")
})

test("selectNode reports stale when desired node is stale", () => {
  const store = createNodeRegistryStore({
    initialNodes: [
      {
        id: "node-a",
        label: "Alpha",
        address: "100.64.0.1",
        lastSeenAt: isoOffset({ baseIso: nowIso, offsetMs: -20_000 })
      }
    ]
  })

  const result = selectNode({
    registry: store.getSnapshot(),
    desiredNodeId: "node-a",
    nowIso,
    staleAfterMs,
    offlineAfterMs
  })

  expect(result.node).toBe(null)
  expect(result.reason).toBe("stale")
})

test("selectNode falls back to first healthy node", () => {
  const store = createNodeRegistryStore({
    initialNodes: [
      {
        id: "node-a",
        label: "Alpha",
        address: "100.64.0.1",
        lastSeenAt: isoOffset({ baseIso: nowIso, offsetMs: -120_000 })
      },
      {
        id: "node-b",
        label: "Beta",
        address: "100.64.0.2",
        lastSeenAt: nowIso
      }
    ]
  })

  const result = selectNode({
    registry: store.getSnapshot(),
    nowIso,
    staleAfterMs,
    offlineAfterMs
  })

  expect(result.node?.id).toBe("node-b")
  expect(result.reason).toBe("fallback")
})

test("fake transport reports offline nodes", async () => {
  const transport = createFakeTransport()
  transport.setNodeOffline({ nodeId: "node-a" })

  const response = await transport.request({ nodeId: "node-a", path: "/v1/node/status" })
  expect(response.ok).toBe(false)
  if (!response.ok) {
    expect(response.error).toBe("transport offline")
  }
})
