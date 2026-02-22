import { expect, test } from "bun:test";
import { __testOnlyNodePair } from "../src/commands/node.ts";

test("derivePairingName prefers explicit name", () => {
  const result = __testOnlyNodePair.derivePairingName({
    explicitName: "remote-1",
    source: "ubuntu@helsinki.tail8fedfd.ts.net",
  });
  expect(result).toBe("remote-1");
});

test("derivePairingName falls back to source host", () => {
  const result = __testOnlyNodePair.derivePairingName({
    explicitName: undefined,
    source: "ubuntu@helsinki.tail8fedfd.ts.net:22",
  });
  expect(result).toBe("helsinki.tail8fedfd.ts.net");
});

test("parseEnrollmentBundleFromRemoteOutput extracts JSON from noisy ssh output", () => {
  const noisyOutput = [
    "Ubuntu 24.04 LTS",
    "Last login: Sat Feb 21 12:34:56",
    '{"bundle":{"version":1,"node":{"id":"node-1","name":"demo-node","labels":["mac"],"capabilities":["runtime","gateway","supervisor"],"endpoint":"http://127.0.0.1:7788","authRef":"node.ref-1","platform":"linux","arch":"arm64","version":"1.3.9"},"token":"tok_test_123","pairing":{"sessionId":"pair-123","code":"125901","approvedAt":"2026-02-21T00:00:00.000Z"}}}',
  ].join("\n");

  const parsed = __testOnlyNodePair.parseEnrollmentBundleFromRemoteOutput({
    text: noisyOutput,
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.bundle.version).toBe(1);
  expect(parsed.bundle.node.id).toBe("node-1");
  expect(parsed.bundle.node.name).toBe("demo-node");
  expect(parsed.bundle.token).toBe("tok_test_123");
  expect(parsed.bundle.pairing?.sessionId).toBe("pair-123");
  expect(parsed.bundle.pairing?.code).toBe("125901");
});

test("renderShellCommand quotes args safely", () => {
  const command = __testOnlyNodePair.renderShellCommand({
    args: ["hack", "node", "init", "--name", "old macbook's node", "--json"],
  });
  expect(command).toContain("'hack'");
  expect(command).toContain("'--name'");
  expect(command).toContain("'old macbook'\\''s node'");
});
