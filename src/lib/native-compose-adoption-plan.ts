import { legacyComposeAdoptionCandidateSupported } from "./native-compose-adoption-contract.ts";
import { legacyComposeRetainedPlan } from "./native-compose-adoption-readiness.ts";
import {
  type ImportField,
  parseImportDocument,
} from "./native-config-import-parser.ts";
import {
  freezeImportValue,
  mapLegacyNativeAdoptionBaseline,
  mapLegacyNativeRetainedBasicBuild,
  mapLegacyNativeCompletedJobAdoptionBaseline,
  mapLegacyNativeStorageAdoption,
} from "./native-config-import-plan.ts";
import {
  type LegacyComposeStorageIntent,
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
  readonly intent?: LegacyComposeStorageIntent;
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
}): LegacyComposeAdoptionPlan {
  const converted = mapLegacyNativeStorageAdoption(opts);
  let jobs = false;
  if (
    converted.candidate &&
    legacyComposeAdoptionCandidateSupported(converted.candidate)
  ) {
    jobs = legacyComposeRetainedPlan(converted.candidate).requiresV7 === true;
  }
  const baseline = jobs
    ? mapLegacyNativeCompletedJobAdoptionBaseline(opts)
    : mapLegacyNativeAdoptionBaseline(opts);
  return plan(opts, baseline);
}

/** Pure closed build/storage intent only; the distinct source/image owner must still admit it. */
export function planLegacyComposeRetainedBasicBuildAdoption(opts: {
  readonly configText: string;
  readonly composeText: string;
}): LegacyComposeAdoptionPlan {
  return plan(opts, mapLegacyNativeRetainedBasicBuild(opts));
}

function plan(
  opts: { readonly configText: string; readonly composeText: string },
  baseline: ReturnType<typeof mapLegacyNativeAdoptionBaseline>
): LegacyComposeAdoptionPlan {
  const config = parseImportDocument({
    text: opts.configText,
    document: "config",
  }).value;
  const compose = parseImportDocument({
    text: opts.composeText,
    document: "compose",
  }).value;
  const qualified = mapLegacyComposeStorage({ config, compose });
  const mapping = {
    supported: qualified !== undefined,
    accepted: qualified?.accepted ?? new Map<string, string>(),
  };
  const intent = qualified?.intent;
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
