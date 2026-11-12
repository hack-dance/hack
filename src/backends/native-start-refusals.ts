import { isRecord } from "../lib/guards.ts";
import { nativeFailureDetail } from "./native-runtime-client.ts";

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export type NativeStartRefusal = {
  readonly code: string;
  readonly message?: string;
  readonly service?: string;
};

/** Shared, value-free decoding for read-only preflight and pre-boot admission. */
export function readNativeStartRefusals(
  value: unknown,
  services: readonly string[]
): readonly NativeStartRefusal[] | null {
  if (!Array.isArray(value) || value.length > 4096) {
    return null;
  }
  const result: NativeStartRefusal[] = [];
  for (const refusal of value) {
    if (
      !isRecord(refusal) ||
      typeof refusal.code !== "string" ||
      !CODE.test(refusal.code)
    ) {
      return null;
    }
    const detail = nativeFailureDetail(refusal);
    result.push({
      code: refusal.code,
      ...(detail.message ? { message: detail.message } : {}),
      ...(detail.service && services.includes(detail.service)
        ? { service: detail.service }
        : {}),
    });
  }
  return result;
}
