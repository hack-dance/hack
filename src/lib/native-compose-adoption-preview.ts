import { acquireLegacyComposeAdoptionBinding } from "./native-compose-adoption-binding.ts";
import {
  legacyComposeAdoptionCandidateSupported,
  legacyComposeAdoptionLayoutSupported,
} from "./native-compose-adoption-contract.ts";
import {
  inspectLegacyComposeContainerStates,
  inspectLegacyComposeRuntimeConfig,
} from "./native-compose-adoption-runtime.ts";
import { compileNativeConfig } from "./native-config-compiler.ts";
import type { ImportField } from "./native-config-import-parser.ts";
import {
  freezeImportValue,
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
    const owner = await acquireLegacyComposeAdoptionBinding(opts),
      acquired = await owner.resolvePreparationInputs(opts);
    const mapped = mapLegacyNativeStorageAdoption(acquired);
    fields = mapped.report.fields;
    const candidate = mapped.candidate;
    if (!candidate) {
      return report({
        complete: false,
        adoption: "not_performed",
        fields,
      });
    }
    if (
      !(
        (await legacyComposeAdoptionLayoutSupported({ ...opts, candidate })) &&
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
    const compiled = await compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(candidate)),
      binary: opts.binary,
      signal: opts.signal,
    });
    if (!compiled.ok) {
      return report({
        complete: false,
        adoption: "not_performed",
        fields: [...fields, refused("candidate_compiler_refused")],
      });
    }
    await inspectLegacyComposeRuntimeConfig({
      binding: acquired.binding,
      composeFile: acquired.binding.composeFile,
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
  } catch {
    return report({
      complete: false,
      adoption: "not_performed",
      fields: [...fields, refused("unsafe_changed_or_unavailable_binding")],
    });
  }
}
