---- MODULE KeeperReclaim ----
CONSTANT UnsafeFence
VARIABLES fence, keeper, tagged
vars == <<fence, keeper, tagged>>
Init == /\ fence = "free" /\ keeper = TRUE /\ tagged = FALSE
BeginPin == /\ fence = "free" /\ keeper
            /\ fence' = "pinning" /\ UNCHANGED <<keeper, tagged>>
PublishPin == /\ fence = "pinning" /\ keeper
              /\ tagged' = TRUE /\ fence' = "free" /\ UNCHANGED keeper
Reclaim == /\ fence = "free" \/ UnsafeFence
           /\ keeper /\ ~tagged
           /\ keeper' = FALSE /\ UNCHANGED <<fence, tagged>>
Next == BeginPin \/ PublishPin \/ Reclaim
Spec == Init /\ [][Next]_vars
PinPreservesImage == (fence = "pinning" \/ tagged) => keeper
====
