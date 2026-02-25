import { expect, test } from "bun:test";
import { __testOnlyNodeAttach } from "../src/commands/node.ts";

test("buildAttachInstructions emits vscode remote command and ssh metadata", () => {
  const attach = __testOnlyNodeAttach.buildAttachInstructions({
    ide: "vscode",
    sshHost: "node.example.com",
    sshPort: 22,
    sshAlias: "hack-node-1234",
    workspaceFolder: "/Users/dev/project",
    containerId: "abc123",
    endpointPort: 7788,
  });

  expect(attach.ssh.host).toBe("node.example.com");
  expect(attach.ssh.alias).toBe("hack-node-1234");
  expect(attach.commands.some((line) => line.startsWith("ssh "))).toBe(true);
  expect(
    attach.commands.some((line) =>
      line.includes('code --remote "ssh-remote+hack-node-1234"')
    )
  ).toBe(true);
  expect(attach.lines.some((line) => line.includes("abc123"))).toBe(true);
});

test("buildAttachInstructions emits shell-first codex instructions", () => {
  const attach = __testOnlyNodeAttach.buildAttachInstructions({
    ide: "codex",
    sshHost: "198.51.100.42",
    sshPort: 2202,
    sshAlias: "hack-node-remote",
    sshUser: "remote-user",
    workspaceFolder: "/workspace/app",
    containerId: "container-42",
    endpointPort: null,
  });

  expect(attach.ssh.target).toBe("remote-user@198.51.100.42");
  expect(
    attach.commands.includes("ssh -p 2202 remote-user@198.51.100.42")
  ).toBe(true);
  expect(attach.commands.includes("docker exec -it container-42 /bin/sh")).toBe(
    true
  );
  expect(attach.commands.at(-1)).toBe("codex");
});

test("resolveNodeEndpoint parses host and port", () => {
  const parsed = __testOnlyNodeAttach.resolveNodeEndpoint({
    endpoint: "https://gateway.example.com:9443",
  });
  expect(parsed.host).toBe("gateway.example.com");
  expect(parsed.port).toBe(9443);
});
