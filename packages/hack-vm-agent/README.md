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

The control socket grants the agent's guest privileges. A project container
with its own mount namespace cannot name the socket if neither the socket nor
its parent is shared. Mode 0600 alone does not exclude container root. Sharing
the socket, the guest root filesystem, an engine socket that permits arbitrary
mounts, or access to the supervisor's mount namespace can grant guest command
execution. The supervisor must keep the socket outside project mounts. The
provider bridge and container isolation are qualified in the launch slice.

The integration test `lost_reply_record_release_new_id_and_restart` walks the
registered GuestAgent model. A partial Start frame implements Stall, completing
it and closing the socket implements Deliver and HostRestart. Reconnecting
observes Finish through Inspect and checks List. A repeated Start must conflict.
The host writes the observed outcome and syncs its receipt (Record) before
Release. NewId admits a second command. A fresh agent rejects the original
wire frame across an incarnation change (the incarnation part of Reboot).
The test exercises a real Linux process. A change of kernel boot ID requires a VM.
