import { join } from "node:path";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { inspectComposeEnvOverrideAtRest } from "./compose-env-at-rest.ts";
import { acquireLegacyComposeAdoptionPreparationBinding } from "./native-compose-adoption-binding.ts";
import { admitLegacyComposeCandidate } from "./native-compose-adoption-compiler.ts";
import {
  legacyComposeAdoptionCandidateSupported,
  legacyComposeAdoptionLayoutSupported,
} from "./native-compose-adoption-contract.ts";
import { normalizeLegacyComposeRetainedFileCandidate } from "./native-compose-adoption-files.ts";
import { legacyAdoptionLocalRefusalFields } from "./native-compose-adoption-local.ts";
import {
  inspectLegacyComposeContainerStates,
  inspectLegacyComposeRuntimeConfig,
} from "./native-compose-adoption-runtime.ts";
import type { ImportField } from "./native-config-import-parser.ts";
import {
  freezeImportValue,
  mapLegacyNativeRetainedBasicBuild,
  mapLegacyNativeRetainedFileStorage,
  mapLegacyNativeRetainedSourceBind,
  mapLegacyNativeStorageAdoption,
} from "./native-config-import-plan.ts";

function refused(code: string): ImportField {
  return {
    document: "config",
    pointer: "",
    line: 1,
    column: 1,
    status: "refused",
    code,
  };
}
function report<T>(value: T): Readonly<T> {
  freezeImportValue(value);
  return Object.freeze(value);
}
/** Preview field code for a generated env override that holds literal values. */
export const LEGACY_ADOPTION_LITERAL_ENV_OVERRIDE_CODE =
  "generated_env_override_holds_values";

/**
 * True when `.hack/.internal/compose.env.override.yml` holds literal env
 * values written by an earlier Hack version. Adoption pins the file's bytes and
 * inode for the life of the adoption, so it must not bind such a file
 * (HACK-1273); `hack up` rewrites it with references first. Counts only.
 */
export async function legacyAdoptionEnvOverrideHoldsValues(opts: {
  readonly projectRoot: string;
}): Promise<boolean> {
  const state = await inspectComposeEnvOverrideAtRest({
    projectDir: join(opts.projectRoot, HACK_PROJECT_DIR_PRIMARY),
  });
  return state.kind === "plaintext";
}

/** Read-only exact existing-data preview; source values, resource names and digests never enter this report. */
export async function previewLegacyComposeAdoption(input: {
  readonly projectRoot: string;
  readonly binary?: string;
  readonly signal?: AbortSignal;
  readonly stop?: boolean;
}) {
  const opts = { ...input };
  let fields: readonly ImportField[] = [];
  try {
    if (await legacyAdoptionEnvOverrideHoldsValues(opts)) {
      return report({
        complete: false,
        adoption: "not_performed",
        fields: [refused(LEGACY_ADOPTION_LITERAL_ENV_OVERRIDE_CODE)],
      });
    }
    const owner = await acquireLegacyComposeAdoptionPreparationBinding(opts),
      acquired = await owner.resolvePreparationInputs(opts);
    let mapper = mapLegacyNativeStorageAdoption;
    if (acquired.fileProof) {
      mapper = mapLegacyNativeRetainedFileStorage;
    } else if (acquired.sourceBindProof) {
      mapper = mapLegacyNativeRetainedSourceBind;
    } else if (acquired.build) {
      mapper = mapLegacyNativeRetainedBasicBuild;
    }
    const mapped = mapper(acquired);
    fields = [
      ...mapped.report.fields,
      ...(acquired.projection?.localFields ?? []),
    ];
    const candidate = acquired.fileProof
      ? normalizeLegacyComposeRetainedFileCandidate({
          candidate: mapped.candidate,
          proof: acquired.fileProof,
          containers: acquired.binding.containers,
        })
      : (acquired.projection?.candidate ?? mapped.candidate);
    if (!candidate) {
      return report({
        complete: false,
        adoption: "not_performed",
        fields,
      });
    }
    if (
      !(
        (acquired.projection ||
          (await legacyComposeAdoptionLayoutSupported({
            ...opts,
            candidate,
          }))) &&
        legacyComposeAdoptionCandidateSupported(candidate)
      )
    ) {
      return report({
        complete: false,
        adoption: "not_performed",
        fields: [
          ...fields,
          refused("selection_outside_retained_container_slice"),
        ],
      });
    }
    const admitted = await admitLegacyComposeCandidate({
      candidateText: JSON.stringify(candidate),
      metadata: acquired.projection?.metadata,
      binary: opts.binary,
      signal: opts.signal,
    });
    if (!admitted) {
      return report({
        complete: false,
        adoption: "not_performed",
        fields: [...fields, refused("candidate_compiler_refused")],
      });
    }
    await inspectLegacyComposeRuntimeConfig({
      binding: acquired.binding,
      composeFile: acquired.binding.composeFile,
      privateInterpolationEnv: acquired.projection?.composeEnv,
      signal: opts.signal,
    });
    const states = await inspectLegacyComposeContainerStates({
      binding: acquired.binding,
      signal: opts.signal,
    });
    if (
      states.some(
        (state) =>
          (!opts.stop && state.running) ||
          state.paused ||
          !["created", "running", "exited"].includes(state.status)
      )
    ) {
      return report({
        complete: false,
        adoption: "not_performed",
        fields: [...fields, refused("original_containers_must_be_stopped")],
      });
    }
    await owner.assertFresh(opts);
    return report({
      complete: true,
      adoption: "not_performed",
      containers: acquired.binding.containers.length,
      volumes: acquired.binding.volumes.length,
      stop: opts.stop ? "requested" : "not_requested",
      fields,
    });
  } catch (error: unknown) {
    return report({
      complete: false,
      adoption: "not_performed",
      fields: [
        ...fields,
        ...legacyAdoptionLocalRefusalFields(error),
        refused("unsafe_changed_or_unavailable_binding"),
      ],
    });
  }
}
