# Experimental guest agent

Launch the static Linux binary with the path of a new Unix stream socket in a
private directory. The guest supervisor owns that directory and removes a stale
socket after confirming the previous process exited. Each connection negotiates version 1 and can submit successive command channels. A later connection can inspect the
same execution. Commands inherit only their explicitly supplied environment.
Use absolute executable paths when selecting guest programs.

The supervisor reserves the ID before spawning, reaps independently of the
connection and retains exit codes or terminating signals. Output offsets address
the retained tail of each pipe (64 KiB). The output reply carries its absolute start offset and signals truncation and EOF
separately. Read both streams through EOF before releasing a result. An agent
restart changes the incarnation and invalidates every old handle. A timed-out
start can arrive after another connection observes absence. Inspect and keep
the outcome unknown while the old request can still arrive.

The registry holds up to 16 unreleased jobs. One counter per incarnation
fences retired IDs. Releasing a job immediately frees its slot. A rejected
admission at capacity leaves the counter unchanged.

The finite model covers two successive IDs per incarnation, terminal outcomes, a half-open transport,
host reconnect and one guest restart. The Linux integration test drives the
corresponding transitions over a socket and uses an agent restart to exercise
incarnation fencing. Booting a guest and establishing its socket bridge require
separate VM qualification.
