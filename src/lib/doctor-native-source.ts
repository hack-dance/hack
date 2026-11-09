import {
  describeNativeSourceSize,
  type NativeSourceSize,
  nativeSourceSizeRemedy,
  readNativeSourceSize,
} from "../backends/native-project-source-size.ts";
import type {
  invokeNativeRuntime,
  NativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import { HackCliError } from "./cli-result.ts";

/** Doctor check id for the native source content limit. */
export const NATIVE_SOURCE_CHECK = "native source size";

/**
 * JSON payload: sizes and project-relative paths of the selected source, measured by
 * the runtime from metadata only (no file contents).
 */
export type NativeSourceReport = NativeSourceSize;

/**
 * Predict the native up source limit refusal (HACK-1965). Over the limit is a
 * warning that names the largest directories and files and both remedies; a failed
 * measurement is a warning too, because native up runs the same measurement first.
 */
export async function checkNativeSourceSize(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<{
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly nativeSource?: NativeSourceReport;
}> {
  let size: NativeSourceSize;
  try {
    size = await readNativeSourceSize(opts);
  } catch (error: unknown) {
    let detail = "Values omitted.";
    if (error instanceof HackCliError) {
      detail = `${error.code}: ${error.message}`;
    } else if (error instanceof Error) {
      detail = error.message;
    }
    return {
      name: NATIVE_SOURCE_CHECK,
      status: "warn",
      message: `Native source size could not be measured, so native up refuses before startup. ${detail}`,
    };
  }
  if (size.withinLimit) {
    return {
      name: NATIVE_SOURCE_CHECK,
      status: "ok",
      message: describeNativeSourceSize(size),
      nativeSource: size,
    };
  }
  return {
    name: NATIVE_SOURCE_CHECK,
    status: "warn",
    message: `${describeNativeSourceSize(size)} Native up and restart refuse source over the limit.${nativeSourceSizeRemedy(size)}`,
    nativeSource: size,
  };
}
