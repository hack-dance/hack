import { confirm, isCancel } from "@clack/prompts";
import { HackCliError } from "./cli-result.ts";

/**
 * Global interactivity convention.
 *
 * Prompting is allowed only when ALL of these hold:
 * - stdin AND stdout are TTYs,
 * - `HACK_NO_INTERACTIVE` is not set to a truthy value,
 * - the global `--no-interactive` flag was not passed.
 *
 * When prompting is disallowed, commands either apply a documented safe
 * default or fail fast with `E_INTERACTIVE_REQUIRED` (mentioning the flags
 * that make the invocation scriptable).
 */

let noInteractiveFlag = false;

/**
 * Record the global `--no-interactive` CLI flag (set once per invocation by
 * the CLI entrypoint).
 */
export function setNoInteractiveFlag(opts: {
  readonly enabled: boolean;
}): void {
  noInteractiveFlag = opts.enabled;
}

/**
 * Reset the process-wide flag (test helper).
 */
export function resetNoInteractiveFlagForTests(): void {
  noInteractiveFlag = false;
}

function isTruthyEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether the user explicitly opted out of prompting for this invocation
 * (`--no-interactive` flag or `HACK_NO_INTERACTIVE` env), independent of
 * TTY detection.
 */
export function isExplicitlyNonInteractive(): boolean {
  if (noInteractiveFlag) {
    return true;
  }
  return isTruthyEnv(process.env.HACK_NO_INTERACTIVE);
}

/**
 * Whether interactive prompts are allowed for this invocation.
 */
export function canPrompt(): boolean {
  if (isExplicitlyNonInteractive()) {
    return false;
  }
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Fail fast because the command needs input that was not provided.
 *
 * @param opts.what - What input was needed (human phrasing).
 * @param opts.hint - The flags/arguments that make this scriptable.
 */
export function requireInteractive(opts: {
  readonly what: string;
  readonly hint: string;
}): never {
  throw new HackCliError({
    code: "E_INTERACTIVE_REQUIRED",
    message: `Interactive input required: ${opts.what}. Non-interactive run detected (no TTY, HACK_NO_INTERACTIVE, or --no-interactive). ${opts.hint}`,
  });
}

export type NonInteractivePolicy = "accept-default" | "decline" | "fail";

const NON_INTERACTIVE_ANSWERS: Readonly<
  Record<
    Exclude<NonInteractivePolicy, "fail">,
    (opts: { readonly initialValue: boolean }) => boolean
  >
> = {
  "accept-default": (opts) => opts.initialValue,
  decline: () => false,
};

/**
 * Confirm prompt that honors the no-interactive convention.
 *
 * When the run is explicitly non-interactive (`--no-interactive` or
 * `HACK_NO_INTERACTIVE`), the declared policy resolves the answer without
 * prompting:
 * - `accept-default`: answer with `initialValue` (the documented default),
 * - `decline`: answer `false` (safe skip for destructive/sudo actions),
 * - `fail`: throw `E_INTERACTIVE_REQUIRED` with the provided hint.
 *
 * Otherwise a normal clack confirm runs (cancel throws, matching existing
 * prompt-site behavior). TTY-less runs without the explicit opt-out keep the
 * legacy clack behavior so wrapper environments stay unchanged.
 */
export async function confirmSafe(opts: {
  readonly message: string;
  readonly initialValue: boolean;
  readonly nonInteractive: NonInteractivePolicy;
  readonly hint?: string;
}): Promise<boolean> {
  if (!isExplicitlyNonInteractive()) {
    const ok = await confirm({
      message: opts.message,
      initialValue: opts.initialValue,
    });
    if (isCancel(ok)) {
      throw new Error("Canceled");
    }
    return ok;
  }

  if (opts.nonInteractive === "fail") {
    requireInteractive({
      what: firstLine(opts.message),
      hint: opts.hint ?? "Re-run interactively to answer this prompt.",
    });
  }

  return NON_INTERACTIVE_ANSWERS[opts.nonInteractive]({
    initialValue: opts.initialValue,
  });
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
