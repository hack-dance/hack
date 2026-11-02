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
  expect(help).toContain("Core workflows:");
  expect(help).toContain("Local helpers:");
  expect(help).toContain("Unsupported experimental:");
  expect(help).toContain("Extension commands:");
  expect(help).not.toMatch(/hack (?:tickets|auth|org|team|linear)\b/);
  expect(help).toMatch(
    /hack remote\s+Beta: guided remote access and gateway helpers/
  );
  expect(help.indexOf("Core workflows:")).toBeLessThan(
    help.indexOf("Unsupported experimental:")
  );
});

test("markdown help preserves the local-first grouping", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, []);

  expect(help).toContain("### Core promises");
  expect(help).toContain("### Core workflows");
  expect(help).toContain("### Local helpers");
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
