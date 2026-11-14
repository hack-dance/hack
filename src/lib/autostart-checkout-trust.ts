import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { checkReplaceableChain, walkReplaceableChain } from "./path-trust.ts";

const STARTUP_INPUT =
  /^(?:hack\.(?:config|env)(?:\..*)?\.(?:json|ya?ml)|docker-compose(?:\..*)?\.ya?ml|\.env(?:\..*)?)$/;

/**
 * Automatic startup may execute checkout hooks only through paths another user
 * cannot replace. This checks live filesystem ownership and modes, not Git content;
 * ordinary updates by the checkout owner remain allowed. No permissions are changed.
 */
export function assertAutostartCheckoutTrusted(opts: {
  readonly repoRoot: string;
  readonly projectDir: string;
}): void {
  const refusal = () =>
    new HackCliError({
      code: "E_PERMISSION",
      message:
        "Autostart cannot trust this checkout path. Use a checkout whose directory chain is owned by the current user or root and is not replaceable by other users. No further startup effects ran. Values omitted.",
      detail: { reason: "checkout_untrusted" },
    });
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw refusal();
  }
  try {
    const checked = new Set<string>();
    for (const path of [opts.repoRoot, opts.projectDir]) {
      if (
        checkReplaceableChain({ path, uid, hackHome: null, checked }) !==
          null ||
        !statSync(path).isDirectory()
      ) {
        throw refusal();
      }
    }
    // These declarative inputs can supply lifecycle commands, Compose graphs,
    // and process environment. Check file modes and symlink targets as well as
    // their directory chains, before any parser reads their contents.
    const inputs = new Set([join(opts.repoRoot, ".env")]);
    for (const name of readdirSync(opts.projectDir)) {
      if (STARTUP_INPUT.test(name)) {
        inputs.add(join(opts.projectDir, name));
      }
    }
    for (const path of inputs) {
      const result = walkReplaceableChain({
        path,
        uid,
        hackHome: null,
        checked,
        allowMissing: true,
      });
      if ("error" in result || (result.complete && !statSync(path).isFile())) {
        throw refusal();
      }
    }
  } catch {
    throw refusal();
  }
}
