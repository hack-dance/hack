import { afterEach, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeComposeStorageDockerFixtureScript } from "./native-compose-storage-docker.ts";

const roots: string[] = [];
const cleanupGuards = new Map<string, () => boolean>();
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => {
      if (cleanupGuards.get(root)?.() === false) {
        return Promise.resolve();
      }
      cleanupGuards.delete(root);
      return rm(root, { recursive: true, force: true });
    })
  );
});
const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  host_env_plan_version: 1,
};

/** Compiler/Docker transports are stand-ins; phase ordering, owners, shell execution and durable receipts use the real source CLI. */
export async function fixture(
  program: string,
  failedStartup = false,
  opts: {
    readonly phase?: "up" | "down";
    readonly before?: string;
    readonly hooks?: unknown;
    readonly noHooks?: boolean;
    readonly oneoff?: boolean;
    readonly cleanupAllowed?: () => boolean;
    readonly storage?: Readonly<
      Record<
        string,
        { readonly kind: "persistent"; readonly scope: "worktree" }
      >
    >;
  } = {}
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-after-command-"))
  );
  roots.push(root);
  if (opts.cleanupAllowed) {
    cleanupGuards.set(root, opts.cleanupAllowed);
  }
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({
      schema_version: 1,
      name: "fixture",
      source: { root: ".", mode: "host-mounted" },
      worktree: { inherit_local: false, auto_branch: false },
      services: {
        web: {
          image: "fixture/web:1",
          ...(opts.storage
            ? {
                mounts: Object.keys(opts.storage).map((storage) => ({
                  storage,
                  target: `/storage/${storage}`,
                  access: "read-write",
                })),
              }
            : {}),
        },
      },
      ...(opts.storage ? { storage: opts.storage } : {}),
      ...(opts.noHooks
        ? {}
        : {
            host: opts.hooks ?? {
              [opts.phase ?? "up"]: {
                before: [
                  {
                    name: "before",
                    command: {
                      exec: [
                        process.execPath,
                        "-e",
                        opts.before ?? 'await Bun.write("order","before\\n")',
                      ],
                    },
                  },
                ],
                after: [
                  {
                    name: "after-exec",
                    command: { exec: [process.execPath, "-e", program] },
                  },
                  {
                    name: "after-shell",
                    command: { shell: 'printf "after-shell\\n" >> order' },
                  },
                ],
              },
            },
          }),
    })
  );
  await Bun.write(
    join(root, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: {
        global: { TOKEN: "global" },
        host: { TOKEN: "host", HOST_ONLY: "host" },
      },
    })
  );
  const compiler = join(root, "compiler");
  await Bun.write(
    compiler,
    `#!${process.execPath}
import {createHash} from "node:crypto";
await import("node:fs/promises").then(m=>m.appendFile("compiler-requests",process.argv[2]+"\\n"));
if(process.argv[2]==="--protocol") console.log(JSON.stringify({...${JSON.stringify(PROTOCOL)},...((await Bun.file("restart-transient").exists()||await Bun.file("restart-finalization-gap").exists())?{process_plan_version:1}:{})}));
else {
 const operation=process.argv[2];const raw=await Bun.stdin.text();const request=operation==="compile"?{}:JSON.parse(raw);
 const text=operation==="compile"?raw:request.project;const source=JSON.parse(text);
 const normalized=entries=>entries.map(h=>({...h,environment:h.environment??{},env_target:{kind:"host"}}));
 const host=Object.fromEntries(["up","down"].map(phase=>[phase,{before:normalized(source.host?.[phase]?.before??[]),after:normalized(source.host?.[phase]?.after??[])}]));
 const profiles=process.argv.slice(3).filter((_,i,a)=>a[i-1]==="--profile").sort();
 const allHooks=[...host.up.before,...host.up.after,...host.down.before,...host.down.after];
 const plan={...source,plan_version:1,selected_profiles:profiles,jobs:{},environment:{},storage:source.storage??{},host};delete plan.schema_version;delete plan.profiles;
 const result={transport_version:1,ok:true,semantic_hash:createHash("sha256").update(text).digest("hex"),declared_workloads:{web:"service"},host_env_targets:{include_default:[...host.up.before,...host.up.after,...host.down.before,...host.down.after].length>0,workloads:[]},plan};
 if(allHooks.length===0) {delete plan.host;delete result.host_env_targets;}
 if(operation!=="compile") result.local_resolution={overlay:null,origin:"project",auto_branch:false,inherit_local:false,resolution_hash:"b".repeat(64)};
 if(operation==="plan") {
  const metadata=request.env_metadata;const bindings=entries=>Object.fromEntries(Object.entries(entries).map(([key,entry])=>[key,{kind:"managed",key,scope:entry.scope,secret:entry.secret}]));
  result.environment_plan={plan_version:1,overlay:metadata.overlay,overlay_exists:metadata.overlay_exists,complete:true,workloads:{web:bindings(metadata.workloads.web)},host:Object.fromEntries(allHooks.map(h=>[h.name,{env_target:h.env_target,bindings:bindings(metadata.host.default)}])),warnings:[],diagnostics:[]};
 }
 if(result.environment_plan && allHooks.length===0) delete result.environment_plan.host;
 console.log(JSON.stringify(result));
}
`
  );
  const docker = join(root, "docker");
  await Bun.write(
    docker,
    `#!${process.execPath}
import {appendFile,rm} from "node:fs/promises";
const root=${JSON.stringify(root)};const args=process.argv.slice(2);
await appendFile(root+"/requests",JSON.stringify(args)+"\\n");
const engine=root+"/engine";
const volumes=root+"/volumes";
${opts.storage ? nativeComposeStorageDockerFixtureScript(root) : ""}
const oneoff=${opts.oneoff === true};
const removed=oneoff && await Bun.file(root+"/oneoff-removed").exists();
const oneoffName=oneoff && await Bun.file(root+"/oneoff-name").exists()?await Bun.file(root+"/oneoff-name").text():"";
if(args[0]==="compose") {
 if(args.includes("up")) {
  if(${failedStartup}) process.exit(19);
  const doc=await Bun.file(args[args.indexOf("-f")+1]).json();
  if(Object.keys(doc.volumes).length>0) {
   const retained=await Bun.file(volumes).exists()?await Bun.file(volumes).json():[];
   for(const [storage,volume] of Object.entries(doc.volumes)) {
    if(!retained.some(row=>row.name===volume.name)) {
     retained.push({id:volume.name,name:volume.name,project:doc.name,version:volume.labels["io.hack.native-config.version"],instance:volume.labels["io.hack.native-config.instance"],owner:volume.labels["io.hack.native-config.owner"],storage,createdAt:new Date().toISOString()});
    }
   }
   await Bun.write(volumes,JSON.stringify(retained));
  }
  await Bun.write(engine,JSON.stringify(doc));${opts.storage ? 'await appendFile(root+"/storage-events","workload\\n");' : ""}await appendFile(root+"/order","engine-ready\\n");process.exit(0);
 }
 if(oneoff && args.includes("run")) {const doc=await Bun.file(args[args.indexOf("-f")+1]).json();await Bun.write(engine,JSON.stringify(doc));await Bun.write(root+"/oneoff-name",args[args.indexOf("--name")+1]);process.exit(0);}
 if(args.includes("down")) {await rm(engine,{force:true});await appendFile(root+"/order","engine-stopped\\n");process.exit(0);}
 process.exit(99);
}
if(oneoff && args[0]==="container" && args[1]==="rm") {if(args.length!==3||args[2]!=="c".repeat(64))process.exit(96);await Bun.write(root+"/oneoff-removed","removed");process.exit(0);}
if(args[1]==="ls") {
 if(args[0]==="volume" && await Bun.file(volumes).exists()) {
  for(const row of await Bun.file(volumes).json())console.log(JSON.stringify({id:row.name,name:row.name,project:row.project}));
 }
 if(args[0]==="container" && await Bun.file(engine).exists() && !removed) {
  const doc=await Bun.file(engine).json();console.log(JSON.stringify({id:"c".repeat(64),name:oneoff?oneoffName:doc.name+"-web-1",project:doc.name}));
 }
 if(args[0]==="network" && await Bun.file(engine).exists()) {
  const doc=await Bun.file(engine).json();console.log(JSON.stringify({id:"d".repeat(64),name:doc.name+"_default",project:doc.name}));
 }
 process.exit(0);
}
if(args[0]==="volume" && args[1]==="inspect" && await Bun.file(volumes).exists()) {
 const selected=args.slice(args.indexOf("--format")+2),format=args[args.indexOf("--format")+1];
 const retained=await Bun.file(volumes).json();
 for(const name of selected) {
  const volume=retained.find(row=>row.name===name);if(!volume)process.exit(1);
  const {createdAt,...row}=volume;
  console.log(JSON.stringify({...row,...(format.includes(".CreatedAt")?{createdAt}:{})}));
 }
 process.exit(0);
}
if(args[0]==="container" && args[1]==="inspect" && await Bun.file(engine).exists()) {
 const doc=await Bun.file(engine).json();const labels=doc.services.web.labels;
 if(oneoff) {console.log(JSON.stringify({id:"c".repeat(64),name:"/"+oneoffName,project:doc.name,version:"1",instance:doc.name,owner:labels["io.hack.native-config.owner"],generation:labels["io.hack.native-config.generation"],service:"web",oneoff:"True",state:"exited",exitCode:0,health:null,networks:{[doc.name+"_default"]:{NetworkID:"d".repeat(64),Aliases:[oneoffName]}}}));process.exit(0);}
 const transitional=await Bun.file(root+"/restart-transient").exists();const finalGap=await Bun.file(root+"/restart-finalization-gap").exists();const counter=root+"/restart-container-inspects";const count=(transitional||finalGap)&&await Bun.file(counter).exists()?Number(await Bun.file(counter).text()):0;if(transitional||finalGap)await Bun.write(counter,String(count+1));
 console.log(JSON.stringify({id:"c".repeat(64),name:"/"+doc.name+"-web-1",project:doc.name,version:"1",instance:doc.name,owner:labels["io.hack.native-config.owner"],generation:labels["io.hack.native-config.generation"],service:"web",oneoff:"False",state:await Bun.file(root+"/unready").exists()?"exited":transitional&&count<2||finalGap&&count>=2?"restarting":"running",exitCode:0,health:null,networks:{[doc.name+"_default"]:{NetworkID:"d".repeat(64),Aliases:[doc.name+"-web-1","web"]}}}));process.exit(0);
}
if(args[0]==="network" && args[1]==="inspect" && await Bun.file(engine).exists()) {
 const doc=await Bun.file(engine).json();const labels=doc.networks.default.labels;
 const transitional=await Bun.file(root+"/restart-transient").exists();const finalGap=await Bun.file(root+"/restart-finalization-gap").exists();const counter=root+"/restart-network-inspects";const count=(transitional||finalGap)&&await Bun.file(counter).exists()?Number(await Bun.file(counter).text()):0;if(transitional||finalGap)await Bun.write(counter,String(count+1));
 console.log(JSON.stringify({id:"d".repeat(64),name:doc.name+"_default",project:doc.name,version:"1",instance:doc.name,owner:labels["io.hack.native-config.owner"],driver:removed&&await Bun.file(root+"/trace-post-remove-refusal").exists()?"foreign":"bridge",internal:false,containers:removed?{}:transitional&&count<2||finalGap&&count>=2?{}:{["c".repeat(64)]:{}}}));process.exit(0);
}
process.exit(99);
`
  );
  await chmod(compiler, 0o700);
  await chmod(docker, 0o700);
  return root;
}

export async function invoke(
  root: string,
  args = ["up", "--detach", "--json"],
  startupTimeoutMs = 1000,
  commandTimeoutMs = 15_000
) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../index.ts"),
      "--path",
      root,
      ...args,
    ],
    {
      cwd: root,
      env: {
        HOME: process.env.HOME,
        LANG: "C",
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_GLOBAL_CONFIG_PATH: join(root, "global.json"),
        HACK_CONFIG_COMPILER_BINARY: join(root, "compiler"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: String(startupTimeoutMs),
        CI: "1",
        HACK_EXECUTION_MODE: "non_interactive",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), commandTimeoutMs);
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

export async function state(root: string) {
  const result = await invoke(root, ["ps", "--json"]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout).data;
}
