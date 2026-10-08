import { afterEach, expect } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../src/lib/native-compose-generation.ts";

const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
const compiler = resolve(
  process.env.HACK_CONFIG_COMPILER_BINARY ?? "dist/hack-config-compiler"
);
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
export const FILE_CANARY = "synthetic-only-private-file-value-$-no-newline";
export const FILE_BYTES = Buffer.from([0, 255, 4, 10]);
export const FILE_SOURCE = {
  schema_version: 1,
  name: "files",
  worktree: { auto_branch: false },
  configs: { binary: { file: "binary" } },
  secrets: { token: { env_ref: "TOKEN" }, empty: { env_ref: "EMPTY" } },
  services: {
    reader: {
      image: "synthetic/reader:1",
      environment: { TOKEN: { unset: true } },
      mounts: [
        { config: "binary", target: "/etc/binary", access: "read-only" },
        { secret: "token", target: "/run/token", access: "read-only" },
        { secret: "empty", target: "/run/empty", access: "read-only" },
      ],
    },
  },
};
const CONTAINER_LIST =
  '{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "com.docker.compose.project")}}}';
const CONTAINER_INSPECT =
  '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"version":{{json (index .Config.Labels "io.hack.native-config.version")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"generation":{{json (index .Config.Labels "io.hack.native-config.generation")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"state":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}},"networks":{{json .NetworkSettings.Networks}}}';
const VOLUME_LIST =
  '{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}}}';
const NETWORK_LIST =
  '{"id":{{json .ID}},"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}}}';
const NETWORK_INSPECT =
  '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "com.docker.compose.project")}},"version":{{json (index .Labels "io.hack.native-config.version")}},"instance":{{json (index .Labels "io.hack.native-config.instance")}},"owner":{{json (index .Labels "io.hack.native-config.owner")}},"driver":{{json .Driver}},"internal":{{json .Internal}},"containers":{{json .Containers}}}';
const MOUNT_INSPECT = '{"id":{{json .Id}},"mounts":{{json .Mounts}}}';

/** Only Docker responses are stand-ins: compiler, inputs, hooks, child groups,
 * private bytes, generation and material journals use current source owners. */
export async function fileCommandFixture(source: unknown = FILE_SOURCE) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "native-file-command-"))
  );
  roots.push(parent);
  const root = join(parent, "checkout");
  await mkdir(join(root, ".hack"), { recursive: true });
  await mkdir(join(parent, "home"), { mode: 0o700 });
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(source)
  );
  await Bun.write(join(root, "binary"), FILE_BYTES);
  await Bun.write(
    join(root, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: FILE_CANARY, EMPTY: "" } },
    })
  );
  const docker = join(parent, "docker");
  await Bun.write(
    docker,
    `#!${process.execPath}
import {appendFile,readFile,stat,rm,rename,writeFile} from "node:fs/promises";
const parent=${JSON.stringify(parent)},root=${JSON.stringify(root)},args=process.argv.slice(2),id="c".repeat(64),foreign="d".repeat(64),networkId="b".repeat(64);
await appendFile(parent+"/requests",JSON.stringify(args)+"\\n");
const engine=parent+"/engine",same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),exists=path=>Bun.file(path).exists();
async function fail(){await Bun.write(parent+"/unexpected","unexpected engine operation");process.exit(97);}
let doc=await exists(engine)?await Bun.file(engine).json():null;
if(args[0]==="compose"){
 const f=args.indexOf("-f");if(f!==3||args[1]!=="-p")await fail();
 if(same(args.slice(5),["up","-d","--remove-orphans"])||same(args.slice(5),["up","-d","--remove-orphans","--force-recreate"])){
  doc=await Bun.file(args[4]).json();if(doc.name!==args[2])await fail();
  const rows=[];for(const v of doc.services.reader.volumes??[]){const p=v.source.replaceAll("$$",()=>"$");rows.push({target:v.target.replaceAll("$$",()=>"$"),bytes:Array.from(await readFile(p)),mode:(await stat(p)).mode&511,readonly:v.read_only,create:v.bind?.create_host_path});}
  await Bun.write(parent+"/delivered",JSON.stringify(rows));await Bun.write(engine,JSON.stringify(doc));await Bun.write(parent+"/last-document",JSON.stringify(doc));
  if(await exists(parent+"/timeout"))await Bun.sleep(60000);
  if(await exists(parent+"/failed"))process.exit(19);
  process.exit(0);
 }
 if(same(args.slice(5),["down","--remove-orphans"])) {
  await rm(engine,{force:true});await Bun.write(parent+"/stop-started","started");
  if(await exists(parent+"/stop-timeout"))await Bun.sleep(60000);
  if(await exists(parent+"/stop-orphan"))Bun.spawn([process.execPath,"-e","await Bun.sleep(1500)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  process.exit(0);
 }
 await fail();
}
if(same(args,["info","--format","{{json .ID}}"])) {
 let changed=await exists(parent+"/drift");
 if(await exists(parent+"/after-retirement-drift")&&await exists(parent+"/last-document")){
  const last=await Bun.file(parent+"/last-document").json(),ref=last["x-hack-native-files"];
  if(ref){const journal=await Bun.file(ref.root+"/"+ref.generationId+"-"+ref.snapshotToken+"/journal.jsonl").text();changed=changed||journal.includes('"phase":"retired"');}
 }
 console.log(JSON.stringify(changed?"changed-engine:1":"synthetic-engine:1"));process.exit(0);
}
const project=doc?.name??null;
const hasForeign=await exists(parent+"/foreign-source");
if(same(args,["container","ls","-a","--no-trunc","--format","{{json .ID}}"])) {if(doc)console.log(JSON.stringify(id));if(hasForeign)console.log(JSON.stringify(foreign));process.exit(0);}
if(same(args,["container","inspect","--format",${JSON.stringify(MOUNT_INSPECT)},...(doc?[id]:[]),...(hasForeign?[foreign]:[])])){
 if(doc){
  const mounts=(doc.services.reader.volumes??[]).map(v=>({Type:v.type,Source:v.source.replaceAll("$$",()=>"$"),Destination:v.target.replaceAll("$$",()=>"$"),RW:v.read_only!==true}));
  const retired=async flag=>await exists(parent+"/"+flag)&&(await Bun.file(await Bun.file(parent+"/"+flag).text()).text()).includes('"phase":"retired"');
  if(await retired("late-mount-drift")){mounts.push({Type:"bind",Source:mounts[0].Source,Destination:"/foreign",RW:false});await Bun.write(parent+"/late-drift-reached","reached");}
  if(await retired("late-member-drift")&&!await exists(parent+"/late-drift-reached")){const first=mounts[0];await rename(first.Source,first.Source+".original");await writeFile(first.Source,Buffer.from(${JSON.stringify(Array.from(FILE_BYTES))}),{mode:0o444});await Bun.write(parent+"/late-drift-reached","reached");}
  console.log(JSON.stringify({id,mounts}));
 }
 if(hasForeign)console.log(JSON.stringify({id:foreign,mounts:[{Type:"bind",Source:await Bun.file(parent+"/foreign-source").text(),Destination:"/foreign",RW:false}]}));process.exit(0);
}
const formats={container:${JSON.stringify(CONTAINER_LIST)},volume:${JSON.stringify(VOLUME_LIST)},network:${JSON.stringify(NETWORK_LIST)}};
if(formats[args[0]]&&same(args,[args[0],"ls",...(args[0]==="container"?["--all","--no-trunc"]:args[0]==="network"?["--no-trunc"]:[]),"--format",formats[args[0]]])){
 if(args[0]==="container"&&doc)console.log(JSON.stringify({id,name:project+"-reader-1",project}));
 if(args[0]==="network"&&doc)console.log(JSON.stringify({id:networkId,name:doc.networks.default.name,project}));process.exit(0);
}
if(same(args,["container","inspect","--format",${JSON.stringify(CONTAINER_INSPECT)},id])){
 if(!doc)await fail();const l=doc.services.reader.labels;console.log(JSON.stringify({id,name:"/"+project+"-reader-1",project,version:l["io.hack.native-config.version"],instance:l["io.hack.native-config.instance"],owner:l["io.hack.native-config.owner"],generation:l["io.hack.native-config.generation"],service:"reader",oneoff:"False",state:await exists(parent+"/unready")?"exited":"running",exitCode:0,health:null,networks:{[doc.networks.default.name]:{NetworkID:networkId,Aliases:[project+"-reader-1","reader"]}}}));process.exit(0);
}
if(same(args,["network","inspect","--format",${JSON.stringify(NETWORK_INSPECT)},networkId])){
 if(!doc)await fail();const n=doc.networks.default,l=n.labels;console.log(JSON.stringify({id:networkId,name:n.name,project,version:l["io.hack.native-config.version"],instance:l["io.hack.native-config.instance"],owner:l["io.hack.native-config.owner"],driver:"bridge",internal:n.internal??false,containers:{[id]:{}}}));process.exit(0);
}
await fail();
`
  );
  await chmod(docker, 0o700);
  return { parent, root };
}
export function spawnFiles(
  fixture: { readonly parent: string; readonly root: string },
  args = ["up", "--detach", "--json"]
) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../index.ts"),
      "--path",
      fixture.root,
      ...args,
    ],
    {
      cwd: fixture.root,
      env: {
        HOME: process.env.HOME,
        LANG: "C",
        PATH: `${fixture.parent}:/usr/bin:/bin`,
        HACK_HOME: join(fixture.parent, "home"),
        HACK_GLOBAL_CONFIG_PATH: join(fixture.parent, "global.json"),
        HACK_CONFIG_COMPILER_BINARY: compiler,
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: "3000",
        CI: "1",
        HACK_EXECUTION_MODE: "non_interactive",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  return child;
}
export async function invokeFiles(
  fixture: { readonly parent: string; readonly root: string },
  args = ["up", "--detach", "--json"]
) {
  const child = spawnFiles(fixture, args);
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
export async function fileCommandState(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const current = await store.loadCurrent(),
      pending = await store.loadPending();
    const selected = pending ?? current.generation;
    const document = selected
      ? await store.readGenerationDocument(selected)
      : null;
    return { current, pending, document };
  } finally {
    await store.close();
  }
}
export function fileReference(document: unknown) {
  if (!(isRecord(document) && isRecord(document["x-hack-native-files"]))) {
    throw new Error("Missing actual material reference");
  }
  return document["x-hack-native-files"];
}
export async function fileJournal(document: unknown) {
  const ref = fileReference(document);
  return readFile(
    join(
      String(ref.root),
      `${ref.generationId}-${ref.snapshotToken}`,
      "journal.jsonl"
    ),
    "utf8"
  );
}
export async function assertFileTransport(fixture: {
  readonly parent: string;
}) {
  expect(await Bun.file(join(fixture.parent, "unexpected")).exists()).toBe(
    false
  );
  return (await Bun.file(join(fixture.parent, "requests")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
