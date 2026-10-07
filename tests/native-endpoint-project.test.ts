import { afterEach, beforeEach, expect, test } from "bun:test";
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
import {
  planNativeProject,
  validateNativeProject,
} from "../src/lib/native-project-validation.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  endpoint_plan_version: 1,
};
const KEYS = [
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "CI",
  "HACK_EXECUTION_MODE",
] as const;
const CANARY = "private-endpoint-project-canary";
const TARGET = { kind: "host", port: 9443, protocol: "https" };
let root = "";
let projectRoot = "";
let receipt = "";
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-endpoint-project-"))
  );
  projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  await writeFile(
    join(projectRoot, ".hack/hack.project.json"),
    '{"schema_version":1,"name":"fixture"}'
  );
  process.env.HACK_HOME = join(root, "home");
  receipt = join(root, "requests.jsonl");
});
afterEach(async () => {
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(root, { recursive: true, force: true });
});

async function mockCompiler(
  opts: {
    readonly capability?: boolean;
    readonly localOnly?: boolean;
    readonly changedPlan?: boolean;
    readonly probe?: boolean;
  } = {}
) {
  const binary = join(root, "compiler");
  const protocol = {
    ...PROTOCOL,
    endpoint_plan_version: opts.capability === false ? undefined : 1,
    routing_plan_version: opts.probe ? 1 : undefined,
  };
  await writeFile(
    binary,
    `#!${process.execPath}
import {appendFile} from 'node:fs/promises';
if(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify(protocol))})}
else{
 const operation=process.argv[2];const raw=await Bun.stdin.text();
 const request=operation==='compile'?{}:JSON.parse(raw);
 await appendFile(${JSON.stringify(receipt)},JSON.stringify({operation,request})+'\\n');
 const target=${JSON.stringify(TARGET)};
 const plan={plan_version:1,name:'fixture',services:{web:{environment:{${opts.localOnly ? "" : "TUNNEL:{endpoint:{kind:'host_binding',name:'tunnel'}}"}}}},jobs:{},worktree:{inherit_local:false,auto_branch:false}${opts.localOnly ? "" : ",host_bindings:{tunnel:target}"}};
 const result={transport_version:1,ok:true,semantic_hash:'a'.repeat(64),declared_workloads:{web:'service'},plan};
 if(operation!=='compile'){
  result.local_resolution={overlay:null,origin:'project',auto_branch:false,inherit_local:false,resolution_hash:'b'.repeat(64)};
  const local=${Boolean(opts.localOnly)}; const changed=${Boolean(opts.changedPlan)}&&operation==='plan';
  result.host_binding_resolution={bindings:{tunnel:{target:changed?{...target,port:9444}:target,origin:local||changed?'checkout_local':'project'}},removed:{}};
  if(${Boolean(opts.probe)}&&request.routing_probe===true){result.routing_inputs_required=true}
 }
 if(operation==='plan'){
  const target=result.host_binding_resolution.bindings.tunnel.target;
  result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:{web:${opts.localOnly ? "{}" : "{TUNNEL:{kind:'endpoint',reference:{kind:'host_binding',name:'tunnel'},target:{...target,context:'workload'}}}"}},warnings:[],diagnostics:[]};
 }
 console.log(JSON.stringify(result))
}`
  );
  await chmod(binary, 0o700);
  process.env.HACK_CONFIG_COMPILER_BINARY = binary;
}

async function calls() {
  return (await readFile(receipt, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          operation: string;
          request: Record<string, unknown>;
        }
    );
}
async function failure(operation: Promise<unknown>, code: string) {
  const error: unknown = await operation.catch((value: unknown) => value);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(CANARY);
  expect(String(error)).not.toContain(root);
}
async function poisonMetadataAndGlobal() {
  await writeFile(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    `invalid [${CANARY}`
  );
  await mkdir(join(root, "home"), { recursive: true });
  await writeFile(join(root, "home/hack.config.json"), `invalid ${CANARY}`);
}

test("authored endpoint capability fence precedes local, global and managed metadata reads", async () => {
  await mockCompiler({ capability: false });
  await mkdir(join(projectRoot, ".hack/hack.local.json"));
  await poisonMetadataAndGlobal();
  await failure(
    planNativeProject({ startDir: projectRoot }),
    "E_COMPILER_VERSION"
  );
  expect((await calls()).map((call) => call.operation)).toEqual(["compile"]);
});

test("local-only endpoint capability fence precedes global policy and managed metadata", async () => {
  await mockCompiler({ localOnly: true, capability: false, probe: true });
  await writeFile(
    join(projectRoot, ".hack/hack.local.json"),
    JSON.stringify({ schema_version: 1, host_bindings: { tunnel: TARGET } })
  );
  await poisonMetadataAndGlobal();
  await failure(
    planNativeProject({ startDir: projectRoot }),
    "E_COMPILER_VERSION"
  );
  expect((await calls()).map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
  ]);
});

test("endpoint validation does not read managed YAML or unrelated global policy", async () => {
  await mockCompiler();
  await poisonMetadataAndGlobal();
  const result = await validateNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("host_binding_resolution.bindings.tunnel", {
    target: TARGET,
    origin: "project",
  });
  expect((await calls()).map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
  ]);
  expect(await Bun.file(join(projectRoot, ".hack/.internal")).exists()).toBe(
    false
  );
});

test("unchanged endpoint metadata planning preserves the prepared binding report", async () => {
  await mockCompiler();
  const result = await planNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("host_binding_resolution.bindings.tunnel", {
    target: TARGET,
    origin: "project",
  });
  expect(result).toHaveProperty(
    "environment_plan.workloads.web.TUNNEL.target",
    { ...TARGET, context: "workload" }
  );
  expect((await calls()).map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
    "plan",
  ]);
});

test("metadata planning cannot alter a prepared binding target despite equal hashes", async () => {
  await mockCompiler({ changedPlan: true });
  await writeFile(
    join(projectRoot, ".hack/hack.local.json"),
    JSON.stringify({
      schema_version: 1,
      host_bindings: { tunnel: { ...TARGET, port: 9444 } },
    })
  );
  await failure(
    planNativeProject({ startDir: projectRoot }),
    "E_COMPILER_RESPONSE"
  );
  expect((await calls()).map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
    "plan",
  ]);
});

test("local-only bindings retain a separate namespace without inventing host invocations", async () => {
  await mockCompiler({ localOnly: true });
  await writeFile(
    join(projectRoot, ".hack/hack.local.json"),
    JSON.stringify({ schema_version: 1, host_bindings: { tunnel: TARGET } })
  );
  const result = await planNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("host_binding_resolution.bindings.tunnel", {
    target: TARGET,
    origin: "checkout_local",
  });
  expect(result).not.toHaveProperty("host_env_targets");
  expect(result).not.toHaveProperty("environment_plan.host");
});
