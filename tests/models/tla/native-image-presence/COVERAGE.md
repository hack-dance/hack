# Native image presence
[State chart](image-presence.svg)

`Safe` requires fresh exact guest readback for a successful ensure, full
verification before upload, and archive verification before success for explicit
loads. `TrustReceipt` changes the readback action to allow success based on the
host-side receipt alone. The reachability control requires a cached success
without an archive read.

`reads` counts full archive passes that hash content before an upload or a
success. `CachedSingleRead` requires at most one for a cached archive: import's
validation is its digest check. The `early-digest` control (`EarlyDigest`)
restores the separate hash a cached archive took before import and violates it
with two reads. The upload's re-read, which `HeldTail` checks block by block
against that validation, is not counted.

| Action | Runtime transition |
| --- | --- |
| `Expire`, `ChangeAvailability` | Record freshness and registry availability can change before selection. |
| `ResolveTag` | `image_tag_store::resolve` reads a fresh record, resolves the registry, falls back to an explicitly marked recorded resolution on registry refusal, or refuses without a usable record. |
| `Begin` | `image_load::load_waiting` hashes explicit archives (`open_verified`) before connection, the first of their two counted `reads`. `load_cached_with` verifies the registry configuration and delays opening an acquired archive. |
| `Readback` | `load_cached_with` requires digest-verified manifest metadata, a compatible completed receipt or an independently verified registry proof, and live lease-free `inspect` before skipping the archive read. A foreign or unresolved intent refuses; an unknown engine result is distinct from absence. Otherwise it opens the archive with `open_archive`, which checks the file but reads no bytes. |
| `Verify` | `import` runs `validated`, which hashes every byte against the archive SHA-256 while checking its structure, before upload. When a reused load receipt and live readback let `import` succeed without that pass, `check_digest` hashes an archive not yet hashed. Either is one counted read. |
| `Create` | The graph creates from the exact config digest. If the image disappeared after ensure, the engine refuses without a tag fallback. |
| `Reconcile`, `Upload` | `image_load::import` reads back before sending, sends with `HeldTail`, and reads back before publishing completion. |

One request, one archive, one provider lease and one engine boot. Exact image ID
and architecture checks are represented by the four guest observations. A
missing image after an earlier load and before the next request is reachable.
The model treats a receipt from a previous boot with unresolved intent like
an absent receipt for replay decisions. It abstracts away boot identity,
filesystem identity and adversarial file writes during verification or upload.
The model abstracts manifest and config digest checks as a verified binding.
A different recorded pin whose independently verified configuration matches
can take the archive verification path and establish a new binding.
The runtime's explicit-load and streamed verification tests exercise those byte
checks independently. This check has no real VM or timing coverage.


The tag extension allows a fresh record to expire and registry reachability to
change before resolution. It distinguishes explicit offline from forced
refresh and ordinary reuse. `TrustExpired` violates `TagSafe` when an ordinary
online command uses an expired record without attempting registry resolution.
Offline fallback requires verified live presence and cannot upload an archive.
It abstracts wall-clock and file durability, and does not model multiple
platform policies or several requests within one command.
