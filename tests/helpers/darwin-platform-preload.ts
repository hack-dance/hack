/**
 * Bun `--preload` module for CLI subprocess tests: reports the platform as
 * macOS so platform-gated output (such as the Local Network hint) is
 * exercised on any host. It changes only `process.platform`; callers must
 * also put stub executables (for example `open`) first on PATH so nothing
 * real launches.
 */
Object.defineProperty(process, "platform", {
  value: "darwin",
  configurable: true,
});
