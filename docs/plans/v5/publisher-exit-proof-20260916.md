# Native publisher exit proof

`provider::publisher::stop` binds a macOS kqueue process-exit watch before checking
the recorded PID, native start time, UID and executable. It then connects to the
private Unix control socket, checking socket device/inode across connection, and
sends the exact reservation control token. No numeric-PID termination signal is
used. A matching native exit event proves termination; successfully queueing a
request alone does not. The watcher exists only during cleanup, with a five-second
bound; there is no background timer or periodic publisher CPU cost.

Callers must obtain the process, binary, socket and token from the same validated
publisher intent. This API does not discover or adopt publishers, validate an
executable content digest, create a receipt, or delete files. It returns an error
on ambiguous state, timeout, stale process identity, nonprivate socket or aliased
state path. A process already absent yields a separate absence result. Failure
retains cleanup responsibility with the caller; it never falls back to SIGKILL.
Non-macOS hosts refuse this experimental host primitive.

The control path must be canonical: the existing private-state guard rejects
symlink components, including macOS `/tmp` in favor of `/private/tmp`. Tests were
corrected to canonicalize their owned temporary directory; the runtime guard was
preserved.

## Verification

Native tests cover exit and released TCP listener, repeated cleanup after process
absence, changed start/UID/executable, symlink/nonprivate socket rejection, and a
queued wrong token that times out while the publisher stays alive. A separate
controller subprocess also stops a publisher owned by its parent test process:
this proves native observation does not require a parent-child wait handle. The
controller test asserts that the selected helper test actually ran.

All five test entries pass (four controls and their subprocess helper). Default/all-feature
Rust suites, strict Clippy, the default native-HTTP release, Bun typecheck/check
and tests pass (940 pass, 5 skip). Final controller tests and Clippy were rerun
after bounding the test startup wait. Private evidence: `.hack-local/review/wu07/publisher-exit-1789584484952581000/`.

The native C publisher is unchanged from the preceding VM-backed qualification.
This unit exercises the new Rust controller against that real host executable;
no VM or application volume is needed for its host process-exit contract.

## Next integration

Managed foreground publication must persist its exact intent before staging and
exec, keep the operation lock through exec, and validate the reservation's guarded
transport and endpoint generation. Its cleanup must call this exit proof before
retiring receipts or executable files, preserve unknown/replaced paths, and work
offline. Guest bridge release and pool shutdown must integrate host cleanup in the
correct order. Startup interruption, missing control sockets, malformed journals,
VM-down cleanup and port reuse require live controls before exposing managed
publication. This unit alone does not close those gates or establish parity.
