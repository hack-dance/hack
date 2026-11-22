# Native image presence
[State chart](image-presence.svg)

`Safe` requires fresh exact guest readback for a successful ensure, full
verification before upload, and archive verification before success for explicit
loads. `TrustReceipt` changes the readback action to allow success based on the
host-side receipt alone. The reachability control requires a cached success
without an archive read.

| Action | Runtime transition |
| --- | --- |
| `Begin` | `image_load::load_waiting` opens and verifies an explicit archive before connection; it delays opening an acquired cache archive. |
| `Readback` | The existing load receipt and live `inspect` decide reuse before the cache archive is opened. A foreign or unresolved intent refuses; an unknown engine result is distinct from absence. |
| `Verify` | `open_verified` and `validated` check the archive before upload. |
| `Reconcile`, `Upload` | `load_waiting` reads back before sending, sends with `HeldTail`, and reads back before publishing completion. |

One request, one archive, one provider lease and one engine boot. Exact image ID
and architecture checks are represented by the four guest observations. A
missing image after an earlier load and before the next request is reachable.
The model treats a receipt from a previous boot with unresolved intent like
an absent receipt for replay decisions. It abstracts away boot identity,
filesystem identity and adversarial file writes during verification or upload.
The runtime's explicit-load and streamed verification tests exercise those byte
checks independently. This check has no real VM or timing coverage.
