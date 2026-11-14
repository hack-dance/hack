import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertAutostartPathAclsTrustedSync } from "./autostart-path-acl.ts";
import { HackCliError } from "./cli-result.ts";
import { checkReplaceableChain, walkReplaceableChain } from "./path-trust.ts";

const STARTUP_INPUT =
  /^(?:hack\.(?:config|env)(?:\..*)?\.(?:json|ya?ml)|docker-compose(?:\..*)?\.ya?ml|\.env(?:\..*)?)$/;
const GENERATED_INPUT = /\.(?:json|ya?ml)$|^\.env/;

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
    const visited = new Set<string>();
    let entries = 0;
    const generatedDirectoryExists = (path: string): boolean => {
      const result = walkReplaceableChain({
        path,
        uid,
        hackHome: null,
        checked,
        allowMissing: true,
      });
      if ("error" in result) {
        throw refusal();
      }
      if (!result.complete) {
        return false;
      }
      if (!statSync(path).isDirectory()) {
        throw refusal();
      }
      const physical = realpathSync(path);
      if (visited.has(physical)) {
        throw refusal();
      }
      visited.add(physical);
      return true;
    };
    const checkGenerated = (path: string, depth: number): void => {
      entries += 1;
      if (entries > 4096 || depth > 16) {
        throw refusal();
      }
      if (!generatedDirectoryExists(path)) {
        return;
      }
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const input = join(path, entry.name);
        if (
          entry.isDirectory() ||
          (entry.isSymbolicLink() && statSync(input).isDirectory())
        ) {
          checkGenerated(input, depth + 1);
        } else if (
          GENERATED_INPUT.test(entry.name) &&
          (checkReplaceableChain({
            path: input,
            uid,
            hackHome: null,
            checked,
          }) !== null ||
            !statSync(input).isFile())
        ) {
          throw refusal();
        }
      }
    };
    checkGenerated(join(opts.projectDir, ".internal"), 0);
    checkGenerated(join(opts.projectDir, ".branch"), 0);
    assertAutostartPathAclsTrustedSync(checked);
  } catch {
    throw refusal();
  }
}
