---------------- MODULE Publication ----------------
EXTENDS Naturals
CONSTANT UnsafeRetire
VARIABLES intent, directory, owned, process, guest, blocked
vars == <<intent, directory, owned, process, guest, blocked>>
Init == /\ intent = FALSE /\ directory = FALSE /\ owned = FALSE
        /\ process = "launcher" /\ guest = TRUE /\ blocked = FALSE
Record == /\ guest /\ ~intent /\ process = "launcher" /\ intent' = TRUE
          /\ UNCHANGED <<directory, owned, process, guest, blocked>>
Create == /\ intent /\ ~directory /\ process = "launcher" /\ directory' = TRUE
          /\ UNCHANGED <<intent, owned, process, guest, blocked>>
RecordDirectory == /\ intent /\ directory /\ ~owned /\ process = "launcher" /\ owned' = TRUE
                   /\ UNCHANGED <<intent, directory, process, guest, blocked>>
Exec == /\ intent /\ directory /\ owned /\ process = "launcher" /\ process' = "native"
        /\ UNCHANGED <<intent, directory, owned, guest, blocked>>
Exit == /\ process # "dead" /\ process' = "dead"
        /\ UNCHANGED <<intent, directory, owned, guest, blocked>>
Unexpected == /\ directory /\ ~blocked /\ blocked' = TRUE
              /\ UNCHANGED <<intent, directory, owned, process, guest>>
Retire == /\ intent /\ (process = "dead" \/ UnsafeRetire)
          /\ (~directory \/ (owned /\ ~blocked))
          /\ intent' = FALSE /\ directory' = FALSE /\ owned' = FALSE
          /\ UNCHANGED <<process, guest, blocked>>
Down == /\ guest /\ ~intent /\ process # "native" /\ guest' = FALSE
        /\ UNCHANGED <<intent, directory, owned, process, blocked>>
Next == Record \/ Create \/ RecordDirectory \/ Exec \/ Exit \/ Unexpected \/ Retire \/ Down
Safe == /\ (process = "native" => intent /\ directory /\ owned /\ guest)
        /\ (blocked => directory)
Spec == Init /\ [][Next]_vars
====================================================
