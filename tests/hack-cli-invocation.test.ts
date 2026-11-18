import { expect, test } from "bun:test";

import { resolveHackInvocation } from "../src/lib/hack-cli.ts";

/**
 * HACK-2329: a compiled CLI run by its path, with no `hack` on PATH, must
 * resolve to itself. It used to fall back to a bare `hack`, so a detached
 * `hack daemon start` spawned nothing and only reported "not ready".
 */
test("a compiled CLI with no hack on PATH resolves to its own executable", async () => {
  expect(
    await resolveHackInvocation({
      env: { PATH: "/nonexistent" },
      main: "/$bunfs/root/hack",
      execPath: "/opt/tools/hack-next",
    })
  ).toEqual({ bin: "/opt/tools/hack-next", args: [] });
});

test("HACK_MCP_COMMAND still wins over the executable", async () => {
  expect(
    await resolveHackInvocation({
      env: { PATH: "/nonexistent", HACK_MCP_COMMAND: "/usr/local/bin/hack" },
      main: "/$bunfs/root/hack",
      execPath: "/opt/tools/hack-next",
    })
  ).toEqual({ bin: "/usr/local/bin/hack", args: [] });
});
