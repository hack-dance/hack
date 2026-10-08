import { afterEach, expect, test } from "bun:test";
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
async function fixture(program: string, failedStartup = false) {
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
      host: {
        up: {
          before: [
            {
              name: "before",
              command: {
                exec: [
                  process.execPath,
                  "-e",
                  'await Bun.write("order","before\\n")',
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
if(process.argv[2]==="--protocol") console.log(${JSON.stringify(JSON.stringify(PROTOCOL))});
else {
 const operation=process.argv[2];const raw=await Bun.stdin.text();const request=operation==="compile"?{}:JSON.parse(raw);
 const text=operation==="compile"?raw:request.project;const source=JSON.parse(text);
 const normalized=entries=>entries.map(h=>({...h,environment:h.environment??{},env_target:{kind:"host"}}));
 const plan={...source,plan_version:1,selected_profiles:[],jobs:{},environment:{},storage:{},host:{up:{before:normalized(source.host.up.before),after:normalized(source.host.up.after)}}};delete plan.schema_version;
 const result={transport_version:1,ok:true,semantic_hash:createHash("sha256").update(text).digest("hex"),declared_workloads:{web:"service"},host_env_targets:{include_default:true,workloads:[]},plan};
 if(operation!=="compile") result.local_resolution={overlay:null,origin:"project",auto_branch:false,inherit_local:false,resolution_hash:"b".repeat(64)};
 if(operation==="plan") {
  const metadata=request.env_metadata;const bindings=entries=>Object.fromEntries(Object.entries(entries).map(([key,entry])=>[key,{kind:"managed",key,scope:entry.scope,secret:entry.secret}]));
  result.environment_plan={plan_version:1,overlay:metadata.overlay,overlay_exists:metadata.overlay_exists,complete:true,workloads:{web:bindings(metadata.workloads.web)},host:Object.fromEntries([...plan.host.up.before,...plan.host.up.after].map(h=>[h.name,{env_target:h.env_target,bindings:bindings(metadata.host.default)}])),warnings:[],diagnostics:[]};
 }
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
 if(args.includes("down")) {await rm(engine,{force:true});process.exit(0);}
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

async function invoke(root: string, args = ["up", "--detach", "--json"]) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "--path",
      root,
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
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

async function state(root: string) {
  const result = await invoke(root, ["ps", "--json"]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout).data;
}

test("source CLI runs ordered finite after hooks only after exact generation readiness and then commits ready", async () => {
  const root = await fixture(
    'if(!(await Bun.file("engine").exists())||process.env.TOKEN!=="host")process.exit(43); await Bun.write("after-value",process.env.HOST_ONLY??""); await import("node:fs/promises").then(m=>m.appendFile("order","after-exec\\n"));'
  );
  const result = await invoke(root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { status: "ready" },
  });
  expect(await Bun.file(join(root, "order")).text()).toBe(
    "before\nengine-ready\nafter-exec\nafter-shell\n"
  );
  expect(await Bun.file(join(root, "after-value")).text()).toBe("host");
  expect(await Bun.file(join(root, "engine")).json()).toMatchObject({
    services: { web: { environment: { TOKEN: "global" } } },
  });
  expect(await state(root)).toMatchObject({
    pending: false,
    beforeHooksPending: false,
    hostHookPhase: null,
    stopped: false,
  });
}, 20_000);

test("nonzero after hook preserves exit 17, skips later hooks and retains an explicitly stoppable pending engine", async () => {
  const root = await fixture("process.exit(17)");
  const result = await invoke(root);
  expect(result.code).toBe(17);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_LIFECYCLE_FAILED" },
  });
  expect(await Bun.file(join(root, "order")).text()).toBe(
    "before\nengine-ready\n"
  );
  expect(await state(root)).toMatchObject({
    pending: true,
    beforeHooksPending: false,
    hostHookPhase: null,
    stopped: true,
  });
  const down = await invoke(root, ["down", "--recover", "--json"]);
  expect(down.code).toBe(0);
  expect(JSON.parse(down.stdout)).toMatchObject({
    ok: true,
    data: { status: "stopped" },
  });
  expect(await state(root)).toMatchObject({ pending: false, stopped: true });
}, 20_000);

test("failed engine startup never runs after hooks", async () => {
  const root = await fixture('await Bun.write("after-ran","unexpected")', true);
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_STARTUP_INCOMPLETE" },
  });
  expect(await Bun.file(join(root, "after-ran")).exists()).toBe(false);
  expect(await Bun.file(join(root, "order")).text()).toBe("before\n");
}, 20_000);

test("after hook that stops an owned workload cannot commit or report ready", async () => {
  const root = await fixture('await Bun.write("unready","stopped")');
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(await state(root)).toMatchObject({
    pending: true,
    stopped: true,
    beforeHooksPending: false,
  });
}, 20_000);

test.each([
  "env",
  "source",
  "local",
] as const)("after %s changes cannot rebind the running generation or report ready", async (kind) => {
  const change = {
    env: 'await Bun.write(".hack/hack.env.default.yaml",JSON.stringify({version:1,environment:"default",secretsprovider:"project_key",values:{global:{TOKEN:"changed"}}}))',
    source:
      'const source=await Bun.file(".hack/hack.project.json").json();source.name="changed";await Bun.write(".hack/hack.project.json",JSON.stringify(source))',
    local:
      'await Bun.write(".hack/hack.local.json",JSON.stringify({schema_version:1}))',
  };
  const root = await fixture(change[kind]);
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(await state(root)).toMatchObject({
    pending: true,
    stopped: true,
    hostHookPhase: null,
  });
  expect(await Bun.file(join(root, "engine")).json()).toMatchObject({
    services: { web: { environment: { TOKEN: "global" } } },
  });
}, 20_000);
