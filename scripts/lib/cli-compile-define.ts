/**
 * Build-time definitions every `bun build --compile` of the Hack CLI needs.
 *
 * `@opentui/core` 0.8 picks its Linux native package at runtime from
 * `process.env.OPENTUI_LIBC`, so an undefined value keeps both the glibc and
 * the musl import in the bundle, and the compile fails unless both packages
 * are installed. Hack ships glibc Linux builds only; defining the libc lets
 * Bun drop the musl branch. On macOS the Linux branch is already folded away
 * by the compile target, so the definition is harmless there.
 * See https://opentui.com/docs/reference/standalone-executables
 *
 * Shell build scripts and the `packages/cli` build script pass the same flag
 * inline; a Linux compile without it fails at bundle time, not at runtime.
 */
export const OPENTUI_LIBC_DEFINE = 'process.env.OPENTUI_LIBC="glibc"';

/** Arguments to add after `--compile` when compiling the CLI. */
export const CLI_COMPILE_DEFINE_ARGS = [
  "--define",
  OPENTUI_LIBC_DEFINE,
] as const;
