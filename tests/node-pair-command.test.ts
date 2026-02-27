import { expect, test } from "bun:test";
import { __testOnlyNodePair } from "../src/commands/node.ts";

test("derivePairingName prefers explicit name", () => {
  const result = __testOnlyNodePair.derivePairingName({
    explicitName: "remote-1",
    source: "remote-user@node-a.tailnet.ts.net",
  });
  expect(result).toBe("remote-1");
});

test("derivePairingName falls back to source host", () => {
  const result = __testOnlyNodePair.derivePairingName({
    explicitName: undefined,
    source: "remote-user@node-a.tailnet.ts.net:22",
  });
  expect(result).toBe("node-a.tailnet.ts.net");
});

test("extractSshHost removes username and optional port", () => {
  expect(
    __testOnlyNodePair.extractSshHost("remote-user@node-a.tailnet.ts.net:22")
  ).toBe("node-a.tailnet.ts.net");
  expect(__testOnlyNodePair.extractSshHost("node-a.tailnet.ts.net")).toBe(
    "node-a.tailnet.ts.net"
  );
});

test("parseSshSource extracts user host and port", () => {
  const parsed = __testOnlyNodePair.parseSshSource(
    "remote-user@node-a.tailnet.ts.net:2201"
  );
  expect(parsed).toBeDefined();
  expect(parsed?.user).toBe("remote-user");
  expect(parsed?.host).toBe("node-a.tailnet.ts.net");
  expect(parsed?.port).toBe(2201);
  expect(parsed?.target).toBe("remote-user@node-a.tailnet.ts.net");
});

test("resolveSshSourceTarget applies explicit port override", () => {
  const resolved = __testOnlyNodePair.resolveSshSourceTarget({
    source: "remote-user@node-a.tailnet.ts.net:2201",
    sshPort: 7788,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.port).toBe(7788);
  expect(resolved.target).toBe("remote-user@node-a.tailnet.ts.net");
});

test("normalizeHostHint extracts host from URL", () => {
  const result = __testOnlyNodePair.normalizeHostHint(
    "https://node-a.tailnet.ts.net"
  );
  expect(result).toBe("node-a.tailnet.ts.net");
});

test("buildAutoEndpointCandidates prefers HTTPS for tailscale DNS", () => {
  const result = __testOnlyNodePair.buildAutoEndpointCandidates({
    host: "node-a.tailnet.ts.net",
  });
  expect(result).toEqual([
    "https://node-a.tailnet.ts.net",
    "http://node-a.tailnet.ts.net:7788",
  ]);
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

test("normalizeRemoteHackOverride trims empty overrides", () => {
  expect(__testOnlyNodePair.normalizeRemoteHackOverride({ value: "   " })).toBe(
    undefined
  );
  expect(
    __testOnlyNodePair.normalizeRemoteHackOverride({
      value: "/Users/remote-user/.hack/bin/hack",
    })
  ).toBe("/Users/remote-user/.hack/bin/hack");
});

test("renderRemoteHackCommand prefers default install path when override is absent", () => {
  const command = __testOnlyNodePair.renderRemoteHackCommand({
    remoteHack: undefined,
    args: ["node", "init", "--json"],
  });

  expect(command).toContain('if [ -x "$HOME/.hack/bin/hack" ]');
  expect(command).toContain("elif command -v hack >/dev/null 2>&1;");
  expect(command).toContain('exec "$__hack_bin"');
  expect(command).toContain("'node'");
  expect(command).toContain("'init'");
});

test("renderRemoteHackCommand uses explicit override when provided", () => {
  const command = __testOnlyNodePair.renderRemoteHackCommand({
    remoteHack: "/Users/remote-user/.hack/bin/hack",
    args: ["node", "init", "--json"],
  });

  expect(command).toContain("'/Users/remote-user/.hack/bin/hack'");
  expect(command).toContain("'node'");
  expect(command).toContain("'init'");
  expect(command).not.toContain("__hack_bin");
});

test("buildAuthorizedKeysInstallCommand safely quotes public key", () => {
  const command = __testOnlyNodePair.buildAuthorizedKeysInstallCommand({
    publicKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINe0bXv8rQxQqg5l1xS+5e9sQw3N test@host",
  });
  expect(command).toContain("grep -qxF");
  expect(command).toContain("authorized_keys");
  expect(command).toContain("printf '%s\\n'");
});

test("upsertManagedSshConfigBlock replaces prior managed section", () => {
  const first = __testOnlyNodePair.renderNodePairSshConfigBlock({
    id: "node-a:22",
    host: "node-a.tailnet.ts.net",
    user: "remote-user",
    port: 22,
    keyPath: "/Users/test/.ssh/hack-node-pair-ed25519",
  });
  const updated = __testOnlyNodePair.renderNodePairSshConfigBlock({
    id: "node-a:22",
    host: "node-a.tailnet.ts.net",
    user: "remote-user",
    port: 2201,
    keyPath: "/Users/test/.ssh/hack-node-pair-ed25519",
  });
  const mergedOnce = __testOnlyNodePair.upsertManagedSshConfigBlock({
    existing: "",
    id: "node-a:22",
    block: first,
  });
  const mergedTwice = __testOnlyNodePair.upsertManagedSshConfigBlock({
    existing: mergedOnce,
    id: "node-a:22",
    block: updated,
  });

  expect(mergedTwice).toContain("Port 2201");
  expect(mergedTwice.match(/Host node-a\.tailnet\.ts\.net/g)?.length).toBe(1);
});
