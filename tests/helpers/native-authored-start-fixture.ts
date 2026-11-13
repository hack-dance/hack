import { afterAll, test as bunTest, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeAuthoredProjectStartError,
  serveNativeAuthoredProject as serveStart,
} from "../../src/backends/native-authored-project-start.ts";
import {
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
  nativeStorageToolManifest,
} from "../../src/backends/native-authored-storage-tool.ts";
import {
  endLifecycleMuxFixtureGroups,
  writeLifecycleMuxFixture,
} from "./lifecycle-mux-fixture.ts";
import {
  createNativeFixtureCases,
  NATIVE_FIXTURE_BUN_MARGIN_MS,
  type NativeFixtureCase,
} from "./native-fixture-cases.ts";
import { optionalFixtureNode } from "./optional-fixture-node.ts";
import { installStaticFixtureNode } from "./static-fixture-node.ts";
import {
  CASE_TIMEOUT_CEILING_MS,
  testBudgetMs,
  withinCaseCeilingMs,
} from "./test-budget.ts";
/** Each file owns an independent case context; importing this helper registers no tests. */
export function createNativeAuthoredStartHarness() {
  const run = "a".repeat(32);

  const CANARY = "synthetic-private-native-start-canary";

  /**
   * Allowance for a case's owners, groups and stop endpoints to be absent
   * afterwards. Harness budget: a passing case settles as soon as they exit.
   */
  const SETTLEMENT_BUDGET_MS = testBudgetMs(1500);

  /** Largest caller startup deadline `serveNativeAuthoredProject` accepts. */
  const MAX_STARTUP_TIMEOUT_MS = 300_000;

  /**
   * Body budget for every case, the two-cycle case included: what the case
   * ceiling leaves after the settlement budget and the guard's margin. A case
   * that overruns it fails by name, inside the hosted shard's per-file limit.
   */
  const CASE_TIMEOUT_MS =
    CASE_TIMEOUT_CEILING_MS -
    SETTLEMENT_BUDGET_MS -
    NATIVE_FIXTURE_BUN_MARGIN_MS;

  withinCaseCeilingMs(
    CASE_TIMEOUT_MS + SETTLEMENT_BUDGET_MS + NATIVE_FIXTURE_BUN_MARGIN_MS
  );

  /**
   * Caller startup deadline for cases that are not about the deadline itself.
   * Each start spawns several Bun children (compiler, planner, owner, hooks); on
   * a loaded host that takes well over the 10-20 s these cases used to allow.
   * The scaled budget is capped at the product's own ceiling and at half the
   * case budget, so a start and its stop fit in one case. Cases that test the
   * deadline pass their own literal product deadline.
   */
  const STARTUP_TIMEOUT_MS = Math.min(
    testBudgetMs(15_000),
    MAX_STARTUP_TIMEOUT_MS,
    Math.floor(CASE_TIMEOUT_MS / 2)
  );

  /** Caller stop deadline for ordinary `down` in the hook and live-stop cases. */
  const STOP_TIMEOUT_MS = STARTUP_TIMEOUT_MS;

  /** A caller's 50 ms startup deadline must return the frontend well inside this wall bound. */
  const DEADLINE_WALL_BOUND_MS = 1000;

  /**
   * Upper bound for a stand-in owner that never receives its release or SIGTERM,
   * and for a stand-in status request that hangs. This bounds the orphan a broken
   * case can leave rather than preventing it: it outlasts every case's Bun
   * timeout, which the case ceiling bounds, and ends well inside the hosted
   * shard's per-file limit. Passing cases release or cancel them explicitly.
   */
  const STAND_IN_CAP_MS = CASE_TIMEOUT_CEILING_MS;

  /**
   * Longest life of a stand-in host process that nothing stopped. A failed case
   * ends its groups through `onFailure`; this bounds the rest (a runner killed by
   * the shard's limit). It outlasts that limit, so no case ever reaches it.
   */
  const HOST_PROCESS_CAP_MS = 900_000;

  const cases = createNativeFixtureCases({
    label: "Startup fixture",
    defaultTimeoutMs: CASE_TIMEOUT_MS,
    settlementBudgetMs: SETTLEMENT_BUDGET_MS,
  });
  // Each split file drains its own overrun bodies and their owned cleanup.
  // It cannot rely on the deliberate-failure case in another file doing so.
  afterAll(() => cases.drain(), CASE_TIMEOUT_CEILING_MS);

  const test = cases.test;

  /** File the stand-in owner waits for before it retires after ready publication. */
  function ownerRelease(root: string, runId: string): string {
    return join(root, `owner-release-${runId}`);
  }

  /**
   * Let a ready stand-in owner retire. This explicit handshake replaces the
   * owner's former fixed ready window: the owner leaves only after the frontend
   * has finished ready publication, or on SIGTERM.
   */
  function releaseOwner(root: string, runId: string): void {
    writeFileSync(ownerRelease(root, runId), "release", { mode: 0o600 });
  }

  /** Window PIDs from the stand-in mux state; `undefined` while it is mid-write. */
  function muxWindowPids(text: string): readonly number[] | undefined {
    let state: unknown;
    try {
      state = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof state !== "object" || state === null || !("windows" in state)) {
      return;
    }
    return Object.values(state.windows as Record<string, unknown>).flatMap(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "pid" in row &&
        typeof row.pid === "number"
          ? [row.pid]
          : []
    );
  }

  /** Record what a published generation may leave behind: the stop owner's loopback
   * endpoint and any detached host process groups. Synchronous, as `onReady` requires. */
  function observeOwners(
    owner: NativeFixtureCase,
    input: Parameters<typeof serveStart>[0] & { readonly root: string }
  ): void {
    try {
      const runs = join(
        input.scope.projectDir,
        ".internal",
        "native-authored-runs"
      );
      for (const name of readdirSync(runs)) {
        if (
          !(
            name.endsWith(".live-stop.json") || name.endsWith(".hook-stop.json")
          )
        ) {
          continue;
        }
        const value: unknown = JSON.parse(
          readFileSync(join(runs, name), "utf8")
        );
        if (
          typeof value === "object" &&
          value !== null &&
          "port" in value &&
          typeof value.port === "number"
        ) {
          owner.settlement.record({
            kind: "endpoint",
            name: `stop owner endpoint (${name.replace(/^[0-9a-f]+\./, "")})`,
            port: value.port,
          });
        }
      }
      let state: unknown;
      try {
        state = JSON.parse(readFileSync(join(input.root, "mux.json"), "utf8"));
      } catch {
        state = undefined;
      }
      if (typeof state === "object" && state !== null && "windows" in state) {
        for (const [window, row] of Object.entries(
          state.windows as Record<string, unknown>
        )) {
          if (
            typeof row === "object" &&
            row !== null &&
            "pid" in row &&
            typeof row.pid === "number"
          ) {
            owner.settlement.record({
              kind: "process",
              name: `host process group (${window})`,
              pid: row.pid,
              group: true,
            });
          }
        }
      }
    } catch (error) {
      owner.fail(error);
    }
  }

  /**
   * Every case serves through this observer; one case below deliberately uses
   * `serveStart`. Ready publication releases the stand-in owner unless the case
   * sets `holdOwner` and calls `releaseOwner` itself.
   */
  const serveNativeAuthoredProject = (
    input: Parameters<typeof serveStart>[0] & {
      readonly root: string;
      readonly holdOwner?: boolean;
    }
  ) => {
    const owner = cases.current();
    const runId = input.run;
    return serveStart({
      ...input,
      onReady: (selection, identity) => {
        observeOwners(owner, input);
        if (input.holdOwner !== true) {
          releaseOwner(input.root, runId);
        }
        return input.onReady?.(selection, identity);
      },
    });
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
    "PATH",
    "HACK_SESSIONS_MUX",
    "HACK_TEST_MUX_STATE",
  ] as const;

  type FixtureOptions = {
    readonly compilerFailure?: boolean;
    readonly finiteHooks?: boolean;
    readonly failBefore?: boolean;
    readonly failDownBefore?: boolean;
    readonly failDownAfter?: boolean;
    readonly changeHookOwnerAfter?: boolean;
    readonly persistent?: boolean;
    readonly hostProcesses?: boolean;
    readonly storage?: boolean;
    readonly liveStop?: boolean;
    readonly semanticAfterHook?: boolean;
    readonly planFailure?: boolean;
    /** Closed native code for `planFailure` (default `native_graph_compile`). */
    readonly planFailureCode?: string;
    readonly planConfigurationRefusals?: readonly unknown[];
    readonly failBeforeReceipt?: boolean;
    readonly removedBeforeReady?: boolean;
    readonly foreignRemovalReview?: boolean;
    readonly releaseHostAfterTest?: boolean;
    /**
     * Like `failBeforeReceipt`, but serve fails the way authored foreground
     * control reports a runtime that stopped: `runtime_not_running` wrapped in
     * `native_graph_foreground`.
     */
    readonly stoppedDuringServe?: boolean;
    /** Native startup code for failBeforeReceipt; defaults to graph_network_intent. */
    readonly failBeforeReceiptCode?: string;
    /** Inspection after failBeforeReceipt proves the journal was never reserved. */
    readonly unreservedInspection?: boolean;
    readonly foreignPlan?: boolean;
    readonly foreignNamespace?: boolean;
    readonly branch?: string | null;
    readonly failedStatus?: boolean;
    readonly changeDuringStatus?: boolean;
    readonly changeDuringPlan?: boolean;
    readonly noManaged?: boolean;
    /**
     * `runtime status --json` reports a stopped candidate runtime. Otherwise the
     * status request fails like any unknown action, which the start treats as
     * inconclusive.
     */
    readonly runtimeStopped?: boolean;
    /** `runtime status --json` hangs, so a caller can cancel during the check. */
    readonly runtimeStatusHangs?: boolean;
    /**
     * The `runtime status --json` request itself fails the way authored
     * foreground control reports a stopped runtime: `runtime_not_running`
     * wrapped in `native_graph_foreground`.
     */
    readonly runtimeStatusWrappedStop?: boolean;
    readonly cleanup?:
      | "removed"
      | "live"
      | "missing"
      | "foreign-id"
      | "foreign-owner";
  };

  let compilerFixtureNode: Promise<string | null> | undefined;

  /** Fake compiler/engine transport; real managed inputs, admission, process and storage owners. */
  async function fixture(options: FixtureOptions = {}) {
    const owner = cases.current();
    // Resolve before fixture PATH/env mutation. This only changes the pure
    // compiler protocol transport; the original Bun script remains the fallback.
    const node = await (compilerFixtureNode ??= optionalFixtureNode());
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
    owner.root(root);
    const projectRoot = join(root, "project");
    const projectDir = join(projectRoot, ".hack");
    const nativeHome = join(root, "candidate");
    await mkdir(projectRoot, { mode: 0o700 });
    await mkdir(projectDir, { mode: 0o700 });
    await mkdir(nativeHome, { mode: 0o700 });
    // Restored by the case guard whatever the outcome, so no later case or file
    // inherits this fixture's HACK_HOME, CI mode or missing PATH.
    const saved = owner.saveEnv(KEYS);
    for (const key of KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
    process.env.HACK_HOME = join(root, "home");
    process.env.CI = "1";
    process.env.HACK_EXECUTION_MODE = "ci";
    if (options.hostProcesses) {
      const bin = join(root, "bin");
      await mkdir(bin, { mode: 0o700 });
      await writeLifecycleMuxFixture(bin);
      process.env.PATH = `${bin}:${saved.PATH ?? "/usr/bin:/bin"}`;
      process.env.HACK_SESSIONS_MUX = "tmux";
      process.env.HACK_TEST_MUX_STATE = join(root, "mux.json");
      // Every supervised host group the stand-in mux starts, including ones a
      // failed start retains before ready (which `observeOwners` never sees).
      owner.settlement.record({
        kind: "pid-file",
        name: "stand-in mux host process groups",
        path: join(root, "mux.json"),
        group: true,
        emptySettled: true,
        parse: muxWindowPids,
      });
      // A start that fails after reservation retains these groups on purpose,
      // for `hack down` recovery that a failed case never reaches.
      owner.onFailure(() =>
        endLifecycleMuxFixtureGroups(join(root, "mux.json"))
      );
    }
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
              ...(options.persistent || options.hostProcesses
                ? {
                    processes: {
                      persistent: options.hostProcesses
                        ? {
                            command: {
                              exec: [
                                process.execPath,
                                "--no-env-file",
                                "-e",
                                'const {appendFileSync}=await import("node:fs");appendFileSync("process-order","started\\n");await Bun.write("process-value",process.env.PROCESS_TOKEN??"missing");const stop=()=>{appendFileSync("process-order","stopped\\n");process.exit(0)};process.on("SIGTERM",stop);process.on("SIGINT",stop);' +
                                  (options.releaseHostAfterTest
                                    ? 'const {existsSync}=await import("node:fs");setInterval(()=>{if(existsSync("release-host-test")){appendFileSync("process-order","fixture-released"+String.fromCharCode(10));process.exit(0)}},20)'
                                    : "setInterval(()=>{},1000)") +
                                  `;setTimeout(()=>process.exit(0),${HOST_PROCESS_CAP_MS})`,
                              ],
                            },
                            env_target: { kind: "host" },
                            environment: {
                              PROCESS_TOKEN: { env_ref: "TOKEN" },
                            },
                          }
                        : { command: { exec: ["sleep", "60"] } },
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
if(operation==='plan'&&${options.hostProcesses === true})result.environment_plan.host.persistent={env_target:{kind:'host'},bindings:{PROCESS_TOKEN:{kind:'managed',key:'TOKEN',scope:'global',secret:false}}};
console.log(JSON.stringify(result));
`
    );
    await chmod(compiler, 0o700);
    await installStaticFixtureNode({ binary: compiler, node });
    process.env.HACK_CONFIG_COMPILER_BINARY =
      options.compilerFailure === true ? compiler : (realCompiler ?? compiler);
    const bundle =
      options.storage && options.liveStop ? join(root, "bundle") : root;
    if (bundle !== root) {
      await mkdir(bundle, { mode: 0o700 });
    }
    const binary = join(bundle, "native");
    if (options.storage && options.liveStop) {
      // Byte-admission stand-in only. No guest installation or filesystem syscall.
      const bytes = Buffer.alloc(128);
      bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
      bytes.writeUInt16LE(183, 18);
      await writeFile(join(bundle, NATIVE_STORAGE_TOOL_FILE), bytes, {
        mode: 0o500,
      });
      await writeFile(
        join(bundle, NATIVE_STORAGE_TOOL_MANIFEST),
        JSON.stringify(nativeStorageToolManifest(bytes, "a".repeat(40))),
        { mode: 0o600 }
      );
    }
    const journal = join(root, "journal.json");
    const calls = join(root, "calls.jsonl");
    const delivery = join(root, "delivery.json");
    const sources = join(root, "sources.jsonl");
    const ownerPid = join(root, "owner.pid");
    // Each stand-in owner appends its PID; a detached owner leads its own group.
    owner.settlement.record({
      kind: "pid-file",
      name: "stand-in native owner",
      path: ownerPid,
      group: true,
    });
    // A hanging status request must be killed by cancellation, not outlive the case.
    // The stand-in publishes its PID by rename, so the file is either absent or
    // complete: a cancel that lands mid-write must not leave an empty record that
    // settlement reads as a write still in progress.
    const statusPid = join(root, "status.pid");
    owner.settlement.record({
      kind: "pid-file",
      name: "stand-in hanging runtime status request",
      path: statusPid,
      group: false,
    });
    const digest = createHash("sha256").update(CANARY).digest("hex");
    await writeFile(
      binary,
      `#!${process.execPath}
import {appendFile,readFile,readdir,rename,unlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {join} from 'node:path';
const args=process.argv.slice(2);const action=args[4];await appendFile(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(${options.runtimeStopped === true}&&args[2]==='runtime'&&args[3]==='status'){console.log(JSON.stringify({phase:'stopped',process_alive:false}));process.exit(0)}
if(${options.runtimeStatusHangs === true}&&args[2]==='runtime'&&args[3]==='status'){const staged=${JSON.stringify(statusPid)}+'.'+process.pid;await writeFile(staged,process.pid+'\\n');await rename(staged,${JSON.stringify(statusPid)});await new Promise((resolve)=>setTimeout(resolve,${STAND_IN_CAP_MS}));process.exit(0)}
if(${options.runtimeStatusWrappedStop === true}&&args[2]==='runtime'&&args[3]==='status'){console.error(JSON.stringify({code:'native_graph_foreground',cause_code:'runtime_not_running',message:${JSON.stringify(CANARY)}}));process.exit(2)}
const journal=${JSON.stringify(journal)};
const root=${JSON.stringify(join(projectDir, ".internal", "native-authored-runs"))};
if(['plan','serve','frontend-plan','frontend-serve'].includes(action)){
 const planning=action==='plan'||action==='frontend-plan';
 if(!planning)await appendFile(${JSON.stringify(ownerPid)},process.pid+'\\n');
 const path=args[args.indexOf('--source-file')+1];const input=JSON.parse(await readFile(path,'utf8'));
 if(planning)await appendFile(${JSON.stringify(sources)},JSON.stringify(input.env_metadata)+'\\n');
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
  if(${options.planFailure === true}){console.error(JSON.stringify({code:${JSON.stringify(options.planFailureCode ?? "native_graph_compile")},message:'private-rejected-plan-detail',configuration_refusals:${JSON.stringify(options.planConfigurationRefusals)}}));process.exit(2)}
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
 if(${options.failBeforeReceipt === true}){console.error(JSON.stringify({code:${JSON.stringify(options.failBeforeReceiptCode ?? "graph_network_intent")},message:${JSON.stringify(CANARY)}}));process.exit(2)}
 if(${options.stoppedDuringServe === true}){console.error(JSON.stringify({code:'native_graph_foreground',cause_code:'runtime_not_running',message:${JSON.stringify(CANARY)}}));process.exit(2)}
 const receipt={version:2,kind:'native-graph-runtime',owner:'f'.repeat(32),boot:'00000000-0000-0000-0000-000000000001',review,phase:'ready-observed',readiness:{web:'started'},resources:{'network:default':{kind:'network',key:'default',name:'hkn-'+input.run+'-network-0',id:'1'.repeat(64),image:null,phase:'created',outbound:true},'container:web':{kind:'container',key:'web',name:'hkn-'+input.run+'-container-0',id:'2'.repeat(64),image:'sha256:'+ '3'.repeat(64),phase:'started',networks:['default']}}};
 if(${options.removedBeforeReady === true}){
  if(${JSON.stringify(options.cleanup ?? "removed")}!=='live'){
   receipt.phase='removed';for(const resource of Object.values(receipt.resources))resource.phase='removed';
  }
  if(${options.foreignRemovalReview === true}){
   provenance.namespace='9'.repeat(64);
   review.review_id=createHash('sha256').update('hack.native-graph-review/v1\\0').update(JSON.stringify(provenance)).digest('hex');
  }
  await writeFile(journal,JSON.stringify(receipt));
  console.error(JSON.stringify({code:'graph_network_intent',message:${JSON.stringify(CANARY)}}));process.exit(2);
 }
 if(${options.storage === true && options.liveStop === true}){
  const namespace=provenance.namespace, owner='9'.repeat(32);
  receipt.version=4;
  receipt.data={data:{binding:{scope:{namespace,storage:'data',owner},guest:{owner:receipt.owner,boot_id:receipt.boot,storage:{device:0,inode:14,bytes:128,uuid:'00000000-0000-0000-0000-000000000002'}},policy:{driver:'local',scope:'local',options:{}}},state:{status:'enrolled',volume:{name:'hkp-'+namespace+'-'+owner+'-data',created_at:'2026-10-08T00:00:01Z',directory:{device:0,inode:15}}}}};
  receipt.data_mounts={web:[{storage:'data',target:'/data',read_only:false}]};
 }
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
 if(${options.finiteHooks === true || options.liveStop === true}){ while(true)await Bun.sleep(50); }
 // Handshake, not a wall-clock window: retire only once the frontend has
 // finished ready publication and the test released this run (or on SIGTERM).
 const release=${JSON.stringify(ownerRelease(root, ""))}+input.run;
 const cap=performance.now()+${STAND_IN_CAP_MS};
 while(!(await Bun.file(release).exists())&&performance.now()<cap)await Bun.sleep(10);
 await unlink(release).catch(()=>undefined);
 await finish();
}else{
 if(action==='inspect'&&${options.failBeforeReceipt === true || options.stoppedDuringServe === true}){console.error(JSON.stringify({code:${JSON.stringify(options.unreservedInspection === true ? "native_graph_unreserved" : "native_graph_receipt")},message:${JSON.stringify(CANARY)}}));process.exit(2)}
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
      sources,
      statusPid,
    };
  }

  async function artifacts(
    scope: Awaited<ReturnType<typeof fixture>>["scope"]
  ) {
    return (
      await readdir(join(scope.projectDir, ".internal", "native-authored-runs"))
    ).filter((name) => name.endsWith(".json"));
  }

  async function failure(
    value: Promise<unknown>,
    outcome: "not-started" | "removed" | "retained" | "unreserved"
  ) {
    const error: unknown = await value.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthoredProjectStartError);
    expect(error).toHaveProperty("outcome", outcome);
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
    return error;
  }

  const macTest = process.platform === "darwin" ? test : bunTest.skip;

  function confirmTestGroupAbsent(
    group: number | undefined,
    original: typeof process.kill
  ): void {
    if (group === undefined || !Number.isSafeInteger(group) || group >= -1) {
      throw new Error("No original group observation; retain fixture and spy.");
    }
    try {
      original(group, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    throw new Error("Original test group remains present.");
  }

  /**
   * Just past the compiler transport's fixed 10 s per-invocation default, which
   * authored compiler calls used to keep whatever time their caller had left.
   */
  const SLOW_COMPILE_MS = 10_500;

  /**
   * A wrapper around the fixture compiler whose first invocation of `operation`
   * (any operation when omitted) sleeps {@link SLOW_COMPILE_MS} before it runs.
   * `install` selects it; the case guard restores the fixture's compiler key.
   * `slept` is the marker the wrapper writes when it has slept.
   */
  async function slowCompilerOnce(opts: {
    readonly root: string;
    readonly operation?: string;
  }): Promise<{ readonly install: () => void; readonly slept: string }> {
    const compiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    if (!compiler) {
      throw new Error("missing fixture compiler");
    }
    const slept = join(opts.root, "slow-compile-once");
    const wrapper = join(opts.root, "slow-compiler");
    const selected = opts.operation
      ? `process.argv[2]===${JSON.stringify(opts.operation)}`
      : "true";
    await writeFile(
      wrapper,
      `#!${process.execPath}
import {existsSync,writeFileSync} from "node:fs";
if(${selected}&&!existsSync(${JSON.stringify(slept)})){writeFileSync(${JSON.stringify(slept)},"");await Bun.sleep(${SLOW_COMPILE_MS});}
const child=Bun.spawn([${JSON.stringify(compiler)},...process.argv.slice(2)],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`
    );
    await chmod(wrapper, 0o700);
    return {
      install: () => {
        process.env.HACK_CONFIG_COMPILER_BINARY = wrapper;
      },
      slept,
    };
  }

  /**
   * Wrap the fixture's native stand-in so its second `frontend-plan` request
   * (the one after up.before has run and the host processes have started)
   * publishes `held` and then waits until the start kills it.
   */
  async function holdSecondFrontendPlan(opts: {
    readonly root: string;
    readonly binary: string;
  }): Promise<{ readonly binary: string; readonly held: string }> {
    const plans = join(opts.root, "frontend-plans");
    const held = join(opts.root, "second-frontend-plan-held");
    const binary = join(opts.root, "native-hold-second-plan");
    await writeFile(
      binary,
      `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
if(args.includes("frontend-plan")){appendFileSync(${JSON.stringify(plans)},"plan\\n");if(readFileSync(${JSON.stringify(plans)},"utf8").trim().split("\\n").length===2){writeFileSync(${JSON.stringify(held)},String(process.pid));setInterval(()=>{},1000);await new Promise(()=>{});}}
const child=Bun.spawn([${JSON.stringify(opts.binary)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`
    );
    await chmod(binary, 0o700);
    return { binary, held };
  }

  /**
   * Delay the stand-in mux's first `list-panes` (issued right after it started
   * the host process window) and publish `held` first, so a case can cancel
   * while the host process launch is still in progress.
   */
  async function holdFirstPaneQuery(root: string): Promise<string> {
    const bin = join(root, "bin");
    const held = join(root, "pane-query-held");
    await writeFile(
      join(bin, "tmux-stand-in"),
      await readFile(join(bin, "tmux")),
      { mode: 0o700 }
    );
    await writeFile(
      join(bin, "tmux"),
      `#!${process.execPath}
import {existsSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
if(args[0]==="list-panes"&&!existsSync(${JSON.stringify(held)})){writeFileSync(${JSON.stringify(held)},"");await Bun.sleep(1000);}
const child=Bun.spawn([${JSON.stringify(join(bin, "tmux-stand-in"))},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`
    );
    await chmod(join(bin, "tmux"), 0o700);
    return held;
  }

  /** True once no process in `group` remains, within a 5 s bound. */
  async function groupEnded(group: number): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(-group, 0);
      } catch (error) {
        if ((error as { code?: unknown }).code === "ESRCH") {
          return true;
        }
        throw error;
      }
      await Bun.sleep(50);
    }
    return false;
  }
  return {
    run,
    CANARY,
    SETTLEMENT_BUDGET_MS,
    MAX_STARTUP_TIMEOUT_MS,
    CASE_TIMEOUT_MS,
    STARTUP_TIMEOUT_MS,
    STOP_TIMEOUT_MS,
    DEADLINE_WALL_BOUND_MS,
    STAND_IN_CAP_MS,
    HOST_PROCESS_CAP_MS,
    cases,
    test,
    ownerRelease,
    releaseOwner,
    muxWindowPids,
    observeOwners,
    serveNativeAuthoredProject,
    KEYS,
    compilerFixtureNode,
    fixture,
    artifacts,
    failure,
    macTest,
    confirmTestGroupAbsent,
    SLOW_COMPILE_MS,
    slowCompilerOnce,
    holdSecondFrontendPlan,
    holdFirstPaneQuery,
    groupEnded,
  };
}
