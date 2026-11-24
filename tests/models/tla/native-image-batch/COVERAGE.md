# Native image batch

[State chart](image-batch.svg)

Four distinct image jobs share three workers, an archive coordinator and one
importer. A failed fetch or import prevents graph start. Cancel stops the
workers and preserves an in-flight import as unknown until reconciliation.
TLC explores 3,233 states. Removing importer exclusion violates `Safe` when any
two jobs are importing at the same time. The verifier checks their phases and
verified archives in the final state, including when either remaining job has
finished or failed.

| Model action | Runtime transition |
| --- | --- |
| Fetch | `image_ensure::ensure_batch` takes a job, and `ensure_pinned_coordinated` reserves cache capacity before acquisition. |
| Archive | The existing registry verification writes a private archive. The cache coordinator checks the receipt and publishes the complete entry under the cache lease. |
| Import / Confirm | One worker takes the importer mutex, then the existing loader checks and takes the provider lease as needed. Tag publication follows guest confirmation. |
| Fail / Start | Every completed job returns a result. The frontend refuses graph startup if any result fails. |
| Cancel | The frontend cancels its owned batch process. The next cache writer recovers owned staging under the same lease. The existing import journal fences an uncertain upload. |

The model abstracts byte budgets, tag locking, archive layout, multiple
commands, guest observation and filesystem crashes. The Rust overlap control
forces a second fetch to start before the first can finish, then fails the
second acquisition while the first imports. It checks cache cleanup and the
first archive's receipt.
