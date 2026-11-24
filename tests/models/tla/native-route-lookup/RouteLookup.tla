---------------------------- MODULE RouteLookup ----------------------------
CONSTANTS RejectJournal, RejectDetached
VARIABLES committed, pending, lookup, opened, linked, selected

States == {"absent", "claimed", "staged"}
Registry == [a : {"live", "absent"}, b : States]
vars == <<committed, pending, lookup, opened, linked, selected>>

Init ==
    /\ committed = [a |-> "live", b |-> "absent"]
    /\ pending = "none"
    /\ lookup = "first"
    /\ opened = [a |-> "absent", b |-> "absent"]
    /\ linked = FALSE
    /\ selected = "none"

TypeOK ==
    /\ committed \in Registry
    /\ pending \in States \cup {"none"}
    /\ lookup \in {"first", "firstOpen", "second", "secondOpen", "allow", "deny"}
    /\ opened \in Registry
    /\ linked \in BOOLEAN
    /\ selected \in {"live", "absent", "none"}

NextSibling == [state \in States |->
    CASE state = "absent" -> "claimed"
      [] state = "claimed" -> "staged"
      [] OTHER -> "absent"]

StageSibling ==
    /\ pending = "none"
    /\ pending' = NextSibling[committed.b]
    /\ UNCHANGED <<committed, lookup, opened, linked, selected>>

CommitSibling ==
    /\ pending # "none"
    /\ committed' = [committed EXCEPT !.b = pending]
    /\ pending' = "none"
    /\ linked' = FALSE
    /\ UNCHANGED <<lookup, opened, selected>>

RejectPending ==
    /\ RejectJournal /\ pending # "none"
    /\ lookup \in {"first", "second"}
    /\ lookup' = "deny"
    /\ UNCHANGED <<committed, pending, opened, linked, selected>>

OpenCommitted ==
    /\ ~RejectJournal \/ pending = "none"
    /\ lookup \in {"first", "second"}
    /\ lookup' = IF lookup = "first" THEN "firstOpen" ELSE "secondOpen"
    /\ opened' = committed
    /\ linked' = TRUE
    /\ UNCHANGED <<committed, pending, selected>>

RejectUnlinked ==
    /\ RejectDetached /\ ~linked
    /\ lookup \in {"firstOpen", "secondOpen"}
    /\ lookup' = "deny"
    /\ UNCHANGED <<committed, pending, opened, linked, selected>>

ReadFirst ==
    /\ lookup = "firstOpen"
    /\ ~RejectDetached \/ linked
    /\ selected' = opened.a
    /\ lookup' = IF selected' = "live" THEN "second" ELSE "deny"
    /\ UNCHANGED <<committed, pending, opened, linked>>

ReadSecond ==
    /\ lookup = "secondOpen"
    /\ ~RejectDetached \/ linked
    /\ lookup' = IF selected = opened.a THEN "allow" ELSE "deny"
    /\ UNCHANGED <<committed, pending, opened, linked, selected>>

Next ==
    StageSibling \/ CommitSibling \/ RejectPending \/ OpenCommitted
    \/ RejectUnlinked \/ ReadFirst \/ ReadSecond

Spec == Init /\ [][Next]_vars

LiveRouteAllowed == committed.a = "live" => lookup # "deny"
NeverDetachDuringRetirement ==
    ~(lookup = "secondOpen" /\ committed.b = "absent" /\ opened.b = "staged" /\ ~linked)
=============================================================================
