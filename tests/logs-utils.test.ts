import { expect, test } from "bun:test"

import { buildLogSelector, resolveShouldTryLoki, resolveUseLoki } from "../src/lib/logs.ts"

test("buildLogSelector renders project-only selector", () => {
  expect(buildLogSelector({ project: "my-project", services: [] })).toBe('{project="my-project"}')
})

test("buildLogSelector renders single service selector", () => {
  expect(buildLogSelector({ project: "my-project", services: ["api"] })).toBe(
    '{project="my-project",service="api"}'
  )
})

test("buildLogSelector renders regex selector for multiple services", () => {
  expect(buildLogSelector({ project: "my-project", services: ["api", "worker"] })).toBe(
    '{project="my-project",service=~"^(api|worker)$"}'
  )
})

test("buildLogSelector escapes regex characters in service names", () => {
  expect(buildLogSelector({ project: null, services: ["api.v2", "web*"] })).toBe(
    '{service=~"^(api\\\\\\\\.v2|web\\\\\\\\*)$"}'
  )
})

test("resolveShouldTryLoki respects explicit compose override", () => {
  expect(
    resolveShouldTryLoki({
      forceCompose: true,
      wantsLokiExplicit: true,
      follow: true,
      followBackend: "loki",
      snapshotBackend: "loki"
    })
  ).toBe(false)
})

test("resolveShouldTryLoki prefers explicit Loki request", () => {
  expect(
    resolveShouldTryLoki({
      forceCompose: false,
      wantsLokiExplicit: true,
      follow: true,
      followBackend: "compose",
      snapshotBackend: "compose"
    })
  ).toBe(true)
})

test("resolveShouldTryLoki follows backend preferences", () => {
  expect(
    resolveShouldTryLoki({
      forceCompose: false,
      wantsLokiExplicit: false,
      follow: true,
      followBackend: "loki",
      snapshotBackend: "compose"
    })
  ).toBe(true)
  expect(
    resolveShouldTryLoki({
      forceCompose: false,
      wantsLokiExplicit: false,
      follow: false,
      followBackend: "compose",
      snapshotBackend: "loki"
    })
  ).toBe(true)
})

test("resolveUseLoki honors explicit Loki request and reachability", () => {
  expect(
    resolveUseLoki({
      forceCompose: false,
      wantsLokiExplicit: true,
      shouldTryLoki: true,
      lokiReachable: false
    })
  ).toBe(true)
  expect(
    resolveUseLoki({
      forceCompose: false,
      wantsLokiExplicit: false,
      shouldTryLoki: true,
      lokiReachable: false
    })
  ).toBe(false)
})
