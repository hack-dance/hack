------------------------------ MODULE MappingRelease ------------------------------
\* HACK-2524: a checkout's native run mapping names the home that owns its run. When
\* that home is deleted, its own records (the proof of a clean stop) go with it, and
\* the mapping could not be released. The question: can a command always release a
\* mapping whose home is gone, without ever releasing one whose run is still alive?
\*
\* home     - "present" (the recorded path holds the recorded directory identity),
\*            "deleted" (the path is absent), "moved" (renamed elsewhere: absent at
\*            the path, alive elsewhere) or "replaced" (another identity at the path).
\* clean    - the run's last lifetime stopped cleanly (its records say so).
\* procs    - a process of the home (frontend, graph owner, relay, provider) is alive.
\* named    - that process names the recorded path (started before any move).
\* mapping  - "held" or "released".
\* unsafe   - a release happened while a process naming the path was alive.
\*
\* Switches (TRUE is this change unless noted):
\*   GoneRelease - a release when the path no longer holds the home and no process
\*                 names it. FALSE: today, only the clean-stop release from records.
\*   PathOnly    - the gone release ignores the process scan (a broken control).
EXTENDS Naturals
CONSTANTS GoneRelease, PathOnly

VARIABLES home, clean, procs, named, mapping, unsafe
vars == <<home, clean, procs, named, mapping, unsafe>>

TypeOK ==
    /\ home \in {"present", "deleted", "moved", "replaced"}
    /\ clean \in BOOLEAN /\ procs \in BOOLEAN /\ named \in BOOLEAN
    /\ mapping \in {"held", "released"} /\ unsafe \in BOOLEAN

Init ==
    /\ home = "present" /\ mapping = "held" /\ unsafe = FALSE
    /\ \/ clean = TRUE /\ procs = FALSE /\ named = FALSE
       \/ clean = FALSE /\ procs = TRUE /\ named = TRUE

\* --- The environment -------------------------------------------------------
\* The user deletes the home, possibly while its processes still run.
Delete ==
    /\ home = "present" /\ home' = "deleted"
    /\ UNCHANGED <<clean, procs, named, mapping, unsafe>>
\* The home is renamed; running processes keep naming the old path.
Move ==
    /\ home = "present" /\ home' = "moved"
    /\ UNCHANGED <<clean, procs, named, mapping, unsafe>>
\* A moved home is started again from its new path: its processes do not name the
\* recorded path (the residual the rule cannot see).
StartMoved ==
    /\ home = "moved" /\ ~procs
    /\ procs' = TRUE /\ named' = FALSE /\ clean' = FALSE
    /\ UNCHANGED <<home, mapping, unsafe>>
\* Another home is created at the recorded path.
Replace ==
    /\ home = "deleted" /\ home' = "replaced"
    /\ UNCHANGED <<clean, procs, named, mapping, unsafe>>
\* The home's processes exit (after a stop, a crash, or the VM's end).
Exit ==
    /\ procs /\ procs' = FALSE /\ named' = FALSE
    /\ UNCHANGED <<home, clean, mapping, unsafe>>
\* A clean stop from a present home.
Stop ==
    /\ home = "present" /\ procs
    /\ procs' = FALSE /\ named' = FALSE /\ clean' = TRUE
    /\ UNCHANGED <<home, mapping, unsafe>>

\* --- Commands ----------------------------------------------------------------
\* Today's release: from the home's records of a clean stop (`releaseNativeProjectRunForeignHome`).
CleanRelease ==
    /\ mapping = "held" /\ home = "present" /\ clean /\ ~procs
    /\ mapping' = "released"
    /\ UNCHANGED <<home, clean, procs, named, unsafe>>
\* This change: the path no longer holds the home, and the process scan finds no
\* process naming it (`releaseNativeProjectRunGoneHome`).
GoneHomeRelease ==
    /\ GoneRelease
    /\ mapping = "held" /\ home /= "present"
    /\ PathOnly \/ ~(procs /\ named)
    /\ mapping' = "released" /\ unsafe' = (procs /\ named)
    /\ UNCHANGED <<home, clean, procs, named>>

Release == CleanRelease \/ GoneHomeRelease
Next == Delete \/ Move \/ StartMoved \/ Replace \/ Exit \/ Stop \/ Release
Spec == Init /\ [][Next]_vars

\* Never release a mapping while a process of its home that names the path lives.
NeverReleaseLive == ~unsafe
\* A mapping whose home is gone, with no process of it alive, can always be released.
NoStrandedMapping ==
    (mapping = "held" /\ home /= "present" /\ ~procs) => ENABLED Release
=============================================================================
