---------------------------- MODULE CommandLease ----------------------------
(* HACK-2669. A service command (hack exec, or the dependency refresh that   *)
(* exec and run send first) needs the provider mutation lease while a ready  *)
(* foreground owner takes the same lease briefly once a tick, for example to *)
(* supervise restarts of a routed service. The owner's tick yields when the  *)
(* lease is busy (with_available_lease); the command never takes the lease   *)
(* from the owner and never cancels it. Wait = FALSE is the old nonblocking  *)
(* acquisition; Wait = TRUE is the bounded wait (COMMAND_LEASE_WAIT).        *)
(*                                                                           *)
(* The waiter may run on an owner's only loop thread (the owner's refresh    *)
(* answer, the authored exec and run), where a shutdown signal or a client   *)
(* disconnect can arrive while it waits. Checked = TRUE runs the caller's    *)
(* check before every attempt (wait_for_acquisition's before_attempt) and    *)
(* once more after acquisition. Checked = FALSE is the first version of the  *)
(* fix, which passed no check, so the owner held the signal until the wait   *)
(* ended.                                                                    *)
EXTENDS Naturals
CONSTANTS Bound, HoldMax, Wait, Checked
VARIABLES lease, cmd, elapsed, held, due, signal, sigAt
vars == <<lease, cmd, elapsed, held, due, signal, sigAt>>

Init == /\ lease = "free" /\ cmd = "waiting"
        /\ elapsed = 0 /\ held = 0 /\ due = TRUE
        /\ signal = FALSE /\ sigAt = 0

\* The owner's tick takes a free lease. It is due again only one tick later.
OwnerTake == /\ lease = "free" /\ due
             /\ lease' = "owner" /\ held' = 0 /\ due' = FALSE
             /\ UNCHANGED <<cmd, elapsed, signal, sigAt>>
\* A busy lease: the owner's tick skips this round and keeps running.
OwnerYield == /\ lease = "command" /\ due
              /\ due' = FALSE
              /\ UNCHANGED <<lease, cmd, elapsed, held, signal, sigAt>>
OwnerRelease == /\ lease = "owner"
                /\ lease' = "free" /\ due' = FALSE
                /\ UNCHANGED <<cmd, elapsed, held, signal, sigAt>>

\* A signal (Ctrl-C, hack down) or a client disconnect while the command waits.
Signal == /\ cmd = "waiting" /\ ~signal
          /\ signal' = TRUE /\ sigAt' = elapsed
          /\ UNCHANGED <<lease, cmd, elapsed, held, due>>

\* One acquisition attempt that finds the lease free admits the command. A
\* checked waiter runs its check first (and again after acquisition), so one
\* with a pending signal is not admitted.
CmdAcquire == /\ cmd = "waiting" /\ lease = "free" /\ elapsed < Bound
              /\ ~(Checked /\ signal)
              /\ lease' = "command" /\ cmd' = "admitted"
              /\ UNCHANGED <<elapsed, held, due, signal, sigAt>>
\* The check refuses before the next attempt; nothing is admitted.
CmdCancel == /\ Checked /\ cmd = "waiting" /\ signal
             /\ cmd' = "cancelled"
             /\ UNCHANGED <<lease, elapsed, held, due, signal, sigAt>>
\* Old behaviour: one attempt that finds the lease held refuses provider_busy.
CmdBusy == /\ ~Wait /\ cmd = "waiting" /\ lease = "owner"
           /\ cmd' = "refused"
           /\ UNCHANGED <<lease, elapsed, held, due, signal, sigAt>>
\* Bounded wait: at the deadline the command refuses, naming the holder.
Expire == /\ Wait /\ cmd = "waiting" /\ elapsed = Bound
          /\ ~(Checked /\ signal)
          /\ cmd' = "refused"
          /\ UNCHANGED <<lease, elapsed, held, due, signal, sigAt>>
CmdFinish == /\ cmd = "admitted"
             /\ lease' = "free" /\ cmd' = "done"
             /\ UNCHANGED <<elapsed, held, due, signal, sigAt>>

(* One unit of time. A waiting command polls far more often than the owner's *)
(* tick (5 to 50 ms against one second), so time does not pass while it      *)
(* waits on a free lease, and a checked waiter sees a pending signal before  *)
(* time passes. A brief holder releases within HoldMax ticks. The            *)
(* nonblocking command makes its one attempt before any time passes.         *)
Tick == /\ ~(cmd = "waiting" /\ lease = "free")
        /\ ~(Checked /\ cmd = "waiting" /\ signal)
        /\ (cmd = "waiting" => Wait /\ elapsed < Bound)
        /\ (lease = "owner" => held < HoldMax)
        /\ elapsed' = IF cmd = "waiting" THEN elapsed + 1 ELSE elapsed
        /\ held' = IF lease = "owner" THEN held + 1 ELSE held
        /\ due' = TRUE
        /\ UNCHANGED <<lease, cmd, signal, sigAt>>

Next == \/ OwnerTake \/ OwnerYield \/ OwnerRelease \/ Signal
        \/ CmdAcquire \/ CmdCancel \/ CmdBusy \/ Expire \/ CmdFinish \/ Tick
Spec == Init /\ [][Next]_vars
        /\ WF_vars(CmdAcquire \/ CmdCancel \/ Expire \/ CmdBusy \/ OwnerRelease \/ Tick)

TypeOK == /\ lease \in {"free", "owner", "command"}
          /\ cmd \in {"waiting", "admitted", "done", "refused", "cancelled"}
          /\ elapsed \in 0..Bound /\ held \in 0..HoldMax /\ due \in BOOLEAN
          /\ signal \in BOOLEAN /\ sigAt \in 0..Bound
\* Effects run only under the command's own lease.
NoEffectWithoutLease == cmd = "admitted" => lease = "command"
NoAdmissionAfterDeadline == cmd \in {"admitted", "done"} => elapsed < Bound
\* The reported bug: a brief holder made a ready run refuse exec. A command
\* cancelled by its own caller is not a refusal by the holder.
BriefHolderNeverRefuses == cmd # "refused"
\* Review finding: an owner's loop must not hold a signal behind the wait.
SignalNotHeld == (signal /\ cmd = "waiting") => elapsed = sigAt
\* A signal that arrived while the command waited admits nothing.
NoAdmissionAfterSignal == signal => cmd \notin {"admitted", "done"}
Settles == cmd = "waiting" ~> cmd # "waiting"
SignalSettles == (signal /\ cmd = "waiting") ~> cmd = "cancelled"
\* Reachability: the command is admitted after waiting out a holder.
NeverAdmittedAfterWait == ~(cmd = "admitted" /\ elapsed > 0)
=============================================================================
