#!/usr/bin/env bun
/**
 * Fails the local `test`, `check` and `typecheck` entry points when the running
 * Bun differs from the `packageManager` pin in the root `package.json`.
 *
 * CI installs exactly that pin. A contributor whose PATH resolves another Bun
 * (for example mise's `latest` install ahead of the checkout's `mise.toml`) would
 * otherwise get results CI does not reproduce: a Bun 1.4.3 test pass hid a
 * Bun 1.4.2 macOS SIGSTOP difference that failed in CI (HACK-1290).
 *
 * `HACK_ALLOW_BUN_VERSION_MISMATCH=1` proceeds deliberately, with a warning on
 * stderr. Any other value is ignored. The check reads only the version strings.
 */
import { resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

/** The opt-in for a deliberate mismatch, such as a Bun upgrade experiment. */
export const BUN_VERSION_OVERRIDE_ENV = "HACK_ALLOW_BUN_VERSION_MISMATCH";

const PIN_PATTERN = /^bun@(\d+\.\d+\.\d+)$/;

export type BunVersionVerdict =
  | { readonly kind: "match"; readonly pinned: string }
  | {
      readonly kind: "overridden";
      readonly pinned: string;
      readonly message: string;
    }
  | {
      readonly kind: "mismatch";
      readonly pinned: string;
      readonly message: string;
    }
  | { readonly kind: "invalid-pin"; readonly message: string };

/** Pure comparison of the running Bun against the `packageManager` value. */
export function checkBunVersion(opts: {
  readonly running: string;
  readonly packageManager: unknown;
  readonly override: string | undefined;
}): BunVersionVerdict {
  const match =
    typeof opts.packageManager === "string"
      ? PIN_PATTERN.exec(opts.packageManager)
      : null;
  const pinned = match?.[1];
  if (!pinned) {
    return {
      kind: "invalid-pin",
      message:
        'package.json "packageManager" must be "bun@<major>.<minor>.<patch>".',
    };
  }
  if (opts.running === pinned) {
    return { kind: "match", pinned };
  }
  const detail =
    `Bun ${opts.running} is running, but package.json pins bun@${pinned} ` +
    "(packageManager), which CI uses.";
  if (opts.override === "1") {
    return {
      kind: "overridden",
      pinned,
      message: `Warning: ${detail} Continuing because ${BUN_VERSION_OVERRIDE_ENV}=1; results may differ from CI.`,
    };
  }
  return {
    kind: "mismatch",
    pinned,
    message:
      `${detail} Run the pinned Bun, for example ` +
      `\`mise x bun@${pinned} -- bun run <script>\`, or put mise shims ahead of ` +
      "other Bun installs so the checkout's mise.toml applies. " +
      `Set ${BUN_VERSION_OVERRIDE_ENV}=1 to run a different Bun deliberately.`,
  };
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  let packageManager: unknown;
  try {
    const manifest: unknown = await Bun.file(
      resolve(root, "package.json")
    ).json();
    packageManager = isRecord(manifest) ? manifest.packageManager : undefined;
  } catch {
    packageManager = undefined;
  }
  const verdict = checkBunVersion({
    running: Bun.version,
    packageManager,
    override: process.env[BUN_VERSION_OVERRIDE_ENV],
  });
  if (verdict.kind === "match") {
    return;
  }
  process.stderr.write(`${verdict.message}\n`);
  if (verdict.kind !== "overridden") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
