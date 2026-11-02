import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  captureProcessPolicyOwnershipSource,
  isProcessPolicyReplayReason,
  processPolicyReplayReason,
  sameProcessPolicyOwnershipSource,
} from "./e2e/native-process-policy-replay-reason.ts";

const sourcePath = join(
  import.meta.dir,
  "../src/lib/native-compose-ownership.ts"
);
const sourceSha256 =
  "8913d0e1f1390b443e04bfb8264f16565f3c2a482c64c6235bb74b645c81c56a";
const header =
  "NativeComposeOwnershipError: Native Compose resource ownership is missing, conflicting or changed; values omitted.";
function stack(caller: string): string {
  return `${header}\n    at refuse (${sourcePath}:200:9)\n    at requireValue (${sourcePath}:204:5)\n    at ${caller}\n    at synthetic (private-canary:1:1)`;
}

test("historical stack classifier refuses the superseding owner source", () => {
  // The replay now uses owner-issued reasons; the old line/hash classifier stays unavailable.
  const before = captureProcessPolicyOwnershipSource();
  const after = captureProcessPolicyOwnershipSource();
  expect(before).toBeNull();
  expect(after).toBeNull();
  expect(sameProcessPolicyOwnershipSource(before, after)).toBe(false);
});

test("only fixed immediate owning callsites can name a replay reason", () => {
  for (const [caller, reason] of [
    ["collectInspections:602", "resource-owner-labels"],
    ["collectInspections:660", "network-policy"],
    ["endpointAliases:745", "endpoint-alias-shape"],
    ["validateEndpointIdentity:785", "endpoint-network-id"],
    ["validateEndpointIdentity:787", "endpoint-aliases"],
    ["requireLiveMember:862", "live-network-membership"],
  ] as const) {
    const [name, line] = caller.split(":");
    const result = processPolicyReplayReason({
      stack: stack(`${name} (${sourcePath}:${line}:5)`),
      sourcePath,
      sourceSha256,
    });
    expect(result).toBe(reason);
    expect(isProcessPolicyReplayReason(result)).toBe(true);
    expect(result).not.toContain("private-canary");
    expect(result).not.toContain(sourcePath);
  }
});

test("source drift and a different source path cannot retain a plausible reason", () => {
  const value = stack(`requireLiveMember (${sourcePath}:862:5)`);
  for (const sourceSha of [
    null,
    undefined,
    "0".repeat(64),
    `${sourceSha256}\n`,
  ]) {
    expect(
      processPolicyReplayReason({
        stack: value,
        sourcePath,
        sourceSha256: sourceSha,
      })
    ).toBe("unavailable");
  }
  expect(
    processPolicyReplayReason({
      stack: value,
      sourcePath: `${sourcePath}.other`,
      sourceSha256,
    })
  ).toBe("unavailable");
});

test("unknown or malformed stacks never search later frames or disclose their values", () => {
  const known = `requireLiveMember (${sourcePath}:862:5)`;
  const value = stack(known);
  for (const candidate of [
    null,
    undefined,
    {},
    [],
    17,
    "",
    "private-canary",
    "x".repeat(16 * 1024 + 1),
    value.replace(header, "Error: private-canary"),
    value.replace("at refuse", "at forged"),
    value.replace(":204:5", ":203:5"),
    value.replace(":862:5", ":863:5"),
    value.replace(":862:5", ":862:0"),
    value.replace(":862:5", ":862:5private-canary"),
    value.replace(`(${sourcePath}:862:5)`, "(private-canary:862:5)"),
    stack(`unknown (${sourcePath}:999:5)\n    at ${known}`),
    stack(`unknown (${sourcePath}:999:5)`),
  ]) {
    const result = processPolicyReplayReason({
      stack: candidate,
      sourcePath,
      sourceSha256,
    });
    expect(result).toBe("unavailable");
    expect(result).not.toContain("private-canary");
  }
  for (const candidate of [
    null,
    17,
    {},
    "private-canary",
    "network-policy\n",
  ]) {
    expect(isProcessPolicyReplayReason(candidate)).toBe(false);
  }
});
