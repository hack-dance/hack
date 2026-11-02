import {
  encodeNativeComposeStorageXattrResponse,
  NATIVE_STORAGE_XATTR_INPUT_LIMIT,
  NATIVE_STORAGE_XATTR_KIND,
  NATIVE_STORAGE_XATTR_VERSION,
  type NativeComposeStorageXattrResponse,
  parseNativeComposeStorageXattrRequest,
  refuseNativeComposeStorageXattr,
} from "../src/lib/native-compose-storage-witness-xattr-codec.ts";
import { runNativeComposeStorageXattrHelper } from "../src/lib/native-compose-storage-witness-xattr-helper.ts";
import { createNativeComposeStorageXattrLinuxKernel } from "../src/lib/native-compose-storage-witness-xattr-linux.ts";

async function input(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > NATIVE_STORAGE_XATTR_INPUT_LIMIT) {
        await reader.cancel();
        return refuseNativeComposeStorageXattr();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks)
  );
}
function refused(): NativeComposeStorageXattrResponse {
  return {
    kind: NATIVE_STORAGE_XATTR_KIND,
    version: NATIVE_STORAGE_XATTR_VERSION,
    outcome: "refused",
  };
}
/** Bundling and exact artifact/ABI/engine qualification are prerequisites; this entry is never launched by the CLI. */
export async function nativeStorageWitnessHelperMain(): Promise<number> {
  let response = refused();
  let close: (() => void) | null = null;
  try {
    const request = parseNativeComposeStorageXattrRequest(await input());
    const selected = await createNativeComposeStorageXattrLinuxKernel();
    close = selected.close;
    response = runNativeComposeStorageXattrHelper({
      request,
      kernel: selected.kernel,
    });
  } catch {
    response = refused();
  } finally {
    if (close) {
      try {
        close();
      } catch {
        response = refused();
      }
    }
  }
  // The owner must force logging=none and capture this bounded response privately.
  try {
    await Bun.write(
      Bun.stdout,
      encodeNativeComposeStorageXattrResponse(response)
    );
  } catch {
    // A truncated private response is uncertain, not a successful helper proof.
    return 1;
  }
  return response.outcome === "refused" ? 1 : 0;
}
if (import.meta.main) {
  process.exitCode = await nativeStorageWitnessHelperMain();
}
