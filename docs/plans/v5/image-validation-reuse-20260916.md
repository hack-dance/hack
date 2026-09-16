# Reuse completed image validation — September 16

Repeated `runtime load-image` previously expanded and hashed every image layer on
every call, even if the exact image was already present. It also rewrote the
completed receipt. This added work to repeated setup without improving content
identity proof.

The candidate now records validation version 1 after the existing full archive
validation. A reuse invocation still reads and hashes the complete bounded archive,
checks checkout and provider ownership, and independently inspects the engine's
content ID, operating system and architecture. Only an exact completed version-1
receipt can avoid repeated layer expansion. If the image is absent, full validation
and the existing explicit load protocol apply. Legacy, future-version or incomplete
receipts do not qualify for this optimization.

Same-boot successful reuse leaves the receipt unchanged. After a VM restart,
independent image inspection is still required and the receipt's boot identity is
updated. No image is deleted and no retention rule is inferred from this cache.
Image receipt count/byte retention and references from non-graph jobs remain open.

Regression coverage includes legacy receipts, unknown validation versions, changed
checkout/owner/archive/image, incomplete loads, and reboot identity. Existing archive
validation tests cover extra members, architecture, image/layer digests and expanded
size limits; an incorrect archive hash still cannot create runtime state.

The isolated comparison uses the same cached pinned image, archive, VM profile and
seven measured CLI invocations after warmup. Each command is measured with macOS
`time -l`; no builds or other qualification jobs overlap the VM run. Baseline and
candidate run in separate sequential boots, so these are component measurements,
not randomized whole-application benchmarks. Results follow after verification.

## Results

All required gates passed: Rust default/all-feature tests, strict Clippy for both,
default release build, and Bun typecheck/check/test (940 passed, 5 skipped).

| Seven-call median | Previous candidate | Validation reuse | After another VM boot |
| --- | ---: | ---: | ---: |
| Elapsed seconds | 1.34 | 0.26 | 0.25 |
| CPU seconds | 1.29 | 0.21 | 0.21 |
| Peak RSS bytes | 108,462,080 | 108,101,632 | 108,101,632 |
| Receipt rewritten during measured calls | yes | no | no |

Elapsed time decreased 80.6% and CPU time 83.7% in the first candidate comparison.
Peak memory was effectively unchanged: the archive is still buffered in memory.
No claim is made about whole-application startup, idle VM resources or reclaimed
disk. Streaming hash verification is a follow-up opportunity for the warm path.

Private evidence under `.hack-local/review/wu07/`:

- `image-reuse-baseline-1789596330655860000/`, binary
  `2adccebaf4f3f472b1b494a60c7124ed8fc16fe0bb641087a79108ac78086a8c`.
- `image-reuse-candidate-1789596582732654000/`, binary
  `bfff09520f5c39bdbaf6bada390159607111c4b14757873f4bae4397ad2a9bf5`.
- `image-reuse-candidate-reboot-1789596604767957000/`, same candidate binary.

The candidate warmup upgraded the legacy receipt through full validation. Negative
archive-hash and image-ID requests were refused without changing that receipt.
A subsequent VM boot successfully reused completed validation after live image
inspection. All three runs ended with the VM stopped, protected global hashes
unchanged, normal memory pressure and no change in swapouts (8/4/4 watchdog samples).
The image remains cached; no application data or image was removed.
