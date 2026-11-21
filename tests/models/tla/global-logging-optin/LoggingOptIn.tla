------------------------- MODULE LoggingOptIn -------------------------
(* Whether Hack runs the global logging stack (src/lib/global-logging.ts,
   `hack global install` / `up` / `down` in src/commands/global.ts).
   `logging.enabled` decides when set; unset means on only for a home that
   has the stack's compose file, which every install before opt-in wrote.
   Install writes that file only while logging is on. Off stops the stack's
   containers and keeps its volumes; only `hack global logs-reset` removes
   them. The user may run any command, or edit the setting, at any time. *)
EXTENDS Naturals
CONSTANTS FilesDecideUnset,   \* unset follows the compose file (else: off)
          InstallOnlyWhenOn,  \* install writes the files only while on
          OffKeepsVolumes     \* turning off stops, never `down -v`
VARIABLES setting, files, running, data, existing, asked, last, prevData
vars == <<setting, files, running, data, existing, asked, last, prevData>>

Settings == {"unset", "on", "off"}
Actions == {"init", "install", "up", "upFlag", "set", "down", "reset"}

\* A home from before opt-in (files, maybe running, logs kept) or a new one.
Init == /\ setting = "unset" /\ last = "init" /\ asked = FALSE
        /\ \/ /\ existing = TRUE /\ files = TRUE /\ data = TRUE
              /\ running \in BOOLEAN
           \/ /\ existing = FALSE /\ files = FALSE /\ data = FALSE
              /\ running = FALSE
        /\ prevData = data

On(s, f) == s = "on" \/ (s = "unset" /\ FilesDecideUnset /\ f)

\* `hack global up` with setting `s` over files `f`: start when on (writing
\* missing files), else stop what a home with files still runs.
UpWith(s, f) ==
    IF On(s, f)
      THEN /\ files' = TRUE /\ running' = TRUE /\ data' = TRUE
      ELSE /\ files' = f /\ running' = FALSE
           /\ data' = (data /\ OffKeepsVolumes)

Install == /\ LET f == IF On(setting, files) \/ ~InstallOnlyWhenOn
                         THEN TRUE ELSE files
              IN UpWith(setting, f)
           /\ last' = "install" /\ prevData' = data
           /\ UNCHANGED <<setting, existing, asked>>
Up == /\ UpWith(setting, files)
      /\ last' = "up" /\ prevData' = data
      /\ UNCHANGED <<setting, existing, asked>>
\* `--logging` / `--no-logging`: save the setting, then up.
UpFlag(v) == /\ setting' = v /\ asked' = (asked \/ v = "on")
             /\ UpWith(v, files)
             /\ last' = "upFlag" /\ prevData' = data /\ UNCHANGED existing
\* `hack config set|unset --global logging.enabled`: no Docker effect.
Set(v) == /\ setting' = v /\ asked' = (asked \/ v = "on") /\ last' = "set"
          /\ prevData' = data
          /\ UNCHANGED <<files, running, data, existing>>
Down == /\ running' = FALSE /\ last' = "down" /\ prevData' = data
        /\ UNCHANGED <<setting, files, data, existing, asked>>
\* `hack global logs-reset`: the one asked-for data removal.
Reset == /\ files /\ running' = FALSE /\ data' = FALSE /\ last' = "reset"
         /\ prevData' = data
         /\ UNCHANGED <<setting, files, existing, asked>>

Next == \/ Install \/ Up \/ Down \/ Reset
        \/ \E v \in {"on", "off"} : UpFlag(v)
        \/ \E v \in Settings : Set(v)

Spec == Init /\ [][Next]_vars

TypeOK == /\ setting \in Settings /\ last \in Actions
          /\ files \in BOOLEAN /\ running \in BOOLEAN /\ data \in BOOLEAN
          /\ existing \in BOOLEAN /\ asked \in BOOLEAN
          /\ prevData \in BOOLEAN

\* A new home never runs the stack unless someone turned it on.
FreshNeverStartsUnasked == running => (existing \/ asked)
\* After a start, an existing home with the setting unset still has it.
ExistingHomeKept ==
    (existing /\ setting = "unset" /\ last \in {"install", "up"}) => running
\* After a start with logging off, its containers are stopped.
OffMeansStopped ==
    (setting = "off" /\ last \in {"install", "up", "upFlag"}) => ~running
\* Logs disappear only in a step the user asked to remove them (logs-reset).
\* `prevData` is `data` before the last step, so this is a step property.
NoSurpriseDataLoss == (prevData /\ ~data) => last = "reset"
=============================================================================
