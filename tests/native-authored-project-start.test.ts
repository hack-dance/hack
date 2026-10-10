import { afterEach, test as bunTest, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadNativeAuthoredProjectRun,
  stopNativeAuthoredProject,
  withNativeAuthoredProjectAdmission,
} from "../src/backends/native-authored-project-run.ts";
import {
  NativeAuthoredProjectStartError,
  serveNativeAuthoredProject,
} from "../src/backends/native-authored-project-start.ts";
import { restoreEnv } from "./helpers/env.ts";

const roots: string[] = [];
const run = "a".repeat(32);
const CANARY = "synthetic-private-native-start-canary";
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
let saved: Record<string, string | undefined> | undefined;
let activeCases = 0;
let unconfirmed = false;
function test(
  name: string,
  body: () => void | Promise<void>,
  timeout?: number
) {
  bunTest(
    name,
    async () => {
      if (unconfirmed) {
        throw new Error(
          "Startup fixture settlement unconfirmed; roots retained."
        );
      }
      activeCases++;
      try {
        await body();
      } catch (error) {
        unconfirmed = true;
        throw error;
      } finally {
        activeCases--;
      }
    },
    timeout
  );
}
afterEach(async () => {
  if (activeCases !== 0) {
    unconfirmed = true;
  }
  if (unconfirmed) {
    return;
  }
  if (saved) {
    for (const key of KEYS) {
      restoreEnv(key, saved[key]);
    }
  }
  saved = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

type FixtureOptions = {
  readonly compilerFailure?: boolean;
  readonly finiteHooks?: boolean;
  readonly failBefore?: boolean;
  readonly failDownBefore?: boolean;
  readonly failDownAfter?: boolean;
  readonly changeHookOwnerAfter?: boolean;
  readonly persistent?: boolean;
  readonly storage?: boolean;
  readonly semanticAfterHook?: boolean;
  readonly planFailure?: boolean;
  readonly foreignPlan?: boolean;
  readonly foreignNamespace?: boolean;
  readonly branch?: string | null;
  readonly failedStatus?: boolean;
  readonly changeDuringStatus?: boolean;
  readonly changeDuringPlan?: boolean;
  readonly noManaged?: boolean;
  readonly cleanup?:
    | "removed"
    | "live"
    | "missing"
    | "foreign-id"
    | "foreign-owner";
};

/** Fake compiler/engine transport; real managed inputs, admission, process and storage owners. */
async function fixture(options: FixtureOptions = {}) {
  // Optional effect-free integration uses the real compiler and native planner;
  // execution/status/cleanup remain this file's separately controlled fake driver.
  const realCompiler = process.env.HACK_TEST_NATIVE_COMPILER;
  const realPlanner = process.env.HACK_TEST_NATIVE_PLANNER;
  if ((realCompiler === undefined) !== (realPlanner === undefined)) {
    throw new Error(
      "Real compiler integration requires both explicit test binaries."
    );
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-start-"))
  );
  roots.push(root);
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(root, "candidate");
  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(projectDir, { mode: 0o700 });
  await mkdir(nativeHome, { mode: 0o700 });
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env.HACK_HOME = join(root, "home");
  process.env.CI = "1";
  process.env.HACK_EXECUTION_MODE = "ci";
  const hook = (name: string) => ({
    name,
    env_target: { kind: "host" },
    command: {
      exec: [
        process.execPath,
        "-e",
        `const {appendFile,readdir}=await import("node:fs/promises"); await appendFile("hook-order", ${JSON.stringify(`${name}\n`)}); ${name === "down-after" && options.changeHookOwnerAfter ? 'const root=".hack/.internal/native-authored-runs";const file=(await readdir(root)).find(name=>name.endsWith(".hooks.json"));if(!file)throw Error("missing synthetic hook owner");await appendFile(root+"/"+file,"\\n");' : ""} ${(name === "up-before" && options.failBefore) || (name === "down-before" && options.failDownBefore) || (name === "down-after" && options.failDownAfter) ? "process.exit(7);" : ""}`,
      ],
    },
  });
  const source = {
    schema_version: 1,
    name: "fixture",
    profiles: ["debug"],
    ...(options.storage
      ? { storage: { data: { kind: "persistent", scope: "worktree" } } }
      : {}),
    ...(options.finiteHooks
      ? {
          host: {
            up: { before: [hook("up-before")], after: [hook("up-after")] },
            down: {
              before: [hook("down-before")],
              after: [hook("down-after")],
            },
            ...(options.persistent
              ? {
                  processes: {
                    persistent: { command: { exec: ["sleep", "60"] } },
                  },
                }
              : {}),
          },
        }
      : {}),
    services: {
      web: {
        image: `sha256:${"3".repeat(64)}`,
        ...(options.storage
          ? {
              mounts: [
                { storage: "data", target: "/data", access: "read_write" },
              ],
            }
          : {}),
        environment:
          options.noManaged === true
            ? {
                TOKEN: { unset: true },
                DROP: { unset: true },
                PUBLIC: { literal: "$EXACT" },
              }
            : {
                TOKEN: { unset: true },
                RENAMED: { env_ref: "TOKEN" },
                DROP: { unset: true },
              },
      },
      off: { image: `sha256:${"3".repeat(64)}`, profiles: ["debug"] },
    },
  };
  await writeFile(
    join(projectDir, "hack.project.json"),
    JSON.stringify(source)
  );
  const envFile = join(projectDir, "hack.env.default.yaml");
  await writeFile(
    envFile,
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: CANARY, DROP: "unselected-private-value" } },
    })
  );
  const compiler = join(root, "compiler");
  await writeFile(
    compiler,
    `#!${process.execPath}
const protocol={transport_version:1,authored_version:1,plan_version:1,resolve_version:1,local_version:1,env_plan_version:1,routing_plan_version:1,host_env_plan_version:1};
if(process.argv[2]==='--protocol'){console.log(${options.compilerFailure === true ? JSON.stringify(CANARY) : "JSON.stringify(protocol)"});process.exit(0)}
const operation=process.argv[2];const raw=await Bun.stdin.text();const request=operation==='compile'?{}:JSON.parse(raw);
const source=${JSON.stringify(source)};
const plan={plan_version:1,name:'fixture',selected_profiles:[],services:{web:source.services.web},jobs:{},worktree:{inherit_local:true,auto_branch:false},...(source.host?{host:source.host}:{})};
const result={transport_version:1,ok:true,semantic_hash:'c'.repeat(64),declared_workloads:{web:'service',off:'service'},plan,...(source.host?{host_env_targets:{include_default:true,workloads:[]}}:{})};
if(${options.semanticAfterHook === true} && await Bun.file(${JSON.stringify(join(projectRoot, "hook-order"))}).exists())result.semantic_hash='e'.repeat(64);
if(operation!=='compile'){
 result.local_resolution={overlay:request.explicit_overlay??null,origin:request.explicit_overlay===undefined?'project':'explicit',auto_branch:false,inherit_local:true,resolution_hash:'d'.repeat(64)};
 if(request.branch!==undefined)result.routing_resolution={domain:'hack.local',domain_origin:'default',branch:request.branch,project_origin:'https://'+request.branch+'.fixture.hack.local',aliases:{},oauth_alias:null,open_preference:'auto',open_preference_origin:'default',open_origin:'https://'+request.branch+'.fixture.hack.local',routes:{}};
}
if(operation==='plan')result.environment_plan={plan_version:1,overlay:request.env_metadata.overlay,overlay_exists:request.env_metadata.overlay_exists,complete:true,workloads:{web:${options.noManaged === true ? "{PUBLIC:{kind:'literal',value:'$EXACT'}}" : "{RENAMED:{kind:'managed',key:'TOKEN',scope:'global',secret:false}}"}},warnings:[],diagnostics:[]};
if(operation==='plan'&&source.host)result.environment_plan.host=Object.fromEntries(['up','down'].flatMap(phase=>['before','after'].flatMap(order=>source.host[phase][order].map(hook=>[hook.name,{env_target:hook.env_target,bindings:{}}]))));
console.log(JSON.stringify(result));
`
  );
  await chmod(compiler, 0o700);
  process.env.HACK_CONFIG_COMPILER_BINARY =
    options.compilerFailure === true ? compiler : (realCompiler ?? compiler);
  const binary = join(root, "native");
  const journal = join(root, "journal.json");
  const calls = join(root, "calls.jsonl");
  const delivery = join(root, "delivery.json");
  const digest = createHash("sha256").update(CANARY).digest("hex");
  await writeFile(
    binary,
    `#!${process.execPath}
import {appendFile,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {join} from 'node:path';
const args=process.argv.slice(2);const action=args[4];await appendFile(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const journal=${JSON.stringify(journal)};
const root=${JSON.stringify(join(projectDir, ".internal", "native-authored-runs"))};
if(['plan','serve','frontend-plan','frontend-serve'].includes(action)){
 const planning=action==='plan'||action==='frontend-plan';
 const path=args[args.indexOf('--source-file')+1];const input=JSON.parse(await readFile(path,'utf8'));
 const digest=createHash('sha256');
 if(input.branch!==null)digest.update('hack-native-branch-namespace-v1\\0');
 digest.update(input.project);if(input.branch!==null)digest.update('\\0').update(input.branch);
 const provenance={version:1,kind:'native',namespace:digest.digest('hex'),run:input.run,input:{semantic_hash:'c'.repeat(64),local_resolution_hash:'d'.repeat(64),environment_policy_hash:'e'.repeat(64),selected_profiles:[]}};
 const review={provenance,review_id:createHash('sha256').update('hack.native-graph-review/v1\\0').update(JSON.stringify(provenance)).digest('hex')};
 const planner=${JSON.stringify(realPlanner)};
 if(planner!==undefined){
  const child=Bun.spawn([planner,'--candidate-root',args[1],'graph','native','plan','--source-file',path,'--json'],{env:{PATH:'/nonexistent'},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10_000);
  try{
   const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   if(code!==0||stdout.length>65536||stderr.length>65536)throw Error('real native plan refused');
   const actual=JSON.parse(stdout);Object.assign(provenance,actual.provenance);review.review_id=actual.review_id;
 }finally{clearTimeout(timer);if(child.exitCode===null){child.kill('SIGKILL');await child.exited}}
 }
 if(${options.foreignPlan === true}&&planning){
  provenance.input.semantic_hash='9'.repeat(64);
  review.review_id=createHash('sha256').update('hack.native-graph-review/v1\\0').update(JSON.stringify(provenance)).digest('hex');
 }
 if(${options.foreignNamespace === true}&&planning){
  provenance.namespace='9'.repeat(64);
  review.review_id=createHash('sha256').update('hack.native-graph-review/v1\\0').update(JSON.stringify(provenance)).digest('hex');
 }
 if(planning){
  if(${options.planFailure === true}){console.error(JSON.stringify({code:'native_graph_compile',message:'private-rejected-plan-detail'}));process.exit(2)}
  if(${options.changeDuringPlan === true})await appendFile(${JSON.stringify(envFile)},'\\n');
  console.log(JSON.stringify(review));process.exit(0);
 }
 const start=(await readdir(root)).find(name=>name.endsWith('.start.json'));
 if(!start||JSON.parse(await readFile(join(root,start),'utf8')).record.review.review_id!==review.review_id)throw Error('missing admitted intent');
 if(args.includes('--environment-stdin')){
  const input=JSON.parse(await Bun.stdin.text());const services=input.services;
  const keys=Object.fromEntries(Object.entries(services).map(([name,values])=>[name,Object.keys(values).sort()]));
  const digests=Object.fromEntries(Object.entries(services).map(([name,values])=>[name,Object.fromEntries(Object.entries(values).map(([key,value])=>[key,createHash('sha256').update(value).digest('hex')]))]));
  await writeFile(${JSON.stringify(delivery)},JSON.stringify({version:input.version,kind:input.kind,review:input.review,run:input.run,lifetime_seconds:input.lifetime_seconds,keys,digests,expectedDigest:${JSON.stringify(digest)}}));
 }
 const receipt={version:2,kind:'native-graph-runtime',owner:'f'.repeat(32),boot:'00000000-0000-0000-0000-000000000001',review,phase:'ready-observed',readiness:{web:'started'},resources:{'network:default':{kind:'network',key:'default',name:'hkn-'+input.run+'-network-0',id:'1'.repeat(64),image:null,phase:'created',outbound:true},'container:web':{kind:'container',key:'web',name:'hkn-'+input.run+'-container-0',id:'2'.repeat(64),image:'sha256:'+ '3'.repeat(64),phase:'started',networks:['default']}}};
 const finish=async()=>{
  if(${JSON.stringify(options.cleanup ?? "removed")}!=='live'){
   receipt.phase='removed';for(const resource of Object.values(receipt.resources))resource.phase='removed';
  }
  if(${JSON.stringify(options.cleanup)}==='foreign-id')receipt.resources['container:web'].id='9'.repeat(64);
  if(${JSON.stringify(options.cleanup)}==='foreign-owner')receipt.owner='9'.repeat(32);
  await writeFile(journal,JSON.stringify(receipt));await writeFile(${JSON.stringify(join(root, "owner-exited"))},'owned');process.exit(0);
 };
 process.on('SIGTERM',finish);await writeFile(journal,JSON.stringify(receipt));
 console.log(JSON.stringify({version:2,kind:'native-graph-foreground-ready',run:input.run,review:review.review_id,receipt}));
 if(${options.finiteHooks === true}){ while(true)await Bun.sleep(50); }
 for(let index=0;index<200;index++){
  const mapping=(await readdir(root)).find(name=>name.endsWith('.json')&&!name.endsWith('.start.json')&&!name.endsWith('.source.json'));
  if(mapping){await Bun.sleep(30);await finish()}await Bun.sleep(10);
 }
 await finish();
}else{
 if(action==='inspect'&&${JSON.stringify(options.cleanup)}==='missing'){console.error(JSON.stringify({code:'graph_owner_recovery',message:'private-missing-journal-detail'}));process.exit(2)}
 const receipt=JSON.parse(await readFile(journal,'utf8'));
 const observations={web:receipt.phase==='removed'?null:{state:'running',health:'none'}};
 if(action==='control'){
  if(${options.changeDuringStatus === true})await appendFile(${JSON.stringify(envFile)},'\\n');
  if(${options.failedStatus === true})observations.web={state:'dead'};
  console.log(JSON.stringify({version:2,kind:'native-graph-control-reply',run:receipt.review.provenance.run,review:receipt.review.review_id,result:{outcome:'status',snapshot:{receipt,observations}}}));
 }else console.log(JSON.stringify({receipt,observations}));
}
`
  );
  await chmod(binary, 0o700);
  const scope = {
    projectRoot,
    projectDir,
    nativeHome,
    branch: options.branch === undefined ? "main" : options.branch,
  };
  return {
    root,
    scope,
    runtime: { binary, home: nativeHome },
    calls,
    delivery,
  };
}

async function artifacts(scope: Awaited<ReturnType<typeof fixture>>["scope"]) {
  return (
    await readdir(join(scope.projectDir, ".internal", "native-authored-runs"))
  ).filter((name) => name.endsWith(".json"));
}
async function failure(
  value: Promise<unknown>,
  outcome: "not-started" | "removed" | "retained"
) {
  const error: unknown = await value.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(NativeAuthoredProjectStartError);
  expect(error).toHaveProperty("outcome", outcome);
  expect(String(error)).not.toContain(CANARY);
  expect(JSON.stringify(error)).not.toContain(CANARY);
  return error;
}
const macTest = process.platform === "darwin" ? test : bunTest.skip;

test("startup diagnostics accept only closed compiler codes", () => {
  const known = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    stage: "inputs",
    compilerCode: "E_COMPILER_RESPONSE",
  });
  expect(known.stage).toBe("inputs");
  expect(known.compilerCode).toBe("E_COMPILER_RESPONSE");
  expect(known.message).toContain("stage inputs (E_COMPILER_RESPONSE)");
  const unknown = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    stage: "inputs",
    compilerCode: CANARY,
  });
  expect(unknown.compilerCode).toBeUndefined();
  expect(String(unknown)).not.toContain(CANARY);
  expect(JSON.stringify(unknown)).not.toContain(CANARY);
});

macTest(
  "compiler input refusal retains a closed stage/code without reserving a runtime",
  async () => {
    const selected = await fixture({ compilerFailure: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 10_000,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "inputs");
    expect(error).toHaveProperty("compilerCode", "E_COMPILER_RESPONSE");
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
  }
);

macTest(
  "native frontend holds admission through exact ready publication and Removed retirement",
  async () => {
    const selected = await fixture();
    let ready = 0;
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: 10_000,
      onReady: (mapping) => {
        ready += 1;
        expect(Object.isFrozen(mapping.record.receipt.resources)).toBe(true);
        expect(mapping.record.receipt.review.provenance.run).toBe(run);
        return undefined;
      },
    });
    expect(code).toBe(0);
    expect(ready).toBe(1);
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await readdir(selected.scope.nativeHome)).toEqual([]);
    const delivery = await Bun.file(selected.delivery).json();
    expect(delivery.kind).toBe("native-graph-environment");
    expect(delivery.version).toBe(2);
    expect(delivery.run).toBe(run);
    expect(delivery.keys).toEqual({ web: ["TOKEN"] });
    expect(delivery.digests).toEqual({
      web: { TOKEN: delivery.expectedDigest },
    });
    expect(delivery.lifetime_seconds).toBeGreaterThan(0);
    expect(delivery.lifetime_seconds).toBeLessThan(10);
    expect(await Bun.file(selected.calls).text()).not.toContain(CANARY);
  }
);

for (const option of [
  "planFailure",
  "foreignPlan",
  "foreignNamespace",
] as const) {
  macTest(
    `native frontend ${option} refuses before reservation or private delivery`,
    async () => {
      const selected = await fixture({ [option]: true });
      const error = await failure(
        serveNativeAuthoredProject({
          ...selected,
          run,
          startupTimeoutMs: 10_000,
        }),
        "not-started"
      );
      expect(error).toHaveProperty(
        "stage",
        option === "planFailure" ? "native-plan" : "review"
      );
      expect(await artifacts(selected.scope)).toEqual([]);
      expect(await Bun.file(selected.delivery).exists()).toBe(false);
      expect(await Bun.file(selected.calls).text()).not.toContain('"serve"');
    }
  );
}

macTest(
  "unscoped native frontend binds the canonical project namespace",
  async () => {
    const selected = await fixture({ branch: null });
    let ready = 0;
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 10_000,
        onReady: (mapping) => {
          expect(mapping.record.receipt.review.provenance.namespace).toBe(
            createHash("sha256")
              .update(selected.scope.projectRoot)
              .digest("hex")
          );
          ready += 1;
          return undefined;
        },
      })
    ).toBe(0);
    expect(ready).toBe(1);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

for (const option of ["failedStatus", "changeDuringStatus"] as const) {
  macTest(
    `native frontend ${option} refuses ready publication and authenticates cleanup`,
    async () => {
      const selected = await fixture({ [option]: true });
      let ready = false;
      await failure(
        serveNativeAuthoredProject({
          ...selected,
          run,
          startupTimeoutMs: 10_000,
          onReady: () => {
            ready = true;
            return undefined;
          },
        }),
        "removed"
      );
      expect(ready).toBe(false);
      expect(await artifacts(selected.scope)).toEqual([]);
      expect(await Bun.file(join(selected.root, "owner-exited")).exists()).toBe(
        true
      );
    }
  );
}

for (const option of ["failedStatus", "changeDuringStatus"] as const) {
  for (const cleanup of ["foreign-id", "foreign-owner"] as const) {
    macTest(
      `pre-publication ${option} cannot retire from ${cleanup} cleanup`,
      async () => {
        const selected = await fixture({ [option]: true, cleanup });
        let ready = false;
        await failure(
          serveNativeAuthoredProject({
            ...selected,
            run,
            startupTimeoutMs: 10_000,
            onReady: () => {
              ready = true;
              return undefined;
            },
          }),
          "retained"
        );
        expect(ready).toBe(false);
        expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
        const retained = await artifacts(selected.scope);
        expect(retained).toHaveLength(2);
        expect(retained.some((name) => name.endsWith(".start.json"))).toBe(
          true
        );
        expect(retained.some((name) => name.endsWith(".source.json"))).toBe(
          true
        );
        expect(
          await Bun.file(join(selected.root, "owner-exited")).exists()
        ).toBe(true);
        await failure(
          serveNativeAuthoredProject({
            ...selected,
            run: "9".repeat(32),
            startupTimeoutMs: 10_000,
          }),
          "retained"
        );
        const calls = (await Bun.file(selected.calls).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          calls.filter((args: string[]) => args.includes("serve"))
        ).toHaveLength(1);
      }
    );
  }
}

for (const cleanup of ["live", "missing", "foreign-id"] as const) {
  macTest(
    `native frontend ${cleanup} cleanup cannot retire ready mapping or startup intent`,
    async () => {
      const selected = await fixture({ cleanup });
      await failure(
        serveNativeAuthoredProject({
          ...selected,
          run,
          startupTimeoutMs: 10_000,
        }),
        "retained"
      );
      expect(await loadNativeAuthoredProjectRun(selected.scope)).not.toBeNull();
      expect(await artifacts(selected.scope)).toHaveLength(3);
      await failure(
        serveNativeAuthoredProject({
          ...selected,
          run: "9".repeat(32),
          startupTimeoutMs: 10_000,
        }),
        "retained"
      );
      const calls = (await Bun.file(selected.calls).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.filter((args: string[]) => args.includes("serve"))
      ).toHaveLength(1);
    }
  );
}

macTest(
  "native frontend cancellation awaits owned cleanup after ready publication",
  async () => {
    const selected = await fixture();
    const signal = new AbortController();
    let ready = false;
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        signal: signal.signal,
        startupTimeoutMs: 10_000,
        onReady: () => {
          ready = true;
          signal.abort();
          return undefined;
        },
      }),
      "removed"
    );
    expect(ready).toBe(true);
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await Bun.file(join(selected.root, "owner-exited")).exists()).toBe(
      true
    );
  }
);

macTest(
  "native frontend admission blocks a second consumer across the ready callback",
  async () => {
    const selected = await fixture();
    const entered = Promise.withResolvers<void>();
    const first = serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: 10_000,
      onReady: () => {
        entered.resolve();
        return undefined;
      },
    });
    await entered.promise;
    await expect(
      withNativeAuthoredProjectAdmission(selected.scope, () =>
        Promise.resolve()
      )
    ).rejects.toThrow("unsafe");
    await first;
    await withNativeAuthoredProjectAdmission(selected.scope, (admission) =>
      admission.assertHeld()
    );
  }
);

test("invalid or pre-canceled native frontend selection has no input or runtime effects", async () => {
  const selected = await fixture();
  const signal = AbortSignal.abort();
  await failure(
    serveNativeAuthoredProject({
      ...selected,
      run,
      signal,
      startupTimeoutMs: 10_000,
    }),
    "not-started"
  );
  await failure(
    serveNativeAuthoredProject({
      ...selected,
      run: "invalid",
      startupTimeoutMs: 10_000,
    }),
    "not-started"
  );
  expect(await Bun.file(selected.calls).exists()).toBe(false);
  expect(await Bun.file(selected.delivery).exists()).toBe(false);
  expect(await readdir(selected.scope.projectDir)).not.toContain(".internal");
});

macTest(
  "private source selection failure after reservation retains intent without spawning the consumer",
  async () => {
    const selected = await fixture({ changeDuringPlan: true });
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 10_000,
      }),
      "retained"
    );
    expect(await artifacts(selected.scope)).toHaveLength(2);
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    expect(await Bun.file(selected.calls).text()).not.toContain('"serve"');
  }
);

macTest(
  "compiler-selected literal-only environment does not acquire private delivery",
  async () => {
    const selected = await fixture({ noManaged: true });
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 10_000,
      })
    ).toBe(0);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

macTest(
  "native frontend keeps the original startup deadline through input acquisition",
  async () => {
    const selected = await fixture();
    const started = performance.now();
    await failure(
      serveNativeAuthoredProject({ ...selected, run, startupTimeoutMs: 50 }),
      "not-started"
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
  }
);

macTest(
  "caller selection mutation cannot redirect an admitted native frontend",
  async () => {
    const selected = await fixture();
    const input = {
      ...selected,
      runtime: { ...selected.runtime },
      scope: { ...selected.scope },
      run,
      startupTimeoutMs: 10_000,
    };
    const pending = serveNativeAuthoredProject(input);
    input.runtime.binary = join(selected.root, "missing");
    input.runtime.home = join(selected.root, "different");
    input.scope.nativeHome = input.runtime.home;
    input.scope.branch = "different";
    input.run = "9".repeat(32);
    expect(await pending).toBe(0);
    const calls = await Bun.file(selected.calls).text();
    expect(calls).toContain(selected.runtime.home);
    expect(calls).not.toContain(input.runtime.home);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

macTest(
  "untyped asynchronous ready observation refuses and consumes private rejection",
  async () => {
    const selected = await fixture();
    const completed = Promise.withResolvers<void>();
    const callback = async () => {
      await Bun.sleep(10);
      completed.resolve();
      throw new Error(CANARY);
    };
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 10_000,
        onReady: callback as unknown as () => undefined,
      }),
      "removed"
    );
    await completed.promise;
    await Bun.sleep(0);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

macTest(
  "asynchronous exit observation cannot leak diagnostics or replace confirmed cleanup",
  async () => {
    const selected = await fixture();
    const completed = Promise.withResolvers<void>();
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 10_000,
        onExitDiagnostic: async () => {
          await Bun.sleep(10);
          completed.resolve();
          throw new Error(CANARY);
        },
      })
    ).toBe(0);
    await completed.promise;
    await Bun.sleep(0);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

if (process.platform !== "darwin") {
  test("unsupported native frontend platform refuses before compiler inputs or provider work", async () => {
    const selected = await fixture();
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 10_000,
      }),
      "not-started"
    );
    expect(await readdir(selected.scope.projectDir)).not.toContain(".internal");
    expect(await Bun.file(selected.calls).exists()).toBe(false);
  });
}

macTest(
  "authored four-phase hooks execute once around ready/Removed and ordinary down uses the live owner",
  async () => {
    const selected = await fixture({ finiteHooks: true });
    let stop: Promise<void> | undefined;
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: 15_000,
      onReady: () => {
        stop = stopNativeAuthoredProject({
          scope: selected.scope,
          timeoutMs: 15_000,
        });
        return undefined;
      },
    });
    await stop;
    expect(code).toBe(0);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n");
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
    const calls = await Bun.file(selected.calls).text();
    expect(calls).toContain('"frontend-plan"');
    expect(calls).toContain('"frontend-serve"');
    expect(calls).not.toContain(CANARY);
    const files = await artifacts(selected.scope);
    expect(files.filter((name) => name.endsWith("-intent.json"))).toHaveLength(
      4
    );
    expect(
      files.filter((name) => name.endsWith("-complete.json"))
    ).toHaveLength(4);
    expect(files.some((name) => name.endsWith(".hooks.json"))).toBe(false);
  },
  30_000
);
macTest(
  "failed up.before records known completion and starts no native consumer or later hook",
  async () => {
    const selected = await fixture({ finiteHooks: true, failBefore: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 15_000,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "hook-up-before");
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\n");
    expect(await Bun.file(selected.calls).text()).not.toContain(
      '"frontend-serve"'
    );
    expect(
      (await artifacts(selected.scope)).some((name) =>
        name.endsWith(".hooks.json")
      )
    ).toBe(false);
  },
  30_000
);
macTest(
  "missing storage bundle refuses before hooks, native planning, reservation or private delivery",
  async () => {
    const selected = await fixture({
      finiteHooks: true,
      storage: true,
      noManaged: true,
    });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 15_000,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "storage-tool");
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).exists()
    ).toBe(false);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    expect(await artifacts(selected.scope)).toEqual([]);
  },
  30_000
);
macTest(
  "persistent host processes refuse before any hook or native operation",
  async () => {
    const selected = await fixture({ finiteHooks: true, persistent: true });
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 15_000,
      }),
      "not-started"
    );
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).exists()
    ).toBe(false);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
  }
);
macTest(
  "failed down.before retains the supervised runtime and cannot replay before explicit hard cancellation",
  async () => {
    const selected = await fixture({ finiteHooks: true, failDownBefore: true });
    const force = new AbortController();
    let stop: Promise<void> | undefined;
    let retainedAtFailure = false;
    const stages: unknown[] = [];
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: 15_000,
      forceSignal: force.signal,
      onHookDiagnostic: (event) => stages.push(event),
      onReady: () => {
        stop = (async () => {
          await expect(
            stopNativeAuthoredProject({
              scope: selected.scope,
              timeoutMs: 15_000,
            })
          ).rejects.toThrow();
          retainedAtFailure =
            (await loadNativeAuthoredProjectRun(selected.scope)) !== null;
          force.abort();
        })();
        return undefined;
      },
    }).catch((error: unknown) => error);
    await stop;
    expect(JSON.parse(JSON.stringify(stages))).toEqual([
      { phase: "up.before", boundary: "acquire" },
      { phase: "up.before", boundary: "prepare" },
      { phase: "up.before", boundary: "complete" },
      { phase: "up.after", boundary: "acquire" },
      { phase: "up.after", boundary: "prepare" },
      { phase: "up.after", boundary: "complete" },
      { phase: "down.before", boundary: "stop-request" },
      { phase: "down.before", boundary: "acquire" },
      { phase: "down.before", boundary: "prepare" },
      { phase: "down.before", boundary: "complete" },
      { phase: "down.before", boundary: "stop-operation" },
    ]);
    expect(retainedAtFailure).toBe(true);
    expect(code).toBeInstanceOf(NativeAuthoredProjectStartError);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\n");
  },
  30_000
);

macTest(
  "known failed down.after retires the hook owner and bindings while preserving failure and permits a fresh run",
  async () => {
    const selected = await fixture({ finiteHooks: true, failDownAfter: true });
    for (const currentRun of [run, "b".repeat(32)]) {
      let stop: Promise<unknown> | undefined;
      const error = await failure(
        serveNativeAuthoredProject({
          ...selected,
          run: currentRun,
          startupTimeoutMs: 15_000,
          onReady: () => {
            stop = stopNativeAuthoredProject({
              scope: selected.scope,
              timeoutMs: 15_000,
            }).catch((caught: unknown) => caught);
            return undefined;
          },
        }),
        "removed"
      );
      expect(error).toHaveProperty("stage", "hook-down-after");
      expect(await stop).toBeInstanceOf(Error);
      expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
      await withNativeAuthoredProjectAdmission(
        selected.scope,
        async (admission) => {
          expect(await admission.loadStart()).toBeNull();
          expect(await admission.hooksRetained()).toBe(false);
        }
      );
    }
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n".repeat(2));
    const calls = (await Bun.file(selected.calls).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)[4]);
    expect(calls.filter((action) => action === "frontend-serve")).toHaveLength(
      2
    );
  },
  30_000
);

macTest(
  "unknown down.after completion keeps frontend bindings and hook intent together without replay",
  async () => {
    const selected = await fixture({
      finiteHooks: true,
      changeHookOwnerAfter: true,
    });
    let stop: Promise<unknown> | undefined;
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 15_000,
        onReady: () => {
          stop = stopNativeAuthoredProject({
            scope: selected.scope,
            timeoutMs: 15_000,
          }).catch((caught: unknown) => caught);
          return undefined;
        },
      }),
      "retained"
    );
    expect(await stop).toBeInstanceOf(Error);
    expect(await loadNativeAuthoredProjectRun(selected.scope)).not.toBeNull();
    await withNativeAuthoredProjectAdmission(
      selected.scope,
      async (admission) => {
        expect(await admission.loadStart()).not.toBeNull();
        expect(await admission.hooksRetained()).toBe(true);
      }
    );
    const files = await artifacts(selected.scope);
    expect(files).toContain(`${run}.hook-down.after-intent.json`);
    expect(files).not.toContain(`${run}.hook-down.after-complete.json`);
    expect(files).toContain(`${run}.source.json`);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n");
  },
  30_000
);

macTest(
  "authored semantic drift after up.before refuses before reservation or native execution",
  async () => {
    const selected = await fixture({
      finiteHooks: true,
      semanticAfterHook: true,
    });
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: 15_000,
      }),
      "not-started"
    );
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\n");
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBe(null);
    expect(
      await withNativeAuthoredProjectAdmission(selected.scope, (admission) =>
        admission.loadStart()
      )
    ).toBe(null);
    expect(
      (await Bun.file(selected.calls).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)[4])
    ).toEqual(["frontend-plan"]);
  },
  30_000
);
