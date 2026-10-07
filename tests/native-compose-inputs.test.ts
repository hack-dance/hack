import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFile,
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
import { YAML } from "bun";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { isRecord } from "../src/lib/guards.ts";
import { acquireNativeComposeInputs } from "../src/lib/native-compose-inputs.ts";
import {
  type ProjectEnvStoredValue,
  type ProjectEnvValuesByScope,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  routing_plan_version: 1,
  host_env_plan_version: 1,
};
const KEYS = [
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "HACK_ENV_SECRET_KEY",
  "CI",
  "HACK_EXECUTION_MODE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
] as const;
const CANARY = "private-synthetic-compose-input-canary";
const KEY = "synthetic-compose-key-never-real-credentials";
const SOURCE = {
  schema_version: 1,
  name: "fixture",
  services: {
    web: { image: "fixture" },
    off: { image: "fixture", profiles: ["debug"] },
  },
  jobs: { seed: { image: "fixture" } },
  worktree: { inherit_local: true, auto_branch: false },
};
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
    await mkdtemp(join(tmpdir(), "native-compose-inputs-"))
  );
  projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  await writeFile(
    join(projectRoot, ".hack/hack.project.json"),
    JSON.stringify(SOURCE)
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

/** Only the compiler transport is substituted; input and freshness owners are real. */
async function compiler(
  opts: {
    readonly changeDuringPlan?: string;
    readonly withHost?: boolean;
    readonly defaultHostName?: string;
  } = {}
) {
  const binary = join(root, "compiler");
  await writeFile(
    binary,
    `#!${process.execPath}
import {appendFile} from 'node:fs/promises';
if(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify(PROTOCOL))})}
else{
 const operation=process.argv[2];const raw=await Bun.stdin.text();
 const request=operation==='compile'?{}:JSON.parse(raw);
 const profiles=process.argv.slice(3).filter((_,index)=>index%2===1);
 await appendFile(${JSON.stringify(receipt)},JSON.stringify({operation,request,profiles})+'\\n');
 const source=${JSON.stringify(SOURCE)};
 const services={web:source.services.web};if(profiles.includes('debug'))services.off=source.services.off;
 const plan={plan_version:1,name:'fixture',selected_profiles:profiles,services,jobs:source.jobs,worktree:source.worktree};
 const result={transport_version:1,ok:true,semantic_hash:'a'.repeat(64),declared_workloads:{web:'service',off:'service',seed:'job'},plan};
 if(${opts.withHost === true}){
  plan.host={up:{before:[{name:${JSON.stringify(opts.defaultHostName ?? "default-host")},command:{shell:'true'},env_target:{kind:'host'}},{name:'web-host',command:{shell:'true'},env_target:{kind:'workload',name:'web'}}]}};
  result.host_env_targets={include_default:true,workloads:['web']};
 }
 if(operation!=='compile'){
  const overlay=request.explicit_overlay??null;
  result.local_resolution={overlay,origin:request.explicit_overlay===undefined?'project':'explicit',auto_branch:false,inherit_local:true,resolution_hash:'b'.repeat(64)};
  if(request.explicit_domain!==undefined){
   const domain=request.explicit_domain;const origin='https://fixture.'+domain;
   if(request.routing_probe===true)result.routing_inputs_required=true;
   else result.routing_resolution={domain,domain_origin:'explicit',project_origin:origin,aliases:{},oauth_alias:null,open_preference:'auto',open_preference_origin:'default',open_origin:origin,routes:{}};
  }
 }
 if(operation==='plan'){
  const metadata=request.env_metadata;
  const workloads=Object.fromEntries([...Object.keys(services),'seed'].map(name=>[name,Object.fromEntries(Object.entries(metadata.workloads[name]).map(([key,entry])=>[key,{kind:'managed',key,scope:entry.scope,secret:entry.secret}]))]));
  result.environment_plan={plan_version:1,overlay:metadata.overlay,overlay_exists:metadata.overlay_exists,complete:true,workloads,warnings:[],diagnostics:[]};
  if(plan.host){
   const bindings=entries=>Object.fromEntries(Object.entries(entries).map(([key,entry])=>[key,{kind:'managed',key,scope:entry.scope,secret:entry.secret}]));
   result.environment_plan.host={[${JSON.stringify(opts.defaultHostName ?? "default-host")}]:{env_target:{kind:'host'},bindings:bindings(metadata.host.default)},'web-host':{env_target:{kind:'workload',name:'web'},bindings:bindings(metadata.host.workloads.web)}};
  }
  const changed=${JSON.stringify(opts.changeDuringPlan)};if(changed)await appendFile(changed,'\\n  \\n');
 }
 console.log(JSON.stringify(result));
}`
  );
  await chmod(binary, 0o700);
  process.env.HACK_CONFIG_COMPILER_BINARY = binary;
}

async function layer(
  filename: string,
  values: ProjectEnvValuesByScope,
  environment = "default"
) {
  await writeFile(
    join(projectRoot, ".hack", filename),
    JSON.stringify({
      version: 1,
      environment,
      secretsprovider: "project_key",
      values,
    })
  );
}

async function requests() {
  return (await readFile(receipt, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          operation: string;
          request: Record<string, unknown>;
          profiles: string[];
        }
    );
}

async function refuses(operation: Promise<unknown>) {
  const error: unknown = await operation.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("changed");
  for (const forbidden of [CANARY, KEY, root]) {
    expect(String(error)).not.toContain(forbidden);
    expect(JSON.stringify(error)).not.toContain(forbidden);
  }
}

/** Produce synthetic ciphertext through the existing owner outside the native fixture. */
async function encrypted(): Promise<ProjectEnvStoredValue> {
  const fixture = join(root, "cipher-fixture");
  await mkdir(join(fixture, ".hack"), { recursive: true });
  await writeFile(join(fixture, PROJECT_ENV_KEY_FILENAME), KEY);
  await setProjectEnvValue({
    projectRoot: fixture,
    projectDir: join(fixture, ".hack"),
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: CANARY,
    secret: true,
  });
  const parsed: unknown = YAML.parse(
    await readFile(join(fixture, ".hack/hack.env.default.yaml"), "utf8")
  );
  if (
    !(
      isRecord(parsed) &&
      isRecord(parsed.values) &&
      isRecord(parsed.values.global) &&
      isRecord(parsed.values.global.TOKEN) &&
      typeof parsed.values.global.TOKEN.secure === "string"
    )
  ) {
    throw new Error("Synthetic cipher fixture is invalid");
  }
  return { secure: parsed.values.global.TOKEN.secure };
}

test("Compose input acquisition binds metadata and private selected values to the same baseline", async () => {
  await compiler();
  await layer("hack.env.default.yaml", {
    global: { TOKEN: CANARY, MODE: "base" },
    web: { MODE: "web" },
    seed: { MODE: "job" },
    off: { INACTIVE: CANARY },
    rogue: { UNKNOWN: CANARY },
  });
  await layer("hack.env.local.yaml", { global: { LOCAL: "local" } });
  const acquired = await acquireNativeComposeInputs({ projectRoot });
  const values = await acquired.resolveManagedValues();
  expect(values).toEqual({
    web: { TOKEN: CANARY, MODE: "web", LOCAL: "local" },
    seed: { TOKEN: CANARY, MODE: "job", LOCAL: "local" },
  });
  expect(acquired.result).toHaveProperty(
    "environment_plan.workloads.web.TOKEN",
    { kind: "managed", key: "TOKEN", scope: "global", secret: false }
  );
  const planRequest = (await requests()).find(
    (entry) => entry.operation === "plan"
  );
  expect(planRequest?.request).toHaveProperty("env_metadata.workloads.off", {
    TOKEN: { scope: "global", secret: false },
    MODE: { scope: "global", secret: false },
    LOCAL: { scope: "global", secret: false },
    INACTIVE: { scope: "off", secret: false },
  });
  expect(planRequest?.request).toHaveProperty("env_metadata.inactive_scopes", [
    "rogue",
  ]);
  expect(JSON.stringify(planRequest)).not.toContain(CANARY);
  await acquired.assertFresh();
});

test("Compose input owner delivers only the captured host target and keeps its capability private", async () => {
  await compiler({ withHost: true });
  await layer("hack.env.default.yaml", {
    global: { BASE: "global" },
    host: { HOST: CANARY, BASE: "host" },
    web: { BASE: "web", WEB: "selected" },
    off: { OFF: "inactive" },
  });
  const acquired = await acquireNativeComposeInputs({ projectRoot });
  expect(await acquired.resolveHostValues("default-host")).toEqual({
    BASE: "host",
    HOST: CANARY,
  });
  expect(await acquired.resolveHostValues("web-host")).toEqual({
    BASE: "host",
    HOST: CANARY,
    WEB: "selected",
  });
  await refuses(acquired.resolveHostValues("off"));
  expect(Object.keys(acquired)).toEqual(["result"]);
  expect(JSON.stringify(acquired)).not.toContain("resolveHostValues");
  await layer("hack.env.default.yaml", { host: { HOST: "refreshed" } });
  await refuses(acquired.resolveHostValues("default-host"));
  const fresh = await acquireNativeComposeInputs({ projectRoot });
  expect(await fresh.resolveHostValues("default-host")).toEqual({
    HOST: "refreshed",
  });
});

test("unknown inherited hook names refuse before private acquisition", async () => {
  await compiler({ withHost: true });
  await layer("hack.env.default.yaml", { host: { TOKEN: await encrypted() } });
  process.env.HACK_EXECUTION_MODE = "non_interactive";
  process.env.CI = "1";
  const acquired = await acquireNativeComposeInputs({ projectRoot });
  for (const name of ["constructor", "toString", "__proto__"]) {
    await refuses(acquired.resolveHostValues(name));
  }
  expect(
    await Bun.file(join(projectRoot, PROJECT_ENV_KEY_FILENAME)).exists()
  ).toBe(false);
});

test("an own authored constructor hook retains its selected host baseline", async () => {
  await compiler({ withHost: true, defaultHostName: "constructor" });
  await layer("hack.env.default.yaml", { host: { TOKEN: CANARY } });
  const acquired = await acquireNativeComposeInputs({ projectRoot });
  expect(await acquired.resolveHostValues("constructor")).toEqual({
    TOKEN: CANARY,
  });
});

test("Compose input values follow the selected profile without admitting undeclared scopes", async () => {
  await compiler();
  await layer("hack.env.default.yaml", {
    web: { WEB: CANARY },
    off: { INACTIVE: "selected" },
    rogue: { UNKNOWN: CANARY },
  });
  const acquired = await acquireNativeComposeInputs({
    projectRoot,
    profiles: ["debug"],
  });
  expect(await acquired.resolveManagedValues()).toEqual({
    web: { WEB: CANARY },
    off: { INACTIVE: "selected" },
    seed: {},
  });
});

test("public plan mutation cannot expand the captured selected value targets", async () => {
  await compiler();
  await layer("hack.env.default.yaml", {
    web: { WEB: CANARY },
    off: { INACTIVE: CANARY },
  });
  const acquired = await acquireNativeComposeInputs({ projectRoot });
  // Owners may freeze this public record or snapshot its selected namespace.
  // Either protection must preserve the original selection during delivery.
  Reflect.set(acquired.result.environment_plan.workloads, "off", {});
  expect(await acquired.resolveManagedValues()).toEqual({
    web: { WEB: CANARY },
    seed: {},
  });
  await acquired.assertFresh();
});

test("Compose private capabilities and revision never enumerate or serialize into the public plan", async () => {
  await compiler();
  await layer("hack.env.default.yaml", { global: { TOKEN: CANARY } });
  const acquired = await acquireNativeComposeInputs({ projectRoot });
  await acquired.resolveManagedValues();
  expect(Object.keys(acquired)).toEqual(["result"]);
  expect(JSON.parse(JSON.stringify(acquired))).toEqual({
    result: acquired.result,
  });
  for (const forbidden of [
    CANARY,
    KEY,
    acquired.inputRevision,
    "inputRevision",
    "assertFresh",
    "resolveManagedValues",
  ]) {
    expect(JSON.stringify(acquired)).not.toContain(forbidden);
  }
  expect(Reflect.set(acquired, "inputRevision", "forged")).toBe(false);
});

test("Compose input acquisition snapshots caller options before asynchronous preparation", async () => {
  await compiler();
  await layer("hack.env.default.yaml", { global: { MODE: "base" } });
  await layer("hack.env.qa.yaml", { global: { MODE: "qa" } }, "qa");
  const original = new AbortController();
  const replacement = new AbortController();
  replacement.abort(CANARY);
  const opts = {
    projectRoot,
    profiles: ["debug"],
    explicitOverlay: "qa" as string | null,
    explicitDomain: "fixture.invalid",
    signal: original.signal,
  };
  const pending = acquireNativeComposeInputs(opts);
  opts.projectRoot = join(root, "not-selected");
  opts.profiles.splice(0, 1, "different");
  opts.explicitOverlay = null;
  opts.explicitDomain = "changed.invalid";
  opts.signal = replacement.signal;
  const acquired = await pending;
  expect(await acquired.resolveManagedValues()).toEqual({
    web: { MODE: "qa" },
    off: { MODE: "qa" },
    seed: { MODE: "qa" },
  });
  await acquired.assertFresh();
  for (const entry of await requests()) {
    expect(entry.profiles).toEqual(["debug"]);
    if (entry.operation !== "compile") {
      expect(entry.request).toHaveProperty("explicit_overlay", "qa");
      expect(entry.request).toHaveProperty(
        "explicit_domain",
        "fixture.invalid"
      );
    }
  }
  original.abort(CANARY);
  await expect(acquired.assertFresh()).rejects.toMatchObject({
    code: "E_COMPILER_CANCELLED",
  });
});

test("Compose acquisition detects ciphertext-only edits despite identical metadata and plaintext", async () => {
  await compiler();
  const first = await encrypted();
  const second = await encrypted();
  expect(first).not.toEqual(second);
  await writeFile(join(projectRoot, PROJECT_ENV_KEY_FILENAME), KEY);
  await layer("hack.env.default.yaml", { global: { TOKEN: first } });
  const acquired = await acquireNativeComposeInputs({ projectRoot });
  expect(await acquired.resolveManagedValues()).toEqual({
    web: { TOKEN: CANARY },
    seed: { TOKEN: CANARY },
  });
  await layer("hack.env.default.yaml", { global: { TOKEN: second } });
  await refuses(acquired.assertFresh());
  await refuses(acquired.resolveManagedValues());
  expect(JSON.stringify(acquired.result)).not.toContain(CANARY);
  expect(JSON.stringify(acquired.result)).not.toContain(JSON.stringify(second));
});

for (const filename of ["hack.project.json", "hack.local.json"] as const) {
  test(`Compose generation refuses ${filename} byte changes after acquisition`, async () => {
    await compiler();
    if (filename === "hack.local.json") {
      await writeFile(
        join(projectRoot, ".hack", filename),
        '{"schema_version":1}'
      );
    }
    await layer("hack.env.default.yaml", { global: { TOKEN: CANARY } });
    const acquired = await acquireNativeComposeInputs({ projectRoot });
    await appendFile(join(projectRoot, ".hack", filename), "\n  \n");
    await refuses(acquired.assertFresh());
    await refuses(acquired.resolveManagedValues());
  });
}

for (const filename of [
  "hack.project.json",
  "hack.local.json",
  "hack.env.default.yaml",
] as const) {
  test(`Compose preparation refuses ${filename} changes between resolution and metadata planning`, async () => {
    if (filename === "hack.local.json") {
      await writeFile(
        join(projectRoot, ".hack", filename),
        '{"schema_version":1}'
      );
    }
    await layer("hack.env.default.yaml", { global: { TOKEN: CANARY } });
    await compiler({ changeDuringPlan: join(projectRoot, ".hack", filename) });
    await refuses(acquireNativeComposeInputs({ projectRoot }));
    expect((await requests()).map((entry) => entry.operation)).toEqual([
      "compile",
      "resolve",
      "plan",
      "compile",
      "resolve",
    ]);
  });
}
