---------------------------- MODULE Emulation ----------------------------
\* One shared native VM pool and its Rosetta 2 x86_64 translation intent.
\* intent: Owner.amd64_emulation (recorded before any provider effect).
\* record: SmolVM's stored machine setting (`--rosetta` at create, `machine update`).
\* config/registered: the running config and guest binfmt_misc registration of a boot.
\* A foreign actor may change the stored setting while the pool is stopped.
EXTENDS Naturals
CONSTANTS EnforceAudit, EnforceRunningRefusal
VARIABLES phase, intent, record, config, registered, engine, amd64
vars == <<phase, intent, record, config, registered, engine, amd64>>
Phases == {"absent", "stopped", "booting", "running"}
TypeOK == /\ phase \in Phases
          /\ intent \in BOOLEAN /\ record \in BOOLEAN /\ config \in BOOLEAN
          /\ registered \in BOOLEAN /\ engine \in BOOLEAN /\ amd64 \in BOOLEAN
Init == /\ phase = "absent" /\ intent = FALSE /\ record = FALSE /\ config = FALSE
        /\ registered = FALSE /\ engine = FALSE /\ amd64 = FALSE
\* `enable_amd64_emulation`: a start that needs translation records intent first.
RecordIntent == /\ phase \in {"absent", "stopped"} /\ ~intent
                /\ intent' = TRUE
                /\ UNCHANGED <<phase, record, config, registered, engine, amd64>>
\* `machine create` passes `--rosetta` exactly when intent is recorded.
Create == /\ phase = "absent"
          /\ phase' = "stopped" /\ record' = intent
          /\ UNCHANGED <<intent, config, registered, engine, amd64>>
\* `machine update --rosetta` on a created, stopped machine whose record lacks it.
\* Interruption is the absence of this step; it is repeated by the next start.
Update == /\ phase = "stopped" /\ intent /\ ~record
          /\ record' = TRUE
          /\ UNCHANGED <<phase, intent, config, registered, engine, amd64>>
ForeignRecord == /\ phase = "stopped"
                 /\ record' = ~record
                 /\ UNCHANGED <<phase, intent, config, registered, engine, amd64>>
\* `machine start`: the provider boots its stored setting; the agent registers it.
Boot == /\ phase = "stopped"
        /\ phase' = "booting" /\ config' = record /\ registered' = record
        /\ UNCHANGED <<intent, record, engine, amd64>>
Matches == record = intent /\ config = intent /\ registered = intent
\* `config_audit::verify`, `audit_boot` and `guest-translation.sh` before engine start.
StartEngine == /\ phase = "booting" /\ (EnforceAudit => Matches)
               /\ phase' = "running" /\ engine' = TRUE
               /\ UNCHANGED <<intent, record, config, registered, amd64>>
RefuseBoot == /\ phase = "booting" /\ ~Matches
              /\ phase' = "stopped" /\ config' = FALSE /\ registered' = FALSE
              /\ UNCHANGED <<intent, record, engine, amd64>>
\* A start that needs translation on a running pool without it.
RequestRunning == /\ phase = "running" /\ ~intent /\ ~EnforceRunningRefusal
                  /\ intent' = TRUE
                  /\ UNCHANGED <<phase, record, config, registered, engine, amd64>>
\* Graph admission: an opted-in amd64 image needs the audited pool's intent.
StartAmd64 == /\ phase = "running" /\ engine /\ intent /\ ~amd64
              /\ amd64' = TRUE
              /\ UNCHANGED <<phase, intent, record, config, registered, engine>>
Stop == /\ phase = "running"
        /\ phase' = "stopped" /\ engine' = FALSE /\ amd64' = FALSE
        /\ config' = FALSE /\ registered' = FALSE
        /\ UNCHANGED <<intent, record>>
Next == RecordIntent \/ Create \/ Update \/ ForeignRecord \/ Boot \/ StartEngine
        \/ RefuseBoot \/ RequestRunning \/ StartAmd64 \/ Stop
Spec == Init /\ [][Next]_vars
\* An amd64 container only ever runs with translation actually present.
NoUntranslatedAmd64 == amd64 => (config /\ registered)
\* A started engine runs exactly the recorded intent: no missing translation for an
\* emulating pool, and no unrequested translation in a pool that never opted in.
EngineMatchesIntent == engine => (config = intent /\ registered = intent)
=============================================================================
