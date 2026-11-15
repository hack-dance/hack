/** Whether the supplied upgrade action can be offered as Run, needs host review, or needs a decision. */
export type UpgradeActionKind = "safe" | "admin" | "manual";

/**
 * Closed allow-list for the supplied command, not severity or a guess from prose.
 * Unknown commands and actions stay manual. Doctor --fix is deliberately not
 * safe: it repairs more than one finding and is not the snapshot-backed apply owner.
 */
export function upgradeActionKind(input: {
  readonly args: readonly string[] | null;
  readonly action: string | null;
}): UpgradeActionKind {
  const args = input.args;
  if (args === null || args.length !== 2) {
    return "manual";
  }
  const [command, verb] = args;
  if (
    (command === "global" && (verb === "install" || verb === "up")) ||
    (command === "daemon" &&
      ["install", "uninstall", "restart", "start"].includes(verb ?? ""))
  ) {
    return "admin";
  }
  if (input.action !== null) {
    return "manual";
  }
  if (
    (command === "upgrade" && verb === "snapshot") ||
    (command === "daemon" && verb === "status")
  ) {
    return "safe";
  }
  return "manual";
}
