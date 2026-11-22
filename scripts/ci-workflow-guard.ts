/** Replay/policy mirror of the independent shell guard in ci.yml; parity is tested against the shell. */
import { isKnownCiInput, touchesStateModels } from "./ci-change-scope.ts";

/** Unknown scripts and shared setup stay full until their consumers are bounded. */
export function requiresWorkflowFull(
  paths: readonly string[] | null,
  opts: { readonly deriveUnknown?: boolean } = {}
): boolean {
  return (
    !paths?.length ||
    paths.some(
      (path) =>
        !(
          opts.deriveUnknown ||
          isKnownCiInput(path) ||
          path.startsWith("tests/")
        ) ||
        (!touchesStateModels(path) && /^scripts\//.test(path)) ||
        /^(?:\.github\/|tests\/helpers\/)/.test(path) ||
        [
          "tests/preload.ts",
          "src/lib/guards.ts",
          "src/lib/cli-result.ts",
          "mise.toml",
        ].includes(path) ||
        /(?:^|\/)(?:package\.json|bun\.lockb?|Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|bunfig\.toml|tsconfig[^/]*\.json)$/.test(
          path
        )
    )
  );
}
