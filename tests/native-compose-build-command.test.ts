import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  acquisition_plan_version: 1,
};

/** The real command/input/generation owners run; only compiler and engine transports are stand-ins. */
async function fixture(build = true) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-build-command-"))
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
      services: {
        web: {
          ...(build
            ? {
                build: {
                  context: "literal-${AMBIENT}",
                  dockerfile: "Dockerfile",
                },
              }
            : { image: "cached:fixture" }),
          command: { exec: ["true"] },
        },
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
 const operation=process.argv[2]; const raw=await Bun.stdin.text();const request=operation==="compile"?{}:JSON.parse(raw);
 const text=operation==="compile"?raw:request.project;const source=JSON.parse(text);
 const plan={...source,plan_version:1,selected_profiles:[],jobs:{},environment:{},storage:{}};delete plan.schema_version;
 const result={transport_version:1,ok:true,semantic_hash:createHash("sha256").update(text).digest("hex"),declared_workloads:{web:"service"},plan};
 if(operation!=="compile") result.local_resolution={overlay:null,origin:"project",auto_branch:false,inherit_local:false,resolution_hash:"b".repeat(64)};
 if(operation==="plan") result.environment_plan={plan_version:1,overlay:request.env_metadata.overlay,overlay_exists:request.env_metadata.overlay_exists,complete:true,workloads:{web:{}},warnings:[],diagnostics:[]};
 console.log(JSON.stringify(result));
}
`
  );
  const docker = join(root, "docker");
  await Bun.write(
    docker,
    `#!${process.execPath}
import {appendFile} from "node:fs/promises";
const root=${JSON.stringify(root)};const args=process.argv.slice(2);const image=root+"/image";const engine=root+"/engine";const network=root+"/network";
await appendFile(root+"/requests",JSON.stringify(args)+"\\n");
if(args[0]==="info") {console.log(JSON.stringify("fixture-engine:1"));process.exit(0);}
if(args[0]==="image") {
 if(args[1]==="ls") {if(await Bun.file(image).exists()) console.log("sha256:"+"d".repeat(64));process.exit(0);}
 if(args[1]==="inspect") {console.log(await Bun.file(image).text());process.exit(0);}
}
if(args[0]==="buildx") {
 if(args[1]!=="build" || args.includes("--build-arg") || !args.includes("--load") || args.at(-1)!==root+"/literal-\u0024{AMBIENT}") process.exit(91);
 const labels=Object.fromEntries(args.flatMap((value,index)=>value==="--label"?[args[index+1].split(/=(.*)/s).slice(0,2)]:[]));
 await Bun.write(image,JSON.stringify({id:"sha256:"+"d".repeat(64),version:labels["io.hack.native-config.version"],instance:labels["io.hack.native-config.instance"],owner:labels["io.hack.native-config.owner"],service:labels["com.docker.compose.service"],kind:labels["io.hack.native-config.workload"]}));process.exit(0);
}
if(args[0]==="compose") {
 const doc=await Bun.file(args[args.indexOf("-f")+1]).json();const web=doc.services.web;
 const built=Object.hasOwn(doc,"x-hack-native-build");
 if(web.build!==undefined || (built ? web.image!==doc.name+"-web:latest" || web.pull_policy!=="never" || !(await Bun.file(image).exists()) : web.image!=="cached:fixture" || web.pull_policy!==undefined)) process.exit(92);
 if(args.includes("up")) {if(args.includes("--no-build")!==built) process.exit(93);await Bun.write(engine,JSON.stringify({doc,oneoff:false}));await Bun.write(network,JSON.stringify(doc));process.exit(0);}
 if(args.includes("run")) {if(args.includes("--no-build")) process.exit(94);await Bun.write(engine,JSON.stringify({doc,oneoff:true,name:args[args.indexOf("--name")+1]}));await Bun.write(network,JSON.stringify(doc));process.exit(0);}
 process.exit(95);
}
if(args[0]==="container" && args[1]==="rm") {await Bun.file(engine).delete();process.exit(0);}
if(args[1]==="ls") {
 if(args[0]==="container" && await Bun.file(engine).exists()) {const value=await Bun.file(engine).json();console.log(JSON.stringify({id:"c".repeat(64),name:value.oneoff?value.name:value.doc.name+"-web-1",project:value.doc.name}));}
 if(args[0]==="network" && await Bun.file(network).exists()) {const doc=await Bun.file(network).json();console.log(JSON.stringify({id:"d".repeat(64),name:doc.name+"_default",project:doc.name}));}
 process.exit(0);
}
if(args[0]==="container" && args[1]==="inspect") {
 const value=await Bun.file(engine).json();const labels=value.doc.services.web.labels;
 const name=value.oneoff?value.name:value.doc.name+"-web-1";
 console.log(JSON.stringify({id:"c".repeat(64),name:"/"+name,project:value.doc.name,version:"1",instance:value.doc.name,owner:labels["io.hack.native-config.owner"],generation:labels["io.hack.native-config.generation"],service:"web",oneoff:value.oneoff?"True":"False",state:value.oneoff?"exited":"running",exitCode:0,health:null,networks:{[value.doc.name+"_default"]:{NetworkID:"d".repeat(64),Aliases:value.oneoff?[name]:[name,"web"]}}}));process.exit(0);
}
if(args[0]==="network" && args[1]==="inspect") {
 const doc=await Bun.file(network).json();const labels=doc.networks.default.labels;
 console.log(JSON.stringify({id:"d".repeat(64),name:doc.name+"_default",project:doc.name,version:"1",instance:doc.name,owner:labels["io.hack.native-config.owner"],driver:"bridge",internal:false,containers:await Bun.file(engine).exists()?{["c".repeat(64)]:{}}:{}}));process.exit(0);
}
process.exit(99);
`
  );
  await chmod(compiler, 0o700);
  await chmod(docker, 0o700);
  return root;
}

async function invoke(root: string, operation: "up" | "run") {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "--path",
      root,
      operation,
      ...(operation === "up" ? ["--detach", "--json"] : ["web", "--", "true"]),
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
        AMBIENT: "must-not-expand",
        CI: "1",
        HACK_EXECUTION_MODE: "non_interactive",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
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

test.each([
  "up",
  "run",
] as const)("source native %s builds literal source first and consumes one image-only generation", async (operation) => {
  const root = await fixture();
  const result = await invoke(root, operation);
  expect(result.code).toBe(0);
  const requests: unknown = (await Bun.file(join(root, "requests")).text())
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  expect(Array.isArray(requests)).toBe(true);
  if (!Array.isArray(requests)) {
    throw new Error("Requests missing");
  }
  const build = requests.findIndex(
    (args) => Array.isArray(args) && args[0] === "buildx"
  );
  const compose = requests.findIndex(
    (args) => Array.isArray(args) && args[0] === "compose"
  );
  expect(build).toBeGreaterThanOrEqual(0);
  expect(compose).toBeGreaterThan(build);
  expect(requests.filter((args) => args[0] === "buildx")).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain("must-not-expand");
  expect(JSON.stringify(requests)).not.toContain('"bake"');
  if (operation === "up") {
    const args = requests[compose];
    expect(args).toEqual([
      "compose",
      "-p",
      expect.any(String),
      "-f",
      expect.any(String),
      "up",
      "--no-build",
      "-d",
      "--remove-orphans",
    ]);
    expect(isRecord(JSON.parse(result.stdout))).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { status: "ready" },
    });
  } else {
    expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  }
}, 30_000);

test("source native image-only up preserves its exact startup argv", async () => {
  const root = await fixture(false);
  const result = await invoke(root, "up");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { status: "ready" },
  });
  const requests: unknown[] = (await Bun.file(join(root, "requests")).text())
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  expect(
    requests.filter((args) => Array.isArray(args) && args[0] === "buildx")
  ).toHaveLength(0);
  const args = requests.find(
    (value) => Array.isArray(value) && value[0] === "compose"
  );
  expect(args).toEqual([
    "compose",
    "-p",
    expect.any(String),
    "-f",
    expect.any(String),
    "up",
    "-d",
    "--remove-orphans",
  ]);
}, 30_000);

test("unchanged build up reuses its projected generation and owned image while rechecking readiness", async () => {
  const root = await fixture();
  expect((await invoke(root, "up")).code).toBe(0);
  const before = await Bun.file(join(root, "engine")).json();
  expect(
    before.doc.services.web.labels["io.hack.native-config.generation"]
  ).toMatch(/^[a-f0-9]{32}$/);
  expect(before.doc.services.web.build).toBeUndefined();
  expect(before.doc["x-hack-native-build"].workloads.web.build.context).toBe(
    `${root}/literal-\u0024\u0024{AMBIENT}`
  );
  const previousRequests = (await Bun.file(join(root, "requests")).text())
    .trim()
    .split("\n");
  expect((await invoke(root, "up")).code).toBe(0);
  expect(await Bun.file(join(root, "engine")).json()).toEqual(before);
  const requests: string[][] = (await Bun.file(join(root, "requests")).text())
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  expect(requests.filter((args) => args[0] === "buildx")).toHaveLength(1);
  expect(
    requests.filter((args) => args[0] === "compose" && args.includes("up"))
  ).toHaveLength(2);
  const warmRequests = requests.slice(previousRequests.length);
  expect(
    warmRequests.some(
      (args) => args[0] === "container" && args[1] === "inspect"
    )
  ).toBe(true);
  expect(
    warmRequests.some((args) => args[0] === "network" && args[1] === "inspect")
  ).toBe(true);
}, 30_000);
