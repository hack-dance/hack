---------------------------- MODULE Retirement ----------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS CheckSettlement, CheckRemoval, CheckFreshness, CheckSession,
          CheckClaim, CheckRetirement, Interference, Crashes
VARIABLES owner, used, phase, exited, reader, group, producerSettled,
          receipt, proof, fresh, source, hard, session,
          stopRequested, hostGone, retired, recovered,
          unsafeSettlement, unsafeRemoval, unsafeFreshness, unsafeSession,
          unsafeClaim, unsafeRetire
bad == <<unsafeSettlement, unsafeRemoval, unsafeFreshness, unsafeSession,
         unsafeClaim, unsafeRetire>>
process == <<exited, reader, group, producerSettled>>
authority == <<receipt, proof, fresh, source, hard, session>>
effect == <<stopRequested, hostGone, retired>>
vars == <<owner, used, phase, process, authority, effect, recovered, bad>>
Init == /\ owner = 0 /\ used = {} /\ phase = "idle"
        /\ exited = FALSE /\ reader = "pending" /\ group = "unknown"
        /\ producerSettled = FALSE /\ receipt = "live" /\ proof = "none"
        /\ fresh = FALSE /\ source = 1 /\ hard = FALSE /\ session = TRUE
        /\ stopRequested = FALSE /\ hostGone = FALSE /\ retired = FALSE
        /\ recovered = FALSE
        /\ unsafeSettlement = FALSE /\ unsafeRemoval = FALSE
        /\ unsafeFreshness = FALSE /\ unsafeSession = FALSE
        /\ unsafeClaim = FALSE /\ unsafeRetire = FALSE
Acquire(a) ==
    /\ owner = 0 /\ a \in {1,2} \ used
    /\ owner' = a /\ used' = used \cup {a} /\ phase' = "running"
    /\ exited' = FALSE /\ reader' = "pending" /\ group' = "unknown"
    /\ producerSettled' = FALSE /\ receipt' = "live" /\ proof' = "none"
    /\ fresh' = FALSE /\ source' = 1 /\ hard' = FALSE /\ session' = TRUE
    /\ stopRequested' = FALSE /\ hostGone' = FALSE /\ retired' = FALSE
    /\ recovered' = FALSE /\ UNCHANGED bad
FailStartup ==
    /\ phase = "running" /\ phase' = "failed"
    /\ UNCHANGED <<owner, used, process, authority, effect, recovered, bad>>
ExitProducer ==
    /\ phase \in {"failed","crashed"} /\ ~exited /\ exited' = TRUE
    /\ UNCHANGED <<owner,used,phase,reader,group,producerSettled,
                    authority,effect,recovered,bad>>
SettleReader ==
    /\ phase \in {"failed","crashed"} /\ reader = "pending"
    /\ reader' \in {"eof","canceled"}
    /\ UNCHANGED <<owner,used,phase,exited,group,producerSettled,
                    authority,effect,recovered,bad>>
ObserveGroupAbsent ==
    /\ phase \in {"failed","crashed"} /\ exited /\ group # "absent"
    /\ group' = "absent"
    /\ UNCHANGED <<owner,used,phase,exited,reader,producerSettled,
                    authority,effect,recovered,bad>>
MarkProducerSettled ==
    /\ phase = "failed" /\ exited /\ reader # "pending" /\ group = "absent"
    /\ ~producerSettled /\ producerSettled' = TRUE
    /\ UNCHANGED <<owner,used,phase,exited,reader,group,authority,
                    effect,recovered,bad>>
PublishRemoved ==
    /\ phase \in {"failed","crashed"} /\ exited /\ receipt = "live"
    /\ receipt' = "removed"
    /\ UNCHANGED <<owner,used,phase,process,proof,fresh,source,hard,session,
                    effect,recovered,bad>>
Inspect ==
    /\ phase = "failed" /\ proof # receipt /\ proof' = receipt
    /\ UNCHANGED <<owner,used,phase,process,receipt,fresh,source,hard,session,
                    effect,recovered,bad>>
RefreshHardInputs ==
    /\ phase = "failed" /\ ~hard /\ source = 1 /\ ~fresh /\ fresh' = TRUE
    /\ UNCHANGED <<owner,used,phase,process,receipt,proof,source,hard,session,
                    effect,recovered,bad>>
ReplaceSource ==
    /\ Interference /\ phase \in {"failed","crashed"} /\ source = 1
    /\ source' = 2
    /\ UNCHANGED <<owner,used,phase,process,receipt,proof,fresh,hard,session,
                    effect,recovered,bad>>
ReplaceSession ==
    /\ Interference /\ phase \in {"failed","crashed"} /\ session
    /\ session' = FALSE
    /\ UNCHANGED <<owner,used,phase,process,receipt,proof,fresh,source,hard,
                    effect,recovered,bad>>
ReplaceReceipt ==
    /\ Interference /\ phase \in {"failed","crashed"} /\ receipt # "foreign"
    /\ receipt' = "foreign"
    /\ UNCHANGED <<owner,used,phase,process,proof,fresh,source,hard,session,
                    effect,recovered,bad>>
HardCancel ==
    /\ Interference /\ phase \in {"failed","crashed"} /\ ~hard
    /\ hard' = TRUE
    /\ UNCHANGED <<owner,used,phase,process,receipt,proof,fresh,source,session,
                    effect,recovered,bad>>
Crash ==
    /\ Crashes /\ phase = "failed" /\ ~recovered /\ phase' = "crashed"
    /\ fresh' = FALSE /\ proof' = "none" /\ producerSettled' = FALSE
    /\ UNCHANGED <<owner,used,exited,reader,group,receipt,source,hard,session,
                    effect,recovered,bad>>
Recover ==
    /\ phase = "crashed" /\ exited /\ reader # "pending" /\ group = "absent"
    /\ receipt = "removed" /\ source = 1 /\ ~hard /\ session
    /\ phase' = "failed" /\ recovered' = TRUE
    /\ UNCHANGED <<owner,used,process,authority,effect,bad>>
RemovalMatches == proof = "removed" /\ receipt = "removed"
InputsMatch == fresh /\ source = 1 /\ ~hard
RequestHostStop(a) ==
    /\ phase = "failed" /\ a \in used /\ ~stopRequested
    /\ (CheckSettlement => producerSettled)
    /\ (CheckRemoval => RemovalMatches)
    /\ (CheckFreshness => InputsMatch)
    /\ (CheckSession => session)
    /\ (CheckClaim => a = owner)
    /\ stopRequested' = TRUE
    /\ unsafeSettlement' = ~producerSettled
    /\ unsafeRemoval' = ~RemovalMatches
    /\ unsafeFreshness' = ~InputsMatch
    /\ unsafeSession' = ~session
    /\ unsafeClaim' = (a # owner)
    /\ UNCHANGED <<owner,used,phase,process,authority,hostGone,retired,
                    recovered,unsafeRetire>>
ConfirmHostExit ==
    /\ phase = "failed" /\ stopRequested /\ ~hostGone /\ hostGone' = TRUE
    /\ UNCHANGED <<owner,used,phase,process,authority,stopRequested,retired,
                    recovered,bad>>
Retire ==
    /\ phase = "failed" /\ stopRequested /\ producerSettled /\ RemovalMatches
    /\ (CheckRetirement => hostGone)
    /\ owner' = 0 /\ phase' = "idle" /\ retired' = TRUE
    /\ unsafeRetire' = ~hostGone
    /\ UNCHANGED <<used,process,authority,stopRequested,hostGone,recovered,
                    unsafeSettlement,unsafeRemoval,unsafeFreshness,
                    unsafeSession,unsafeClaim>>
Next == (\E a \in {1,2}: Acquire(a) \/ RequestHostStop(a))
        \/ FailStartup \/ ExitProducer \/ SettleReader \/ ObserveGroupAbsent
        \/ MarkProducerSettled \/ PublishRemoved \/ Inspect \/ RefreshHardInputs
        \/ ReplaceSource \/ ReplaceSession \/ ReplaceReceipt \/ HardCancel
        \/ Crash \/ Recover \/ ConfirmHostExit \/ Retire
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(FailStartup) /\ WF_vars(ExitProducer)
            /\ WF_vars(SettleReader) /\ WF_vars(ObserveGroupAbsent)
            /\ WF_vars(MarkProducerSettled) /\ WF_vars(PublishRemoved)
            /\ WF_vars(Inspect) /\ WF_vars(RefreshHardInputs)
            /\ WF_vars(\E a \in {1,2}: RequestHostStop(a))
            /\ WF_vars(ConfirmHostExit) /\ WF_vars(Retire)
TypeOK == /\ owner \in 0..2 /\ used \subseteq {1,2}
          /\ phase \in {"idle","running","failed","crashed"}
          /\ exited \in BOOLEAN /\ reader \in {"pending","eof","canceled"}
          /\ group \in {"unknown","absent"} /\ producerSettled \in BOOLEAN
          /\ receipt \in {"live","removed","foreign"}
          /\ proof \in {"none","live","removed","foreign"}
          /\ fresh \in BOOLEAN /\ source \in {1,2} /\ hard \in BOOLEAN
          /\ session \in BOOLEAN /\ stopRequested \in BOOLEAN
          /\ hostGone \in BOOLEAN /\ retired \in BOOLEAN /\ recovered \in BOOLEAN
          /\ \A i \in 1..6: bad[i] \in BOOLEAN
Safe == bad = <<FALSE,FALSE,FALSE,FALSE,FALSE,FALSE>>
ConditionalCompletion == [](phase = "failed" => <>retired)
=============================================================================
