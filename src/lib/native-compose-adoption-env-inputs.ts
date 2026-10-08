import { isRecord } from "./guards.ts";
import { legacyComposeAdoptionManagedReadLayoutSupported } from "./native-compose-adoption-contract.ts";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import {
  acquireNativeConfigImportInputs,
  isOwnedNativeConfigImportAcquisition,
  type NativeConfigImportInputs,
} from "./native-config-import-inputs.ts";
import { parseImportDocument } from "./native-config-import-parser.ts";
import { mapLegacyNativeStorageAdoption } from "./native-config-import-plan.ts";
import { acquireManagedProjectEnvFile } from "./native-project-inputs.ts";
import type { NativeProjectEnvSelectionOptions } from "./project-env-config.ts";
import {
  resolveVerifiedPrimaryWorktreeRoot,
  shouldInheritPrimaryLocalInputs,
} from "./worktree-local-config.ts";

const MANAGED_SUFFIX = /(?:\.local)?\.yaml$/;
const CONSTRUCTION_TOKEN = Symbol("legacy-adoption-managed-admission");
const ownedAdmissions = new WeakSet<object>();

type Source = Extract<NativeConfigImportInputs, { readonly ok: true }>;
type Context = {
  readonly source: Source;
  readonly primary: Source | null;
  readonly selection: NativeProjectEnvSelectionOptions;
  readonly ci: string | undefined;
  readonly mode: string | undefined;
};

function refuse(): never {
  throw new Error(
    "Legacy adoption managed input admission refused: selected sources are unsupported, unsafe or changed; values omitted."
  );
}
function redact(error: unknown): never {
  if (
    error instanceof NativeConfigCompilerError &&
    error.code === "E_COMPILER_CANCELLED"
  ) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Legacy adoption managed acquisition was cancelled; values omitted."
    );
  }
  refuse();
}

/**
 * Private, nonserialized source admission. Only this factory can construct a
 * capability, from an identity-verified strict import acquisition. It authorizes
 * managed-layer reads at the selected legacy root and verified inherited primary;
 * it grants no engine, write, native-family or effect authority. Captured sources,
 * selection and runner exclusions must remain fresh throughout the acquisition.
 */
export class LegacyAdoptionManagedEnvAdmission {
  readonly #context: Context;

  private constructor(context: Context, token: symbol) {
    if (token !== CONSTRUCTION_TOKEN) {
      refuse();
    }
    this.#context = Object.freeze(context);
    ownedAdmissions.add(this);
    Object.freeze(this);
  }

  static async acquire(opts: {
    readonly source: NativeConfigImportInputs;
    readonly signal?: AbortSignal;
  }): Promise<LegacyAdoptionManagedEnvAdmission> {
    try {
      if (
        !(isRecord(opts) && isOwnedNativeConfigImportAcquisition(opts.source))
      ) {
        refuse();
      }
      const source = opts.source;
      const signal = opts.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        refuse();
      }
      await source.assertFresh({ signal });
      const mapped = mapLegacyNativeStorageAdoption(source);
      const candidate = mapped.candidate;
      if (!(candidate && isRecord(candidate.services))) {
        refuse();
      }
      const inheritLocal = !(
        isRecord(candidate.worktree) &&
        candidate.worktree.inherit_local === false
      );
      const overlay =
        isRecord(candidate.environment) &&
        typeof candidate.environment.default_overlay === "string"
          ? candidate.environment.default_overlay
          : null;
      const selection = Object.freeze({
        projectRoot: source.projectRoot,
        overlay,
        inheritLocal,
        declaredWorkloadNames: Object.freeze(
          Object.keys(candidate.services).sort()
        ),
        signal,
      });
      const primaryRoot = shouldInheritPrimaryLocalInputs({ inheritLocal })
        ? await resolveVerifiedPrimaryWorktreeRoot(selection)
        : null;
      const primary = primaryRoot
        ? await acquireNativeConfigImportInputs({
            projectRoot: primaryRoot,
            signal,
          })
        : null;
      if (primary && !primary.ok) {
        refuse();
      }
      const context = {
        source,
        primary,
        selection,
        ci: process.env.CI,
        mode: process.env.HACK_EXECUTION_MODE,
      };
      const admission = new LegacyAdoptionManagedEnvAdmission(
        context,
        CONSTRUCTION_TOKEN
      );
      await admission.assertRoot(selection);
      return admission;
    } catch (error: unknown) {
      redact(error);
    }
  }

  get selection(): NativeProjectEnvSelectionOptions {
    if (!ownedAdmissions.has(this)) {
      refuse();
    }
    return this.#context.selection;
  }

  async assertRoot(opts: {
    readonly projectRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    try {
      if (!ownedAdmissions.has(this)) {
        refuse();
      }
      const context = this.#context;
      if (
        !isRecord(opts) ||
        (opts.projectRoot !== context.source.projectRoot &&
          opts.projectRoot !== context.primary?.projectRoot) ||
        process.env.CI !== context.ci ||
        process.env.HACK_EXECUTION_MODE !== context.mode
      ) {
        refuse();
      }
      await context.source.assertFresh(opts);
      await context.primary?.assertFresh(opts);
      if (!(await legacyComposeAdoptionManagedReadLayoutSupported(opts))) {
        refuse();
      }
      const primaryRoot = shouldInheritPrimaryLocalInputs(context.selection)
        ? await resolveVerifiedPrimaryWorktreeRoot({
            ...context.selection,
            signal: opts.signal,
          })
        : null;
      if (primaryRoot !== (context.primary?.projectRoot ?? null)) {
        refuse();
      }
    } catch (error: unknown) {
      redact(error);
    }
  }

  async acquireFile(opts: {
    readonly projectRoot: string;
    readonly filename: string;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array | undefined> {
    try {
      await this.assertRoot(opts);
      const bytes = await acquireManagedProjectEnvFile(opts);
      if (bytes !== undefined) {
        this.assertManagedDocument({ bytes, filename: opts.filename });
      }
      await this.assertRoot(opts);
      return bytes;
    } catch (error: unknown) {
      redact(error);
    }
  }

  /** Strict syntax/closed fields qualify the exact raw bytes before the shared owner parses them. */
  private assertManagedDocument(opts: {
    readonly bytes: Uint8Array;
    readonly filename: string;
  }): void {
    const parsed = parseImportDocument({
      text: new TextDecoder("utf-8", { fatal: true }).decode(opts.bytes),
      document: "compose",
    }).value;
    const environment = opts.filename
      .slice("hack.env.".length)
      .replace(MANAGED_SUFFIX, "");
    if (
      !parsed ||
      Object.keys(parsed).some(
        (key) =>
          !["version", "environment", "secretsprovider", "values"].includes(key)
      ) ||
      parsed.version !== 1 ||
      parsed.secretsprovider !== "project_key" ||
      (parsed.environment !== undefined &&
        parsed.environment !== environment &&
        !(environment === "local" && parsed.environment === "default")) ||
      !isRecord(parsed.values)
    ) {
      refuse();
    }
    for (const [scope, values] of Object.entries(parsed.values)) {
      if (
        !(
          (scope === "global" ||
            this.#context.selection.declaredWorkloadNames.includes(scope)) &&
          isRecord(values)
        )
      ) {
        refuse();
      }
      for (const value of Object.values(values)) {
        if (
          isRecord(value) &&
          (Object.keys(value).length !== 1 ||
            typeof value.secure !== "string" ||
            !value.secure.length)
        ) {
          refuse();
        }
      }
    }
  }
}

/** Runtime identity guard: TypeScript constructor privacy alone grants no authority. */
export function isOwnedLegacyAdoptionManagedEnvAdmission(
  input: unknown
): input is LegacyAdoptionManagedEnvAdmission {
  return (
    typeof input === "object" && input !== null && ownedAdmissions.has(input)
  );
}
