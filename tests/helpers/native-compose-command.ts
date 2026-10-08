import { afterEach, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
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
  } = {}
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-after-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({
      schema_version: 1,
      name: "fixture",
      source: { root: ".", mode: "host-mounted" },
      worktree: { inherit_local: false, auto_branch: false },
      services: { web: { image: "fixture/web:1" } },
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
if(process.argv[2]==="--protocol") console.log(${JSON.stringify(JSON.stringify(PROTOCOL))});
else {
 const operation=process.argv[2];const raw=await Bun.stdin.text();const request=operation==="compile"?{}:JSON.parse(raw);
 const text=operation==="compile"?raw:request.project;const source=JSON.parse(text);
 const normalized=entries=>entries.map(h=>({...h,environment:h.environment??{},env_target:{kind:"host"}}));
 const host=Object.fromEntries(["up","down"].map(phase=>[phase,{before:normalized(source.host?.[phase]?.before??[]),after:normalized(source.host?.[phase]?.after??[])}]));
 const profiles=process.argv.slice(3).filter((_,i,a)=>a[i-1]==="--profile").sort();
 const allHooks=[...host.up.before,...host.up.after,...host.down.before,...host.down.after];
 const plan={...source,plan_version:1,selected_profiles:profiles,jobs:{},environment:{},storage:{},host};delete plan.schema_version;delete plan.profiles;
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
if(args[0]==="compose") {
 if(args.includes("up")) {
  if(${failedStartup}) process.exit(19);
  const doc=await Bun.file(args[args.indexOf("-f")+1]).json();await Bun.write(engine,JSON.stringify(doc));await appendFile(root+"/order","engine-ready\\n");process.exit(0);
 }
 if(args.includes("down")) {await rm(engine,{force:true});await appendFile(root+"/order","engine-stopped\\n");process.exit(0);}
 process.exit(99);
}
if(args[1]==="ls") {
 if(args[0]==="container" && await Bun.file(engine).exists()) {
  const doc=await Bun.file(engine).json();console.log(JSON.stringify({id:"c".repeat(64),name:doc.name+"-web-1",project:doc.name}));
 }
 process.exit(0);
}
if(args[0]==="container" && args[1]==="inspect" && await Bun.file(engine).exists()) {
 const doc=await Bun.file(engine).json();const labels=doc.services.web.labels;
 console.log(JSON.stringify({id:"c".repeat(64),name:"/"+doc.name+"-web-1",project:doc.name,version:"1",instance:doc.name,owner:labels["io.hack.native-config.owner"],generation:labels["io.hack.native-config.generation"],service:"web",oneoff:"False",state:await Bun.file(root+"/unready").exists()?"exited":"running",exitCode:0,health:null}));process.exit(0);
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
  args = ["up", "--detach", "--json"]
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
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
        CI: "1",
        HACK_EXECUTION_MODE: "non_interactive",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
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
