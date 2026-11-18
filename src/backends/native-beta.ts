/**
 * The native backend's release status in 5.0.0 (HACK-2026): an opt-in beta for
 * Apple Silicon macOS, delivered by the `hack-next` channel. The stable
 * archives and the Homebrew formula carry no native runtime, so stable `hack`
 * can only point at the candidate.
 */
export const NATIVE_BETA_DOCS_URL =
  "https://github.com/hack-dance/hack/blob/main/docs/guides/candidate-install.md";

/** The one line `hack up`, `hack status` and `hack doctor` print under native selection. */
export function nativeBetaNotice(): string {
  return `Native backend (beta): Apple Silicon macOS only, delivered by the hack-next channel. Limits and install: ${NATIVE_BETA_DOCS_URL}`;
}

/**
 * Appended to the refusal for `HACK_RUNTIME_BACKEND=native` without a usable
 * candidate. The usual cause on stable `hack` is the variable alone, set from a
 * guide or a shell profile, with no candidate installed.
 */
export function nativeBetaCandidatePointer(): string {
  return `The native backend is a beta for Apple Silicon macOS. It is not part of stable hack: the hack-next channel installs it, and its hack-next launcher sets these paths. Install the candidate (${NATIVE_BETA_DOCS_URL}), or unset HACK_RUNTIME_BACKEND to use the default Compose backend.`;
}

/**
 * The refusal `hack native setup` gives first on a host that is not Apple
 * Silicon macOS (HACK-2329), or null on one that is. An explicit
 * `HACK_NATIVE_BINARY` skips it: that is a developer pointing at their own
 * build, and the binary itself decides.
 */
export function nativePlatformRefusal(opts: {
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (opts.platform === "darwin" && opts.arch === "arm64") {
    return null;
  }
  if (opts.env.HACK_NATIVE_BINARY?.trim()) {
    return null;
  }
  const host = `${opts.platform === "darwin" ? "macOS" : opts.platform} ${opts.arch}`;
  const backend =
    opts.env.HACK_RUNTIME_BACKEND === "native"
      ? "Unset HACK_RUNTIME_BACKEND (or set it to compose) to use the Compose backend."
      : "Use the Compose backend; it is the default here.";
  return `The native runtime supports Apple Silicon macOS only; this host is ${host}. ${backend}`;
}
