import { expect, test } from "bun:test";
import { beginTerminalHandoff } from "../src/tui/terminal-handoff.ts";

test("a suspend that completes hands the terminal over", async () => {
  expect(await beginTerminalHandoff(async () => undefined)).toBe("handed_over");
});

test("a synchronous suspend refusal keeps the terminal and starts nothing", async () => {
  expect(
    await beginTerminalHandoff(() => {
      throw new Error(
        "Native scene suspension requires completed terminal setup and no pending transition"
      );
    })
  ).toBe("not_handed_over");
});

test("a rejected suspend transition is rethrown: input is already detached", async () => {
  await expect(
    beginTerminalHandoff(async () => {
      throw new Error("native terminal transition failed");
    })
  ).rejects.toThrow("native terminal transition failed");
});
