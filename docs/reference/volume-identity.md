# Volume identity after cache quarantine

Docker's local driver derives volume `CreatedAt` from the modification time of
the directory containing `_data`. Creating `hack-quarantine` beside `_data`
changes that timestamp without replacing the volume. Graph volume identity is
therefore the other inspected fields plus the guest-observed `_data` device/inode.
Inspection and directory observation failures must refuse without claiming that
replacement was observed.

## Audit (HACK-1353)

The audit covers `packages/runtime-core/src` and `src`, including whole-inspection
equality as well as explicit `CreatedAt`, `created_at`, and `createdAt` comparisons.

| Consumer | Identity or quarantine exclusion |
| --- | --- |
| `graph/cache_quarantine.rs` | Shared stable inspection and `_data` identity. `volume_created` remains evidence in the reviewed selection digest, never incarnation identity. |
| `graph/host_pin_recovery.rs` | Retained-volume projections capture and compare stable inspection plus `_data` identity. |
| `graph/absent_publication_cleanup.rs` | Captures the same projection; host-pin verification checks it before cleanup effects. |
| `graph/restore.rs` | Restore generation binds stable inspection digest and `_data` identity. |
| `graph/source_device_rebind.rs`, `graph/quiescent_dependency_recovery.rs` | Consume restore's retained-volume selection; source-device rebind also uses host-pin projections. |
| `graph/foreground/retained_data.rs` | Removal intents persist and recheck stable inspection plus `_data` identity, including retry after partial removal. |
| `graph/volume_subpaths.rs` | Preparation records compare stable inspection. The guest preparation script checks the recorded `_data` identity for both pending and completed records. |
| `graph/interrupted_start_cleanup.rs` | Checks only that the observed timestamp is nonempty, not equality with a recorded timestamp. Quarantine changes the value but does not remove it. Cache provenance verification is conditional on dependency-cache resources. |
| `graph/cache_provenance.rs` | Dependency-cache identity still includes the timestamp. Quarantine admission explicitly rejects `resource.cache.is_some()`, so it cannot touch these volumes. The admission regression covers this refusal. |
| `graph/native/persistent_data.rs` and its enrollment, witnessed and engine modules | The separate native persistent protocol uses `hkp-` volumes. The graph receipt loader accepts ordinary volumes only under its run-specific `hkg-` prefix (or validated dependency-cache names). These enrollments cannot enter graph cache quarantine. |
| `src/backends/native-authored-persistent-data-protocol.ts` | Codec for that separate native persistent enrollment; same exclusion. |
| `src/lib/native-compose-retained-storage.ts`, `native-compose-ownership.ts` | Timestamp fences for Compose-managed volumes. These use Compose ownership labels and declarations, not graph receipt-owned volumes. Graph inspection requires graph ownership labels and run-scoped names, so it cannot quarantine these resources. |
| `src/lib/native-compose-adoption-binding.ts` | Volume birth facts and whole-inventory comparisons apply to Compose adoption; same ownership exclusion. Container and network birth facts are not volume identities. |
| `src/lib/native-compose-storage-witness-docker-inventory.ts`, `native-compose-storage-witness-xattr-carrier.ts` | Target volume birth facts belong to the Compose storage-witness protocol; same exclusion. Carrier `createdAt` facts in the Docker adapter and carrier journal identify containers, not volumes. |
| `src/lib/native-compose-vm-file-owner.ts` | Compares inspection facts for its separately labeled private material volume, not graph application volumes; graph ownership inspection cannot admit it. |
| Graph native test helpers under `foreground/native_test/` and `shutdown/native_test/` | Timestamp assertions check that scenarios without quarantine leave retained volumes unchanged. They do not authorize production effects. Quarantine regressions instead expect the timestamp to change. |

Other creation timestamps in `src` describe branches, tokens, jobs, containers,
images or networks, not Docker volume identity.

## Verification and compatibility

The portable quarantine orchestration regression runs the production guest scripts
against a fixture volume whose inspection timestamp follows the volume directory's
mtime. After quarantine, it exercises the production projection selection and
verification shared by host-pin and absent-publication recovery, restore's selection
(also consumed by rebind and quiescent recovery), retained-removal comparison, and
persisted subpath preparation with the guest's existing-directory check. It also
rejects a recreated `_data` directory and changed stable metadata. This is synthetic
provider evidence, not native transport or complete host-recovery qualification.

Post-effect inspect and directory-identity script failures return
`graph_cache_quarantine_unobserved`; actual observed replacement, absence or changed
metadata returns `graph_cache_quarantine_unsettled`. Both retain the pending record
for explicit resume or resolution. Tests cover both move and resolution effects.

Old host-pin/removal projections without a recorded directory identity cannot be
safely upgraded from current observations and continue to refuse. Old restore or
rebind selections containing a timestamp instead of the stable inspection digest
also refuse; they are not silently rebound. Existing subpath preparation records
already contain a directory identity and accept a timestamp-only change.

The native host gate remains deferred to a later approved host run owned by Kit.
