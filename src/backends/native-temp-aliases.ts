import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

interface AliasSweep {
  readonly dangling: readonly string[];
  readonly removed: readonly string[];
  readonly incomplete: boolean;
}

const aliasName = /^hkl-[0-9a-f]{12}$/u;

function isAliasList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (name: unknown) => typeof name === "string" && aliasName.test(name)
    )
  );
}

export async function inspectTempAliases(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly fix: boolean;
}): Promise<AliasSweep> {
  const result = await invokeNativeRuntime({
    runtime: opts.runtime,
    cwd: opts.cwd,
    args: ["runtime", "temp-aliases", ...(opts.fix ? ["--fix"] : []), "--json"],
    timeoutMs: 3000,
  });
  if (
    isRecord(result) &&
    isAliasList(result.dangling) &&
    isAliasList(result.removed) &&
    typeof result.incomplete === "boolean"
  ) {
    return {
      dangling: result.dangling,
      removed: result.removed,
      incomplete: result.incomplete,
    };
  }
  return { dangling: [], removed: [], incomplete: true };
}
