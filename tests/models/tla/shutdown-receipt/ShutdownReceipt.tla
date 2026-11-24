------------------------ MODULE ShutdownReceipt ------------------------
CONSTANT SkipReceiptWrite
VARIABLES phase, receiptId, shutdownId, compute
vars == <<phase, receiptId, shutdownId, compute>>

Init == /\ phase = "CreateLost"
        /\ receiptId = "none" /\ shutdownId = "none" /\ compute = "owned"

BeginCleanup == /\ phase = "CreateLost" /\ phase' = "CleanupIntent"
                /\ UNCHANGED <<receiptId, shutdownId, compute>>

\* Both preflight and terminal observations verify ownership and the same ID.
ObserveTerminal == /\ phase = "CleanupIntent" /\ compute = "owned"
                   /\ phase' = "TerminalObserved"
                   /\ UNCHANGED <<receiptId, shutdownId, compute>>

\* Pending writes are never promoted. A crash before rename has the old value.
WriteReceipt == /\ phase = "TerminalObserved" /\ phase' = "ReceiptWritten"
                /\ receiptId' = IF SkipReceiptWrite THEN receiptId ELSE "original"
                /\ UNCHANGED <<shutdownId, compute>>

WriteShutdown == /\ phase = "ReceiptWritten" /\ phase' = "ShutdownWritten"
                 /\ shutdownId' = "original"
                 /\ UNCHANGED <<receiptId, compute>>

RemoveCompute == /\ phase = "ShutdownWritten" /\ phase' = "ComputeAbsent"
                 /\ compute' = "absent"
                 /\ UNCHANGED <<receiptId, shutdownId>>

RetryAbsent == /\ phase = "CleanupIntent" /\ compute = "absent"
               /\ phase' = "ComputeAbsent"
               /\ UNCHANGED <<receiptId, shutdownId, compute>>

FinishCleanup == /\ phase = "ComputeAbsent" /\ phase' = "Stopped"
                 /\ UNCHANGED <<receiptId, shutdownId, compute>>

Crash == /\ phase \in {"TerminalObserved", "ReceiptWritten", "ShutdownWritten",
                       "ComputeAbsent"}
         /\ phase' = "CleanupIntent"
         /\ UNCHANGED <<receiptId, shutdownId, compute>>

ReplaceAtName == /\ phase = "Stopped" /\ compute = "absent"
                 /\ compute' = "replacement"
                 /\ UNCHANGED <<phase, receiptId, shutdownId>>

\* Restore verifies old-ID and name absence and then matches the terminal ID.
Restore == /\ phase = "Stopped" /\ compute = "absent"
           /\ receiptId = shutdownId /\ phase' = "Restored"
           /\ UNCHANGED <<receiptId, shutdownId, compute>>

Refuse == /\ phase = "Stopped" /\ (compute # "absent" \/ receiptId # shutdownId)
          /\ phase' = "Refused"
          /\ UNCHANGED <<receiptId, shutdownId, compute>>

Next == BeginCleanup \/ ObserveTerminal \/ WriteReceipt \/ WriteShutdown
        \/ RemoveCompute \/ RetryAbsent \/ FinishCleanup \/ Crash
        \/ ReplaceAtName \/ Restore \/ Refuse
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"CreateLost", "CleanupIntent", "TerminalObserved",
                        "ReceiptWritten", "ShutdownWritten", "ComputeAbsent",
                        "Stopped", "Restored", "Refused"}
          /\ receiptId \in {"none", "original"}
          /\ shutdownId \in {"none", "original"}
          /\ compute \in {"owned", "absent", "replacement"}
IdentifiableByRestore == shutdownId # "none" => receiptId = shutdownId
RestoreRequiresAbsence == phase = "Restored" => compute = "absent"
NeverRestored == phase # "Restored"
========================================================================
