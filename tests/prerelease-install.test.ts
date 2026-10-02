import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("prerelease manager preserves stable Hack and refuses unsafe selection changes", () => {
  const result = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-B",
      fileURLToPath(
        new URL("./python/test_prerelease_install.py", import.meta.url)
      ),
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 60_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  expect(result.exitCode).toBe(0);
});
