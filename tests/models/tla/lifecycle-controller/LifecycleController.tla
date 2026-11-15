------------------------- MODULE LifecycleController -------------------------
EXTENDS Naturals
CONSTANTS SkipEpochFence, SkipPendingFence
VARIABLES stage, token, epoch, creatorEpoch, adopted, live, pending,
          nativePublished, stopped, unsafeStop, unsafeLaunch, unknown
vars == <<stage, token, epoch, creatorEpoch, adopted, live, pending,
          nativePublished, stopped, unsafeStop, unsafeLaunch, unknown>>

Init == /\ stage = "Idle" /\ token = 0 /\ epoch = 0 /\ creatorEpoch = 0
        /\ adopted = FALSE /\ live = FALSE /\ pending = FALSE
        /\ nativePublished = FALSE /\ stopped = FALSE
        /\ unsafeStop = FALSE /\ unsafeLaunch = FALSE /\ unknown = FALSE

Begin == /\ stage = "Idle" /\ ~stopped
         /\ stage' = "Starting" /\ token' = 1
         /\ epoch' = 1 /\ creatorEpoch' = 1
         /\ UNCHANGED <<adopted, live, pending, nativePublished, stopped,
                         unsafeStop, unsafeLaunch, unknown>>
PublishPending == /\ stage = "Starting" /\ ~pending
                  /\ pending' = TRUE
                  /\ UNCHANGED <<stage, token, epoch, creatorEpoch, adopted,
                                  live, nativePublished, stopped, unsafeStop,
                                  unsafeLaunch, unknown>>
Launch == /\ stage = "Starting" /\ (pending \/ SkipPendingFence)
          /\ stage' = "AwaitReply" /\ live' = TRUE
          /\ unsafeLaunch' = (unsafeLaunch \/ ~pending)
          /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, pending,
                          nativePublished, stopped, unsafeStop, unknown>>
Accept == /\ stage = "AwaitReply"
          /\ stage' = "Ready" /\ nativePublished' = TRUE
          /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, live, pending,
                          stopped, unsafeStop, unsafeLaunch, unknown>>
LoseReply == /\ stage = "AwaitReply"
             /\ stage' = "InspectLate"
             /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, live, pending,
                             nativePublished, stopped, unsafeStop,
                             unsafeLaunch, unknown>>
PublishLate == /\ stage = "InspectLate" /\ live
               /\ stage' = "LatePublished" /\ nativePublished' = TRUE
               /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, live,
                               pending, stopped, unsafeStop, unsafeLaunch, unknown>>
FailUnknown == /\ stage = "LatePublished" /\ nativePublished
               /\ stage' = "Failed" /\ unknown' = TRUE
               /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, live,
                               pending, nativePublished, stopped,
                               unsafeStop, unsafeLaunch>>
Adopt == /\ stage \in {"Ready", "Failed"} /\ live /\ ~adopted
         /\ epoch = 1 /\ stage' = "Adopted" /\ epoch' = 2
         /\ adopted' = TRUE
         /\ UNCHANGED <<token, creatorEpoch, live, pending, nativePublished,
                         stopped, unsafeStop, unsafeLaunch, unknown>>
Abort == /\ stage \in {"Ready", "Failed", "Adopted"} /\ live
         /\ (epoch = creatorEpoch \/ SkipEpochFence)
         /\ stage' = "Aborted" /\ live' = FALSE
         /\ unsafeStop' = (unsafeStop \/ (epoch # creatorEpoch))
         /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, pending,
                         nativePublished, stopped, unsafeLaunch, unknown>>
Stop == /\ stage \in {"Ready", "Failed", "Adopted"}
        /\ stage' = "Stopped" /\ live' = FALSE /\ stopped' = TRUE
        /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, pending,
                        nativePublished, unsafeStop, unsafeLaunch, unknown>>
Add == /\ stage = "Adopted" /\ live /\ ~stopped
       /\ stage' = "AwaitReply" /\ nativePublished' = FALSE /\ unknown' = FALSE
       /\ UNCHANGED <<token, epoch, creatorEpoch, adopted, live, pending,
                       stopped, unsafeStop, unsafeLaunch>>
Next == Begin \/ PublishPending \/ Launch \/ Accept \/ LoseReply
        \/ PublishLate \/ FailUnknown \/ Adopt \/ Abort \/ Stop \/ Add
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in {"Idle", "Starting", "AwaitReply", "Ready", "InspectLate",
                        "LatePublished", "Failed", "Adopted", "Aborted", "Stopped"}
          /\ token \in 0..1 /\ epoch \in 0..2 /\ creatorEpoch \in 0..1
          /\ \A b \in {adopted, live, pending, nativePublished, stopped,
                         unsafeStop, unsafeLaunch, unknown} : b \in BOOLEAN
NoAdoptedStop == ~unsafeStop
DurableBeforeLaunch == ~unsafeLaunch
LateFailurePublished == unknown => nativePublished
StoppedPreventsAdd == stopped => ~live
StableNativeOwner == (epoch > 0) => token = 1
=============================================================================
