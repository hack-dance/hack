/**
 * Preload for a source CLI child (`bun --preload <this> index.ts ...`) whose
 * stdout is a pipe: it makes `process.stdout.isTTY` report true, the shape of
 * an interactive terminal whose stdin is piped (`echo | hack ...`). A prompt
 * site gated on stdout alone would then enter a clack prompt that cannot
 * settle on the piped stdin; `canPrompt()` must still refuse. Nothing else is
 * changed.
 */
Object.defineProperty(process.stdout, "isTTY", {
  configurable: true,
  value: true,
});
