------------------------- MODULE DigestCache -------------------------
(***************************************************************************)
(* Per-process executable digest cache (src/backends/native-executable-  *)
(* hash.ts). A file has content, an inode and a change time that the     *)
(* filesystem stamps from a coarse clock: two writes in one clock tick   *)
(* get the same ctime. Size and mtime are folded into the ctime stamp:   *)
(* an in-place same-size write is the case where they do not help.       *)
(*                                                                       *)
(* A hash is a read with a stat before and after; the after-stat must    *)
(* equal the before-stat or the result is refused. The cache keys a       *)
(* digest on that stat and returns it while a fresh stat still matches.  *)
(* RacyGuard: store only when the file's ctime is older than the tick in *)
(* which the read began.                                                 *)
(***************************************************************************)
EXTENDS Naturals, TLC
CONSTANTS RacyGuard, MaxClock, MaxWrites
VARIABLES clock, content, ino, ctime, writes,
          phase, startId, startContent, startClock,
          cache, staleHit
vars == <<clock, content, ino, ctime, writes, phase, startId, startContent,
          startClock, cache, staleHit>>

Id == <<ino, ctime>>
None == <<0, 0, 0>>

Init == /\ clock = 1 /\ content = 0 /\ ino = 1 /\ ctime = 0 /\ writes = 0
        /\ phase = "idle" /\ startId = <<0, 0>> /\ startContent = 0
        /\ startClock = 0 /\ cache = None /\ staleHit = FALSE

Tick == /\ clock < MaxClock /\ clock' = clock + 1
        /\ UNCHANGED <<content, ino, ctime, writes, phase, startId,
                       startContent, startClock, cache, staleHit>>

\* In-place same-size write (for example cp over the file).
WriteInPlace == /\ writes < MaxWrites
                /\ content' = content + 1 /\ ctime' = clock
                /\ writes' = writes + 1
                /\ UNCHANGED <<clock, ino, phase, startId, startContent,
                               startClock, cache, staleHit>>

\* Atomic replacement (rename of a new file): a new inode.
Replace == /\ writes < MaxWrites
           /\ content' = content + 1 /\ ino' = ino + 1 /\ ctime' = clock
           /\ writes' = writes + 1
           /\ UNCHANGED <<clock, phase, startId, startContent, startClock,
                          cache, staleHit>>

\* A lookup whose fresh stat matches the cached key returns its digest.
CacheHit == /\ phase = "idle" /\ cache # None
            /\ <<cache[1], cache[2]>> = Id
            /\ staleHit' = (staleHit \/ cache[3] # content)
            /\ UNCHANGED <<clock, content, ino, ctime, writes, phase, startId,
                           startContent, startClock, cache>>

\* A miss reads the file: before-stat, then the content.
BeginRead == /\ phase = "idle"
             /\ (cache = None \/ <<cache[1], cache[2]>> # Id)
             /\ phase' = "reading" /\ startId' = Id
             /\ startContent' = content /\ startClock' = clock
             /\ UNCHANGED <<clock, content, ino, ctime, writes, cache, staleHit>>

\* After-stat equal: the digest of what was read is returned; it is cached
\* only when the racy guard admits it.
FinishRead == /\ phase = "reading" /\ Id = startId
              /\ phase' = "idle"
              /\ cache' = IF ~RacyGuard \/ startId[2] < startClock
                             THEN <<startId[1], startId[2], startContent>>
                             ELSE cache
              /\ UNCHANGED <<clock, content, ino, ctime, writes, startId,
                             startContent, startClock, staleHit>>

\* After-stat differs: refused, nothing cached.
RefuseRead == /\ phase = "reading" /\ Id # startId
              /\ phase' = "idle"
              /\ UNCHANGED <<clock, content, ino, ctime, writes, startId,
                             startContent, startClock, cache, staleHit>>

Next == Tick \/ WriteInPlace \/ Replace \/ CacheHit \/ BeginRead
        \/ FinishRead \/ RefuseRead
Spec == Init /\ [][Next]_vars

TypeOK == /\ clock \in 1..MaxClock /\ writes \in 0..MaxWrites
          /\ phase \in {"idle", "reading"} /\ staleHit \in BOOLEAN
\* A cache hit always returns the digest of the file's current content.
CacheNeverStale == ~staleHit
=============================================================================
