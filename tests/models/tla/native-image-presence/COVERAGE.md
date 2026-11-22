# Native image presence
[State chart](image-presence.svg)

`Safe` requires fresh exact guest readback for a successful ensure, full
verification before upload, and archive verification before success for explicit
loads. `TrustReceipt` changes the readback action to allow success based on the
host-side receipt alone. The reachability control requires a cached success
without an archive read.

| Action | Runtime transition |
| --- | --- |
| `Begin` | `image_load::load_waiting` verifies explicit archives before connection. `load_cached_with` verifies the registry configuration and delays opening an acquired archive. |
| `Readback` | `load_cached_with` requires digest-verified manifest metadata, a compatible completed receipt and live lease-free `inspect` before skipping the archive read. A foreign or unresolved intent refuses; an unknown engine result is distinct from absence. |
| `Verify` | `open_verified` and `validated` check the archive before upload. |
| `Create` | The graph creates from the exact config digest. If the image disappeared after ensure, the engine refuses without a tag fallback. |
| `Reconcile`, `Upload` | `image_load::import` reads back before sending, sends with `HeldTail`, and reads back before publishing completion. |

One request, one archive, one provider lease and one engine boot. Exact image ID
and architecture checks are represented by the four guest observations. A
missing image can occur before readback or between successful readback and create.
The model treats a receipt from a previous boot with unresolved intent like
an absent receipt for replay decisions. It abstracts away boot identity,
filesystem identity and adversarial file writes during verification or upload.
The model abstracts manifest and config digest checks as a verified binding.
A different recorded pin whose independently verified configuration matches
can take the archive verification path and establish a new binding.
The runtime's explicit-load and streamed verification tests exercise those byte
checks independently. This check has no real VM or timing coverage.
