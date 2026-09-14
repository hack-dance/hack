//! Manual WU07 infrastructure probe, not actual-project graph acceptance.
use super::{engine::Engine, source_probe, state};
use crate::{Candidate, CandidateError};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn error(message: &str) -> CandidateError {
    CandidateError::new("graph_probe", message)
}

fn remove_container(engine: &Engine<'_>, name: &str, owner: &str) -> Result<(), CandidateError> {
    let inspected =
        match engine.request(Method::GET, &format!("/v1.53/containers/{name}/json"), None) {
            Ok(value) => value,
            Err(e) if e.code == "engine_not_found" => return Ok(()),
            Err(e) => return Err(e),
        };
    if inspected["Config"]["Labels"]["io.hack-local.graph-probe"] != owner {
        return Err(error("Container ownership mismatch."));
    }
    let id = source_probe::container_id(&inspected)?;
    engine.request(
        Method::DELETE,
        &format!("/v1.53/containers/{id}?force=true&v=true"),
        None,
    )?;
    if !matches!(engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None), Err(e) if e.code == "engine_not_found")
    {
        return Err(error("Removed probe container remains."));
    }
    Ok(())
}

fn start(engine: &Engine<'_>, name: &str, mut config: Value) -> Result<String, CandidateError> {
    let network = config["HostConfig"]["NetworkMode"]
        .as_str()
        .ok_or_else(|| error("Missing graph network."))?
        .to_owned();
    config["NetworkingConfig"] = json!({"EndpointsConfig":{network:{"Aliases":[name]}}});
    let value = engine.request(
        Method::POST,
        &format!("/v1.53/containers/create?name={name}"),
        Some(&config),
    )?;
    let id = source_probe::container_id(&value)?;
    let inspected = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    if inspected["Config"]["Labels"] != config["Labels"] || inspected["Image"] != config["Image"] {
        return Err(error("Created container identity differs from request."));
    }
    engine.request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
    Ok(id)
}

fn completed(engine: &Engine<'_>, id: &str) -> Result<(), CandidateError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let value = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
        if value["State"]["Running"] == false {
            if value["State"]["ExitCode"] != 0 {
                return Err(error("Probe job exited unsuccessfully."));
            }
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(error("Probe job readiness deadline exceeded."));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "Manual owned development VM only; requires pinned Bun image and external watchdog"]
fn owned_graph_storage_live() -> Result<(), CandidateError> {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("root"),
    ))?;
    let status = super::status(&candidate)?;
    if status.phase != "running" || status.profile != Some(super::Profile::Development) {
        return Err(error("Owned development VM required."));
    }
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("pinned image");
    let owner = format!("graph-{}-{}", std::process::id(), crate::node::now());
    let network = format!("hack-{owner}");
    let volume = format!("hack-{owner}-data");
    let names = [
        format!("hack-{owner}-init"),
        format!("hack-{owner}-web"),
        format!("hack-{owner}-check"),
    ];
    let labels = json!({"io.hack-local.graph-probe":owner});
    let evidence_dir = candidate.state_root.join("review/wu07");
    state::private_directory(&evidence_dir)?;
    state::write(
        &evidence_dir.join(format!("{owner}.json")),
        &json!({"phase":"intent","network":network,"volume":volume,"containers":names}),
    )?;
    let mut phase = "network-tools";
    let result = (|| {
        {
            let engine = Engine::connect(&candidate)?;
            engine
                .guest()
                .execute("iptables -t nat -S >/dev/null", &[], None)?;
            // Exercise refusal using the real bootstrap verifier before graph allocation.
            engine.guest().execute(
                r#"
root=/etc/hack-local-network-tools
identity=$(cat "$root/identity")
if /bin/sh -c "$1" hack-local foreign-owner "$identity" check; then exit 91; fi
test ! -e "$root/ready.probe-retained"; test ! -L "$root/ready.probe-retained"
mv "$root/ready" "$root/ready.probe-retained"
trap 'mv "$root/ready.probe-retained" "$root/ready"' EXIT
if /bin/sh -c "$1" hack-local "$2" "$identity" check; then exit 92; fi
mv "$root/ready.probe-retained" "$root/ready"
trap - EXIT
/bin/sh -c "$1" hack-local "$2" "$identity" check
"#,
                &[
                    include_str!("guest-network-tools.sh"),
                    engine.guest().incarnation(),
                ],
                None,
            )?;
            phase = "network-create";
            engine.request(
                Method::POST,
                "/v1.53/networks/create",
                Some(&json!({"Name":network,"Driver":"bridge","Internal":true,"Labels":labels})),
            )?;
            let inspected =
                engine.request(Method::GET, &format!("/v1.53/networks/{network}"), None)?;
            if inspected["Labels"] != labels
                || inspected["Internal"] != true
                || inspected["Driver"] != "bridge"
            {
                return Err(error("Private network identity differs."));
            }
            phase = "volume-create";
            engine.request(
                Method::POST,
                "/v1.53/volumes/create",
                Some(&json!({"Name":volume,"Driver":"local","Labels":labels})),
            )?;
        }
        for generation in 0..2 {
            let engine = Engine::connect(&candidate)?;
            let inspected =
                engine.request(Method::GET, &format!("/v1.53/volumes/{volume}"), None)?;
            if inspected["Labels"] != labels || inspected["Driver"] != "local" {
                return Err(error("Persistent volume identity differs."));
            }
            let config = |program: String, data: bool| {
                let mut host = json!({"NetworkMode":network,"Memory":268435456,"NanoCpus":1000000000_u64,
                    "PidsLimit":64,"ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],
                    "Tmpfs":{"/tmp":"rw,noexec,nosuid,size=16777216"}});
                if data {
                    host["Mounts"] = json!([{"Type":"volume","Source":volume,"Target":"/data"}]);
                }
                json!({"Image":image,"Cmd":[],"Entrypoint":["/usr/local/bin/bun","-e",program],"Labels":labels,"HostConfig":host})
            };
            phase = "init";
            let setup = if generation == 0 {
                format!(
                    "import {{Database}} from 'bun:sqlite'; const db=new Database('/data/probe.sqlite'); db.exec('CREATE TABLE proof(value TEXT)'); db.query('INSERT INTO proof VALUES (?)').run('{}'); db.close();",
                    owner
                )
            } else {
                format!(
                    "import {{Database}} from 'bun:sqlite'; const db=new Database('/data/probe.sqlite',{{readonly:true}}); if(db.query('SELECT value FROM proof').get().value!=='{}') throw Error('persistence'); db.close();",
                    owner
                )
            };
            let init = start(&engine, &names[0], config(setup, true))?;
            completed(&engine, &init)?;
            phase = "web-start";
            start(&engine,&names[1],config("import {Database} from 'bun:sqlite'; const db=new Database('/data/probe.sqlite',{readonly:true}); Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response(db.query('SELECT value FROM proof').get().value)}});".into(),true))?;
            phase = "http-readiness";
            let web = engine.request(
                Method::GET,
                &format!("/v1.53/containers/{}/json", names[1]),
                None,
            )?;
            let address = web["NetworkSettings"]["Networks"][&network]["IPAddress"]
                .as_str()
                .ok_or_else(|| error("Web address missing."))?;
            let address: std::net::Ipv4Addr =
                address.parse().map_err(|_| error("Invalid web address."))?;
            let probe = format!(
                "let ok=false; for(let i=0;i<12;i++){{try{{const r=await fetch('http://{}:3000',{{signal:AbortSignal.timeout(500)}}); if(await r.text()==='{}'){{ok=true;break;}}}}catch(e){{console.log(e.code || e.name);}} await Bun.sleep(100);}} console.log('dns-ready='+ok); const r=await fetch('http://{}:3000',{{signal:AbortSignal.timeout(1000)}}); console.log('address-ready='+(await r.text()==='{}')); if(!ok)throw Error('readiness');",
                names[1], owner, address, owner
            );
            let check = start(&engine, &names[2], config(probe, false))?;
            if let Err(failure) = completed(&engine, &check) {
                let check_logs = engine.logs(&check)?;
                let web = engine.request(
                    Method::GET,
                    &format!("/v1.53/containers/{}/json", names[1]),
                    None,
                )?;
                let web_id = source_probe::container_id(&web)?;
                let web_logs = engine.logs(&web_id)?;
                state::write(
                    &evidence_dir.join(format!("{owner}-diagnostics.json")),
                    &json!({"check_logs":check_logs,"web_logs":web_logs,"web_state":web["State"],"web_networks":web["NetworkSettings"]["Networks"]}),
                )?;
                return Err(failure);
            }
            for name in &names {
                remove_container(&engine, name, &owner)?;
            }
            drop(engine);
            if generation == 0 {
                phase = "vm-restart";
                if super::down(&candidate)?.process_alive != Some(false) {
                    return Err(error("VM did not stop."));
                }
                super::up_with_profile(&candidate, super::Profile::Development)?;
            }
        }
        Ok::<_, CandidateError>(())
    })();
    let cleanup = (|| {
        let engine = Engine::connect_cleanup(&candidate)?;
        for name in &names {
            remove_container(&engine, name, &owner)?;
        }
        for (collection, name) in [("networks", &network), ("volumes", &volume)] {
            match engine.request(Method::GET, &format!("/v1.53/{collection}/{name}"), None) {
                Ok(value) => {
                    if value["Labels"] != labels {
                        return Err(error("Resource cleanup ownership mismatch."));
                    }
                    engine.request(Method::DELETE, &format!("/v1.53/{collection}/{name}"), None)?;
                    if !matches!(engine.request(Method::GET,&format!("/v1.53/{collection}/{name}"),None),Err(e) if e.code == "engine_not_found")
                    {
                        return Err(error("Removed resource remains."));
                    }
                }
                Err(e) if e.code == "engine_not_found" => {}
                Err(e) => return Err(e),
            }
        }
        Ok::<_, CandidateError>(())
    })();
    state::write(
        &evidence_dir.join(format!("{owner}.json")),
        &json!({"passed":result.is_ok() && cleanup.is_ok(),"network":network,"volume":volume,"containers":names,"image":image,"phase":phase,"failure":result.as_ref().err().map(|e| &e.code),"cleanup_confirmed":cleanup.is_ok(),"scope":"Synthetic init/SQLite/web/check pipeline and VM restart; not Event Agent or host-loopback acceptance"}),
    )?;
    cleanup?;
    result
}
