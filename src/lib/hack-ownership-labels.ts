/**
 * Container, network and volume label namespaces that Hack writes to prove
 * which resources it owns. This list is the single source of truth for those
 * namespaces: every `io.hack*` label key that Hack's TypeScript or the Rust
 * runtime-core writes or verifies starts with one of them, and a test scans
 * both source trees to keep this list complete and free of stale entries.
 *
 * - `io.hack-local.`: native runtime graph ownership (`owner`, `graph`,
 *   `namespace`, `plan`, `kind`, `resource`, `job`, cache and probe labels),
 *   which the runtime-core provider writes and verifies before cleanup.
 * - `io.hack.native-config.`: native-config Compose ownership (`version`,
 *   `instance`, `owner`, `generation`, `workload`, `storage`), which the
 *   native-config renderer writes and its generation inventory, route owner
 *   and storage witness verify.
 * - `io.hack.native-file.`: native-config VM file ownership (`owner`,
 *   `generation`, `token`, `role`).
 * - `io.hack.storage-witness.`: native-config storage witness carriers
 *   (`owner`, `generation`, `helper`, `carrier`).
 *
 * A project must not declare a label in these namespaces, because their
 * consumers trust them as ownership evidence. The TypeScript Compose
 * classifier rejects them, and runtime-core's own label review rejects them
 * again from a Rust mirror of this list
 * (`packages/runtime-core/src/project/compose/ownership_labels.rs`) that the
 * same test keeps identical. Add a namespace here, and to the mirror, before
 * writing a label in it.
 */
export const HACK_OWNERSHIP_LABEL_NAMESPACES = [
  "io.hack-local.",
  "io.hack.native-config.",
  "io.hack.native-file.",
  "io.hack.storage-witness.",
] as const;
