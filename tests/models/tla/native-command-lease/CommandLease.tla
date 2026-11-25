---------------------------- MODULE CommandLease ----------------------------
(* HACK-2669. A service command (hack exec, or the dependency refresh that   *)
(* exec and run send first) needs the provider mutation lease while a ready  *)
(* foreground owner takes the same lease briefly once a tick, for example to *)
(* supervise restarts of a routed service. The owner's tick yields when the  *)
(* lease is busy (with_available_lease); the command never takes the lease   *)
(* from the owner and never cancels it. Wait = FALSE is the old nonblocking  *)
(* acquisition; Wait = TRUE is the bounded wait (COMMAND_LEASE_WAIT).        *)
EXTENDS Naturals
CONSTANTS Bound, HoldMax, Wait
VARIABLES lease, cmd, elapsed, held, due
vars == <<lease, cmd, elapsed, held, due>>

Init == /\ lease = "free" /\ cmd = "waiting"
        /\ elapsed = 0 /\ held = 0 /\ due = TRUE

\* The owner's tick takes a free lease. It is due again only one tick later.
OwnerTake == /\ lease = "free" /\ due
             /\ lease' = "owner" /\ held' = 0 /\ due' = FALSE
             /\ UNCHANGED <<cmd, elapsed>>
\* A busy lease: the owner's tick skips this round and keeps running.
OwnerYield == /\ lease = "command" /\ due
              /\ due' = FALSE
              /\ UNCHANGED <<lease, cmd, elapsed, held>>
OwnerRelease == /\ lease = "owner"
                /\ lease' = "free" /\ due' = FALSE
                /\ UNCHANGED <<cmd, elapsed, held>>

\* One acquisition attempt that finds the lease free admits the command.
CmdAcquire == /\ cmd = "waiting" /\ lease = "free" /\ elapsed < Bound
              /\ lease' = "command" /\ cmd' = "admitted"
              /\ UNCHANGED <<elapsed, held, due>>
\* Old behaviour: one attempt that finds the lease held refuses provider_busy.
CmdBusy == /\ ~Wait /\ cmd = "waiting" /\ lease = "owner"
           /\ cmd' = "refused"
           /\ UNCHANGED <<lease, elapsed, held, due>>
\* Bounded wait: at the deadline the command refuses, naming the holder.
Expire == /\ Wait /\ cmd = "waiting" /\ elapsed = Bound
          /\ cmd' = "refused"
          /\ UNCHANGED <<lease, elapsed, held, due>>
CmdFinish == /\ cmd = "admitted"
             /\ lease' = "free" /\ cmd' = "done"
             /\ UNCHANGED <<elapsed, held, due>>

(* One unit of time. A waiting command polls far more often than the owner's *)
(* tick (5 to 50 ms against one second), so time does not pass while it      *)
(* waits on a free lease. A brief holder releases within HoldMax ticks. The   *)
(* nonblocking command makes its one attempt before any time passes.         *)
Tick == /\ ~(cmd = "waiting" /\ lease = "free")
        /\ (cmd = "waiting" => Wait /\ elapsed < Bound)
        /\ (lease = "owner" => held < HoldMax)
        /\ elapsed' = IF cmd = "waiting" THEN elapsed + 1 ELSE elapsed
        /\ held' = IF lease = "owner" THEN held + 1 ELSE held
        /\ due' = TRUE
        /\ UNCHANGED <<lease, cmd>>

Next == \/ OwnerTake \/ OwnerYield \/ OwnerRelease
        \/ CmdAcquire \/ CmdBusy \/ Expire \/ CmdFinish \/ Tick
Spec == Init /\ [][Next]_vars
        /\ WF_vars(CmdAcquire \/ Expire \/ CmdBusy \/ OwnerRelease \/ Tick)

TypeOK == /\ lease \in {"free", "owner", "command"}
          /\ cmd \in {"waiting", "admitted", "done", "refused"}
          /\ elapsed \in 0..Bound /\ held \in 0..HoldMax /\ due \in BOOLEAN
\* Effects run only under the command's own lease.
NoEffectWithoutLease == cmd = "admitted" => lease = "command"
NoAdmissionAfterDeadline == cmd \in {"admitted", "done"} => elapsed < Bound
\* The reported bug: a brief holder made a ready run refuse exec.
BriefHolderNeverRefuses == cmd # "refused"
Settles == cmd = "waiting" ~> cmd # "waiting"
\* Reachability: the command is admitted after waiting out a holder.
NeverAdmittedAfterWait == ~(cmd = "admitted" /\ elapsed > 0)
=============================================================================
