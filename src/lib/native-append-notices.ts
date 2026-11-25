import { isRecord } from "./guards.ts";

/**
 * Notices for a committed targeted native start (`hack up <service>` on a
 * running run). `changed` names running services whose definition changed and
 * kept their previous configuration. When the CLI offered its full-file review
 * and the owner could not use it (a changed source inventory, a running
 * service's authored definition that changed since `up`, or no recorded owner
 * input), the owner's reply carries `combined_review: "owner_fallback"`: the
 * run then records the owner's own review of the combined services, which a
 * later restore must reconcile (`plan_reconcile::eligible` refuses for live
 * source, a carried source cache scope or a pending initializer cache
 * release). Replies from earlier runtimes omit the field.
 */
export function nativeAppendNotices(opts: {
  readonly changed: readonly string[];
  readonly response: unknown;
  readonly combinedOffered: boolean;
}): string[] {
  const notices = opts.changed.map(
    (name) =>
      `Service ${name} is running with its previous configuration. Use hack restart to apply the change on native; Compose supports hack restart ${name}.`
  );
  if (
    opts.combinedOffered &&
    isRecord(opts.response) &&
    opts.response.combined_review === "owner_fallback"
  ) {
    notices.push(
      "Native recorded its own review of the combined services because the full-file review did not match what the run recorded (for example, a service definition or the source changed since the run started). A later restore of this run has to reconcile it; that refuses for live source, a carried source cache scope or a pending initializer cache release."
    );
  }
  return notices;
}
