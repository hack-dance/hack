export type RecoveryCheckStatus = "ok" | "warn" | "error";

export type RecoveryCheckResult = {
  readonly name: string;
  readonly status: RecoveryCheckStatus;
  readonly message: string;
};

export type DoctorRecoveryGuidance = {
  readonly temporaryBreakage: readonly string[];
  readonly configurationRepair: readonly string[];
  readonly followUp: readonly string[];
  readonly verify: readonly string[];
  readonly capture: readonly string[];
};

const FIX_CHECKS = new Set(["caddy local ca", "dns:hack", "dns:hack.gy"]);
const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_./:-]+$/u;

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

export function buildDoctorRecoveryGuidance(input: {
  readonly results: readonly RecoveryCheckResult[];
}): DoctorRecoveryGuidance {
  const temporaryBreakage: string[] = [];
  const configurationRepair: string[] = [];
  const followUp: string[] = [];

  for (const result of input.results) {
    if (result.status === "ok") {
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

    if (result.message.includes("hack daemon clear")) {
      pushUnique(temporaryBreakage, "hack daemon clear");
      pushUnique(temporaryBreakage, "hack daemon start");
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

  return input.command.replace("<repo>", quotedProjectRoot);
}

function quoteShellArg(value: string): string {
  if (SAFE_SHELL_ARG_PATTERN.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
