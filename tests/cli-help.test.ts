import { expect, test } from "bun:test";
import {
  renderHelpForPath,
  renderHelpMarkdownForPath,
} from "../src/cli/help.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

test("root help leads with the local-first offer and new command grouping", () => {
  const help = renderHelpForPath(CLI_SPEC, []);

  expect(help).toContain("Local development without the port-collision tax");
  expect(help).toContain("Core promises:");
  expect(help).toContain(
    "  1. Run many projects and branches side by side, each at a real HTTPS hostname like https://myapp.hack.local."
  );
  expect(help).toContain("  2. Manage project env and secrets safely.");
  expect(help).toContain(
    "  3. Sessions and lifecycle you can trust: up, down, restart, logs and doctor."
  );
  expect(help).toContain(
    "Core workflows: start, stop and inspect a project, its branch instances and sessions\n"
  );
  expect(help).toContain(
    "Env and host commands: project env and secrets, and host commands that receive them\n"
  );
  expect(help).toContain(
    "Agent integrations (optional): opt-in skills and MCP for coding agents; Hack works without them\n"
  );
  expect(help).toContain("Unsupported experimental:\n");
  expect(help).toContain("Extension commands:\n");
  expect(help).not.toMatch(/hack (?:tickets|auth|org|team|linear)\b/);
  // "Beta" names the native backend only; retained remote commands are unsupported.
  expect(help).not.toMatch(/\bBeta\b/);
  expect(renderHelpForPath(CLI_SPEC, [], { showExperimental: true })).toMatch(
    /hack remote\s+Unsupported: guided remote access and gateway helpers/
  );
  expect(help.indexOf("Core workflows:")).toBeLessThan(
    help.indexOf("Unsupported experimental:")
  );
});

test("markdown help preserves the local-first grouping", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, []);

  expect(help).toContain("### Core promises");
  expect(help).toContain(
    "### Core workflows\n\nStart, stop and inspect a project, its branch instances and sessions.\n"
  );
  expect(help).toContain(
    "### Env and host commands\n\nProject env and secrets, and host commands that receive them.\n"
  );
  expect(help).toContain("### Agent integrations (optional)");
  expect(help).toContain("### Unsupported experimental");
  expect(help).not.toMatch(/`hack (?:tickets|auth|org|team|linear)\b/);
});

test("experimental subcommand help stays visibly labeled experimental", () => {
  const help = renderHelpForPath(CLI_SPEC, ["remote", "setup"]);
  const markdown = renderHelpMarkdownForPath(CLI_SPEC, ["remote", "setup"]);

  expect(help).toContain("hack remote setup");
  expect(help).toContain("Status: Unsupported experimental workflow");
  expect(markdown).toContain("> Status: Unsupported experimental workflow.");
});

test("dispatch help no longer advertises built-in GitHub PR automation", () => {
  const help = renderHelpForPath(CLI_SPEC, ["dispatch", "run"]);

  expect(help).toContain("hack dispatch run");
  expect(help).not.toContain("create/update GitHub PR");
  expect(help).not.toMatch(/--pr(?:-|\b)|--github-profile/);
});

test("text help says where a child command's own argv begins", () => {
  const run = renderHelpForPath(CLI_SPEC, ["run"]);
  expect(run).toContain("hack run [options] <service> [cmd...]");
  expect(run).toContain(
    "Everything from `<cmd>` on is passed to the command unchanged, including flags such as `--version` or `--help`."
  );
  // session exec takes its workspace command as one argument: the note says to
  // quote it rather than claiming that later tokens pass through.
  const sessionExec = renderHelpForPath(CLI_SPEC, ["session", "exec"]);
  expect(sessionExec).toContain(
    '`<command>` is one argument: quote a command that has its own arguments or flags, as in `"npm --version"`.'
  );
  expect(sessionExec).not.toContain("Everything from `<command>` on");
});
