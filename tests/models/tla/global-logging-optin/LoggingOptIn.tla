------------------------- MODULE LoggingOptIn -------------------------
(* Whether Hack runs the global logging stack (src/lib/global-logging.ts,
   `hack global install` / `up` / `down` in src/commands/global.ts).
   `logging.enabled` decides when set; unset means on only for a home that
   has the stack's directory, which every install before opt-in wrote.
   The first manual install or up in such a home saves `on`, so the choice no
   longer hangs on that directory. Install writes the logging files only while
   logging is on. Off stops the stack's containers, found by their Compose
   project label, and keeps its volumes; only
   `hack global logs-reset` removes them. The user may run any command, edit
   the setting, or move the compose file aside, at any time; the whole
   directory only after the home's first manual start. *)
EXTENDS Naturals
CONSTANTS FilesDecideUnset,   \* unset follows the compose file (else: off)
          InstallOnlyWhenOn,  \* install writes the files only while on
          OffKeepsVolumes,    \* turning off stops, never `down -v`
          SaveDecision        \* the first manual start saves an existing home's `on`
VARIABLES setting, files, dir, running, data, existing, asked, cleared,
          ran, last, prevData
vars == <<setting, files, dir, running, data, existing, asked, cleared,
          ran, last, prevData>>

Settings == {"unset", "on", "off"}
Actions == {"init", "install", "up", "upFlag", "set", "down", "reset", "move",
            "moveDir"}

\* A home from before opt-in (files, maybe running, logs kept) or a new one.
Init == /\ setting = "unset" /\ last = "init" /\ asked = FALSE
        /\ cleared = FALSE /\ ran = FALSE
        /\ \/ /\ existing = TRUE /\ files = TRUE /\ dir = TRUE /\ data = TRUE
              /\ running \in BOOLEAN
           \/ /\ existing = FALSE /\ files = FALSE /\ dir = FALSE
              /\ data = FALSE /\ running = FALSE
        /\ prevData = data

\* `d`: the logging directory exists.
On(s, d) == s = "on" \/ (s = "unset" /\ FilesDecideUnset /\ d)

\* The setting a manual install or up leaves: an existing home's `on` saved.
Saved(s, d) ==
    IF SaveDecision /\ s = "unset" /\ FilesDecideUnset /\ d THEN "on" ELSE s

\* `hack global up` with setting `s`, compose file `f` and directory `d`:
\* start when on (writing missing files), else stop whatever runs of the
\* stack, found by its Compose project label (no file or directory needed).
UpWith(s, f, d) ==
    IF On(s, d)
      THEN /\ files' = TRUE /\ dir' = TRUE /\ running' = TRUE /\ data' = TRUE
      ELSE /\ files' = f /\ dir' = d /\ running' = FALSE
           /\ data' = (data /\ OffKeepsVolumes)

Install == /\ LET writes == On(setting, dir) \/ ~InstallOnlyWhenOn
                  s == Saved(setting, dir)
              IN /\ setting' = s
                 /\ UpWith(s, files \/ writes, dir \/ writes)
           /\ last' = "install" /\ prevData' = data /\ ran' = TRUE
           /\ UNCHANGED <<existing, asked, cleared>>
Up == /\ LET s == Saved(setting, dir)
         IN /\ setting' = s /\ UpWith(s, files, dir)
      /\ last' = "up" /\ prevData' = data /\ ran' = TRUE
      /\ UNCHANGED <<existing, asked, cleared>>
\* `--logging` / `--no-logging`: save the setting, then up.
UpFlag(v) == /\ setting' = v /\ asked' = (asked \/ v = "on")
             /\ UpWith(v, files, dir)
             /\ last' = "upFlag" /\ prevData' = data /\ ran' = TRUE
             /\ UNCHANGED <<existing, cleared>>
\* `hack config set|unset --global logging.enabled`: no Docker effect.
Set(v) == /\ setting' = v /\ asked' = (asked \/ v = "on") /\ last' = "set"
          /\ cleared' = (v = "unset") /\ prevData' = data
          /\ UNCHANGED <<files, dir, running, data, existing, ran>>
Down == /\ running' = FALSE /\ last' = "down" /\ prevData' = data
        /\ UNCHANGED <<setting, files, dir, data, existing, asked, cleared, ran>>
\* `hack global logs-reset`: the one asked-for data removal.
Reset == /\ files /\ running' = FALSE /\ data' = FALSE /\ last' = "reset"
         /\ prevData' = data
         /\ UNCHANGED <<setting, files, dir, existing, asked, cleared, ran>>
\* The compose file moved aside by hand (the directory stays).
MoveFiles == /\ files /\ files' = FALSE /\ last' = "move" /\ prevData' = data
             /\ UNCHANGED <<setting, dir, running, data, existing, asked, cleared,
                            ran>>
\* The whole logging directory moved aside, after the first manual start.
MoveDir == /\ ran /\ dir /\ files' = FALSE /\ dir' = FALSE /\ last' = "moveDir"
           /\ prevData' = data
           /\ UNCHANGED <<setting, running, data, existing, asked, cleared, ran>>

Next == \/ Install \/ Up \/ Down \/ Reset \/ MoveFiles \/ MoveDir
        \/ \E v \in {"on", "off"} : UpFlag(v)
        \/ \E v \in Settings : Set(v)

Spec == Init /\ [][Next]_vars

TypeOK == /\ setting \in Settings /\ last \in Actions
          /\ files \in BOOLEAN /\ dir \in BOOLEAN /\ running \in BOOLEAN
          /\ data \in BOOLEAN /\ existing \in BOOLEAN /\ asked \in BOOLEAN
          /\ cleared \in BOOLEAN /\ ran \in BOOLEAN /\ prevData \in BOOLEAN

\* A new home never runs the stack unless someone turned it on.
FreshNeverStartsUnasked == running => (existing \/ asked)
\* After a start, an existing home keeps the stack unless someone turned it
\* off or cleared the setting, even with its files moved aside.
ExistingHomeKept ==
    (existing /\ ~cleared /\ setting \in {"unset", "on"}
       /\ last \in {"install", "up"}) => running
\* After a start with logging off, its containers are stopped.
OffMeansStopped ==
    (setting = "off" /\ last \in {"install", "up", "upFlag"}) => ~running
\* After any start, a running stack is one the setting says is on.
NoOrphanedStack ==
    (last \in {"install", "up", "upFlag"} /\ running) => On(setting, dir)
\* Logs disappear only in a step the user asked to remove them (logs-reset).
\* `prevData` is `data` before the last step, so this is a step property.
NoSurpriseDataLoss == (prevData /\ ~data) => last = "reset"
=============================================================================
