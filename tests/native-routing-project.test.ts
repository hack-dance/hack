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
import { join, resolve } from "node:path";
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
  routing_plan_version: 1,
};
const CANARY = "private-global-routing-canary";
const KEYS = [
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "CI",
  "HACK_EXECUTION_MODE",
] as const;
let root: string;
let saved: Record<string, string | undefined>;
let projectRoot: string;
let receipt: string;
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-routing-project-"))
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
    readonly routing?: boolean;
    readonly localRouting?: boolean;
    readonly capability?: boolean;
  } = {}
) {
  const binary = join(root, "compiler");
  const protocol =
    opts.capability === false
      ? { ...PROTOCOL, routing_plan_version: undefined }
      : PROTOCOL;
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFile } from 'node:fs/promises';
if (process.argv[2] === '--protocol') { console.log(${JSON.stringify(JSON.stringify(protocol))}); }
else {
 const operation=process.argv[2]; const raw=await Bun.stdin.text();
 const request=operation==='compile'?{}:JSON.parse(raw);
 await appendFile(${JSON.stringify(receipt)}, JSON.stringify({operation,request})+'\\n');
 const plan={plan_version:1,name:'fixture',services:{},jobs:{},worktree:{inherit_local:false,auto_branch:false}${opts.routing ? ",routes:{aliases:{},http:{}}" : ""}};
 const result={transport_version:1,ok:true,semantic_hash:'a'.repeat(64),declared_workloads:{},plan};
 if(operation!=='compile') {
  result.local_resolution={overlay:null,origin:'project',auto_branch:false,inherit_local:false,resolution_hash:'b'.repeat(64)};
  if(${opts.routing || opts.localRouting ? "true" : "false"} || request.explicit_domain!==undefined) {
   const domain=request.explicit_domain??request.global_domain??'hack.local';
   const origin='https://fixture.'+domain;
   if(request.routing_probe===true) result.routing_inputs_required=true;
   else result.routing_resolution={domain,domain_origin:request.explicit_domain!==undefined?'explicit':request.global_domain!==undefined?'global':'default',project_origin:origin,aliases:{},oauth_alias:null,open_preference:'auto',open_preference_origin:'default',open_origin:origin,routes:{}};
  }
 }
 if(operation==='plan') result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:{},warnings:[],diagnostics:[]};
 console.log(JSON.stringify(result));
}
`
  );
  await chmod(binary, 0o700);
  process.env.HACK_CONFIG_COMPILER_BINARY = binary;
  return binary;
}
async function globalPolicy(
  text = JSON.stringify({ default_domain: "global.invalid", secret: CANARY })
) {
  await mkdir(join(root, "home"), { recursive: true });
  await writeFile(join(root, "home/hack.config.json"), text);
}
async function failure(operation: Promise<unknown>, code: string) {
  const error: unknown = await operation.catch((value: unknown) => value);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(CANARY);
}
async function requests() {
  return (await readFile(receipt, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("explicit domain and global scalar reach resolve and plan identically without unrelated global values", async () => {
  await mockCompiler({ routing: true });
  await globalPolicy();
  const result = await planNativeProject({
    startDir: projectRoot,
    explicitDomain: "explicit.invalid",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected planning success");
  }
  expect(result.routing_resolution?.domain).toBe("explicit.invalid");
  const calls = await requests();
  const resolved = calls.filter((call) => call.operation === "resolve");
  expect(resolved).toHaveLength(2);
  expect(resolved[0].request.routing_probe).toBe(true);
  expect(resolved[0].request).not.toHaveProperty("global_domain");
  expect(resolved[1].request).not.toHaveProperty("routing_probe");
  expect(resolved[1].request.global_domain).toBe("global.invalid");
  const planned = calls.find((call) => call.operation === "plan");
  expect(planned.request.explicit_domain).toBe("explicit.invalid");
  expect(planned.request.global_domain).toBe(resolved[1].request.global_domain);
  expect(JSON.stringify(calls)).not.toContain(CANARY);
});

test("validation never reads managed YAML and nonrouting validation never reads global policy", async () => {
  await mockCompiler();
  await globalPolicy(`broken ${CANARY}`);
  await writeFile(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    `broken [${CANARY}`
  );
  expect((await validateNativeProject({ startDir: projectRoot })).ok).toBe(
    true
  );
  await mockCompiler({ routing: true });
  await globalPolicy();
  expect((await validateNativeProject({ startDir: projectRoot })).ok).toBe(
    true
  );
});

test("routing global failures are refused rather than replaced by defaults", async () => {
  await mockCompiler({ routing: true });
  await globalPolicy(`broken ${CANARY}`);
  await failure(
    validateNativeProject({ startDir: projectRoot }),
    "E_CONFIG_INPUT"
  );
  expect(
    (await requests()).filter((call) => call.operation === "resolve")
  ).toHaveLength(1);
});

test("explicit routing capability is fenced before compile or local policy acquisition", async () => {
  await mockCompiler({ capability: false });
  await mkdir(join(projectRoot, ".hack/hack.local.json"));
  await failure(
    validateNativeProject({
      startDir: projectRoot,
      explicitDomain: "example.invalid",
    }),
    "E_COMPILER_VERSION"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("authored routing capability is fenced before local/global acquisition", async () => {
  await mockCompiler({ capability: false, routing: true });
  await mkdir(join(projectRoot, ".hack/hack.local.json"));
  await globalPolicy(`broken ${CANARY}`);
  await failure(
    validateNativeProject({ startDir: projectRoot }),
    "E_COMPILER_VERSION"
  );
  expect((await requests()).map((call) => call.operation)).toEqual(["compile"]);
});

test("local-only routing capability is fenced before global policy and managed metadata", async () => {
  await mockCompiler({ capability: false, localRouting: true });
  await globalPolicy(`broken ${CANARY}`);
  await writeFile(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    `broken [${CANARY}`
  );
  await failure(
    planNativeProject({ startDir: projectRoot }),
    "E_COMPILER_VERSION"
  );
  expect((await requests()).map((call) => call.operation)).toEqual([
    "compile",
    "resolve",
  ]);
});

async function cli(args: readonly string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "config",
      ...args,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, HACK_LOGGER: "console" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

for (const operation of ["validate", "plan"] as const) {
  test(`native CLI ${operation} forwards --domain in JSON output`, async () => {
    await mockCompiler();
    await globalPolicy();
    const output = await cli([operation, "--domain", "cli.invalid", "--json"]);
    expect(output.exit).toBe(0);
    expect(JSON.parse(output.stdout).routing_resolution.domain).toBe(
      "cli.invalid"
    );
  });

  test(`native CLI ${operation} forwards --domain in human output`, async () => {
    await mockCompiler();
    await globalPolicy();
    const human = await cli([operation, "--domain", "cli.invalid"]);
    expect(human.exit).toBe(0);
    expect(human.stdout).toContain(
      "Routing preview: https://fixture.cli.invalid"
    );
    expect(human.stdout).toContain("DNS and TLS are not checked");
  });

  test(`native CLI ${operation} explicit-file mode refuses --domain before any compiler read`, async () => {
    await mockCompiler();
    await globalPolicy();
    const output = await cli([
      operation,
      "--file",
      CANARY,
      "--domain",
      "cli.invalid",
    ]);
    expect(output.exit).not.toBe(0);
    expect(await Bun.file(receipt).exists()).toBe(false);
  });
}
