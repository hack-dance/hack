import { expect, test } from "bun:test";
import {
  hasOnlyNativeCacheLabels,
  nativeCacheInitializers,
  nativeSharedSourceFlags,
  nativeStartCacheSource,
  publishNativeCacheSource,
} from "../src/backends/native-project-cache.ts";
import type { NativeProjectReview } from "../src/backends/native-project-review.ts";
import {
  expectClosedRefusal,
  expectClosedThrow,
} from "./helpers/closed-refusal.ts";

const planId = "a".repeat(64),
  namespace = "b".repeat(64),
  revision = "c".repeat(64);
function review(services: Record<string, unknown>): NativeProjectReview {
  return {
    planId,
    namespace,
    projectArgs: [
      "--project",
      "/fixture",
      "--normalized-file",
      "/private/public.json",
      "--expect-original",
      "d".repeat(64),
    ],
    report: { plan: { services } },
  };
}
const base = {
  runtime: { binary: "/native", home: "/home" },
  projectRoot: "/fixture",
};
test("image-only and inactive bind services do not request native shared-source mode", () => {
  expect(
    nativeSharedSourceFlags({
      services: {
        web: { active: true, mounts: [] },
        disabled: { active: false, mounts: [{ kind: "bind" }] },
      },
    })
  ).toEqual([]);
  expect(
    nativeSharedSourceFlags({
      services: { web: { active: true, mounts: [{ kind: "volume" }] } },
    })
  ).toEqual([]);
  expect(
    nativeSharedSourceFlags({
      services: { web: { active: true, mounts: [{ kind: "bind" }] } },
    })
  ).toEqual(["--shared-source"]);
});
test("cache labels preserve map/list contracts without admitting routing or unrelated labels", () => {
  for (const labels of [
    undefined,
    {},
    {
      "hack.dependencies.cache-volume": "modules",
      "hack.dependencies.bootstrap": "true",
    },
    ["hack.dependencies.lockfiles=bun.lock"],
  ]) {
    expect(hasOnlyNativeCacheLabels(labels)).toBe(true);
  }
  for (const labels of [
    null,
    [1],
    { caddy: "app.hack.local" },
    ["hack.dependencies.unknown=1"],
  ]) {
    expect(hasOnlyNativeCacheLabels(labels)).toBe(false);
  }
});
test("only active reviewed initializers publish the exact normalized source", async () => {
  const selected = review({
    deps: { active: true, dependency_cache: { volume: "modules" } },
    disabled: { active: false, dependency_cache: { volume: "other" } },
    web: { active: true },
  });
  const result = await publishNativeCacheSource({
    ...base,
    review: selected,
    invoke: async (request) => {
      expect(request.args).toEqual([
        "project",
        "publish-source",
        ...selected.projectArgs,
        "--expect-plan",
        planId,
        "--json",
      ]);
      expect(request.privateInput).toBeUndefined();
      return {
        revision,
        namespace,
        state: "guest-content-verified-no-job-started",
      };
    },
  });
  expect(result.flags).toEqual(["--source-revision", revision]);
  expect([...result.initializers]).toEqual(["deps"]);
  const none = await publishNativeCacheSource({
    ...base,
    review: review({
      deps: { active: false, dependency_cache: { volume: "modules" } },
    }),
    invoke: async () => {
      throw new Error("must not publish");
    },
  });
  expect(none.flags).toEqual([]);
});
test("missing, foreign or unverified source publications cannot be admitted", async () => {
  const selected = review({
    deps: { active: true, dependency_cache: { volume: "modules" } },
  });
  for (const publication of [
    { revision },
    {
      revision,
      namespace: "f".repeat(64),
      state: "guest-content-verified-no-job-started",
    },
    { revision, namespace, state: "pending" },
    {
      revision: "bad",
      namespace,
      state: "guest-content-verified-no-job-started",
    },
  ]) {
    await expectClosedRefusal(
      publishNativeCacheSource({
        ...base,
        review: selected,
        invoke: async () => publication,
      }),
      "verified revision"
    );
  }
});

test("invalid reviewed cache and source replies refuse with closed messages", async () => {
  expectClosedThrow(
    () => nativeSharedSourceFlags(null),
    "Native source review is invalid."
  );
  expectClosedThrow(
    () => nativeCacheInitializers({}),
    "Native cache review is invalid."
  );
  expectClosedThrow(
    () => nativeCacheInitializers({ services: { web: null } }),
    "Native service review is invalid."
  );
  await expectClosedRefusal(
    nativeStartCacheSource({
      runtime: { binary: "/fixture/native", home: "/fixture/home" },
      projectRoot: "/fixture/project",
      review: {} as NativeProjectReview,
      restoreRevision: "not-a-revision",
      invoke: async () => {
        throw new Error("must not invoke");
      },
    }),
    "Native retained cache source revision is invalid."
  );
});
