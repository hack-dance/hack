import { type CliOkResult, okResult } from "./cli-result.ts";

/** Unpublished HACK-2218 contracts use an envelope and a versioned payload schema. */
export const MACHINE_SCHEMAS = {
  version: "hack.version.v1",
  projectsObserve: "hack.projects.observe.v1",
  globalAdminPlan: "hack.global-admin-plan.v1",
  globalStatusObserve: "hack.global-status.observe.v1",
} as const;

export function machineSuccess<T extends object>(opts: {
  readonly schema: (typeof MACHINE_SCHEMAS)[keyof typeof MACHINE_SCHEMAS];
  readonly data: T;
}): CliOkResult<T & { readonly schema: string }> {
  return okResult({ data: { ...opts.data, schema: opts.schema } });
}
