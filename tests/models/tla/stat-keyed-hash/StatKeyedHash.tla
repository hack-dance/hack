------------------------------ MODULE StatKeyedHash ------------------------------
(* Stat-keyed file hashes for the step store (HACK-2461). A content hash is
   reused when the file's stat key is unchanged (BuildKit's contenthash /
   fsutil idea, and git's index). One file, two contents of the same size, a coarse clock.
   - Write: an ordinary edit sets mtime and ctime to now.
   - SetMtime: tools that restore mtimes (git checkout of an old tree, rsync -t,
     tar -x, touch -d) move mtime anywhere; ctime still becomes now and cannot
     be set by user code.
   The hasher is not atomic: stat, read, stat again, then store.
   Negative controls: KeyWithCtime = FALSE (size + mtime only, as fsutil's
   receiver compares, vendor/github.com/tonistiigi/fsutil/diff_containerd.go)
   and RacyCheck = FALSE (store even when the file changed in the current
   clock tick, the case git calls "racily clean"). *)
EXTENDS Naturals

CONSTANTS MaxT, KeyWithCtime, RacyCheck, RacyAtStat

Contents == {"A", "B"}
VARIABLES now, content, mtime, ctime, entry, pc, before, readv, statAt

vars == <<now, content, mtime, ctime, entry, pc, before, readv, statAt>>

Key(m, c) == IF KeyWithCtime THEN <<m, c>> ELSE <<m, 0>>
NoEntry == [valid |-> FALSE, key |-> <<0, 0>>, hash |-> "A"]

Init ==
  /\ now = 1
  /\ content = "A"
  /\ mtime = 0
  /\ ctime = 0
  /\ entry = NoEntry
  /\ pc = "idle"
  /\ before = <<0, 0>>
  /\ readv = "A"
  /\ statAt = 0

Tick ==
  /\ now < MaxT
  /\ now' = now + 1
  /\ UNCHANGED <<content, mtime, ctime, entry, pc, before, readv, statAt>>

Write ==
  /\ \E v \in Contents : content' = v
  /\ mtime' = now
  /\ ctime' = now
  /\ UNCHANGED <<now, entry, pc, before, readv, statAt>>

SetMtime ==
  /\ \E m \in 0..now : mtime' = m
  /\ ctime' = now
  /\ UNCHANGED <<now, content, entry, pc, before, readv, statAt>>

HashStat ==
  /\ pc = "idle"
  /\ before' = Key(mtime, ctime)
  /\ statAt' = now
  /\ pc' = "statted"
  /\ UNCHANGED <<now, content, mtime, ctime, entry, readv>>

HashRead ==
  /\ pc = "statted"
  /\ readv' = content
  /\ pc' = "read"
  /\ UNCHANGED <<now, content, mtime, ctime, entry, before, statAt>>

\* Store only if the stat key did not move while reading and, with RacyCheck,
\* the file's times are strictly older than the clock tick of the FIRST stat
\* (RacyAtStat). A write in that tick leaves an identical key. Comparing with
\* the clock at store time (RacyAtStat = FALSE) is the trap TLC found first.
HashStore ==
  /\ pc = "read"
  /\ entry' = IF before = Key(mtime, ctime) /\ (RacyCheck => LET t == IF RacyAtStat THEN statAt ELSE now IN ctime < t /\ mtime < t)
                THEN [valid |-> TRUE, key |-> before, hash |-> readv]
                ELSE entry
  /\ pc' = "idle"
  /\ UNCHANGED <<now, content, mtime, ctime, before, readv, statAt>>

Next == Tick \/ Write \/ SetMtime \/ HashStat \/ HashRead \/ HashStore

Spec == Init /\ [][Next]_vars

\* Whenever a lookup would hit (stored key equals the file's key now), the
\* stored hash is the hash of the current content.
HitIsFresh ==
  (entry.valid /\ entry.key = Key(mtime, ctime)) => entry.hash = content

\* Sanity: a cache hit is reachable.
NeverHits == ~(entry.valid /\ entry.key = Key(mtime, ctime))
=============================================================================
