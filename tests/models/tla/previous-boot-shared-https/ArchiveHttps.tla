---------------------------- MODULE ArchiveHttps ----------------------------
EXTENDS TLC, FiniteSets
CONSTANTS KeepCrashBarrier, CheckSelection, CheckProof
VARIABLES admission, engine, recovery, crashed, intent, selected, version,
          eligible, originals, archived, complete, finalized, published,
          unsafeArchive, unsafePublication
vars == <<admission, engine, recovery, crashed, intent, selected, version,
          eligible, originals, archived, complete, finalized, published,
          unsafeArchive, unsafePublication>>
Artifacts == {"owner", "socket"}
Init == /\ admission = "free" /\ engine = FALSE /\ recovery = FALSE
        /\ crashed = FALSE /\ intent = FALSE /\ selected = 0 /\ version = 1
        /\ eligible \in BOOLEAN /\ originals = Artifacts /\ archived = {}
        /\ complete = FALSE /\ finalized = FALSE /\ published = FALSE
        /\ unsafeArchive = FALSE /\ unsafePublication = FALSE
AcquireAdmission == /\ admission = "free" /\ ~intent /\ ~published
                    /\ admission' = "recovery" /\ recovery' = TRUE
                    /\ UNCHANGED <<engine, crashed, intent, selected, version,
                         eligible, originals, archived, complete, finalized,
                         published, unsafeArchive, unsafePublication>>
AcquireEngine == /\ admission = "recovery" /\ recovery /\ ~engine
                 /\ engine' = TRUE
                 /\ UNCHANGED <<admission, recovery, crashed, intent, selected,
                      version, eligible, originals, archived, complete,
                      finalized, published, unsafeArchive, unsafePublication>>
Prepare == /\ admission = "recovery" /\ recovery /\ engine /\ ~intent
           /\ (eligible \/ ~CheckProof)
           /\ intent' = TRUE /\ selected' = version
           /\ UNCHANGED <<admission, engine, recovery, crashed, version,
                eligible, originals, archived, complete, finalized, published,
                unsafeArchive, unsafePublication>>
ArchiveOwner == /\ admission = "recovery" /\ recovery /\ engine /\ intent
                /\ "owner" \in originals
                /\ (selected = version \/ ~CheckSelection)
                /\ originals' = originals \ {"owner"}
                /\ archived' = archived \cup {"owner"}
                /\ unsafeArchive' = (~eligible \/ selected # version)
                /\ UNCHANGED <<admission, engine, recovery, crashed, intent,
                     selected, version, eligible, complete, finalized,
                     published, unsafePublication>>
ArchiveSocket == /\ admission = "recovery" /\ recovery /\ engine /\ intent
                 /\ "socket" \in originals
                 /\ (selected = version \/ ~CheckSelection)
                 /\ originals' = originals \ {"socket"}
                 /\ archived' = archived \cup {"socket"}
                 /\ unsafeArchive' = (~eligible \/ selected # version)
                 /\ UNCHANGED <<admission, engine, recovery, crashed, intent,
                      selected, version, eligible, complete, finalized,
                      published, unsafePublication>>
Commit == /\ admission = "recovery" /\ recovery /\ engine /\ intent
          /\ archived = Artifacts /\ eligible /\ selected = version
          /\ complete' = TRUE /\ engine' = FALSE /\ recovery' = FALSE
          /\ admission' = "free"
          /\ UNCHANGED <<crashed, intent, selected, version, eligible,
               originals, archived, finalized, published, unsafeArchive,
               unsafePublication>>
Crash == /\ admission = "recovery" /\ recovery /\ ~crashed
         /\ crashed' = TRUE /\ engine' = FALSE /\ recovery' = FALSE
         /\ admission' = IF KeepCrashBarrier THEN "recovery" ELSE "free"
         /\ UNCHANGED <<intent, selected, version, eligible, originals,
              archived, complete, finalized, published, unsafeArchive,
              unsafePublication>>
Resume == /\ admission = "recovery" /\ ~recovery /\ crashed /\ ~complete
          /\ recovery' = TRUE
          /\ UNCHANGED <<admission, engine, crashed, intent, selected, version,
               eligible, originals, archived, complete, finalized, published,
               unsafeArchive, unsafePublication>>
ChangeInputs == /\ version = 1 /\ ~engine /\ ~complete
                /\ version' = 2
                /\ UNCHANGED <<admission, engine, recovery, crashed, intent,
                     selected, eligible, originals, archived, complete,
                     finalized, published, unsafeArchive, unsafePublication>>
Finalize == /\ complete /\ selected = version /\ ~finalized
            /\ finalized' = TRUE
            /\ UNCHANGED <<admission, engine, recovery, crashed, intent,
                 selected, version, eligible, originals, archived, complete,
                 published, unsafeArchive, unsafePublication>>
AcquireStartup == /\ admission = "free" /\ "owner" \notin originals
                  /\ ~published
                  /\ admission' = "startup"
                  /\ UNCHANGED <<engine, recovery, crashed, intent, selected,
                       version, eligible, originals, archived, complete,
                       finalized, published, unsafeArchive, unsafePublication>>
Publish == /\ admission = "startup" /\ ~published
           /\ published' = TRUE /\ admission' = "free"
           /\ unsafePublication' = (~complete \/ archived # Artifacts)
           /\ UNCHANGED <<engine, recovery, crashed, intent, selected, version,
                eligible, originals, archived, complete, finalized,
                unsafeArchive>>
Next == AcquireAdmission \/ AcquireEngine \/ Prepare \/ ArchiveOwner
        \/ ArchiveSocket \/ Commit \/ Crash \/ Resume \/ ChangeInputs
        \/ Finalize \/ AcquireStartup \/ Publish
Spec == Init /\ [][Next]_vars
TypeOK == /\ admission \in {"free", "recovery", "startup"}
          /\ {engine, recovery, crashed, intent, eligible, complete, finalized,
                published, unsafeArchive, unsafePublication} \subseteq BOOLEAN
          /\ selected \in {0, 1, 2} /\ version \in {1, 2}
          /\ originals \subseteq Artifacts /\ archived \subseteq Artifacts
PreserveArtifacts == /\ originals \cup archived = Artifacts
                     /\ originals \cap archived = {}
NoUnprovedArchive == ~unsafeArchive
NoPrematurePublication == ~unsafePublication
=============================================================================
