import { legacyComposeAdoptionCandidateSupported } from "./native-compose-adoption-contract.ts";
import { legacyComposeRetainedPlan } from "./native-compose-adoption-readiness.ts";
import {
  type ImportField,
  parseImportDocument,
} from "./native-config-import-parser.ts";
import {
  freezeImportValue,
  mapLegacyNativeAdoptionBaseline,
  mapLegacyNativeBranchStorageAdoption,
  mapLegacyNativeCompletedJobAdoptionBaseline,
  mapLegacyNativeRetainedBasicBuild,
  mapLegacyNativeRetainedRouting,
  mapLegacyNativeRetainedSourceBind,
  mapLegacyNativeStorageAdoption,
} from "./native-config-import-plan.ts";
import {
  legacyRoutingStorageDocument,
  mapLegacyComposeRouting,
} from "./native-config-import-routing.ts";
import {
  type LegacyComposeSourceBindIntent,
  type LegacyComposeStorageIntent,
  mapLegacyComposeSourceBindStorage,
  mapLegacyComposeStorage,
} from "./native-config-import-storage.ts";

export type { LegacyComposeStorageIntent } from "./native-config-import-storage.ts";

export type LegacyComposeAdoptionPlan = {
  readonly report: {
    readonly report_version: 1;
    readonly supported: boolean;
    readonly adoption: "not_performed";
    readonly fields: readonly ImportField[];
  };
  /** Private authored identity intent, not resource ownership or a converted config. */
  readonly intent?: LegacyComposeStorageIntent | LegacyComposeSourceBindIntent;
};

function storageFields(
  fields: readonly ImportField[],
  mapping: {
    readonly supported: boolean;
    readonly accepted: ReadonlyMap<string, string>;
  }
): ImportField[] {
  if (!mapping.supported) {
    return [...fields];
  }
  return fields.map((field) => {
    if (field.document !== "compose") {
      return field;
    }
    const match = [...mapping.accepted].find(
      ([pointer]) =>
        field.pointer === pointer || field.pointer.startsWith(`${pointer}/`)
    );
    return match
      ? {
          ...field,
          status: "exact",
          code: "existing_storage_binding",
          target: match[1],
        }
      : field;
  });
}

/**
 * Closed authored prerequisite for existing local named volumes. Reuses the
 * import field report for all other fields, including inactive profiles. This
 * never produces a native candidate or claims complete conversion/adoption.
 * Unknown options and ambiguous identity/path mappings remain refused.
 */
export function planLegacyComposeAdoption(opts: {
  readonly configText: string;
  readonly composeText: string;
  readonly selectedComposeProject?: string;
}): LegacyComposeAdoptionPlan {
  const converted = mapLegacyNativeStorageAdoption(opts);
  let jobs = false;
  if (
    converted.candidate &&
    legacyComposeAdoptionCandidateSupported(converted.candidate)
  ) {
    jobs = legacyComposeRetainedPlan(converted.candidate).requiresV7 === true;
  }
  let mapper = mapLegacyNativeAdoptionBaseline;
  if (jobs) {
    mapper = mapLegacyNativeCompletedJobAdoptionBaseline;
  } else if (opts.selectedComposeProject) {
    mapper = mapLegacyNativeBranchStorageAdoption;
  }
  const baseline = mapper(opts);
  return plan(opts, baseline);
}

/** Pure closed build/storage intent only; the distinct source/image owner must still admit it. */
export function planLegacyComposeRetainedBasicBuildAdoption(opts: {
  readonly configText: string;
  readonly composeText: string;
}): LegacyComposeAdoptionPlan {
  return plan(opts, mapLegacyNativeRetainedBasicBuild(opts));
}

/** Separate v14 authored contract; mixed bind/build/job/branch families remain refused. */
export function planLegacyComposeRetainedRoutingAdoption(opts: {
  readonly configText: string;
  readonly composeText: string;
}): LegacyComposeAdoptionPlan {
  return plan(opts, mapLegacyNativeRetainedRouting(opts), "routing");
}

/** Closed static directory-binding family; still requires the separate issued path and engine owner. */
export function planLegacyComposeSourceBindAdoption(opts: {
  readonly configText: string;
  readonly composeText: string;
}): LegacyComposeAdoptionPlan {
  return plan(opts, mapLegacyNativeRetainedSourceBind(opts), "source-bind");
}

function plan(
  opts: {
    readonly configText: string;
    readonly composeText: string;
    readonly selectedComposeProject?: string;
  },
  baseline: ReturnType<typeof mapLegacyNativeAdoptionBaseline>,
  family: "ordinary" | "routing" | "source-bind" = "ordinary"
): LegacyComposeAdoptionPlan {
  const config = parseImportDocument({
    text: opts.configText,
    document: "config",
  }).value;
  const compose = parseImportDocument({
    text: opts.composeText,
    document: "compose",
  }).value;
  const routingFamily = family === "routing";
  const sourceBind = family === "source-bind";
  const routing = routingFamily
    ? mapLegacyComposeRouting({ config, compose })
    : undefined;
  const qualified = sourceBind
    ? mapLegacyComposeSourceBindStorage({ config, compose })
    : mapLegacyComposeStorage({
        config,
        compose:
          routing && compose ? legacyRoutingStorageDocument(compose) : compose,
        selectedComposeProject: opts.selectedComposeProject,
      });
  const mapping = {
    supported:
      qualified !== undefined && (!routingFamily || routing !== undefined),
    accepted: qualified?.accepted ?? new Map<string, string>(),
  };
  const intent = qualified
    ? { ...qualified.intent, ...(routing ? { routing: routing.intent } : {}) }
    : undefined;
  const fields = storageFields(baseline.report.fields, mapping);
  const supported =
    mapping.supported && !fields.some((field) => field.status === "refused");
  if (!(supported || fields.some((field) => field.status === "refused"))) {
    fields.push({
      document: "compose",
      pointer: "",
      line: 1,
      column: 1,
      status: "refused",
      code: "explicit_identity_and_owned_storage_required",
    });
  }
  const result: LegacyComposeAdoptionPlan = {
    report: { report_version: 1, supported, adoption: "not_performed", fields },
  };
  if (supported && intent) {
    freezeImportValue(intent);
    Object.defineProperty(result, "intent", { value: intent });
  }
  freezeImportValue(result.report);
  return Object.freeze(result);
}
