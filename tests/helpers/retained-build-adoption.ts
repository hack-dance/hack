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
import { openLegacyComposeAdoptedGenerationStore } from "../../src/lib/native-compose-adoption-generation.ts";
import { runLegacyComposeRetainedOperation } from "../../src/lib/native-compose-adoption-execution.ts";
import { parseLegacyComposeAdoptionReceipt } from "../../src/lib/native-compose-adoption-receipt.ts";
import { managedEnvCompilerFixture } from "./managed-env-compiler.ts";
import { restoreEnv } from "./env.ts";

export const BUILD_CANARY = "synthetic-private-retained-build";
const CREATED = "2026-01-01T01:02:03Z";
const CONTAINER = "a".repeat(64),
  NETWORK = "b".repeat(64),
  IMAGE = `sha256:${"c".repeat(64)}`,
  HASH = "d".repeat(64);
function identity(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.dev !== "number" ||
    typeof value.ino !== "number" ||
    !Number.isSafeInteger(value.dev) ||
    !Number.isSafeInteger(value.ino) ||
    value.dev < 0 ||
    value.ino <= 0
  ) {
    throw new Error("Synthetic identity is invalid; values omitted.");
  }
  return { dev: value.dev, ino: value.ino };
}
/** Source-to-model transport control only. No real daemon, image build or SQL proof. */
export async function retainedBuildFixture() {
  const outer = await realpath(
    await mkdtemp(join(tmpdir(), "retained-build-owner-"))
  );
  const root = join(outer, "checkout");
  await mkdir(join(root, ".hack"), { recursive: true });
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/marker"), BUILD_CANARY);
  await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY src /source\n");
  await writeFile(join(root, ".dockerignore"), "**\n!Dockerfile\n!src\n");
  const config = '{"name":"fixture"}';
  const compose = JSON.stringify({
    name: "fixture",
    services: { db: { build: "..", volumes: ["data:/data"] } },
    volumes: { data: { name: "fixture_original_data" } },
  });
  await writeFile(join(root, ".hack/hack.config.json"), config);
  await writeFile(join(root, ".hack/docker-compose.yml"), compose);
  await writeFile(join(outer, "accepted-compose"), compose);
  const model = {
    running: false,
    image: IMAGE,
    tag: IMAGE,
    imageBirth: CREATED,
    containerBirth: CREATED,
    volumeBirth: CREATED,
    hash: HASH,
    reference: "fixture-db",
    engine: "synthetic-retained-build-engine",
    partial: false,
    sourceRace: false,
    hold: false,
    probeHold: false,
    imageExists: true,
    row: BUILD_CANARY,
  };
  const modelPath = join(outer, "model.json"),
    commands = join(outer, "commands"),
    binary = join(outer, "docker");
  await writeFile(modelPath, JSON.stringify(model));
  await writeFile(
    binary,
    `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const outer=${JSON.stringify(outer)}, root=${JSON.stringify(root)}, id=${JSON.stringify(CONTAINER)}, network=${JSON.stringify(NETWORK)};
const args=process.argv.slice(2), [kind,action]=args, m=JSON.parse(readFileSync(outer+'/model.json','utf8'));
appendFileSync(outer+'/commands',JSON.stringify(args)+'\\n');
function red(){writeFileSync(outer+'/unexpected','unowned action');process.exit(99);}
const volume='fixture_original_data', born=${JSON.stringify(CREATED)};
if(kind==='info' && args.length===3 && action==='--format') {console.log(args[2]==='{{json .ID}}' ? JSON.stringify(m.engine) : JSON.stringify({id:m.engine,os:'linux'}));process.exit(0);}
if(kind==='compose') {
 const path=args[10], service=args.at(-1);
 if(args[1]!=='--project-name' || args[2]!=='fixture' || args[3]!=='--project-directory' || args[4]!==root+'/.hack' || args[5]!=='--env-file' || args[6]!=='/dev/null' || args[7]!=='--profile' || args[8]!=='*' || args[9]!=='--file' || args[11]!=='config' || args[12]!=='--no-env-resolution') red();
 const prefix=root+'/.hack/.internal/legacy-compose-adoption-v1/generations/', tail=path.slice(prefix.length).split('/');
 if(path!==root+'/.hack/docker-compose.yml' && !(path.startsWith(prefix) && tail.length===2 && /^[a-f0-9]{32}$/.test(tail[0]) && tail[1]==='legacy-compose.yml')) red();
 if(readFileSync(path,'utf8')!==readFileSync(outer+'/accepted-compose','utf8')) red();
 if(args.length===15 && args[13]==='--images' && service==='db') console.log(m.reference);
 else if(args.length===15 && args[13]==='--hash' && service==='*') console.log('db '+m.hash);
 else red();process.exit(0);
}
if(kind==='image' && action==='inspect' && args.length===5 && args[2]==='--format') {
 if(!m.imageExists) process.exit(1);
 if(!args[3].includes('createdAt') || args[3].includes('Env')) red();
 const selected=args[4];if(selected!==m.reference && selected!==m.image) process.exit(1);
 console.log(JSON.stringify({id:selected===m.reference ? m.tag : m.image,createdAt:m.imageBirth}));process.exit(0);
}
if(kind==='container' && ['start','stop'].includes(action)) {
 if(args.length!==3 || args[2]!==id) red();
 if(m.hold) {writeFileSync(outer+'/effect-started',String(process.pid));await Bun.sleep(60000);}
 m.running=action==='start';if(m.sourceRace) {writeFileSync(root+'/src/marker','changed');}
 writeFileSync(outer+'/model.json',JSON.stringify(m));process.exit(m.partial ? 7 : 0);
}
if(!['container','volume','network'].includes(kind) || !['ls','inspect'].includes(action) || !args.includes('--format')) red();
if(m.probeHold) {writeFileSync(outer+'/probe-started',String(process.pid));await Bun.sleep(60000);}
if(action==='ls') {
 const row=kind==='container' ? {id,name:'fixture-db-1',project:'fixture'} : kind==='network' ? {id:network,name:'fixture_default',project:'fixture'} : {id:volume,name:volume,project:'fixture'};
 console.log(JSON.stringify(row));process.exit(0);
}
const selected=args.at(-1), format=args[3];
if(kind==='container') {
 if(selected!==id) process.exit(1);
 if(format.includes('.Config.Image')) console.log(JSON.stringify({id,image:m.image,reference:m.reference,createdAt:m.containerBirth}));
 else if(format.includes('config-hash')) console.log(JSON.stringify({id,hash:m.hash}));
 else if(format.includes('.Mounts')) console.log(JSON.stringify({id,name:'/fixture-db-1',project:'fixture',native:'',service:'db',number:'1',oneoff:'False',running:m.running,workingDir:root+'/.hack',configFiles:root+'/.hack/docker-compose.yml',mounts:[{type:'volume',name:volume,source:'/var/lib/docker/volumes/original/_data',target:'/data',rw:true}],networks:[{name:'fixture_default',id:network}]}));
 else if(format.includes('.State.Running')) console.log(JSON.stringify({id,running:m.running,paused:false,status:m.running ? 'running' : 'exited',...(format.includes('Health') ? {health:''} : {})}));
 else red();
} else if(kind==='volume' && selected===volume) console.log(JSON.stringify({id:volume,name:volume,project:'fixture',native:'',storage:'data',createdAt:m.volumeBirth,driver:'local',scope:'local',mountpoint:'/var/lib/docker/volumes/original/_data',options:null}));
else if(kind==='network' && selected===network) console.log(JSON.stringify({id:network,name:'fixture_default',project:'fixture',native:'',logical:'default',createdAt:born,driver:'bridge',scope:'local',internal:false,containers:m.running ? [id] : []}));
else red();
`
  );
  await chmod(binary, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = outer;
  const compiler = await managedEnvCompilerFixture(join(outer, "compiler"));
  function isModel(value: unknown): value is typeof model {
    return (
      isRecord(value) &&
      Object.keys(value).sort().join() === Object.keys(model).sort().join() &&
      Object.entries(model).every(
        ([key, original]) => typeof value[key] === typeof original
      )
    );
  }
  return {
    root,
    outer,
    config,
    compose,
    model,
    compiler,
    acceptCompose: (text: string) =>
      writeFile(join(outer, "accepted-compose"), text),
    persist: () => writeFile(modelPath, JSON.stringify(model)),
    readModel: async () => {
      const value: unknown = JSON.parse(await readFile(modelPath, "utf8"));
      if (!isModel(value)) {
        throw new Error("Synthetic model is invalid; values omitted.");
      }
      return value;
    },
    commands: async (): Promise<string[][]> =>
      (await readFile(commands, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (
            !Array.isArray(value) ||
            !value.every((part): part is string => typeof part === "string")
          ) {
            throw new Error(
              "Synthetic command ledger is invalid; values omitted."
            );
          }
          return value;
        }),
    receipt: async () => {
      const value: unknown = JSON.parse(
        await readFile(
          join(root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json"),
          "utf8"
        )
      );
      if (!isRecord(value) || !isRecord(value.checkout)) {
        throw new Error("Synthetic receipt is invalid; values omitted.");
      }
      return parseLegacyComposeAdoptionReceipt(value, {
        root: identity(value.checkout.root),
        project: identity(value.checkout.project),
        git: identity(value.checkout.git),
      });
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
