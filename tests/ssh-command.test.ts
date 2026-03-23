import { expect, test } from "bun:test";

import { __testOnlySshCommand } from "../src/commands/ssh.ts";

test("buildWorkspaceAttachShellCommand uses tmux attach semantics", () => {
  expect(
    __testOnlySshCommand.buildWorkspaceAttachShellCommand({
      backend: "tmux",
      workspaceName: "alpha",
    })
  ).toContain("tmux attach -d -t 'alpha'");
});

test("buildWorkspaceAttachShellCommand uses zellij attach semantics", () => {
  expect(
    __testOnlySshCommand.buildWorkspaceAttachShellCommand({
      backend: "zellij",
      workspaceName: "alpha",
    })
  ).toContain("zellij attach 'alpha'");
});
