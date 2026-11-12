/**
 * File-local start refusals and their Compose fields. The reason is supplied by
 * the runtime's shared validator; it is never translated or copied here.
 * The source-inventory test rejects a missing entry. Null means project-wide.
 */
export const NATIVE_START_REFUSAL_ENTRIES: Readonly<
  Record<string, string | null>
> = {
  invalid_capability_list: "cap_add",
  graph_capabilities: "cap_add",
  graph_budget: null,
  graph_cache_readiness: "depends_on",
  graph_condition: "depends_on",
  graph_cycle: "depends_on",
  graph_dependency: "depends_on",
  graph_disposable_cache: "volumes",
  graph_incompatible: null,
  graph_one_shot_readiness: "depends_on",
  graph_port_publication: "ports",
  graph_readiness: "healthcheck",
  graph_restart_policy: "restart",
  graph_route_binding: "labels",
  graph_service: null,
  graph_subset: null,
  http_probe: "healthcheck.x-hack-http",
  native_http_mount: "volumes",
  native_http_readiness: "healthcheck",
  native_http_unavailable: "healthcheck.x-hack-http",
};

/** Acquired-runtime boundaries excluded from file-only review, with explicit reasons. */
export const NATIVE_START_RUNTIME_BOUNDARIES: Readonly<Record<string, string>> =
  {
    graph_dependency_cache:
      "Cache admission needs the verified source manifest and acquired cache identity.",
    graph_dependency_hosts:
      "Resolved private host bindings and relay slots must be acquired at start.",
    environment_file_mount:
      "Reserved wrapper paths depend on whether private file delivery is selected.",
    environment_launcher:
      "Private wrapper publication and image process identity are runtime operations.",
    environment_launcher_budget:
      "Private launcher size depends on resolved process and environment values.",
    environment_launcher_disabled:
      "Launcher availability is conditional on private delivery and the runtime feature set.",
    environment_user:
      "The effective process identity includes image defaults acquired at start.",
    graph_cache_source:
      "An acquired and verified source publication is required.",
    graph_network_alias:
      "The conflict depends on privately resolved host-dependency bindings.",
    graph_receipt:
      "The retained graph receipt and ownership bindings must agree.",
    graph_service_failed:
      "The service's actual process failed during execution.",
    graph_timeout:
      "The execution timeout is a runtime/CLI budget, not Compose configuration.",
    graph_timeout_budget:
      "The running operation exhausted its execution budget.",
  };
