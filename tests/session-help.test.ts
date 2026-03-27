import { expect, test } from "bun:test";

import { renderHelpMarkdownForPath } from "../src/cli/help.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

test("hack session help explains persistent workspaces and tmux-first fallback", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, ["session"]);

  expect(help).toContain("persistent project workspaces");
  expect(help).toContain("tmux-first");
  expect(help).toContain("zellij");
  expect(help).toContain("`hack setup tmux`");
});

test("hack session start help explains reuse and isolated workspace creation", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, ["session", "start"]);

  expect(help).toContain("Reuse the default project workspace");
  expect(help).toContain("create an isolated long-running workspace");
  expect(help).toContain("project--agent-1");
  expect(help).toContain("--detach");
  expect(help).toContain("--env");
  expect(help).toContain("--service");
});

test("hack session attach and exec help explain workspace-oriented flows", () => {
  const attachHelp = renderHelpMarkdownForPath(CLI_SPEC, ["session", "attach"]);
  const execHelp = renderHelpMarkdownForPath(CLI_SPEC, ["session", "exec"]);

  expect(attachHelp).toContain("Attach to a running workspace by name");
  expect(attachHelp).toContain("zellij attaches to the named session directly");
  expect(execHelp).toContain("Queue a command in the workspace");
  expect(execHelp).toContain("zellij opens a new pane");
  expect(execHelp).toContain("long-running agents");
  expect(execHelp).toContain("--env");
  expect(execHelp).toContain("--service");
});

test("hack setup tmux help documents tmux-first onboarding", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, ["setup", "tmux"]);

  expect(help).toContain("recommended tmux binding");
  expect(help).toContain("hack workspaces");
  expect(help).toContain("--check");
  expect(help).toContain("--remove");
});

test("hack ssh help uses workspace terminology", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, ["ssh"]);

  expect(help).toContain("hack ssh [workspace]");
  expect(help).toContain("Workspace to connect to");
  expect(help).toContain("reuse their current mux backend");
});
