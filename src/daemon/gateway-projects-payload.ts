/** Keep machine-wide login progress local when projecting gateway-visible projects. */
export function gatewayProjectsPayload<
  T extends {
    readonly projects: readonly Record<string, unknown>[];
    readonly autostart_global: unknown;
  },
>(opts: {
  readonly payload: T;
  readonly enabledProjectIds: ReadonlySet<string>;
}) {
  const { autostart_global: _localAutostart, ...payload } = opts.payload;
  return {
    ...payload,
    include_unregistered: false,
    projects: payload.projects.filter(
      (project) =>
        typeof project.project_id === "string" &&
        opts.enabledProjectIds.has(project.project_id)
    ),
  };
}
