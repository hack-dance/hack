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

const FIX_CHECKS = new Set([
  "caddy local ca",
  "coredns forwarding",
  "dns:hack",
  "dns:hack.gy",
  "dnsmasq:53",
]);

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

    if (
      result.name === "proxy ports" &&
      result.message.includes("hack global up")
    ) {
      pushUnique(temporaryBreakage, "hack global up");
      continue;
    }

    if (
      result.name === "caddy hosts" &&
      result.message.includes("hack restart")
    ) {
      pushUnique(temporaryBreakage, "hack restart");
      continue;
    }

    if (
      result.name === "daemon" &&
      result.message.includes("hack daemon clear")
    ) {
      pushUnique(temporaryBreakage, "hack daemon clear");
      pushUnique(temporaryBreakage, "hack daemon start");
      continue;
    }

    if (
      result.name === "daemon" &&
      result.message.includes("hack daemon start")
    ) {
      pushUnique(temporaryBreakage, "hack daemon start");
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
  const projectRoot = input.projectRoot ?? "<repo>";
  const nextSteps: string[] = [];

  if (input.includeClassifyStep ?? false) {
    nextSteps.push(
      `Run \`hack doctor --path ${projectRoot}\` to classify restart versus repair work.`
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

function scopeRecoveryCommand(input: {
  readonly command: string;
  readonly projectRoot: string | null;
}): string {
  const projectRoot = input.projectRoot?.trim();
  if (!projectRoot) {
    return input.command;
  }

  if (input.command === "hack doctor") {
    return `hack doctor --path ${projectRoot}`;
  }

  if (input.command === "hack doctor --fix") {
    return `hack doctor --fix --path ${projectRoot}`;
  }

  if (input.command === "hack restart") {
    return `hack restart --path ${projectRoot}`;
  }

  return input.command.replace("<repo>", projectRoot);
}
