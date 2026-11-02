/**
 * One-line macOS Local Network hint for browser-facing `.local` URLs.
 *
 * macOS decides Local Network access by name: a browser that resolves a
 * `.local` hostname needs the per-app Local Network permission even when
 * Hack's resolver answers with loopback (Apple TN3179). Safari is exempt;
 * other browsers need a one-time grant.
 *
 * Contract:
 * - The hint text is a closed constant: no hostnames, paths or other
 *   interpolated data.
 * - It is written to stderr only, never to stdout and never into a `--json`
 *   payload, so machine-readable output stays unchanged.
 * - It appears only on macOS, only for hosts ending in `.local`, and at most
 *   once per emitter. The process-wide emitter makes that once per command.
 * - It never reads or changes the permission itself.
 */

export const LOCAL_NETWORK_HINT_MESSAGE =
  "Hint: on macOS, browsers other than Safari need a one-time Local Network permission to open .local names (System Settings > Privacy & Security > Local Network). See docs/guides/macos-browser-network.md.";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const TRAILING_DOTS = /\.+$/;

/**
 * Extracts the hostname from an absolute URL or a bare host, lowercased and
 * without a trailing root dot. Returns null for empty or unparsable input.
 */
export function browserHostFromTarget(target: string): string | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const candidate = URL_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(candidate).hostname;
  } catch {
    return null;
  }
  const normalized = hostname.toLowerCase().replace(TRAILING_DOTS, "");
  return normalized.length > 0 ? normalized : null;
}

/** True when the target's hostname is a name under the `.local` suffix. */
export function isLocalSuffixTarget(target: string): boolean {
  const host = browserHostFromTarget(target);
  return host?.endsWith(".local") === true;
}

/** True when the hint applies to any target on the given platform. */
export function shouldShowLocalNetworkHint(opts: {
  readonly platform: string;
  readonly targets: Iterable<string>;
}): boolean {
  if (opts.platform !== "darwin") {
    return false;
  }
  for (const target of opts.targets) {
    if (isLocalSuffixTarget(target)) {
      return true;
    }
  }
  return false;
}

export interface LocalNetworkHintEmitter {
  /**
   * Records browser-facing URLs or hosts that Hack printed or opened, and
   * writes the hint once when one of them needs it. Returns true only for
   * the call that wrote the hint.
   */
  note(targets: Iterable<string>): boolean;
}

/** Creates an emitter with injected platform and writer (used by tests). */
export function createLocalNetworkHintEmitter(opts: {
  readonly platform: string;
  readonly write: (line: string) => void;
}): LocalNetworkHintEmitter {
  let shown = false;
  return {
    note(targets) {
      if (shown) {
        return false;
      }
      if (!shouldShowLocalNetworkHint({ platform: opts.platform, targets })) {
        return false;
      }
      shown = true;
      opts.write(`${LOCAL_NETWORK_HINT_MESSAGE}\n`);
      return true;
    },
  };
}

let processEmitter: LocalNetworkHintEmitter | null = null;

/**
 * Process-wide hint for the current command. Each CLI invocation is one
 * process, so this shows the hint at most once per command.
 */
export function noteBrowserTargetsForLocalNetworkHint(
  targets: Iterable<string>
): boolean {
  processEmitter ??= createLocalNetworkHintEmitter({
    platform: process.platform,
    write: (line) => {
      process.stderr.write(line);
    },
  });
  return processEmitter.note(targets);
}
