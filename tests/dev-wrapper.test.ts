import { expect, test } from "bun:test";

import {
  DEV_WRAPPER_MARKER,
  isDevWrapperShimBytes,
} from "../src/lib/self-update.ts";

test("isDevWrapperShimBytes detects local-dev wrapper scripts", () => {
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `# ${DEV_WRAPPER_MARKER} (auto-generated)`,
    `exec bun /repo/index.ts "$@"`,
    "",
  ].join("\n");

  const bytes = new TextEncoder().encode(script);
  expect(isDevWrapperShimBytes(bytes)).toBe(true);
});

test("isDevWrapperShimBytes does not mis-detect compiled binaries", () => {
  // Compiled binaries may contain the marker string in their data segment, but they don't start
  // with a shebang.
  const fakeBinaryBytes = new TextEncoder().encode(
    `BIN${DEV_WRAPPER_MARKER}BIN`
  );
  expect(isDevWrapperShimBytes(fakeBinaryBytes)).toBe(false);
});
