/** Replay/policy mirror of the independent shell guard in ci.yml; parity is tested against the shell. */
export function requiresWorkflowFull(paths: readonly string[] | null): boolean {
  return (
    !paths?.length ||
    paths.some(
      (path) =>
        /^(?:scripts\/|\.github\/|tests\/helpers\/)/.test(path) ||
        [
          "tests/preload.ts",
          "src/lib/guards.ts",
          "src/lib/cli-result.ts",
          "mise.toml",
        ].includes(path) ||
        /(?:^|\/)(?:package\.json|bun\.lockb?|Cargo\.(?:toml|lock)|bunfig\.toml|tsconfig[^/]*\.json)$/.test(
          path
        )
    )
  );
}
