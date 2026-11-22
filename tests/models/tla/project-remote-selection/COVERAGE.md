# Checkout remote selection

The finite model uses one checkout, two competing writers and two target names.
`Claim` reserves the selection writer lock and stages a choice. `Publish`
represents the atomic rename in `saveRemoteChoices`. `Crash` leaves the old
choice visible when a writer dies before publication. Readers can observe saved
state at every step. The negative control exposes a partial choice at `Claim`
when staging writes directly into the visible file.

`Start` takes an immutable snapshot of the published choice, including while
a writer is staging a new preference. If the writer publishes after that
snapshot, the choices can differ, and the new choice remains pending. The
model covers neither Docker effects nor filesystem crash durability.
Running-copy application adds a separate effect and recovery protocol.

TLC explored 22 distinct states. The negative control violated
`ReaderSeesWholeChoice` with `saved = "partial"` at `Claim`.

[State chart](state.svg) · [Mermaid source](state.mmd)
