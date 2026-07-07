import { findExecutableInPath, run } from "../lib/shell.ts";
import { logger } from "../ui/logger.ts";

/**
 * Handoff helpers for `hack init --with <agent>`: resolve the requested agent
 * CLIs, launch them interactively with the onboarding prompt, or fall back to
 * printing the prompt with copy-paste instructions.
 *
 * Both supported CLIs accept the prompt as a positional argument for an
 * interactive session (`claude "<prompt>"`, `codex "<prompt>"`).
 */

export type OnboardingAgent = "claude" | "codex";

export type OnboardingWith = OnboardingAgent | "both";

export type OnboardingHandoffOutcome = {
  /** Agent CLIs that were launched interactively. */
  readonly launched: readonly OnboardingAgent[];
  /** Requested agent CLIs that were not found on PATH. */
  readonly missing: readonly OnboardingAgent[];
  /** Whether the prompt was printed for copy-paste instead of (or in addition to) launching. */
  readonly printed: boolean;
  /** Worst exit code from launched CLIs (0 when none launched). */
  readonly exitCode: number;
};

const WITH_VALUES: ReadonlySet<string> = new Set(["claude", "codex", "both"]);

const WITH_AGENTS: Readonly<
  Record<OnboardingWith, readonly OnboardingAgent[]>
> = {
  claude: ["claude"],
  codex: ["codex"],
  both: ["claude", "codex"],
};

/**
 * Parse a raw `--with` value. Returns null when the value is not one of
 * `claude`, `codex`, or `both` (callers surface the usage error).
 */
export function parseOnboardingWith(opts: {
  readonly value: string;
}): OnboardingWith | null {
  const normalized = opts.value.trim().toLowerCase();
  return WITH_VALUES.has(normalized) ? (normalized as OnboardingWith) : null;
}

/**
 * Expand a `--with` selection into the ordered agent CLI list to hand off to.
 */
export function resolveOnboardingAgents(opts: {
  readonly withValue: OnboardingWith;
}): readonly OnboardingAgent[] {
  return WITH_AGENTS[opts.withValue];
}

/**
 * Hand the onboarding prompt to the requested agent CLIs.
 *
 * Behavior:
 * - `interactive: false` (non-TTY, `--no-interactive`, `HACK_NO_INTERACTIVE`):
 *   never spawns; prints the prompt once with copy-paste instructions.
 * - Otherwise each requested CLI found on PATH is launched interactively with
 *   the prompt as its positional argument (sequentially for `both`).
 * - Any requested CLI missing from PATH triggers the printed fallback once.
 *
 * @param opts.launch - Test seam; defaults to spawning via `run` with
 *   inherited stdio.
 */
export async function runOnboardingHandoff(opts: {
  readonly prompt: string;
  readonly withValue: OnboardingWith;
  readonly interactive: boolean;
  readonly launch?: (launchOpts: {
    readonly agent: OnboardingAgent;
    readonly binPath: string;
    readonly prompt: string;
  }) => Promise<number>;
}): Promise<OnboardingHandoffOutcome> {
  const agents = resolveOnboardingAgents({ withValue: opts.withValue });
  const launch = opts.launch ?? launchAgentCli;

  if (!opts.interactive) {
    printPromptFallback({
      prompt: opts.prompt,
      agents,
      reason: "non-interactive run",
    });
    return { launched: [], missing: [], printed: true, exitCode: 0 };
  }

  const launched: OnboardingAgent[] = [];
  const missing: OnboardingAgent[] = [];
  let exitCode = 0;

  for (const agent of agents) {
    const binPath = findExecutableInPath(agent);
    if (!binPath) {
      missing.push(agent);
      continue;
    }
    logger.info({ message: `Handing off to ${agent} — starting a session…` });
    const code = await launch({ agent, binPath, prompt: opts.prompt });
    launched.push(agent);
    exitCode = Math.max(exitCode, code);
  }

  const printed = missing.length > 0;
  if (printed) {
    printPromptFallback({
      prompt: opts.prompt,
      agents: missing,
      reason: `${formatAgentList(missing)} not found on PATH`,
    });
  }

  return { launched, missing, printed, exitCode };
}

async function launchAgentCli(opts: {
  readonly agent: OnboardingAgent;
  readonly binPath: string;
  readonly prompt: string;
}): Promise<number> {
  return await run([opts.binPath, opts.prompt], { stdin: "inherit" });
}

function printPromptFallback(opts: {
  readonly prompt: string;
  readonly agents: readonly OnboardingAgent[];
  readonly reason: string;
}): void {
  const commands = opts.agents
    .map((agent) => `  ${agent} "<prompt below>"`)
    .join("\n");
  process.stdout.write(
    [
      `Could not launch an agent session (${opts.reason}).`,
      "Paste the prompt below into a fresh agent session, or run:",
      commands,
      "",
      "----- hack onboarding prompt -----",
      opts.prompt,
      "----- end prompt -----",
      "",
    ].join("\n")
  );
}

function formatAgentList(agents: readonly OnboardingAgent[]): string {
  return agents.join(" and ");
}
