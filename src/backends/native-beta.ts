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
