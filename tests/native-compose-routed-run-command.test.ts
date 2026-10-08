import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { openNativeComposeRouteClaims } from "../src/lib/native-compose-route-claims.ts";
import { prepareNativeComposeRouteOwner } from "../src/lib/native-compose-route-owner.ts";
import type { NativeRoutingResolution } from "../src/lib/native-routing-plan-protocol.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
const ID = "c".repeat(64);
const ONEOFF = "d".repeat(64);
const BINDING = {
  engineId: "fixture-engine:1",
  proxyId: "a".repeat(64),
  networkId: "b".repeat(64),
  proxyIp: "172.29.0.2",
};
const LITERAL = "literal-$HOME-${UNSET}-$$";
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

type Mode =
  | "ordinary"
  | "cleanup-failure"
  | "exposed"
  | "not-ready"
  | "foreign"
  | "changed-input"
  | "source-drift"
  | "replacement";
async function fixture(mode: Mode = "ordinary") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-routed-run-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await mkdir(join(root, "home"));
  const input = composeFixture();
  input.plan.worktree.auto_branch = false;
  const web = input.plan.services.web;
  if (!web) {
    throw new Error("Fixture requires web");
  }
  web.environment = { LITERAL: { literal: LITERAL } };
  input.environmentPlan.workloads.web = {
    LITERAL: { kind: "literal", value: LITERAL },
  };
  input.plan.routes = {
    domain: "dev.test",
    aliases: {},
    http: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        hostname: "project",
      },
    },
  };
  const origin = "https://fixture.dev.test";
  const resolution: NativeRoutingResolution = {
    domain: "dev.test",
    domain_origin: "project",
    project_origin: origin,
    aliases: {},
    oauth_alias: null,
    open_preference: "auto",
    open_preference_origin: "default",
    open_origin: origin,
    routes: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        origin,
        aliases: {},
      },
    },
  };
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({
      schema_version: 1,
      name: "fixture",
      services: input.plan.services,
      routes: input.plan.routes,
      worktree: { auto_branch: false },
    })
  );
  const owner = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  const generation = await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const rendered = renderNativeCompose({
      ...input,
      projectRoot: root,
      runtimeIdentity: owner.identity.composeProject,
      generationIdentity: reservation.generationId,
      ownerToken: owner.identity.ownerToken,
      routingResolution: resolution,
      declaredWorkloads: { web: "service" },
    });
    const routing = await prepareNativeComposeRouteOwner({
      owner: owner.identity,
      generationId: reservation.generationId,
      document: rendered.document,
      plan: input.plan,
      resolution,
      declared: { web: "service" },
      previous: [],
      io: {
        ingress: async () => BINDING,
        inventory: async () => {},
        proxy: async () => {},
        claims: async (options) =>
          await openNativeComposeRouteClaims({
            ...options,
            root: join(root, "home/compose-routing"),
          }),
      },
    });
    try {
      const saved = await mutation.publish({
        reservation,
        composeJson: JSON.stringify(routing?.document ?? rendered.document),
        profiles: [],
        inputRevision: createHash("sha256").update("fixture").digest("hex"),
        assertFresh: async () => {},
      });
      await mutation.runEffect({
        generation: saved,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        beforeComplete: () => routing?.complete() ?? Promise.resolve(),
        effect: async () => {
          await routing?.markEffectsPossible();
          await routing?.verifyTransition({ deadline: Date.now() + 5000 });
          return { outcome: "complete", value: 0 };
        },
      });
      return saved;
    } finally {
      await routing?.close();
    }
  });
  const document = await owner.readGenerationDocument(generation);
  const receipt = join(
    root,
    ".hack/.internal/native-compose",
    owner.identity.instanceId,
    "receipt.json"
  );
  await owner.close();
  await Bun.write(
    join(root, "compiler"),
    `#!${process.execPath}
const operation=process.argv[2];
if(operation === "--protocol") console.log(JSON.stringify({transport_version:1,authored_version:1,plan_version:1,resolve_version:1,local_version:1,env_plan_version:1,routing_plan_version:1}));
else {
 const request=operation==="compile"?{}:JSON.parse(await Bun.stdin.text());
 const result={transport_version:1,ok:true,semantic_hash:"a".repeat(64),declared_workloads:{web:"service"},plan:${JSON.stringify(input.plan)}};
 if(${JSON.stringify(mode)}==="changed-input") result.plan.services.web.environment.LITERAL.literal="changed";
 if(operation!=="compile") {result.local_resolution={overlay:null,origin:"project",auto_branch:false,inherit_local:true,resolution_hash:"b".repeat(64)}; if(request.routing_probe===true) result.routing_inputs_required=true; else result.routing_resolution=${JSON.stringify(resolution)};}
 if(operation==="plan") { result.environment_plan=${JSON.stringify(input.environmentPlan)}; if(${JSON.stringify(mode)}==="changed-input") result.environment_plan.workloads.web.LITERAL.value="changed"; }
 console.log(JSON.stringify(result));
}
`
  );
  await chmod(join(root, "compiler"), 0o700);
  await dockerTransport({
    root,
    mode,
    project: owner.identity.composeProject,
    owner: owner.identity.ownerToken,
    generation: generation.generationId,
  });
  return { root, receipt, generation, document };
}

/** Fake engine observations; real command, generation/claim stores and projection publication. */
async function dockerTransport(opts: {
  root: string;
  mode: Mode;
  project: string;
  owner: string;
  generation: string;
}) {
  await Bun.write(
    join(opts.root, "docker"),
    `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,unlinkSync,writeFileSync} from "node:fs";
const {root,mode,project,owner,generation}=${JSON.stringify(opts)}, binding=${JSON.stringify(BINDING)}, main=${JSON.stringify(ID)}, oneId=${JSON.stringify(ONEOFF)};
const args=process.argv.slice(2), format=args[args.indexOf("--format")+1]??"", oneFile=root+"/oneoff";
appendFileSync(root+"/commands",JSON.stringify(args)+"\\n");
const hasOne=()=>existsSync(oneFile), oneName=()=>hasOne()?readFileSync(oneFile,"utf8"):"";
const mainId=()=>mode==="replacement"&&existsSync(root+"/spawned")?"e".repeat(64):main;
const containers=()=>[{id:mainId(),name:project+"-web-1",project},...(hasOne()?[{id:oneId,name:oneName(),project}]:[])];
const emit=(value)=>console.log(JSON.stringify(value));
if(args[0]==="compose") {
 if(!args.includes("run") || !args.includes("--no-deps")) process.exit(99);
 const file=args[args.indexOf("-f")+1], doc=JSON.parse(readFileSync(file,"utf8"));
 writeFileSync(root+"/delivery",JSON.stringify({file,document:doc,args}));
 writeFileSync(oneFile,args[args.indexOf("--name")+1]);writeFileSync(root+"/spawned","yes");process.exit(17);
}
if(args[0]==="container"&&args[1]==="rm") {
 if(args.length!==3||args[2]!==oneId) process.exit(98);
 if(mode==="cleanup-failure") process.exit(1);
 unlinkSync(oneFile);process.exit(0);
}
if(args[0]==="info") {
 if(mode==="source-drift"&&!existsSync(root+"/changed")) {appendFileSync(root+"/.hack/hack.project.json","\\n ");writeFileSync(root+"/changed","yes");}
 emit(binding.engineId);
} else if(args[0]==="exec") {
 process.stdout.write(JSON.stringify({srv0:{listen:[":443"],tls_connection_policies:[{}],routes:[{match:[{host:["fixture.dev.test"]}],handle:[{handler:"subroute",routes:[{handle:[{handler:"reverse_proxy",upstreams:[{dial:"172.29.0.3:3000"}]}],terminal:true}]}],terminal:true}]}})+"\\n200");
} else if(args[0]==="container"&&args[1]==="ls") {
 if(format.includes('"name"')) for(const row of containers()) emit(row);
 else if(args.includes("label=com.docker.compose.project=hack-dev-proxy")) emit(binding.proxyId);
 else if(args.includes("label=com.docker.compose.project="+project)) for(const row of containers()) emit(row.id);
 else {emit(binding.proxyId);for(const row of containers()) emit(row.id);}
} else if(args[0]==="container"&&args[1]==="inspect") {
 for(const id of args.slice(args.indexOf("--format")+2)) {
  const proxy=id===binding.proxyId, one=id===oneId;
  if(format.includes("routeLabels")) emit({id,routeLabels:mode==="exposed"?["caddy_0",null]:[null]});
  else if(format.includes("sites")) emit({id,project:proxy?"hack-dev-proxy":project,owner:proxy?null:owner,instance:proxy?null:project,generation:proxy?null:generation,sites:proxy||one?[null]:["https://fixture.dev.test",null]});
  else if(proxy) emit({id,project:"hack-dev-proxy",service:"caddy",running:true,network:binding.networkId,ip:binding.proxyIp});
  else if(format.includes('"health"')) emit({id,name:"/"+(one?oneName():project+"-web-1"),project,version:"1",instance:project,owner:mode==="foreign"?"f".repeat(32):owner,generation,service:"web",oneoff:one?"True":"False",state:one?"exited":mode==="not-ready"?"exited":"running",exitCode:one?17:0,health:null});
  else emit({id,project,instance:project,owner,generation,service:"web",oneoff:one?"True":"False",running:!one,network:binding.networkId,ip:one?"172.29.0.4":"172.29.0.3"});
 }
} else if(args[0]==="network"&&args[1]==="inspect") emit({id:binding.networkId,name:"hack-dev"});
else if(!(["network","volume"].includes(args[0])&&args[1]==="ls")) {console.error("private-command-canary");process.exit(97);}
`
  );
  await chmod(join(opts.root, "docker"), 0o700);
}

async function invoke(root: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../index.ts"),
      "run",
      "web",
      "--",
      "synthetic",
      "space arg",
      "$HOME",
      "exit17",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_GLOBAL_CONFIG_PATH: join(root, "home/hack.config.json"),
        HACK_CONFIG_COMPILER_BINARY: join(root, "compiler"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: "10000",
        GIT_DIR: "",
        GIT_WORK_TREE: "",
        GIT_COMMON_DIR: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const outputs = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  children.push(child);
  return { exit: await child.exited, output: (await outputs).join("") };
}

async function claimsSnapshot(root: string) {
  const base = join(root, "home/compose-routing");
  const paths = await readdir(base, { recursive: true });
  return await Promise.all(
    paths
      .filter((path) => path.endsWith(".json"))
      .sort()
      .map(async (path) => [path, await readFile(join(base, path), "utf8")])
  );
}

test("warm routed source CLI runs a private projection, preserves graph/claims, literal argv/env and exact exit 17", async () => {
  const { root, receipt, generation, document } = await fixture();
  const before = await claimsSnapshot(root);
  const result = await invoke(root);
  expect(result.exit).toBe(17);
  expect(result.output).not.toContain("private-command-canary");
  const delivery = await Bun.file(join(root, "delivery")).json();
  expect(delivery.file).not.toBe(generation.composeFile);
  expect(delivery.file).toContain("/oneoffs/");
  expect(delivery.args).toContain("--no-deps");
  expect(delivery.args.slice(-5)).toEqual([
    "web",
    "synthetic",
    "space arg",
    "$HOME",
    "exit17",
  ]);
  expect(delivery.document.services.web.environment.LITERAL).toBe(
    LITERAL.replaceAll("$", () => "$$")
  );
  expect(
    Object.keys(delivery.document.services.web.labels).some(
      (name) =>
        name === "caddy" ||
        name.startsWith("caddy.") ||
        name.startsWith("caddy_")
    )
  ).toBe(false);
  expect(
    delivery.document.services.web.labels["io.hack.native-config.generation"]
  ).toBe(generation.generationId);
  expect(await Bun.file(generation.composeFile).json()).toEqual(document);
  expect(await claimsSnapshot(root)).toEqual(before);
  const state = await Bun.file(receipt).json();
  expect(state).toMatchObject({
    current: { generationId: generation.generationId },
    stopped: false,
    pending: null,
  });
  expect(await Bun.file(join(root, "oneoff")).exists()).toBe(false);
  const commands = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    commands.filter((args: string[]) => args[0] === "compose")
  ).toHaveLength(1);
  expect(commands.filter((args: string[]) => args[1] === "rm")).toEqual([
    ["container", "rm", ONEOFF],
  ]);
}, 30_000);

test.each([
  "not-ready",
  "foreign",
  "changed-input",
  "source-drift",
] as const)("warm routed source CLI refuses %s before one-off effects", async (mode) => {
  const { root, receipt } = await fixture(mode);
  const result = await invoke(root);
  expect(result.exit).toBe(1);
  expect(result.output).not.toContain("private-command-canary");
  expect(await Bun.file(join(root, "delivery")).exists()).toBe(false);
  expect((await Bun.file(receipt).json()).pending).toBeNull();
}, 30_000);

test.each([
  "cleanup-failure",
  "exposed",
  "replacement",
] as const)("warm routed source CLI retains recoverable intent after %s", async (mode) => {
  const { root, receipt, generation } = await fixture(mode);
  const before = await claimsSnapshot(root);
  const result = await invoke(root);
  expect(result.exit).toBe(1);
  expect(result.output).not.toContain("private-command-canary");
  expect(await Bun.file(join(root, "delivery")).exists()).toBe(true);
  expect((await Bun.file(receipt).json()).pending).toMatchObject({
    operation: "run",
    generationId: generation.generationId,
    projection: { projectionId: expect.any(String) },
  });
  expect(await claimsSnapshot(root)).toEqual(before);
}, 30_000);
