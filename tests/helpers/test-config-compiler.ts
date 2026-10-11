import { statSync } from "node:fs";
import {
  resolveTestConfigCompilerBinary,
  TEST_CONFIG_COMPILER_SETUP,
} from "../../scripts/check-test-config-compiler.ts";

/**
 * Select the compiler fixture a suite depends on, once per test file.
 *
 * Resolution matches the `bun run test` preflight: an explicit absolute
 * HACK_CONFIG_COMPILER_BINARY, otherwise the checkout's built
 * `dist/hack-config-compiler`. The selection must be an existing regular
 * executable; it is never replaced by a fallback.
 *
 * Call it at module scope so an absent fixture fails the file exactly once
 * with the fixed preflight text instead of one opaque E_COMPILER_MISSING
 * refusal per case, and never as a silent pass. The message names only the
 * public dist location, never the selected path or the underlying error.
 */
export function requireTestConfigCompiler(): string {
  try {
    const binary = resolveTestConfigCompilerBinary();
    const info = statSync(binary);
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      throw new Error("Not a regular executable");
    }
    return binary;
  } catch {
    throw new Error(TEST_CONFIG_COMPILER_SETUP);
  }
}
