import { isMac } from "./os.ts";
import {
  findProxyPortConflicts,
  type HostListener,
  parseLsofListeners,
  parseSsListeners,
  renderProxyPortConflictMessage,
  renderProxyStartFailureHint,
  renderProxyStartFailureNotBindHint,
} from "./proxy-bind.ts";
import { exec } from "./shell.ts";

const LIST_TIMEOUT_MS = 3000;

/** Host TCP listeners (read-only `ss` on Linux, `lsof` on macOS). */
export async function listHostTcpListeners(): Promise<
  readonly HostListener[] | null
> {
  const cmd = isMac()
    ? ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]
    : ["ss", "-Hltnp"];
  let res: Awaited<ReturnType<typeof exec>>;
  try {
    res = await exec(cmd, { stdin: "ignore", timeoutMs: LIST_TIMEOUT_MS });
  } catch {
    // ss/lsof missing: Bun.spawn throws. Diagnosis is best-effort, so the
    // caller still prints the proxy.bind_address hint and its exit code.
    return null;
  }
  // lsof exits 1 when nothing matches; that means "no listeners".
  const noMatches = isMac() && res.exitCode === 1;
  if (res.exitCode !== 0 && !noMatches) {
    return null;
  }
  return isMac()
    ? parseLsofListeners(res.stdout)
    : parseSsListeners(res.stdout);
}

/**
 * After the proxy failed to start: a message naming the listeners that hold
 * the proxy ports and the setting to change. When no conflicting listener is
 * visible, a generic hint naming the setting, unless the caller read
 * Docker's error and it named no port bind (`bindFailure: false`); the
 * ports are not blamed then (HACK-2673).
 */
export async function diagnoseProxyPortConflict(opts: {
  readonly bindAddress: string | null;
  /**
   * Whether Docker reported a port it could not publish: true or false when
   * its error was read, null or absent when it was not (the generic port
   * hint is printed then, as before).
   */
  readonly bindFailure?: boolean | null;
  readonly listListeners?: () => Promise<readonly HostListener[] | null>;
}): Promise<string> {
  const listeners = await (opts.listListeners ?? listHostTcpListeners)();
  const conflicts =
    listeners === null
      ? []
      : findProxyPortConflicts({ listeners, bindAddress: opts.bindAddress });
  if (conflicts.length > 0) {
    return renderProxyPortConflictMessage({
      conflicts,
      bindAddress: opts.bindAddress,
    });
  }
  return opts.bindFailure === false
    ? renderProxyStartFailureNotBindHint()
    : renderProxyStartFailureHint(opts.bindAddress);
}
