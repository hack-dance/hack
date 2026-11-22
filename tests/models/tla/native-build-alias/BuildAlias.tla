---- MODULE BuildAlias ----
EXTENDS Naturals
CONSTANT UnsafeUntag, UnsafeRemote, UnsafeSweep
VARIABLES phase, alias, base, keeper, child, wire, sweptLive
vars == <<phase, alias, base, keeper, child, wire, sweptLive>>

Init == /\ phase = "idle" /\ alias = FALSE /\ base = TRUE
        /\ keeper = FALSE /\ child = FALSE /\ wire = FALSE /\ sweptLive = FALSE
Record == /\ phase = "idle" /\ phase' = "recorded"
          /\ keeper' = ~UnsafeUntag
          /\ UNCHANGED <<alias, base, child, wire, sweptLive>>
Tag == /\ phase = "recorded" /\ base /\ phase' = "tagged" /\ alias' = TRUE
       /\ UNCHANGED <<base, keeper, child, wire, sweptLive>>
Solve == /\ phase = "tagged" /\ alias /\ phase' = "solving" /\ child' = TRUE
         /\ UNCHANGED <<alias, base, keeper, wire, sweptLive>>
ResolveMissing == /\ phase = "solving" /\ UnsafeRemote
                  /\ wire' = TRUE /\ UNCHANGED <<phase, alias, base, keeper, child, sweptLive>>
Finish == /\ phase = "solving" /\ phase' = "finished" /\ child' = FALSE
          /\ UNCHANGED <<alias, base, keeper, wire, sweptLive>>
Crash == /\ phase \in {"recorded", "tagged", "solving", "finished"}
         /\ phase' = "stranded"
         /\ UNCHANGED <<alias, base, keeper, child, wire, sweptLive>>
ChildExits == /\ phase = "stranded" /\ child /\ child' = FALSE
              /\ UNCHANGED <<phase, alias, base, keeper, wire, sweptLive>>
Cleanup == /\ phase \in {"finished", "stranded"}
           /\ ~child \/ UnsafeSweep
           /\ sweptLive' = (sweptLive \/ child)
           /\ base' = (base /\ (keeper \/ ~alias))
           /\ alias' = FALSE /\ phase' = "idle" /\ child' = FALSE
           /\ UNCHANGED <<keeper, wire>>

Next == Record \/ Tag \/ Solve \/ ResolveMissing \/ Finish \/ Crash \/ ChildExits \/ Cleanup
Spec == Init /\ [][Next]_vars
BaseSurvives == base
NoRegistryFallback == ~wire
NoLiveSweep == ~sweptLive
IdleIsClean == phase = "idle" => ~alias
====
