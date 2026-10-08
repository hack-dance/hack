import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  nativeRoutedDownClaimsMatch,
  nativeRoutedDownHookProofMatches,
  nativeRoutedDownPhaseMatches,
} from "./e2e/scenarios/native-config-routed-down-hooks.ts";

const pin = {
  root: "/fixture/primary",
  marker: "synthetic-primary-marker",
  composeProject: "native-fixture",
  ownerToken: "a".repeat(32),
  generationId: "b".repeat(32),
  containers: ["c".repeat(64)],
  networks: ["d".repeat(64)],
  volume: { name: "native-fixture_state", createdAt: "2026-10-08T12:00:00Z" },
  origins: ["https://primary.test", "https://oauth.test"],
};
function observed(phase: "before" | "after" | "sibling") {
  return {
    pin: {
      ...pin,
      containers: phase === "after" ? [] : [...pin.containers],
      networks: phase === "after" ? [] : [...pin.networks],
    },
    pending:
      phase === "sibling"
        ? null
        : { operation: "down", generationId: pin.generationId },
    stopped: false,
    hostHookPhase: phase === "sibling" ? null : `down.${phase}`,
    beforeHooksPending: phase !== "sibling",
    marker: phase === "after" ? null : pin.marker,
  };
}
test("routed down phases require exact pending generation and true before/after engine boundary", () => {
  for (const phase of ["before", "after", "sibling"] as const) {
    const actual = observed(phase);
    expect(
      nativeRoutedDownPhaseMatches({ expected: pin, observed: actual, phase })
    ).toBe(true);
    for (const patch of [
      { stopped: true },
      { pending: { operation: "up", generationId: pin.generationId } },
      { pending: { operation: "down", generationId: "e".repeat(32) } },
      { hostHookPhase: "down.unknown" },
      { beforeHooksPending: phase === "sibling" },
      { pin: { ...actual.pin, ownerToken: "e".repeat(32) } },
      { pin: { ...actual.pin, generationId: "f".repeat(32) } },
      {
        pin: {
          ...actual.pin,
          volume: { ...pin.volume, createdAt: "2026-10-08T12:01:00Z" },
        },
      },
      {
        pin: {
          ...actual.pin,
          origins: ["https://foreign.test", pin.origins[1]],
        },
      },
      { pin: { ...actual.pin, containers: ["short-id"] } },
      { pin: { ...actual.pin, containers: ["e".repeat(64), "e".repeat(64)] } },
      { pin: { ...actual.pin, networks: ["e".repeat(64), "e".repeat(64)] } },
    ]) {
      expect(
        nativeRoutedDownPhaseMatches({
          expected: pin,
          observed: { ...actual, ...patch },
          phase,
        })
      ).toBe(false);
    }
  }
  expect(
    nativeRoutedDownPhaseMatches({
      expected: pin,
      observed: observed("before"),
      phase: "after",
    })
  ).toBe(false);
  expect(
    nativeRoutedDownPhaseMatches({
      expected: pin,
      observed: observed("after"),
      phase: "before",
    })
  ).toBe(false);
  for (const value of [
    null,
    {},
    { pin },
    { ...observed("after"), pending: null },
    { ...observed("after"), beforeHooksPending: false },
  ]) {
    expect(
      nativeRoutedDownPhaseMatches({
        expected: pin,
        observed: value,
        phase: "after",
      })
    ).toBe(false);
  }
});
test("sibling proof refuses replacement IDs and wrong retained data even with the same owner", () => {
  const actual = observed("sibling");
  for (const patch of [
    { marker: "wrong-checkout-marker" },
    { marker: null },
    { pin: { ...actual.pin, containers: ["e".repeat(64)] } },
    { pin: { ...actual.pin, networks: ["e".repeat(64)] } },
    {
      pin: {
        ...actual.pin,
        volume: { ...pin.volume, name: "replacement-volume" },
      },
    },
    { hostHookPhase: "down.after", beforeHooksPending: true },
  ]) {
    expect(
      nativeRoutedDownPhaseMatches({
        expected: pin,
        observed: { ...actual, ...patch },
        phase: "sibling",
      })
    ).toBe(false);
  }
});
test("private hook proof must bind exact owner, generation, phase and observed engine membership", () => {
  for (const phase of ["before", "after"] as const) {
    const proof = {
      phase,
      generationId: pin.generationId,
      ownerToken: pin.ownerToken,
      containers: phase === "before" ? pin.containers : [],
      networks: phase === "before" ? pin.networks : [],
      heldClaims: true,
      siblingsUnchanged: true,
      ownerPending: true,
      routeState: phase === "before" ? "live" : "absent",
    };
    const match = (value: unknown) =>
      nativeRoutedDownHookProofMatches({ expected: pin, phase, proof: value });
    expect(match(proof)).toBe(true);
    for (const patch of [
      { ownerToken: "f".repeat(32) },
      { generationId: "f".repeat(32) },
      { phase: "unknown" },
      { heldClaims: false },
      { siblingsUnchanged: false },
      { ownerPending: false },
      { routeState: "unverified" },
      { containers: phase === "before" ? [] : pin.containers },
      { networks: phase === "before" ? [] : pin.networks },
      { extra: true },
    ]) {
      expect(match({ ...proof, ...patch })).toBe(false);
    }
    expect(match({ ...proof, containers: undefined })).toBe(false);
  }
});
function claim(host: string, digest = "a".repeat(64)): string {
  return `${createHash("sha256").update(host).digest("hex")}.json:${digest}`;
}
test("held claims cannot retire early; finalization removes only the two exact primary claims", () => {
  const own = [claim("primary.test"), claim("oauth.test")];
  const siblings = [
    "alpha.test",
    "oauth.alpha.test",
    "beta.test",
    "oauth.beta.test",
  ].map((host) => claim(host));
  const before = [...own, ...siblings].sort().join("\n");
  const after = [...siblings].sort().join("\n");
  const match = (observed: unknown, retired: boolean, original = before) =>
    nativeRoutedDownClaimsMatch({
      before: original,
      ownOrigins: pin.origins,
      observed,
      retired,
    });
  expect(match(before, false)).toBe(true);
  expect(match(after, true)).toBe(true);
  expect(match(after, false)).toBe(false);
  expect(match(before, true)).toBe(false);
  for (const incorrect of [
    "",
    undefined,
    after.split("\n").slice(1).join("\n"),
    `${after}\n${claim("foreign.test")}`,
    after.replace(/a{64}$/, "b".repeat(64)),
  ]) {
    expect(match(incorrect, true)).toBe(false);
  }
  for (const malformed of [
    before.replace(/a{64}$/, "bad"),
    [...own, ...siblings.slice(1), own[0]].sort().join("\n"),
    before.replace(own[0] ?? "", claim("foreign.test")),
  ]) {
    expect(match(after, true, malformed)).toBe(false);
  }
});
