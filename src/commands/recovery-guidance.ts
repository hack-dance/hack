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
