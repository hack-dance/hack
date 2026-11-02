import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import { legacyComposeRoutingResolutionMatches } from "./native-compose-adoption-routing-resolution.ts";
import { hasCode } from "./native-compose-private-state.ts";
import {
  NativeConfigCompilerError,
  resolveNativeConfig,
} from "./native-config-compiler.ts";
import {
  type NativeConfigImportInputs,
  privateNativeConfigImportLocalInput,
  readNativeConfigImportSourceFile,
} from "./native-config-import-inputs.ts";
import {
  type ImportField,
  parseImportDocument,
} from "./native-config-import-parser.ts";
import { freezeImportValue } from "./native-config-import-plan.ts";
import type { LegacyComposeRoutingIntent } from "./native-config-import-routing.ts";
import type { NativeRoutingResolution } from "./native-routing-plan-protocol.ts";

type Source = Extract<NativeConfigImportInputs, { readonly ok: true }>;
type Role = "primary_local" | "checkout_local";
const localRefusals = new WeakMap<object, readonly ImportField[]>();

function refuse(): never {
  throw new Error(
    "Legacy adoption typed local input refused: inputs are unsupported, unsafe or changed; values omitted."
  );
}
function refuseFields(fields: readonly ImportField[]): never {
  const error = new Error(
    "Legacy adoption typed local input refused: inputs are unsupported, unsafe or changed; values omitted."
  );
  freezeImportValue(fields);
  Object.freeze(error);
  localRefusals.set(error, fields);
  throw error;
}
/** Only module-issued redacted diagnostics survive private owner error translation. */
export function retainLegacyAdoptionLocalRefusal(error: unknown): void {
  if (typeof error === "object" && error !== null && localRefusals.has(error)) {
    throw error;
  }
}
/** Public provenance only; forged errors cannot introduce text or diagnostic authority. */
export function legacyAdoptionLocalRefusalFields(
  error: unknown
): readonly ImportField[] {
  return typeof error === "object" && error !== null
    ? (localRefusals.get(error) ?? [])
    : [];
}
function encodedLocal(text: string | null | undefined) {
  return text == null ? undefined : new TextEncoder().encode(text);
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Legacy adoption typed local acquisition was cancelled; values omitted."
    );
  }
}

/** Strict syntax and closed first-slice fields, including fields shadowed by a later layer. Values stay private. */
export function mapLegacyAdoptionLocalInput(opts: {
  readonly text: string;
  readonly document: Role;
  readonly retainedRouting?: boolean;
}) {
  const parsed = parseImportDocument(opts);
  const value = parsed.value;
  if (!value) {
    return Object.freeze({ complete: false, fields: parsed.fields });
  }
  const environment = value?.environment;
  const valid =
    value !== undefined &&
    value.schema_version === 1 &&
    Object.keys(value).every(
      (key) =>
        key === "schema_version" ||
        key === "environment" ||
        (opts.retainedRouting === true && (key === "routes" || key === "open"))
    ) &&
    (environment === undefined ||
      (isRecord(environment) &&
        Object.keys(environment).every((key) => key === "default_overlay") &&
        (!Object.hasOwn(environment, "default_overlay") ||
          environment.default_overlay === null ||
          typeof environment.default_overlay === "string"))) &&
    (!Object.hasOwn(value, "routes") ||
      (opts.retainedRouting === true &&
        isRecord(value.routes) &&
        Object.keys(value.routes).every((key) => key === "domain") &&
        (!Object.hasOwn(value.routes, "domain") ||
          typeof value.routes.domain === "string"))) &&
    (!Object.hasOwn(value, "open") ||
      (opts.retainedRouting === true &&
        isRecord(value.open) &&
        Object.keys(value.open).every((key) => key === "prefer") &&
        (!Object.hasOwn(value.open, "prefer") ||
          ["auto", "alias", "dev"].includes(String(value.open.prefer)))));
  const fields: readonly ImportField[] = parsed.fields.map((field) => ({
    ...field,
    status: valid ? "exact" : "refused",
    code: valid
      ? "unchanged_legacy_selection_required"
      : "local_input_outside_lossless_slice",
    ...(valid ? { target: field.pointer } : {}),
  }));
  const reported = fields.length
    ? fields
    : [
        {
          document: opts.document,
          pointer: "",
          line: 1,
          column: 1,
          status: "refused" as const,
          code: "local_schema_version_required",
        },
      ];
  return Object.freeze({ complete: valid, fields: Object.freeze(reported) });
}

/** Resolve raw local documents through the existing compiler, before keys or managed-value acquisition. Only an unchanged legacy selection qualifies. */
export async function resolveLegacyAdoptionLocalInputs(opts: {
  readonly source: Source;
  readonly primary: Source | null;
  readonly candidate: Record<string, unknown>;
  readonly overlay: string | null;
  readonly binary?: string;
  readonly signal?: AbortSignal;
  readonly routing?: LegacyComposeRoutingIntent;
}) {
  const routing = opts.routing;
  check(opts.signal);
  const checkout = privateNativeConfigImportLocalInput(opts.source);
  const primary = opts.primary
    ? privateNativeConfigImportLocalInput(opts.primary)
    : undefined;
  const fields: ImportField[] = [];
  for (const [document, input] of [
    ["primary_local", primary],
    ["checkout_local", checkout],
  ] as const) {
    if (input?.text != null) {
      const mapped = mapLegacyAdoptionLocalInput({
        text: input.text,
        document,
        retainedRouting: routing !== undefined,
      });
      if (!mapped.complete) {
        refuseFields(mapped.fields);
      }
      fields.push(...mapped.fields);
    }
  }
  const present = checkout?.text != null || primary?.text != null;
  let routingResolution: NativeRoutingResolution | undefined;
  if (present || routing) {
    const resolved = await resolveNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(opts.candidate)),
      primaryLocal: encodedLocal(primary?.text),
      checkoutLocal: encodedLocal(checkout?.text),
      binary: opts.binary,
      signal: opts.signal,
      requireRoutingPlanning: routing !== undefined,
    });
    if (
      !resolved.ok ||
      resolved.local_resolution.overlay !== opts.overlay ||
      (routing &&
        !legacyComposeRoutingResolutionMatches({
          routing,
          resolution: resolved.routing_resolution,
        }))
    ) {
      refuseFields(
        fields.map((field) => ({
          ...field,
          status: "refused",
          code: "local_selection_would_change_legacy",
        }))
      );
    }
    if (resolved.ok) {
      routingResolution = resolved.routing_resolution;
    }
  }
  await opts.source.assertFresh({ signal: opts.signal });
  await opts.primary?.assertFresh({ signal: opts.signal });
  check(opts.signal);
  const result = {
    fields,
    routingResolution,
    proof: present
      ? { checkout: checkout?.proof ?? null, primary: primary?.proof ?? null }
      : undefined,
  };
  for (const [key, value] of Object.entries(result)) {
    freezeImportValue(value);
    Object.defineProperty(result, key, { enumerable: false });
  }
  return Object.freeze(result);
}

/** Recheck held local presence, bytes and full file identity without resolving keys or values. The durable owner supplies exact current Git/directory authority. */
async function assertCheckoutLocal(opts: {
  readonly projectRoot: string;
  readonly proof: unknown;
  readonly signal?: AbortSignal;
  readonly retainedRouting?: boolean;
}) {
  const proof = opts.proof;
  const path = join(opts.projectRoot, ".hack/hack.local.json");
  const entry = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    refuse();
  });
  if (proof === null) {
    if (entry !== null) {
      refuse();
    }
  } else {
    if (
      !(isRecord(proof) && isRecord(proof.info)) ||
      Object.keys(proof).sort().join(",") !== "hash,info"
    ) {
      refuse();
    }
    const current = await readNativeConfigImportSourceFile({
      path,
      signal: opts.signal,
    });
    const info = current.info;
    if (
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      JSON.stringify({
        hash: createHash("sha256").update(current.bytes).digest("hex"),
        info: {
          dev: info.dev,
          ino: info.ino,
          mode: info.mode,
          nlink: info.nlink,
          uid: info.uid,
        },
      }) !== JSON.stringify(proof)
    ) {
      refuse();
    }
    if (
      !mapLegacyAdoptionLocalInput({
        text: new TextDecoder("utf-8", { fatal: true }).decode(current.bytes),
        document: "checkout_local",
        retainedRouting: opts.retainedRouting,
      }).complete
    ) {
      refuse();
    }
  }
}

/** Key-free raw local recheck; exact directory and Git-family authority belongs to the saved generation owner. */
export async function assertSavedLegacyAdoptionLocalInputs(opts: {
  readonly projectRoot: string;
  readonly primary: Source | null;
  readonly proof: unknown;
  readonly signal?: AbortSignal;
  readonly checkOwner: () => Promise<void>;
  readonly retainedRouting?: boolean;
}) {
  check(opts.signal);
  const proof = opts.proof;
  if (
    !isRecord(proof) ||
    Object.keys(proof).sort().join(",") !== "checkout,primary" ||
    (proof.checkout === null && proof.primary === null)
  ) {
    refuse();
  }
  await opts.checkOwner();
  await assertCheckoutLocal({
    projectRoot: opts.projectRoot,
    proof: proof.checkout,
    signal: opts.signal,
    retainedRouting: opts.retainedRouting,
  });
  const primary = opts.primary
    ? privateNativeConfigImportLocalInput(opts.primary)
    : undefined;
  if (
    primary?.text != null &&
    !mapLegacyAdoptionLocalInput({
      text: primary.text,
      document: "primary_local",
      retainedRouting: opts.retainedRouting,
    }).complete
  ) {
    refuse();
  }
  if (
    JSON.stringify(primary?.proof ?? null) !== JSON.stringify(proof.primary)
  ) {
    refuse();
  }
  await opts.primary?.assertFresh({ signal: opts.signal });
  await opts.checkOwner();
  check(opts.signal);
}
