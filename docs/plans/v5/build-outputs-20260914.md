# September 14, 2026 — Source builds and verified output reuse

The existing graph primitives now have a maintained build-output qualification fixture: a completed
Bun build service writes an owned artifact volume, and the web service consumes it read-only.
The live fixture compiled TypeScript, served 200 checked responses, and restored new compute using
the same verified bundle and SQLite token. This adds application-build evidence without adding a
second build engine or claiming Dockerfile/dependency-install support.

## Runnable fixture and output contract

Source is in `tests/fixtures/source-build/`; regression tests are
`tests/runtime-build-output.test.ts`. The four-service graph is build → init → web → check.
The build service has no network, 512 MiB RAM and one CPU. Other services have 256 MiB and half a
CPU each. The graph uses one private network, separate artifact/data volumes, read-only roots,
verified immutable source mounts, and the pinned Bun 1.3.14 Linux arm64 image.

The fixture's build identity includes its declared source files, Bun version, target and image
contract. One bundle, limited to 1 MiB, is staged under `pending`; files and directory state are
flushed before activation by rename. Consumers start only after the producer succeeds and verify
the expected identity, exact inventory, size and SHA-256 before loading the bundle. Restore reuses
only verified output; corrupt output is refused rather than overwritten. Pending/foreign output
is retained and prevents a retry from silently adopting it. The read-only consumer mount is the
runtime write boundary; the producer remains a trusted single writer within this owned fixture.

The fixture helper is not a general artifact service or hostile-writer sandbox. Named volumes do
not gain a general disk quota. The controlled producer limits its published bundle; arbitrary
build scripts, dependencies, multi-output manifests, cross-project cache reuse and GC need separate
contracts. The interruption test injects an error after staging a bundle and before its manifest;
it is not a process-kill or physical-power-loss qualification.

Run focused tests with the repository-pinned Bun:

```sh
mise exec bun@1.3.9 -- bun test tests/runtime-build-output.test.ts
```

The manual runner requires a prepared, stopped candidate and the exact previously qualified image
archive. It copies the fixture outside the candidate checkout, preserves raw evidence and failed
attempts, watches host pressure/swap/headroom, cleans only its owned graph resources and stops the VM:

```sh
python3 scripts/test-hack-local-build-output.py --run-live \
  --image-archive /absolute/path/to/qualified/image.tar \
  --protected-project /absolute/path/to/captured/application
```

## Live outcomes and costs

| Case | Result |
| --- | --- |
| Build and serve | Compiled 501-byte bundle; init completed, web healthy, 200 HTTP checks |
| Ordinary cleanup and restore | New compute IDs, verified artifact reuse, same bundle hash and database token |
| Actual TypeScript syntax error | Build failed; init/web/check containers absent |
| Injected failure before manifest publication | Build failed; init/web/check containers absent |
| Artifact tampered before reuse | Restore failed verification; init/web/check containers absent |
| Explicit cleanup | Every case's graph containers, network and volumes absent; evidence archived |

The successful case recorded these **single observations**, not a benchmark distribution:

| Build/output phase | Elapsed | Process CPU consumed | Process RSS afterward |
| --- | --- | --- | --- |
| Compile and publish | 9.49 ms | 7.61 ms | 45.52 MiB |
| Verify and reuse | 3.10 ms | 3.51 ms | 42.48 MiB |

CPU is the build process's user+system delta from input fingerprinting through output verification;
module startup, container lifecycle and VM overhead are outside that interval. RSS is an end-of-phase
snapshot, not peak usage or whole-provider memory. These observations do not establish a Docker or
stable-Hack comparison. Input hashing also now allocates file-sized buffers plus one growth-detection
byte, about 9 KiB for the fixture's source set, instead of eight 1 MiB buffers. That allocation change
preserves the size/change checks but is not a measured whole-runtime memory reduction.

## Evidence and limits

The completed run is `.hack-local/review/wu07/build-output-1789420823216079000/`. It preserves the
frozen fixture/runner, calls, build/check output, manifests, resource identities, watchdog and protected
hashes. All four cases completed; the VM ended stopped, pressure stayed normal, swapouts stayed at
4132 and protected captured application/global configuration/installed binary hashes were unchanged.
Source publications, sync state, failed-attempt evidence and archives remain retained.

Binary SHA-256: `ec362123bda65ce14cd984eda8d884531fc58de9115a4491815541e554a9d12b`.
Protocol SHA-256: `cf8ea6c2757fe37cce59585fb284e12ebbe2e6e4f30b1c9e7c903fe86b4fbabe`.
Results SHA-256: `fd20f828c0755639a6394fa3500d3ff3bd59406644e0ccb2c75387b4de0d2921`.

The earlier `build-output-1789420760521965000` run passed build/reuse but its harness expected a
custom compile-error string. Bun instead rejected with its native syntax diagnostic. The failure and
successful cleanup remain recorded; the corrected runner requires the pinned compiler's actual
diagnostic and absent downstream containers. Host tests also caught macOS refusing to rename the
staging directory after it was made read-only; final directory permissions now follow the rename.

Seven focused tests exercise real compilation/execution, verified reuse, changed input, failed or
interrupted production, size limits, content tampering, symlinks/hardlinks and foreign inventory.
The underlying Rust graph implementation is unchanged from its 125-test source-mount checkpoint.
The fresh Event Agent plan still has 14 services, 22 errors and two warnings; no Event Agent startup,
managed secrets, routing, reload, image build or dependency install is claimed. Those remain in the
[work-unit ledger](work-units.md).

## Verification repair discovered during this checkpoint

The first repository-wide gate invocation returned the old 937-test transcript from Turbo cache.
The CLI package executes root-owned source/tests, but the default package inputs contained only
three package files. That green result did not exercise the new tests. `packages/cli/turbo.json`
now declares the root source, tests, fixtures, scripts, documentation and relevant configuration as
inputs for test/typecheck/check, preserving package defaults with the documented
[Turborepo input patterns](https://turborepo.dev/docs/reference/configuration#inputs).
Private candidate state and dependency trees are not included in the observed input inventory.

`tests/runtime-turbo-inputs.test.ts` inspects a real Turbo dry run rather than merely comparing the
configuration text. A separate controlled edit proved all three CLI hashes change with fixture
bytes and return after exact restoration. The corrected full gates ran the CLI tasks freshly:
**940 tests passed, five skipped**, typecheck passed, and lint passed. The unchanged DB tasks reused
their cache. Changed fixture/test files also passed explicit lint, and the Python runner compiled.
The ordinary Rust suite was not repeated because this checkpoint changes no Rust behavior.
