# Experimental guest agent

Launch the static Linux binary with the path of a new Unix stream socket in a
private directory. The guest supervisor owns that directory and removes a stale
socket after confirming the previous process exited. Each connection negotiates version 1 and can submit successive command channels. A later connection can inspect the
same execution. Commands inherit only their explicitly supplied environment.
Use absolute executable paths when selecting guest programs.

The supervisor reserves the ID before spawning outside the registry lock. Each command leads its own
process group. The supervisor observes terminal status with waitid(WNOWAIT)
and keeps the leader unreaped through Release. Signal targets the pinned group,
including descendants after the leader exits. Release kills the group, reaps
the leader and closes the agent's pipe ends even if an escaped descendant
holds a writer. Release discards unread output. Output offsets address
the retained tail of each pipe (64 KiB). After overflow, the stream reports truncation on every subsequent read. The output reply carries its absolute start offset and signals truncation and EOF
separately. Read both streams through EOF when complete output is required. A descendant
that inherits a writer can delay EOF indefinitely. An agent
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

The launcher must put the agent and jobs in a dedicated cgroup, prevent jobs
from migrating outside it, kill the whole cgroup after an agent crash, and
observe it empty before starting another incarnation. A session change alone
does not move a task out of a cgroup. A guest reboot clears old processes; an
agent crash leaves them running. The launcher implements this duty in a later slice.

The socket parent must be owned by the agent UID with mode 0700. The trust
boundary is the private mount and the supervisor-owned bridge; Unix peer
credentials would identify the bridge rather than its host caller.
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
wire frame across AgentRestart. The crash regression lets a child perform an
observable write after its agent exits. The launcher must enforce KillCgroup
and observe that the cgroup is empty to enable a safe AgentRestart.
The test exercises a real Linux process. A change of kernel boot ID requires a VM.
