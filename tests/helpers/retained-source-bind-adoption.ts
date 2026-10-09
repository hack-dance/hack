import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";
import { runLegacyComposeRetainedOperation } from "../../src/lib/native-compose-adoption-execution.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../../src/lib/native-compose-adoption-generation.ts";
import { restoreEnv } from "./env.ts";
import { managedEnvCompilerFixture } from "./managed-env-compiler.ts";

export const SOURCE_BIND_CANARY = "synthetic-private-retained-source-bind";
const CONTAINER = "a".repeat(64),
  NETWORK = "b".repeat(64),
  HASH = "c".repeat(64);
const CREATED = "2026-01-01T01:02:03Z";
/** Closed source-to-model transport only: no actual Docker, SQL or mounted access proof. */
export async function retainedSourceBindFixture() {
  const outer = await realpath(
    await mkdtemp(join(tmpdir(), "retained-source-bind-model-"))
  );
  const root = join(outer, "checkout");
  await mkdir(join(root, ".hack"), { recursive: true });
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/marker"), SOURCE_BIND_CANARY);
  const config = '{"name":"fixture"}';
  const compose = JSON.stringify({
    name: "fixture",
    services: {
      db: { image: "fixture", volumes: ["data:/data", "../source:/work:rw"] },
    },
    volumes: { data: { name: "fixture_data" } },
  });
  await writeFile(join(root, ".hack/hack.config.json"), config);
  await writeFile(join(root, ".hack/docker-compose.yml"), compose);
  const model = {
    running: false,
    partial: false,
    source: join(root, "source"),
    readOnly: false,
    volumeBirth: CREATED,
    row: SOURCE_BIND_CANARY,
    hash: HASH,
    engine: "synthetic-bind-engine",
  };
  const modelPath = join(outer, "model.json");
  await writeFile(modelPath, JSON.stringify(model));
  const binary = join(outer, "docker");
  await writeFile(
    binary,
    `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const outer=${JSON.stringify(outer)},root=${JSON.stringify(root)},id=${JSON.stringify(CONTAINER)},network=${JSON.stringify(NETWORK)},born=${JSON.stringify(CREATED)},expected=${JSON.stringify(compose)};
const args=process.argv.slice(2),[kind,action]=args,m=JSON.parse(readFileSync(outer+'/model.json','utf8'));
appendFileSync(outer+'/commands',JSON.stringify(args)+'\\n');
function red(){writeFileSync(outer+'/unexpected','unowned command');process.exit(99);}
if(kind==='info'&&args.length===3&&action==='--format'){console.log(args[2]==='{{json .ID}}'?JSON.stringify(m.engine):JSON.stringify({id:m.engine,os:'linux'}));process.exit(0);}
if(kind==='compose'){
 if(args.length!==15||args[1]!=='--project-name'||args[2]!=='fixture'||args[3]!=='--project-directory'||args[4]!==root+'/.hack'||args[5]!=='--env-file'||args[6]!=='/dev/null'||args[7]!=='--profile'||args[8]!=='*'||args[9]!=='--file'||args[11]!=='config'||args[12]!=='--no-env-resolution'||args[13]!=='--hash'||args[14]!=='*')red();
 const path=args[10],prefix=root+'/.hack/.internal/legacy-compose-adoption-v1/generations/',tail=path.slice(prefix.length).split('/');
 if(path!==root+'/.hack/docker-compose.yml'&&!(path.startsWith(prefix)&&tail.length===2&&/^[a-f0-9]{32}$/.test(tail[0])&&tail[1]==='legacy-compose.yml'))red();
 if(readFileSync(path,'utf8')!==expected)red();console.log('db '+m.hash);process.exit(0);
}
if(kind==='container'&&['start','stop'].includes(action)){
 if(args.length!==3||args[2]!==id)red();m.running=action==='start';writeFileSync(outer+'/model.json',JSON.stringify(m));process.exit(m.partial?7:0);
}
if(!['container','volume','network'].includes(kind)||!['ls','inspect'].includes(action)||!args.includes('--format'))red();
if(action==='ls'){console.log(JSON.stringify(kind==='container'?{id,name:'fixture-db-1',project:'fixture'}:kind==='network'?{id:network,name:'fixture_default',project:'fixture'}:{id:'fixture_data',name:'fixture_data',project:'fixture'}));process.exit(0);}
const selected=args.at(-1),format=args[3];
if(kind==='container'&&selected===id){
 if(format.includes('config-hash'))console.log(JSON.stringify({id,hash:m.hash}));
 else if(format.includes('.Mounts')){
  if(!format.includes('index $m "Name"'))red();
  console.log(JSON.stringify({id,name:'/fixture-db-1',project:'fixture',native:'',service:'db',number:'1',oneoff:'False',running:m.running,workingDir:root+'/.hack',configFiles:root+'/.hack/docker-compose.yml',mounts:[{type:'volume',name:'fixture_data',source:'/var/lib/docker/volumes/original/_data',target:'/data',rw:true},{type:'bind',name:null,source:m.source,target:'/work',rw:!m.readOnly}],networks:[{name:'fixture_default',id:network}]}));
 }else if(format.includes('.State.Running'))console.log(JSON.stringify({id,running:m.running,paused:false,status:m.running?'running':'exited',...(format.includes('Health')?{health:''}:{})}));else red();
}else if(kind==='volume'&&selected==='fixture_data')console.log(JSON.stringify({id:'fixture_data',name:'fixture_data',project:'fixture',native:'',storage:'data',createdAt:m.volumeBirth,driver:'local',scope:'local',mountpoint:'/var/lib/docker/volumes/original/_data',options:null}));
else if(kind==='network'&&selected===network)console.log(JSON.stringify({id:network,name:'fixture_default',project:'fixture',native:'',logical:'default',createdAt:born,driver:'bridge',scope:'local',internal:false,containers:m.running?[id]:[]}));else red();
`
  );
  await chmod(binary, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = outer;
  const compiler = await managedEnvCompilerFixture(join(outer, "compiler"));
  return {
    root,
    outer,
    config,
    compose,
    model,
    compiler,
    persist: () => writeFile(modelPath, JSON.stringify(model)),
    readModel: async () => {
      const value: unknown = JSON.parse(await readFile(modelPath, "utf8"));
      if (
        !(
          isRecord(value) &&
          Object.keys(value).sort().join() ===
            Object.keys(model).sort().join() &&
          Object.entries(model).every(
            ([key, old]) => typeof value[key] === typeof old
          )
        )
      ) {
        throw new Error("Synthetic model refused; values omitted.");
      }
      return value;
    },
    commands: async (): Promise<readonly (readonly string[])[]> => {
      const text = await readFile(join(outer, "commands"), "utf8");
      return text
        .trim()
        .split("\n")
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (
            !(
              Array.isArray(value) &&
              value.every((part): part is string => typeof part === "string")
            )
          ) {
            throw new Error("Synthetic commands refused; values omitted.");
          }
          return value;
        });
    },
    receipt: async () => {
      const value: unknown = JSON.parse(
        await readFile(
          join(root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json"),
          "utf8"
        )
      );
      if (!isRecord(value)) {
        throw new Error("Synthetic receipt refused; values omitted.");
      }
      return value;
    },
    store: (signal?: AbortSignal) =>
      openLegacyComposeAdoptedGenerationStore({ projectRoot: root, signal }),
    operation: async (
      store: Awaited<
        ReturnType<typeof openLegacyComposeAdoptedGenerationStore>
      >,
      generation: Parameters<typeof store.withMutation>[0]["generation"],
      operation: "start" | "stop",
      recover = false
    ) => {
      const deadline = Date.now() + 15_000;
      return await store.withMutation({
        generation,
        operation,
        recover,
        services: [],
        binary: compiler,
        deadline,
        run: (input) =>
          runLegacyComposeRetainedOperation({
            input,
            operation,
            deadline,
            signal: new AbortController().signal,
          }),
      });
    },
    cleanup: async () => {
      restoreEnv("PATH", previousPath);
      await rm(outer, { recursive: true, force: true });
    },
  };
}
