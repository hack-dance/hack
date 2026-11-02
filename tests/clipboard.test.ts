import { afterEach, beforeEach, expect, test } from "bun:test";

import { copyToClipboard } from "../src/ui/clipboard.ts";
import { restoreEnv } from "./helpers/env.ts";

const ORIGINAL_PATH = process.env.PATH;

beforeEach(() => {
  process.env.PATH = "";
});

afterEach(() => {
  restoreEnv("PATH", ORIGINAL_PATH);
});

test("copyToClipboard returns error when no helper is available", async () => {
  const result = await copyToClipboard({ text: "hello" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.length > 0).toBe(true);
  }
});
