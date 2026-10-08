import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planNativeProject,
  validateNativeProject,
} from "../src/lib/native-project-validation.ts";
import { restoreEnv } from "./helpers/env.ts";

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
const CANARY = "private-network-project-canary";
const WEB = { image: "fixture", networks: { inside: {} } };
const SOURCE = {
  schema_version: 1,
  name: "fixture",
  networks: { inside: { internal: true } },
  services: { web: WEB },
  jobs: {},
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
    await mkdtemp(join(tmpdir(), "native-network-project-"))
  );
  projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  await Bun.write(
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

async function compiler(
  opts: {
    readonly capability?: boolean;
    readonly changeAt?: "resolve" | "plan";
    readonly invalid?: boolean;
  } = {}
) {
  const binary = join(root, "compiler");
  const protocol = {
    transport_version: 1,
    authored_version: 1,
    plan_version: 1,
    resolve_version: 1,
    local_version: 1,
    env_plan_version: 1,
    network_plan_version: opts.capability === false ? undefined : 1,
  };
  await Bun.write(
    binary,
    `#!${process.execPath}
import {appendFile} from 'node:fs/promises';
if(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify(protocol))})}
else{
 const operation=process.argv[2];const text=await Bun.stdin.text();
 const request=operation==='compile'?{}:JSON.parse(text);
 await appendFile(${JSON.stringify(receipt)},JSON.stringify({operation,request})+'\\n');
 if(${Boolean(opts.invalid)}){
  console.log(JSON.stringify({transport_version:1,ok:false,diagnostics:[{code:'invalid_network_selection',pointer:'/services/web/networks',message:'Network selection cannot be empty.',line:1,column:1}]}));process.exitCode=1;
 }else{
  const plan={plan_version:1,name:'fixture',networks:{inside:{internal:true}},selected_profiles:[],services:{web:${JSON.stringify(WEB)}},jobs:{},worktree:{inherit_local:true,auto_branch:false}};
  if(operation===${JSON.stringify(opts.changeAt)})plan.networks.inside.internal=false;
  const result={transport_version:1,ok:true,semantic_hash:'a'.repeat(64),declared_workloads:{web:'service'},plan};
  if(operation!=='compile')result.local_resolution={overlay:null,origin:'project',auto_branch:false,inherit_local:true,resolution_hash:'b'.repeat(64)};
  if(operation==='plan')result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:{web:{}},warnings:[],diagnostics:[]};
  console.log(JSON.stringify(result));
 }
}`
  );
  await chmod(binary, 0o700);
  process.env.HACK_CONFIG_COMPILER_BINARY = binary;
}

async function calls(): Promise<
  readonly {
    readonly operation: string;
    readonly request: Record<string, unknown>;
  }[]
> {
  return (await Bun.file(receipt).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function failure(operation: Promise<unknown>, code: string) {
  const error: unknown = await operation.catch((value: unknown) => value);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(CANARY);
  expect(String(error)).not.toContain(root);
}

async function poison() {
  await Bun.write(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    `invalid [${CANARY}`
  );
  await mkdir(join(root, "home"), { recursive: true });
  await Bun.write(join(root, "home/hack.config.json"), `invalid ${CANARY}`);
}

test("network capability refusal precedes local, env metadata and unrelated global inputs", async () => {
  await compiler({ capability: false });
  await mkdir(join(projectRoot, ".hack/hack.local.json"));
  await poison();
  await failure(
    planNativeProject({ startDir: projectRoot }),
    "E_COMPILER_VERSION"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("network offline validation reads no managed values and creates no runtime state", async () => {
  await compiler();
  await poison();
  const before = await readdir(join(projectRoot, ".hack"));
  const result = await validateNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("plan.networks.inside.internal", true);
  expect((await calls()).map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
  ]);
  expect(await readdir(join(projectRoot, ".hack"))).toEqual(before);
});

test("network metadata planning sends provenance only, without decrypting or creating engine state", async () => {
  await compiler();
  await Bun.write(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: {
        global: { TOKEN: { secure: `invalid-ciphertext-${CANARY}` } },
        web: { LABEL: CANARY },
      },
    })
  );
  const before = await readdir(join(projectRoot, ".hack"));
  const result = await planNativeProject({ startDir: projectRoot });
  const requests = await calls();
  expect(requests.map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
    "plan",
  ]);
  expect(requests[2]?.request).toHaveProperty("env_metadata.workloads.web", {
    TOKEN: { scope: "global", secret: true },
    LABEL: { scope: "web", secret: false },
  });
  expect(JSON.stringify(requests)).not.toContain(CANARY);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(await readdir(join(projectRoot, ".hack"))).toEqual(before);
  expect(await Bun.file(join(root, "home")).exists()).toBe(false);
});

test.each([
  "resolve",
  "plan",
] as const)("%s cannot remove isolation behind unchanged identity hashes", async (changeAt) => {
  await compiler({ changeAt });
  await failure(
    planNativeProject({ startDir: projectRoot }),
    "E_COMPILER_RESPONSE"
  );
  expect((await calls()).map((call) => call.operation)).toEqual(
    changeAt === "resolve"
      ? ["compile", "resolve"]
      : ["compile", "resolve", "plan"]
  );
});

test("invalid network source keeps Rust diagnostics before poisoned local/metadata reads", async () => {
  await compiler({ invalid: true });
  await mkdir(join(projectRoot, ".hack/hack.local.json"));
  await poison();
  const result = await planNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("ok", false);
  expect(result).toHaveProperty(
    "diagnostics.0.code",
    "invalid_network_selection"
  );
  expect((await calls()).map((call) => call.operation)).toEqual(["compile"]);
});
