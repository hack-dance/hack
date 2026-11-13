export type RecoveryCheckStatus = "ok" | "warn" | "error";

export type RecoveryCheckResult = {
  readonly name: string;
  readonly status: RecoveryCheckStatus;
  readonly message: string;
};

export type DoctorRecoveryGuidance = {
  readonly temporaryBreakage: readonly string[];
  readonly configurationRepair: readonly string[];
  /**
   * Alternatives the operator chooses between (one is enough), as plain
   * text; for example the two ways forward for a secret store whose key is
   * missing (HACK-2177).
   */
  readonly choices?: readonly string[];
  readonly followUp: readonly string[];
  readonly verify: readonly string[];
  readonly capture: readonly string[];
};

const FIX_CHECKS = new Set(["caddy local ca", "dns:hack", "dns:hack.gy"]);
/** The secret integrity finding for a store whose key is missing names this command. */
const RETIRE_STORE_COMMAND = "hack secrets retire-store";
/** The command as the finding names it, with the diagnosed project's `--path`. */
const RETIRE_STORE_COMMAND_PATTERN =
  /hack secrets retire-store(?: --path (?:'(?:[^']|'"'"')*'|[A-Za-z0-9_./:-]+))?/u;

/** The two ways forward for such a store, shown as one choice (HACK-2177). */
function secretStoreChoices(command: string): readonly string[] {
  return [
    "Restore the encrypted secret store's key: put the key file back where the secret integrity check says (mode 600), or set HACK_SECRETS_FILE_KEY to the same key.",
    `Or, if the key is gone for good, retire the store: \`${command}\` moves it aside to a timestamped name beside it, deletes nothing, and prints how to put it back.`,
  ];
}
const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_./:-]+$/u;
const PROJECTS_PRUNE_COMMAND_PATTERN =
  /hack projects prune(?: --project [A-Za-z0-9_.-]+)?/u;

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function isActionableRecoveryResult(result: RecoveryCheckResult): boolean {
  if (result.status === "ok") {
    return false;
  }

  if (result.message === "Not found (optional)") {
    return false;
  }

  if (result.message.startsWith("Skipped (")) {
    return false;
  }

  if (
    result.name === "project" &&
    result.message.includes("run 'hack init' in a repo")
  ) {
    return false;
  }

  if (
    result.name === "gateway tokens" &&
    result.message.includes("No active tokens")
  ) {
    return false;
  }

  return true;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery guidance intentionally classifies many operator-facing repair hints in one pass.
export function buildDoctorRecoveryGuidance(input: {
  readonly results: readonly RecoveryCheckResult[];
}): DoctorRecoveryGuidance {
  const temporaryBreakage: string[] = [];
  const configurationRepair: string[] = [];
  const choices: string[] = [];
  const followUp: string[] = [];

  for (const result of input.results) {
    // Ignore reports from retired v4/early-v5 instruction audits.
    if (result.name === "agent integrations") {
      continue;
    }
    if (!isActionableRecoveryResult(result)) {
      continue;
    }

    if (
      result.name === "secret integrity" &&
      result.message.includes(RETIRE_STORE_COMMAND)
    ) {
      const command =
        result.message.match(RETIRE_STORE_COMMAND_PATTERN)?.[0] ??
        RETIRE_STORE_COMMAND;
      for (const choice of secretStoreChoices(command)) {
        pushUnique(choices, choice);
      }
      // Any other finding in the same check still needs a look.
      followUp.push(`${result.name}: ${result.message}`);
      continue;
    }

    if (result.message.includes("hack global up")) {
      pushUnique(temporaryBreakage, "hack global up");
      continue;
    }

    if (result.message.includes("hack restart")) {
      pushUnique(temporaryBreakage, "hack restart");
      continue;
    }

    if (result.message.includes("hack down")) {
      pushUnique(temporaryBreakage, "hack down");
      continue;
    }

    if (result.message.includes("hack projects prune")) {
      const command = result.message.match(PROJECTS_PRUNE_COMMAND_PATTERN)?.[0];
      pushUnique(temporaryBreakage, command ?? "hack projects prune");
      continue;
    }

    if (result.message.includes("hack env materialize")) {
      pushUnique(configurationRepair, "hack env materialize");
      continue;
    }

    if (result.message.includes("hack daemon clear")) {
      pushUnique(temporaryBreakage, "hack daemon clear");
      pushUnique(temporaryBreakage, "hack daemon start");
      continue;
    }

    if (result.message.includes("hack daemon restart")) {
      pushUnique(temporaryBreakage, "hack daemon restart");
      continue;
    }

    if (result.message.includes("hack daemon start")) {
      pushUnique(temporaryBreakage, "hack daemon start");
      continue;
    }

    if (result.message.includes("sudo brew services restart dnsmasq")) {
      pushUnique(temporaryBreakage, "sudo brew services restart dnsmasq");
      continue;
    }

    if (
      FIX_CHECKS.has(result.name) ||
      result.message.includes("hack doctor --fix")
    ) {
      pushUnique(configurationRepair, "hack doctor --fix");
      continue;
    }

    followUp.push(`${result.name}: ${result.message}`);
  }

  return {
    temporaryBreakage,
    configurationRepair,
    choices,
    followUp,
    verify: ["hack doctor"],
    capture: ["hack crash-capture --path <repo>"],
  };
}

export function scopeDoctorRecoveryGuidance(input: {
  readonly guidance: DoctorRecoveryGuidance;
  readonly projectRoot: string | null;
}): DoctorRecoveryGuidance {
  return {
    temporaryBreakage: input.guidance.temporaryBreakage.map((command) =>
      scopeRecoveryCommand({ command, projectRoot: input.projectRoot })
    ),
    configurationRepair: input.guidance.configurationRepair.map((command) =>
      scopeRecoveryCommand({ command, projectRoot: input.projectRoot })
    ),
    // A retire command without --path acts on the current directory: scope
    // it to the diagnosed project, as the other project commands are.
    choices: (input.guidance.choices ?? []).map((choice) =>
      input.projectRoot?.trim() &&
      choice.includes(`\`${RETIRE_STORE_COMMAND}\``)
        ? choice.replace(
            `\`${RETIRE_STORE_COMMAND}\``,
            `\`${RETIRE_STORE_COMMAND} --path ${quoteShellArg(input.projectRoot.trim())}\``
          )
        : choice
    ),
    followUp: [...input.guidance.followUp],
    verify: input.guidance.verify.map((command) =>
      scopeRecoveryCommand({ command, projectRoot: input.projectRoot })
    ),
    capture: input.guidance.capture.map((command) =>
      scopeRecoveryCommand({ command, projectRoot: input.projectRoot })
    ),
  };
}

export function buildRecoveryNextSteps(input: {
  readonly guidance: DoctorRecoveryGuidance;
  readonly projectRoot: string | null;
  readonly includeClassifyStep?: boolean;
}): readonly string[] {
  const scoped = scopeDoctorRecoveryGuidance({
    guidance: input.guidance,
    projectRoot: input.projectRoot,
  });
  const nextSteps: string[] = [];

  if (input.includeClassifyStep ?? false) {
    nextSteps.push(
      `Run \`${scopeRecoveryCommand({
        command: "hack doctor",
        projectRoot: input.projectRoot,
      })}\` to classify restart versus repair work.`
    );
  }

  for (const command of scoped.temporaryBreakage) {
    nextSteps.push(`Temporary breakage: \`${command}\`.`);
  }

  for (const command of scoped.configurationRepair) {
    nextSteps.push(`Configuration repair: \`${command}\`.`);
  }

  const choices = scoped.choices ?? [];
  if (choices.length > 0) {
    nextSteps.push(`Choose one: ${choices.join(" ")}`);
  }

  for (const item of scoped.followUp) {
    nextSteps.push(`Manual follow-up: ${item}`);
  }

  for (const command of scoped.verify) {
    nextSteps.push(`Verify with \`${command}\`.`);
  }

  if (scoped.capture[0]) {
    nextSteps.push(
      `If it still fails, run \`${scoped.capture[0]}\` again after the next repro.`
    );
  }

  return nextSteps;
}

export function buildRecoveryWorkflowLines(input: {
  readonly guidance: DoctorRecoveryGuidance;
  readonly projectRoot: string | null;
  readonly includeClassifyStep?: boolean;
}): readonly string[] {
  const scoped = scopeDoctorRecoveryGuidance({
    guidance: input.guidance,
    projectRoot: input.projectRoot,
  });
  const lines: string[] = [];
  let stepNumber = 1;

  if (input.includeClassifyStep ?? false) {
    lines.push(`${stepNumber}. Classify:`);
    lines.push(
      `   - \`${scopeRecoveryCommand({
        command: "hack doctor",
        projectRoot: input.projectRoot,
      })}\``
    );
    stepNumber += 1;
  }

  if (scoped.temporaryBreakage.length > 0) {
    lines.push(`${stepNumber}. Fix now:`);
    for (const command of scoped.temporaryBreakage) {
      lines.push(`   - \`${command}\``);
    }
    stepNumber += 1;
  }

  if (scoped.configurationRepair.length > 0) {
    lines.push(`${stepNumber}. Repair configuration:`);
    for (const command of scoped.configurationRepair) {
      lines.push(`   - \`${command}\``);
    }
    stepNumber += 1;
  }

  const choices = scoped.choices ?? [];
  if (choices.length > 0) {
    lines.push(`${stepNumber}. Choose one:`);
    for (const choice of choices) {
      lines.push(`   - ${choice}`);
    }
    stepNumber += 1;
  }

  if (scoped.followUp.length > 0) {
    lines.push(`${stepNumber}. Investigate:`);
    for (const item of scoped.followUp) {
      lines.push(`   - ${item}`);
    }
    stepNumber += 1;
  }

  lines.push(`${stepNumber}. Verify:`);
  for (const command of scoped.verify) {
    lines.push(`   - \`${command}\``);
  }
  stepNumber += 1;

  lines.push(`${stepNumber}. If it still fails:`);
  for (const command of scoped.capture) {
    lines.push(`   - \`${command}\``);
  }

  return lines;
}

export function scopeRecoveryCommand(input: {
  readonly command: string;
  readonly projectRoot: string | null;
}): string {
  const projectRoot = input.projectRoot?.trim();
  if (!projectRoot) {
    return input.command;
  }
  const quotedProjectRoot = quoteShellArg(projectRoot);

  if (input.command === "hack doctor") {
    return `hack doctor --path ${quotedProjectRoot}`;
  }

  if (input.command === "hack doctor --fix") {
    return `hack doctor --fix --path ${quotedProjectRoot}`;
  }

  if (input.command === "hack restart") {
    return `hack restart --path ${quotedProjectRoot}`;
  }

  if (input.command === "hack down") {
    return `hack down --path ${quotedProjectRoot}`;
  }

  if (input.command === "hack env materialize") {
    return `hack env materialize --path ${quotedProjectRoot}`;
  }

  return input.command.replace("<repo>", quotedProjectRoot);
}

function quoteShellArg(value: string): string {
  if (SAFE_SHELL_ARG_PATTERN.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
