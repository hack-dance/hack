# Interactive private envelope

`Envelope.tla` exhausts 15 states for one handshake and two abstract private bytes.
Raw mode precedes the ready marker. The host sends only after that marker;
validation requires consuming every private byte. Restoration precedes ACK, and
user input is admitted only after ACK. Error exits leave echo disabled, including
for bytes still in flight. The `negative` control restores on error and must fail
`NoRestoreOverPrivate` at `Fail`, with pending bytes and echo enabled.

`interactiveFreshExec`/`interactiveEnvelope` in `environment-launcher.zig` own
guest termios and parsing. `engine::interactive_exec::deliver` owns the host
marker, base64 delivery and ACK gate. `Terminal::relay` starts only after that
gate. The Python PTY fixture tests successful restoration, malformed base64,
expiry, extra/short input, timeout and non-TTY refusal. Error tests send late
synthetic bytes and require no echo. The Rust handshake test preserves output
coalesced with ACK and proves malformed/old markers receive no private bytes.

Bounds and assumptions: 64 KiB decoded envelope, 5-second delivery, exact
termios semantics and a trusted pinned launcher. Real Docker detach scanning,
PTY wiring, job control, same-user container access and VM behavior are outside
the model. It proves no liveness or isolation from the command's own user.
