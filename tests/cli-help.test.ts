import { expect, test } from "bun:test";
import {
  renderHelpForPath,
  renderHelpMarkdownForPath,
} from "../src/cli/help.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

test("root help leads with core promises and separates core from beta surfaces", () => {
  const help = renderHelpForPath(CLI_SPEC, []);

  expect(help).toContain("Local development without the port-collision tax");
  expect(help).toContain("Core promises:");
  expect(help).toContain(
    "1. Run multiple repos or branches at the same time without port conflicts."
  );
  expect(help).toContain("Core workflows:");
  expect(help).toContain("Collaboration & integrations:");
  expect(help).toContain("Beta workflows:");
  expect(help).toContain("Extension commands:");
  expect(help).toMatch(
    /hack remote\s+Beta: guided remote access and gateway helpers/
  );
  expect(help).toMatch(
    /hack tickets(?: \[args\.\.\.\])?\s+Track repo-local work in git-backed tickets/
  );

  expect(help.indexOf("Core workflows:")).toBeLessThan(
    help.indexOf("Beta workflows:")
  );
  expect(help).toMatch(/hack auth\s+Manage Hack account sign-in/);
  expect(help.indexOf("Collaboration & integrations:")).toBeLessThan(
    help.indexOf("hack auth")
  );
  expect(help.indexOf("hack auth")).toBeLessThan(
    help.indexOf("Beta workflows:")
  );
  expect(help).not.toContain("hack auth login");
});

test("markdown help preserves the core offer and command grouping", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, []);

  expect(help).toContain("### Core promises");
  expect(help).toContain(
    "1. Run multiple repos or branches at the same time without port conflicts."
  );
  expect(help).toContain("### Core workflows");
  expect(help).toContain("### Collaboration & integrations");
  expect(help).toContain("### Beta workflows");
  expect(help).toContain("### Extension commands");
  expect(help).toContain("`hack auth`");
});
