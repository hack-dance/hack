import {
  compileNativeConfig,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";
import { acquireNativeConfigImportInputs } from "./native-config-import-inputs.ts";
import type { ImportField } from "./native-config-import-parser.ts";
import {
  mapLegacyNativeImport,
  type NativeImportPlan,
  nativeImportResult,
} from "./native-config-import-plan.ts";

function refusedField(code: string): ImportField {
  return {
    document: "config",
    pointer: "",
    line: 1,
    column: 1,
    status: "refused",
    code,
  };
}

/**
 * Exact-root read-only preview. No draft, active input, engine, env/key or registry
 * operations. Complete private candidates go only to the matching pure Rust compiler
 * in memory. Stable reads and rechecks do not lock concurrent external editors.
 */
export async function previewNativeConfigImport(inputOpts: {
  readonly projectRoot: string;
  readonly binary?: string;
  readonly signal?: AbortSignal;
}): Promise<NativeImportPlan> {
  const { binary, signal } = inputOpts;
  const root = inputOpts.projectRoot;
  try {
    const inputs = await acquireNativeConfigImportInputs({
      projectRoot: root,
      signal,
    });
    if (!inputs.ok) {
      return nativeImportResult({ fields: [refusedField(inputs.code)] });
    }
    const mapped = mapLegacyNativeImport({
      configText: inputs.configText,
      composeText: inputs.composeText,
    });
    let result = mapped;
    if (mapped.candidate) {
      const compiled = await compileNativeConfig({
        input: new TextEncoder().encode(JSON.stringify(mapped.candidate)),
        binary,
        signal,
      });
      if (!compiled.ok) {
        // Compiler output/plans and partial candidates never enter a public report.
        result = nativeImportResult({
          fields: [
            ...mapped.report.fields,
            refusedField("candidate_compiler_refused"),
          ],
        });
      }
    }
    await inputs.assertFresh({ signal });
    return result;
  } catch (error: unknown) {
    if (
      error instanceof NativeConfigCompilerError &&
      error.code === "E_COMPILER_CANCELLED"
    ) {
      throw error;
    }
    return nativeImportResult({
      fields: [refusedField("unsafe_changed_or_unavailable_input")],
    });
  }
}
