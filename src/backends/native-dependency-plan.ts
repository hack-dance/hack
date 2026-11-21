/**
 * The host dependency plan ID of a graph with no host dependency bindings.
 *
 * `graph dependency-plan` hashes the reviewed selection file the CLI wrote
 * together with the captured listener evidence of each binding. With no
 * bindings there is no host evidence to capture, so the ID depends only on
 * the bytes the CLI itself chose (plan, relay artifact path and digest), and
 * the CLI computes it instead of starting a runtime process for it.
 *
 * Contract with `packages/runtime-core/src/graph_cli/relay.rs`
 * (`Selection::capture`): SHA-256 of the compact serde_json encoding of
 * `("hack-graph-dependencies-v1", selection, evidence)`, with the selection's
 * fields in declaration order and an empty evidence list. `graph serve`
 * recomputes the digest from the same file and refuses a mismatch, so a drift
 * between the two encodings fails closed (the start is refused before any
 * service starts); it never admits an unreviewed selection.
 * `tests/native-dependency-plan.test.ts` pins golden vectors.
 */
export function emptyNativeDependencyPlanId(selection: {
  readonly plan: string;
  readonly artifact: string;
  readonly artifactSha256: string;
}): string {
  // Key order is the Rust struct's field order; JSON.stringify and serde_json
  // escape strings the same way for every UTF-8 path.
  const bytes = JSON.stringify([
    "hack-graph-dependencies-v1",
    {
      version: 1,
      plan: selection.plan,
      artifact: selection.artifact,
      artifact_sha256: selection.artifactSha256,
      dependencies: [],
    },
    [],
  ]);
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
