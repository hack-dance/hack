import { isRecord } from "./guards.ts";
import {
  compileNativeConfig,
  planNativeConfig,
} from "./native-config-compiler.ts";
import type { NativeProjectEnvMetadata } from "./project-env-config.ts";

/** Private in-memory candidate admission. Managed planning carries names only and must preserve authored identity and workload selection. */
export async function admitLegacyComposeCandidate(opts: {
  readonly candidateText: string;
  readonly metadata?: NativeProjectEnvMetadata;
  readonly binary?: string;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const input = new TextEncoder().encode(opts.candidateText);
  const compiled = await compileNativeConfig({
    input,
    binary: opts.binary,
    signal: opts.signal,
  });
  if (!compiled.ok) {
    return false;
  }
  const metadata = opts.metadata;
  if (!metadata) {
    return true;
  }
  const candidate: unknown = JSON.parse(opts.candidateText);
  if (!(isRecord(candidate) && isRecord(candidate.services))) {
    return false;
  }
  const names = Object.keys(candidate.services).sort();
  const planned = await planNativeConfig({
    input,
    binary: opts.binary,
    signal: opts.signal,
    envMetadata: {
      metadata_version: 1,
      overlay: metadata.overlay,
      overlay_exists: metadata.overlayExists,
      workloads: Object.fromEntries(
        names.map((name) => [name, metadata.effectiveMetadata[name] ?? {}])
      ),
      inactive_scopes: metadata.unknownScopes,
    },
  });
  return (
    planned.ok &&
    planned.environment_plan.complete &&
    planned.semantic_hash === compiled.semantic_hash &&
    JSON.stringify(Object.keys(planned.declared_workloads).sort()) ===
      JSON.stringify(names) &&
    Object.values(planned.declared_workloads).every(
      (kind) => kind === "service"
    )
  );
}
