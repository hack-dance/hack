------------------------------ MODULE StepStore ------------------------------
(* Step store (HACK-2461): when may a command skip a step because a record
   says it was done, when may garbage collection delete a record, and which
   image digest does a command use for a mutable tag.
   One step of one class (constant Class):
     "cas"  pure; output stored by content address in the store, never
            changed in place (plan compile, normalized Compose)
     "slot" pure; output written to one path a later run may overwrite
            (generated override file); a skip compares the slot's digest
     "boot" lives in the VM; key carries the boot id; a skip needs one
            cheap observation (image loaded, probe binary present)
   - input: digest of everything the step reads; changes at any time.
   - world: outputs present, as <<input, epoch>>.
   - store: record keys. pc: effect then record; a crash can fall between.
   - pins: keys a running command holds (the shared store lock);
     held: the output the command took from a skip or a record and will use.
   - pruning: the key whose two-step deletion is in progress.
   Tag part: reg is the registry's digest for one tag; tag the stored
   resolution [d, age]; used the digest the running command took.
   Negative controls (each must break a named invariant):
     NoEpoch        the key omits the boot id
     RecordFirst    the record is written before the effect
     NoVerify       a record is trusted without an observation
     LateKey        the key uses the input read at record time
     NoPin          prune ignores pins
     ObjectFirst    prune deletes the output before the record
     IgnoreTTL      an expired tag record is used without re-resolving
     ResolvePerUse  every use inside one command resolves the tag again *)
EXTENDS Naturals

CONSTANTS Inputs, MaxBoot, Class, Drifts, TTL,
          NoEpoch, RecordFirst, NoVerify, LateKey, NoPin, ObjectFirst,
          IgnoreTTL, ResolvePerUse

VARIABLES input, boot, world, store, pc, cap, done, cmd, pins, held,
          pruning, reg, tag, used, pull, resolved, offline, bad
vars == <<input, boot, world, store, pc, cap, done, cmd, pins, held,
          pruning, reg, tag, used, pull, resolved, offline, bad>>

None == <<0, 0>>
Digests == {1, 2}
Flags == {"skip", "use", "mixed", "stale", "pull"}
Flag(k, c) == [bad EXCEPT ![k] = @ \/ c]
Epoch(b) == IF Class = "boot" THEN b ELSE 0
Key(i, b) == <<i, IF NoEpoch THEN 0 ELSE Epoch(b)>>
Out(i, b) == <<i, Epoch(b)>>
Present(i, b) == Out(i, b) \in world
Produce(i, b) == IF Class = "cas" THEN world \cup {Out(i, b)} ELSE {Out(i, b)}
\* A cas record is trusted alone; slot and boot records need one observation.
Usable == /\ Key(input, boot) \in store
          /\ (Class = "cas" \/ NoVerify \/ Present(input, boot))
RecVars == <<input, boot, world, store, pc, cap, done>>
GcVars == <<pins, held, pruning>>
TagVars == <<reg, tag, used, pull, resolved, offline>>

Init == /\ input \in Inputs /\ boot = 1 /\ world = {} /\ store = {}
        /\ pc = "idle" /\ cap = 0 /\ done = FALSE
        /\ cmd = "idle" /\ pins = {} /\ held = None /\ pruning = None
        /\ reg \in Digests /\ tag = [d |-> 0, age |-> 0] /\ used = 0
        /\ pull = FALSE /\ resolved = FALSE /\ offline = FALSE
        /\ bad = [k \in Flags |-> FALSE]

\* ---- Commands ----
BeginCmd(p) == /\ cmd = "idle" /\ cmd' = "running" /\ pull' = p
               /\ used' = 0 /\ resolved' = FALSE /\ offline' = FALSE
               /\ UNCHANGED <<RecVars, GcVars, reg, tag, bad>>
EndCmd == /\ cmd = "running" /\ pc = "idle"
          /\ cmd' = "idle" /\ pins' = {} /\ held' = None
          /\ UNCHANGED <<RecVars, pruning, TagVars, bad>>

\* ---- One step ----
Skip == /\ cmd = "running" /\ pc = "idle" /\ ~done /\ Usable
        /\ done' = TRUE
        /\ pins' = pins \cup {Key(input, boot)}
        /\ held' = Out(input, boot)
        /\ bad' = Flag("skip", ~Present(input, boot))
        /\ UNCHANGED <<input, boot, world, store, pc, cap, cmd, pruning,
                       TagVars>>
\* The command pins the key before it produces the output.
Execute == /\ cmd = "running" /\ pc = "idle" /\ ~done /\ ~Usable
           /\ cap' = input
           /\ pins' = pins \cup {Key(input, boot)}
           /\ IF RecordFirst
                THEN /\ store' = store \cup {Key(input, boot)}
                     /\ world' = world /\ pc' = "recorded"
                ELSE /\ world' = Produce(input, boot)
                     /\ store' = store /\ pc' = "effected"
           /\ UNCHANGED <<input, boot, done, cmd, held, pruning, TagVars, bad>>
\* The effect vanished before it could be recorded: run again.
RecordLost == /\ pc = "effected" /\ Class # "cas" /\ ~NoVerify
              /\ ~Present(cap, boot)
              /\ pc' = "idle" /\ done' = FALSE
              /\ UNCHANGED <<input, boot, world, store, cap, cmd, GcVars,
                             TagVars, bad>>
\* Written only after one observation confirms the effect.
\* The command pins what it recorded, as it pins what it skipped to.
Record == /\ pc = "effected"
          /\ (Class = "cas" \/ NoVerify \/ Present(cap, boot))
          /\ store' = store \cup {Key(IF LateKey THEN input ELSE cap, boot)}
          /\ pins' = pins \cup {Key(IF LateKey THEN input ELSE cap, boot)}
          /\ held' = Out(cap, boot)
          /\ pc' = "idle" /\ done' = (cap = input)
          /\ UNCHANGED <<input, boot, world, cap, cmd, pruning, TagVars, bad>>
EffectAfterRecord == /\ pc = "recorded"
                     /\ world' = Produce(cap, boot)
                     /\ pins' = pins \cup {Key(cap, boot)}
                     /\ held' = Out(cap, boot)
                     /\ pc' = "idle" /\ done' = (cap = input)
                     /\ UNCHANGED <<input, boot, store, cap, cmd, pruning,
                                    TagVars, bad>>
\* The output is used later in the same command (for example by a create).
Use == /\ cmd = "running" /\ held # None
       /\ held' = None
       /\ UNCHANGED <<RecVars, cmd, pins, pruning, TagVars, bad>>

\* ---- Garbage collection: record first, then the cas object ----
\* Only cas objects live in the store; pruning a slot or boot record never
\* touches the project file or the VM.
Objects(k) == IF Class = "cas" THEN {o \in world : o = k} ELSE {}
PruneStart(k) ==
  /\ pruning = None /\ k \in store /\ (NoPin \/ k \notin pins)
  /\ pruning' = k
  /\ IF ObjectFirst
       THEN /\ world' = world \ Objects(k) /\ store' = store
            /\ bad' = Flag("use", held \in Objects(k))
       ELSE /\ store' = store \ {k} /\ world' = world /\ bad' = bad
  /\ UNCHANGED <<input, boot, pc, cap, done, cmd, pins, held, TagVars>>
PruneFinish ==
  /\ pruning # None
  /\ IF ObjectFirst
       THEN /\ store' = store \ {pruning} /\ world' = world /\ bad' = bad
       ELSE \* Under the shard lock: delete the object only if no record
            \* or pin names it again (a writer may have made it again).
            LET gone == (NoPin \/ pruning \notin pins) /\ pruning \notin store
            IN /\ world' = IF gone THEN world \ Objects(pruning) ELSE world
               /\ store' = store
               /\ bad' = Flag("use", gone /\ held \in Objects(pruning))
  /\ pruning' = None
  /\ UNCHANGED <<input, boot, pc, cap, done, cmd, pins, held, TagVars>>

\* ---- The world ----
ChangeInput == /\ \E i \in Inputs \ {input} : input' = i
               /\ done' = FALSE
               /\ UNCHANGED <<boot, world, store, pc, cap, cmd, GcVars,
                              TagVars, bad>>
Reboot == /\ boot < MaxBoot /\ boot' = boot + 1
          /\ world' = IF Class = "boot" THEN {} ELSE world
          /\ pc' = "idle" /\ done' = FALSE /\ cmd' = "idle"
          /\ pins' = {} /\ held' = None
          /\ UNCHANGED <<input, store, cap, pruning, TagVars, bad>>
Drift == /\ Drifts /\ world # {}
         /\ world' = {} /\ done' = FALSE
         /\ UNCHANGED <<input, boot, store, pc, cap, cmd, GcVars, TagVars,
                        bad>>
\* The process dies: memory and flocks go; the store keeps what was renamed.
Crash == /\ cmd = "running"
         /\ pc' = "idle" /\ done' = FALSE /\ cmd' = "idle"
         /\ pins' = {} /\ held' = None
         /\ UNCHANGED <<input, boot, world, store, cap, pruning, TagVars,
                        bad>>

\* ---- Tag resolution ----
MoveTag == /\ reg' = 3 - reg
           /\ UNCHANGED <<RecVars, cmd, GcVars, tag, used, pull, resolved,
                          offline, bad>>
Tick == /\ tag.d # 0 /\ tag.age <= TTL
        /\ tag' = [tag EXCEPT !.age = @ + 1]
        /\ UNCHANGED <<RecVars, cmd, GcVars, reg, used, pull, resolved,
                       offline, bad>>
NeedsResolve == tag.d = 0 \/ pull \/ (tag.age > TTL /\ ~IgnoreTTL)
Resolve == /\ cmd = "running" /\ used = 0 /\ ~resolved /\ NeedsResolve
           /\ tag' = [d |-> reg, age |-> 0] /\ resolved' = TRUE
           /\ UNCHANGED <<RecVars, cmd, GcVars, reg, used, pull, offline,
                          bad>>
\* The registry cannot be reached in this command.
ResolveFails == /\ cmd = "running" /\ used = 0 /\ ~resolved /\ NeedsResolve
                /\ ~offline /\ offline' = TRUE
                /\ UNCHANGED <<RecVars, cmd, GcVars, reg, tag, used, pull,
                               resolved, bad>>
\* First use takes the stored resolution; later uses repeat it.
UseTag ==
  /\ cmd = "running"
  /\ IF used = 0
       THEN /\ tag.d # 0
            /\ (resolved \/ ~NeedsResolve \/ (offline /\ ~pull))
            /\ used' = tag.d
            /\ bad' = Flag("stale", tag.age > TTL /\ ~resolved /\ ~offline)
       ELSE IF ResolvePerUse
              THEN /\ used' = reg /\ bad' = Flag("mixed", reg # used)
              ELSE /\ used' = used /\ bad' = bad
  /\ UNCHANGED <<RecVars, cmd, GcVars, reg, tag, pull, resolved, offline>>
\* `hack pull` reports the digest it resolved in this command.
PullDone == /\ cmd = "running" /\ pull /\ used # 0
            /\ bad' = Flag("pull", ~resolved)
            /\ UNCHANGED <<RecVars, cmd, GcVars, TagVars>>

Next == \/ BeginCmd(TRUE) \/ BeginCmd(FALSE) \/ EndCmd
        \/ Skip \/ Execute \/ RecordLost \/ Record \/ EffectAfterRecord \/ Use
        \/ (\E k \in store : PruneStart(k)) \/ PruneFinish
        \/ ChangeInput \/ Reboot \/ Drift \/ Crash
        \/ MoveTag \/ Tick \/ Resolve \/ ResolveFails \/ UseTag \/ PullDone

Spec == Init /\ [][Next]_vars

\* A skipped step had identical inputs and its output was present.
NoUnsoundSkip == ~bad["skip"]
\* Garbage collection never deletes an output a running command took.
NoPruneInUse == ~bad["use"]
\* One command uses one digest per tag.
OneDigestPerCommand == ~bad["mixed"]
\* A tag record older than the limit is used only after a failed resolve
\* in the same command (offline; shown as stale).
NoSilentStaleTag == ~bad["stale"]
\* `hack pull` always resolves in its own command.
PullResolves == ~bad["pull"]
=============================================================================
