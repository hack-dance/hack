import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
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
  process_plan_version: 1,
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
const CANARY = "private-process-project-canary";
const WEB = {
  image: "fixture",
  entrypoint: { exec: [] },
  init: false,
  shutdown: { signal: "SIGPWR", grace: "2s" },
  restart: { kind: "unless-stopped" },
};
const SOURCE = {
  schema_version: 1,
  name: "fixture",
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
    await mkdtemp(join(tmpdir(), "native-process-project-"))
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

async function mockCompiler(
  opts: {
    readonly capability?: boolean;
    readonly changeAt?: "resolve" | "plan";
    readonly invalid?: boolean;
  } = {}
) {
  const binary = join(root, "compiler");
  const protocol = {
    ...PROTOCOL,
    process_plan_version: opts.capability === false ? undefined : 1,
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
 if(${Boolean(opts.invalid)}){
  console.log(JSON.stringify({transport_version:1,ok:false,diagnostics:[{code:'invalid_restart',pointer:'/services/web/restart',message:'Invalid restart policy.',line:1,column:1}]}));process.exitCode=1;
 }else{
  const web=${JSON.stringify(WEB)};web.shutdown.grace='2000ms';
  if(operation===${JSON.stringify(opts.changeAt)})web.init=true;
  const plan={plan_version:1,name:'fixture',selected_profiles:[],services:{web},jobs:{},worktree:{inherit_local:true,auto_branch:false}};
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

async function managedValues(
  project: string,
  filename = "hack.env.default.yaml"
) {
  await writeFile(
    join(project, ".hack", filename),
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
}

async function git(project: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", project, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
}

async function linked() {
  await git(projectRoot, ["init", "--quiet", "-b", "main"]);
  await git(projectRoot, ["add", ".hack/hack.project.json"]);
  await git(projectRoot, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const checkout = join(root, "linked");
  await git(projectRoot, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "fixture",
    checkout,
  ]);
  return checkout;
}

test("authored process capability is required before local policy, managed metadata or global reads", async () => {
  await mockCompiler({ capability: false });
  await mkdir(join(projectRoot, ".hack/hack.local.json"));
  await poisonMetadataAndGlobal();
  await failure(
    planNativeProject({ startDir: projectRoot }),
    "E_COMPILER_VERSION"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("process validation preserves planning-only behavior without managed values or unrelated global policy", async () => {
  await mockCompiler();
  await poisonMetadataAndGlobal();
  const before = await readdir(join(projectRoot, ".hack"));
  const result = await validateNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("plan.services.web.init", false);
  expect(result).toHaveProperty("plan.services.web.shutdown.grace", "2000ms");
  expect((await calls()).map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
  ]);
  expect(await readdir(join(projectRoot, ".hack"))).toEqual(before);
});

test("process metadata planning passes only names and provenance to the compiler", async () => {
  await mockCompiler();
  await managedValues(projectRoot);
  const before = await readdir(join(projectRoot, ".hack"));
  const result = await planNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("plan.services.web.entrypoint", { exec: [] });
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
] as const)("%s cannot alter process intent behind unchanged identity hashes", async (changeAt) => {
  await mockCompiler({ changeAt });
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

test("authoritative invalid-process diagnostics stop before poisoned local or metadata inputs", async () => {
  await mockCompiler({ invalid: true });
  await mkdir(join(projectRoot, ".hack/hack.local.json"));
  await poisonMetadataAndGlobal();
  const result = await planNativeProject({ startDir: projectRoot });
  expect(result).toHaveProperty("ok", false);
  expect(result).toHaveProperty("diagnostics.0", {
    code: "invalid_restart",
    pointer: "/services/web/restart",
    message: "Invalid restart policy.",
    line: 1,
    column: 1,
    document: "project",
  });
  expect((await calls()).map((call) => call.operation)).toEqual(["compile"]);
});

test("linked worktree process planning preserves source policy and verified local inheritance without runtime effects", async () => {
  const checkout = await linked();
  const primaryLocal = JSON.stringify({ schema_version: 1 });
  const checkoutLocal = JSON.stringify({ schema_version: 1 });
  await writeFile(join(projectRoot, ".hack/hack.local.json"), primaryLocal);
  await writeFile(join(checkout, ".hack/hack.local.json"), checkoutLocal);
  await managedValues(projectRoot, "hack.env.local.yaml");
  await mockCompiler();
  const primaryBefore = await readdir(join(projectRoot, ".hack"));
  const checkoutBefore = await readdir(join(checkout, ".hack"));
  const result = await planNativeProject({ startDir: checkout });
  expect(result).toHaveProperty(
    "plan.services.web.restart.kind",
    "unless-stopped"
  );
  const requests = await calls();
  for (const call of requests.filter(
    (entry) => entry.operation !== "compile"
  )) {
    expect(call.request).toHaveProperty("primary_local", primaryLocal);
    expect(call.request).toHaveProperty("checkout_local", checkoutLocal);
    expect(call.request).toHaveProperty("project", JSON.stringify(SOURCE));
  }
  expect(requests[2]?.request).toHaveProperty(
    "env_metadata.workloads.web.TOKEN",
    {
      scope: "global",
      secret: true,
    }
  );
  expect(JSON.stringify(requests)).not.toContain(CANARY);
  expect(await readdir(join(projectRoot, ".hack"))).toEqual(primaryBefore);
  expect(await readdir(join(checkout, ".hack"))).toEqual(checkoutBefore);
  expect(await Bun.file(join(root, "home")).exists()).toBe(false);
});
