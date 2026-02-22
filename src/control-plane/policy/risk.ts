export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskAssessment = {
  readonly level: RiskLevel;
  readonly reasons: readonly string[];
  readonly requiresApproval: boolean;
};

const LOW_COMMANDS = new Set([
  "cat",
  "ls",
  "pwd",
  "echo",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "stat",
  "env",
  "printenv",
  "git status",
  "git log",
  "git diff",
  "hack status",
  "hack logs",
]);

const MEDIUM_HINTS = [
  " test",
  " build",
  " lint",
  " check",
  " typecheck",
  " fmt",
  " format",
  " compile",
] as const;

const HIGH_HINTS = [
  "git push",
  "git branch -d",
  "git branch -D",
  "git checkout -b",
  "git checkout -B",
  "git merge",
  "git rebase",
  "gh pr create",
  "gh pr comment",
  "gh pr merge",
  "git tag -d",
] as const;

const CRITICAL_HINTS = [
  "rm -rf /",
  "rm -rf ~",
  "mkfs",
  "shutdown",
  "reboot",
  "dd if=",
  "fdisk",
  "parted",
  "chmod -R 777 /",
] as const;

const SENSITIVE_PATH_HINTS = [
  "/etc/",
  "~/.ssh",
  ".ssh/",
  "~/.aws",
  ".aws/credentials",
  ".gnupg/",
  "/var/lib/docker",
] as const;

function collectPatternReasons(opts: {
  readonly normalizedCommand: string;
  readonly hints: readonly string[];
  readonly formatter: (hint: string) => string;
}): string[] {
  const reasons: string[] = [];
  for (const hint of opts.hints) {
    if (opts.normalizedCommand.includes(hint)) {
      reasons.push(opts.formatter(hint));
    }
  }
  return reasons;
}

function isSensitivePathWrite(opts: {
  readonly normalizedCommand: string;
  readonly pathHint: string;
}): boolean {
  const normalizedHint = opts.pathHint.toLowerCase();
  if (
    opts.normalizedCommand.includes(`>${normalizedHint}`) ||
    opts.normalizedCommand.includes(`>>${normalizedHint}`) ||
    opts.normalizedCommand.includes(`tee ${normalizedHint}`)
  ) {
    return true;
  }
  if (!opts.normalizedCommand.includes(normalizedHint)) {
    return false;
  }
  return (
    opts.normalizedCommand.includes("cp ") ||
    opts.normalizedCommand.includes("mv ")
  );
}

function collectSensitivePathReasons(opts: {
  readonly normalizedCommand: string;
}): string[] {
  const reasons: string[] = [];
  for (const hint of SENSITIVE_PATH_HINTS) {
    if (
      isSensitivePathWrite({
        normalizedCommand: opts.normalizedCommand,
        pathHint: hint,
      })
    ) {
      reasons.push(`sensitive path write detected: ${hint}`);
    }
  }
  return reasons;
}

function isAgentRunner(opts: { readonly runner: string }): boolean {
  const normalizedRunner = opts.runner.trim().toLowerCase();
  return (
    normalizedRunner === "codex" ||
    normalizedRunner === "claude" ||
    normalizedRunner === "cursor"
  );
}

function isLowRiskCommand(opts: {
  readonly command: readonly string[];
}): boolean {
  const firstTwo = opts.command.slice(0, 2).join(" ").toLowerCase();
  const firstOne = (opts.command[0] ?? "").toLowerCase();
  return LOW_COMMANDS.has(firstTwo) || LOW_COMMANDS.has(firstOne);
}

/**
 * Classify a command into low/medium/high/critical risk.
 *
 * `high` and `critical` require explicit approval before dispatch writes.
 */
export function assessCommandRisk(opts: {
  readonly command: readonly string[];
  readonly runner: string;
}): RiskAssessment {
  const commandText = opts.command.join(" ").trim();
  const normalized = ` ${commandText.toLowerCase()} `;
  const criticalReasons = collectPatternReasons({
    normalizedCommand: normalized,
    hints: CRITICAL_HINTS,
    formatter: (hint) => `matched critical pattern: ${hint.trim()}`,
  });
  const sensitivePathReasons =
    criticalReasons.length === 0
      ? collectSensitivePathReasons({ normalizedCommand: normalized })
      : [];
  const blockingReasons = [...criticalReasons, ...sensitivePathReasons];
  if (blockingReasons.length > 0) {
    return {
      level: "critical",
      reasons: blockingReasons,
      requiresApproval: true,
    };
  }

  const reasons: string[] = [];
  if (isAgentRunner({ runner: opts.runner })) {
    reasons.push(`agent runner: ${opts.runner.trim().toLowerCase()}`);
  }

  const highReasons = collectPatternReasons({
    normalizedCommand: normalized,
    hints: HIGH_HINTS,
    formatter: (hint) => `matched high-risk operation: ${hint}`,
  });
  reasons.push(...highReasons);
  if (highReasons.length > 0) {
    return {
      level: "high",
      reasons,
      requiresApproval: true,
    };
  }

  reasons.push(
    ...collectPatternReasons({
      normalizedCommand: normalized,
      hints: MEDIUM_HINTS,
      formatter: (hint) => `matched medium operation: ${hint.trim()}`,
    })
  );

  if (isLowRiskCommand({ command: opts.command })) {
    return {
      level: reasons.length > 0 ? "medium" : "low",
      reasons,
      requiresApproval: false,
    };
  }

  if (reasons.length > 0) {
    return {
      level: "medium",
      reasons,
      requiresApproval: false,
    };
  }

  return {
    level: "medium",
    reasons: ["defaulted to medium for unknown command pattern"],
    requiresApproval: false,
  };
}
