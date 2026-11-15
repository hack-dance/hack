/** Protocol fixture only; this does not qualify native artifacts or a guest. */
export function nativeSetupInspection(state = "ready") {
  return {
    protocol_version: 1,
    state,
    code:
      state === "not_set_up" || state === "partial_resumable"
        ? "E_NATIVE_SETUP_REQUIRED"
        : state === "unsupported_host"
          ? "unsupported_host"
          : state === "invalid_preserved"
            ? "native_setup_invalid"
            : `native_setup_${state}`,
    installation_state: state,
    supported_host: true,
    setup_only: true,
    pins: [
      {
        url: "https://example.invalid/provider.tgz",
        size_bytes: 5,
        archive_sha256: "a".repeat(64),
      },
    ],
  };
}

/** Keep observation outside older fixtures' effect tripwires. First-use tests
 * separately assert the complete inspection request and its ordering.
 */
export function nativeSetupShellReply(): string {
  return `if [ "$#" = 6 ] && [ "$3" = runtime ] && [ "$4" = setup ] && [ "$5" = inspect ] && [ "$6" = --json ]; then
  printf '%s\\n' '${JSON.stringify(nativeSetupInspection())}'
  exit 0
fi`;
}

export function nativeSetupScriptReply(): string {
  return `if (process.argv.length === 8 && process.argv.slice(4).join(" ") === "runtime setup inspect --json") {
  console.log(${JSON.stringify(JSON.stringify(nativeSetupInspection()))});
  process.exit(0);
}`;
}
