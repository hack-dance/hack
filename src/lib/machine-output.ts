import { type CliOkResult, okResult } from "./cli-result.ts";

/** HACK-2218 machine contracts use an envelope and a versioned payload schema. */
export const MACHINE_SCHEMAS = {
  activity: "hack.activity.v1",
  autostart: "hack.autostart.v1",
  version: "hack.version.v1",
  projectsObserve: "hack.projects.observe.v1",
  globalAdminPlan: "hack.global-admin-plan.v1",
  globalStatusObserve: "hack.global-status.observe.v1",
  usageByService: "hack.usage.by-service.v1",
  updateCheck: "hack.update-check.v1",
} as const;

export function machineSuccess<T extends object>(opts: {
  readonly schema: (typeof MACHINE_SCHEMAS)[keyof typeof MACHINE_SCHEMAS];
  readonly data: T;
}): CliOkResult<T & { readonly schema: string }> {
  return okResult({ data: { ...opts.data, schema: opts.schema } });
}
