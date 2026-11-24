---- MODULE BuildAlias ----
EXTENDS Naturals
CONSTANT UnsafeUntag, UnsafeRemote, UnsafeSweep, OldOrder
VARIABLES phase, alias, base, keeper, child, wire, sweptLive, changed, verified
vars == <<phase, alias, base, keeper, child, wire, sweptLive, changed, verified>>

Init == /\ phase = "idle" /\ alias = FALSE /\ base = TRUE
        /\ keeper = FALSE /\ child = FALSE /\ wire = FALSE /\ sweptLive = FALSE
        /\ changed = FALSE /\ verified = FALSE
Record == /\ phase = "idle" /\ phase' = "recorded"
          /\ keeper' = ~UnsafeUntag
          /\ UNCHANGED <<alias, base, child, wire, sweptLive, changed, verified>>
Tag == /\ phase = "recorded" /\ base /\ phase' = "tagged" /\ alias' = TRUE
       /\ UNCHANGED <<base, keeper, child, wire, sweptLive, changed, verified>>
Solve == /\ phase = "tagged" /\ alias /\ phase' = "solving" /\ child' = TRUE
         /\ UNCHANGED <<alias, base, keeper, wire, sweptLive, changed, verified>>
ResolveMissing == /\ phase = "solving" /\ UnsafeRemote
                  /\ wire' = TRUE /\ UNCHANGED <<phase, alias, base, keeper, child, sweptLive, changed, verified>>
Finish == /\ phase = "solving" /\ phase' = "finished" /\ child' = FALSE
          /\ verified' = TRUE
          /\ UNCHANGED <<alias, base, keeper, wire, sweptLive, changed>>
Crash == /\ phase \in {"recorded", "tagged", "solving", "finished"}
         /\ phase' = "stranded"
         /\ UNCHANGED <<alias, base, keeper, child, wire, sweptLive, changed, verified>>
ChildExits == /\ phase = "stranded" /\ child /\ child' = FALSE
              /\ UNCHANGED <<phase, alias, base, keeper, wire, sweptLive, changed, verified>>
Cleanup == /\ phase \in {"finished", "stranded"}
           /\ ~child \/ UnsafeSweep
           /\ ~changed
           /\ keeper \/ ~alias \/ UnsafeUntag
           /\ sweptLive' = (sweptLive \/ child)
           /\ base' = (base /\ (keeper \/ ~alias))
           /\ alias' = FALSE /\ phase' = "idle" /\ child' = FALSE
           /\ UNCHANGED <<keeper, wire, changed, verified>>

LoseKeeper == /\ phase = "stranded" /\ alias /\ keeper /\ ~child /\ ~changed
              /\ keeper' = FALSE
              /\ UNCHANGED <<phase, alias, base, child, wire, sweptLive, changed, verified>>
RestoreKeeper == /\ phase = "stranded" /\ alias /\ ~keeper /\ ~child /\ ~changed
                 /\ ~OldOrder /\ ~UnsafeUntag /\ keeper' = TRUE
                 /\ UNCHANGED <<phase, alias, base, child, wire, sweptLive, changed, verified>>
Reuse == /\ phase = "stranded" /\ verified /\ ~child /\ ~changed /\ ~OldOrder
         /\ phase' = "reused"
         /\ UNCHANGED <<alias, base, keeper, child, wire, sweptLive, changed, verified>>
Refuse == /\ phase = "stranded" /\ alias /\ ~keeper /\ ~child /\ ~changed /\ OldOrder
           /\ phase' = "blocked"
           /\ UNCHANGED <<alias, base, keeper, child, wire, sweptLive, changed, verified>>
Retry == /\ phase = "blocked" /\ UNCHANGED vars
ChangeIncarnation == /\ phase = "stranded" /\ ~child /\ ~changed
                      /\ changed' = TRUE /\ alias' = FALSE /\ keeper' = FALSE
                      /\ UNCHANGED <<phase, base, child, wire, sweptLive, verified>>
DiscardJournal == /\ phase = "stranded" /\ changed
                  /\ phase' = "idle" /\ changed' = FALSE /\ verified' = FALSE
                  /\ UNCHANGED <<alias, base, keeper, child, wire, sweptLive>>

Next == Record \/ Tag \/ Solve \/ ResolveMissing \/ Finish \/ Crash \/ ChildExits \/ Cleanup
        \/ LoseKeeper \/ RestoreKeeper \/ Reuse \/ Refuse \/ Retry
        \/ ChangeIncarnation \/ DiscardJournal
Spec == Init /\ [][Next]_vars
BaseSurvives == base
NoRegistryFallback == ~wire
NoLiveSweep == ~sweptLive
IdleIsClean == phase = "idle" => ~alias
CanRecover == phase # "blocked"
====
