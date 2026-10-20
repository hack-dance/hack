import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const KINDS = new Set(["docker_hub", "image_id"]);

/** Admission is pure in the runtime, so each request is short and bounded. */
const ADMISSION_TIMEOUT_MS = 10_000;

function refused(): Error {
  return new Error(
    "Native project image reference refused before runtime startup: use a public Docker Hub reference (shorthand such as alpine:3.21 is accepted) or a sha256 image ID; no VM, provider or image acquisition was started."
  );
}

/**
 * Admit every authored service image before any VM, provider or image effect.
 *
 * The native runtime owns reference normalization (`runtime admit-image`), so
 * this adapter only collects distinct references and checks the closed response.
 * Content IDs need no registry and are not sent. Admission does not pin or
 * rewrite images: acquisition later re-normalizes with the same runtime rule.
 * A refusal or malformed response throws a value-free error; other runtime
 * request failures propagate unchanged.
 */
export async function admitNativeProjectImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly specs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const references = new Set<string>();
  for (const spec of Object.values(opts.specs)) {
    if (typeof spec.image !== "string") {
      throw refused();
    }
    if (!IMAGE_ID.test(spec.image)) {
      references.add(spec.image);
    }
  }
  for (const reference of references) {
    if (opts.signal?.aborted) {
      throw refused();
    }
    let admitted: unknown;
    try {
      admitted = await invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: ["runtime", "admit-image", "--reference", reference, "--json"],
        timeoutMs: ADMISSION_TIMEOUT_MS,
        signal: opts.signal,
      });
    } catch (error) {
      // A reference refusal gets actionable guidance; any other runtime failure
      // (missing binary, timeout, cancellation) keeps its own closed diagnostic.
      if (
        error instanceof NativeRuntimeRequestError &&
        error.nativeCode === "registry_image"
      ) {
        throw refused();
      }
      throw error;
    }
    if (
      !(
        isRecord(admitted) &&
        typeof admitted.reference === "string" &&
        typeof admitted.kind === "string" &&
        KINDS.has(admitted.kind)
      )
    ) {
      throw refused();
    }
  }
}
