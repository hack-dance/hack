import { isMac } from "./os.ts";
import {
  findProxyPortConflicts,
  type HostListener,
  parseLsofListeners,
  parseSsListeners,
  renderProxyPortConflictMessage,
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
  const res = await exec(cmd, { stdin: "ignore", timeoutMs: LIST_TIMEOUT_MS });
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
 * the proxy ports and the setting to change, or `null` when none is found.
 */
export async function diagnoseProxyPortConflict(opts: {
  readonly bindAddress: string | null;
  readonly listListeners?: () => Promise<readonly HostListener[] | null>;
}): Promise<string | null> {
  const listeners = await (opts.listListeners ?? listHostTcpListeners)();
  if (listeners === null) {
    return null;
  }
  const conflicts = findProxyPortConflicts({
    listeners,
    bindAddress: opts.bindAddress,
  });
  return conflicts.length === 0
    ? null
    : renderProxyPortConflictMessage({
        conflicts,
        bindAddress: opts.bindAddress,
      });
}
