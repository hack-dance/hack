----------------------------- MODULE PoolLayout -----------------------------
CONSTANT StrictOlder
Layouts == {"legacy", "compact"}
None == "absent"
VARIABLES owner, initial, lease, journal, providerShare, ownerShare, refused

vars == <<owner, initial, lease, journal, providerShare, ownerShare, refused>>
Init == /\ owner = None /\ initial = None /\ lease = None
        /\ journal = None /\ providerShare = None /\ ownerShare = None
        /\ refused = FALSE

Acquire(layout) ==
    /\ layout \in Layouts /\ lease = None
    /\ (owner = None \/ layout = "compact" \/ owner = "legacy")
    /\ lease' = layout
    /\ UNCHANGED <<owner, initial, journal, providerShare, ownerShare, refused>>

Create ==
    /\ owner = None /\ lease \in Layouts
    /\ owner' = lease /\ initial' = lease
    /\ UNCHANGED <<lease, journal, providerShare, ownerShare, refused>>

\* The durable journal stores the converted path, even before the provider row changes.
PlanAdd ==
    /\ owner \in Layouts /\ lease = "compact"
    /\ journal = None /\ ownerShare = None
    /\ journal' = owner
    /\ UNCHANGED <<owner, initial, lease, providerShare, ownerShare, refused>>

CommitProvider ==
    /\ lease = "compact" /\ journal \in Layouts /\ providerShare = None
    /\ providerShare' = journal
    /\ UNCHANGED <<owner, initial, lease, journal, ownerShare, refused>>

CommitOwner ==
    /\ lease = "compact" /\ journal \in Layouts
    /\ providerShare = journal /\ ownerShare = None
    /\ ownerShare' = journal
    /\ UNCHANGED <<owner, initial, lease, journal, providerShare, refused>>

FinishAdd ==
    /\ lease = "compact" /\ journal \in Layouts /\ ownerShare = journal
    /\ journal' = None
    /\ UNCHANGED <<owner, initial, lease, providerShare, ownerShare, refused>>

\* A lease may be released at any durable boundary. A new lease resumes the
\* same journal and commits only the missing sides.
ReleaseOrCrash ==
    /\ lease # None /\ lease' = None
    /\ UNCHANGED <<owner, initial, journal, providerShare, ownerShare, refused>>

OlderUse ==
    /\ owner = "compact" /\ refused = FALSE
    /\ refused' = TRUE
    /\ owner' = IF StrictOlder THEN owner ELSE "legacy"
    /\ UNCHANGED <<initial, lease, journal, providerShare, ownerShare>>

Next == (\E layout \in Layouts : Acquire(layout)) \/ Create \/ PlanAdd
        \/ CommitProvider \/ CommitOwner \/ FinishAdd \/ ReleaseOrCrash \/ OlderUse
Spec == Init /\ [][Next]_vars
LayoutPreserved == /\ owner = initial
                   /\ journal \in {None, owner}
                   /\ providerShare \in {None, owner}
                   /\ ownerShare \in {None, providerShare}
                   /\ (journal = None => ownerShare = providerShare)
=============================================================================
