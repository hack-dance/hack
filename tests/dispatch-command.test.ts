import { expect, test } from "bun:test";

import { __testOnlyDispatch } from "../src/commands/dispatch.ts";

test("removed dispatch PR automation warns without changing the migration text", () => {
  const message = __testOnlyDispatch.resolveRemovedDispatchPrAutomationMessage({
    pr: true,
    prBase: "main",
  });

  expect(message).not.toBeNull();
  expect(message).toContain("removed in Hack v3");
  expect(message).toContain("Dispatch still runs the remote command");
  expect(message).toContain("gh pr create");
});
