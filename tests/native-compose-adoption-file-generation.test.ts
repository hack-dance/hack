import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { acquireLegacyComposeAdoptionBinding } from "../src/lib/native-compose-adoption-binding.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../src/lib/native-compose-adoption-generation.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import { restoreEnv } from "./helpers/env.ts";

const ID = "a".repeat(64);
const NETWORK = "b".repeat(64);
const BIRTH = "2026-01-01T01:02:03Z";
const CANARY = "synthetic-private-retained-file-material";
let root: string;
let projectRoot: string;
let binary: string;
let priorPath: string | undefined;
let fixture: {
  running: boolean;
  failed: boolean;
  digest: string;
  size: number;
  uid: number;
  guestIno: number;
  mountSource: string;
  rw: boolean;
  guestDelayMs?: number;
  stateReads?: number;
  flipAfterState?: number;
};
beforeEach(async () => {
  priorPath = process.env.PATH;
  root = await realpath(
    await mkdtemp(join(tmpdir(), "retained-file-generation-"))
  );
  projectRoot = join(root, "checkout");
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  await mkdir(join(projectRoot, ".git"));
  await mkdir(join(projectRoot, "material"));
  await writeFile(join(projectRoot, "material/config"), CANARY, {
    mode: 0o444,
  });
  await writeFile(
    join(projectRoot, ".hack/hack.config.json"),
    '{"name":"fixture"}\n'
  );
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "name: fixture\nservices:\n  app:\n    image: fixture:pinned\n    configs: [settings]\n    volumes: [data:/data]\nconfigs:\n  settings:\n    file: ../material/config\nvolumes:\n  data:\n    name: fixture_data\n"
  );
  fixture = {
    running: true,
    failed: false,
    digest: createHash("sha256").update(CANARY).digest("hex"),
    size: Buffer.byteLength(CANARY),
    uid: 123,
    guestIno: 456,
    mountSource: join(projectRoot, "material/config"),
    rw: false,
  };
  await save();
  await writeFile(
    join(root, "docker"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const root=${JSON.stringify(root)}, projectRoot=${JSON.stringify(projectRoot)}, id=${JSON.stringify(ID)}, network=${JSON.stringify(NETWORK)}, birth=${JSON.stringify(BIRTH)};
const args=process.argv.slice(2);appendFileSync(root+'/commands',JSON.stringify(args)+'\\n');
const value=JSON.parse(readFileSync(root+'/fixture.json','utf8'));
const [kind,action]=args;
if(kind==='exec') {
  if(args[1]!==id || args.at(-1)!=='/settings') process.exit(91);
  if(value.guestDelayMs) {appendFileSync(root+'/guest-pids',String(process.pid)+'\\n');await Bun.sleep(value.guestDelayMs);}
  if(args[2]==='stat' && args.length===7 && args[3]==='-c' && args[4]==='%d:%i:%u:%g:%s:%f:%a' && args[5]==='--') {console.log('7:'+value.guestIno+':'+value.uid+':321:'+value.size+':'+(0o100444).toString(16)+':444');process.exit(0);}
  if(args[2]==='sha256sum' && args.length===5 && args[3]==='--') {console.log(value.digest+'  /settings');process.exit(0);}
  process.exit(92);
}
if(kind==='container' && ['start','stop','restart'].includes(action)) {
  if(args.length!==3 || args[2]!==id) process.exit(93);
  value.running=action!=='stop';writeFileSync(root+'/fixture.json',JSON.stringify(value));process.exit(value.failed?7:0);
}
if(kind==='compose' && args.includes('config') && args.includes('--hash')) {console.log('app '+'d'.repeat(64));process.exit(0);}
if(kind==='info' && action==='--format') {console.log(JSON.stringify({id:'fixed-engine',os:'linux'}));process.exit(0);}
if(!['container','volume','network'].includes(kind) || !['ls','inspect'].includes(action) || !args.includes('--format')) process.exit(94);
const common={project:'fixture',native:''};
if(action==='ls') {
  console.log(JSON.stringify(kind==='container'?{id,name:'fixture-app-1',project:'fixture'}:kind==='volume'?{id:'fixture_data',name:'fixture_data',project:'fixture'}:{id:network,name:'fixture_default',project:'fixture'}));process.exit(0);
}
if(kind==='container') {
  if(args.at(-1)!==id) process.exit(95);
  const format=args[args.indexOf('--format')+1];
  if(format.includes('config-hash')) {console.log(JSON.stringify({id,hash:'d'.repeat(64)}));process.exit(0);}
  if(!format.includes('.Mounts')) {console.log(JSON.stringify({id,running:value.running,paused:false,status:value.running?'running':'exited'}));value.stateReads=(value.stateReads??0)+1;if(value.stateReads===value.flipAfterState) value.running=!value.running;writeFileSync(root+'/fixture.json',JSON.stringify(value));process.exit(0);}
  console.log(JSON.stringify({...common,id,name:'/fixture-app-1',service:'app',number:'1',oneoff:'False',running:value.running,workingDir:projectRoot+'/.hack',configFiles:projectRoot+'/.hack/docker-compose.yml',mounts:[{type:'volume',name:'fixture_data',source:'/volumes/data',target:'/data',rw:true},{type:'bind',name:'',source:value.mountSource,target:'/settings',rw:value.rw}],networks:[{name:'fixture_default',id:network}]}));process.exit(0);
}
if(kind==='volume') {console.log(JSON.stringify({...common,id:'fixture_data',name:'fixture_data',storage:'data',createdAt:birth,driver:'local',scope:'local',mountpoint:'/volumes/data',options:null}));process.exit(0);}
console.log(JSON.stringify({...common,id:network,name:'fixture_default',logical:'default',createdAt:birth,driver:'bridge',scope:'local',internal:false,containers:value.running?[id]:[]}));
`
  );
  await chmod(join(root, "docker"), 0o700);
  binary = join(root, "compiler");
  await writeFile(
    binary,
    `#!${process.execPath}
if(process.argv[2]==='--protocol') console.log(JSON.stringify(Object.fromEntries(['transport_version','authored_version','plan_version','file_plan_version'].map(key=>[key,1]))));
else {const source=JSON.parse(await Bun.stdin.text());const {schema_version,...plan}=source;console.log(JSON.stringify({transport_version:1,ok:true,plan:{plan_version:1,...plan,jobs:{},selected_profiles:[]},semantic_hash:'a'.repeat(64),declared_workloads:Object.fromEntries(Object.keys(source.services).map(name=>[name,'service']))}));}
`
  );
  await chmod(binary, 0o700);
  process.env.PATH = root;
});
afterEach(async () => {
  restoreEnv("PATH", priorPath);
  await rm(root, { recursive: true, force: true });
});
async function save() {
  await writeFile(join(root, "fixture.json"), JSON.stringify(fixture));
}
async function state() {
  return JSON.parse(
    await readFile(
      join(
        projectRoot,
        ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
      ),
      "utf8"
    )
  );
}
async function commands() {
  return (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}
async function mutations() {
  return (await commands()).filter(
    (args) =>
      args[0] === "container" &&
      ["start", "stop", "restart"].includes(args[1] ?? "")
  );
}
async function prepared() {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    return { store, generation };
  } catch (error: unknown) {
    await store.close();
    throw error;
  }
}
async function effect(operation: "start" | "stop" | "restart") {
  const current = JSON.parse(
    await readFile(join(root, "fixture.json"), "utf8")
  );
  current.running = operation !== "stop";
  await writeFile(join(root, "fixture.json"), JSON.stringify(current));
  return current.failed ? 7 : 0;
}

test("file8 earns explicit preparation, stopped publication, retained lifecycle and rollback without changing material", async () => {
  const original = await readFile(join(projectRoot, "material/config"));
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(8);
    expect((await state()).adoption_receipt_version).toBe(8);
    expect(JSON.stringify(generation)).not.toContain(CANARY);
    await store.withPreparationStop({
      generation,
      binary,
      deadline: Date.now() + 15_000,
      run: async (input) => {
        await input.assertFresh();
        return await effect("stop");
      },
    });
    await store.publish({ generation, binary });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("active generation missing");
    }
    expect(
      await store.withMutation({
        generation: active,
        operation: "start",
        services: [],
        binary,
        deadline: Date.now() + 15_000,
        run: async (input) => {
          await input.assertFresh();
          expect(JSON.stringify(input)).toBe("{}");
          return await effect("start");
        },
      })
    ).toBe(0);
    expect(
      await store.withMutation({
        generation: active,
        operation: "restart",
        services: [],
        binary,
        deadline: Date.now() + 15_000,
        run: async (input) => {
          await input.assertFresh();
          return await effect("restart");
        },
      })
    ).toBe(0);
    expect(
      await store.withMutation({
        generation: active,
        operation: "stop",
        services: [],
        binary,
        deadline: Date.now() + 15_000,
        run: async (input) => {
          await input.assertFresh();
          return await effect("stop");
        },
      })
    ).toBe(0);
    await store.rollback();
    expect((await state()).publication.phase).toBe("rolled-back");
    expect((await state()).pendingOperation).toBeNull();
    expect(await readFile(join(projectRoot, "material/config"))).toEqual(
      original
    );
    expect(
      (await commands()).every(
        (args) =>
          !["rm", "create", "up", "down", "build", "pull"].includes(
            args[1] ?? ""
          )
      )
    ).toBe(true);
  } finally {
    await store.close();
  }
}, 30_000);

test("ordinary binding and unsupported secret grants refuse without acquiring material or engine", async () => {
  await expect(
    acquireLegacyComposeAdoptionBinding({ projectRoot })
  ).rejects.toThrow();
  const source = await readFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    source.replaceAll("configs", "secrets")
  );
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    await expect(store.prepare({ binary })).rejects.toThrow();
    expect(await commands().catch(() => [])).toEqual([]);
  } finally {
    await store.close();
  }
});
test.each([
  "foreign-source",
  "writable",
])("exact original bind %s cannot earn file8", async (variation) => {
  if (variation === "foreign-source") {
    fixture.mountSource = join(root, "foreign");
  } else {
    fixture.rw = true;
  }
  await save();
  await expect(prepared()).rejects.toThrow();
  expect(await mutations()).toEqual([]);
});
test("fresh material drift refuses start before callback; saved observations/stop/rollback still settle originals", async () => {
  const { store, generation } = await prepared();
  try {
    await store.withPreparationStop({
      generation,
      binary,
      deadline: Date.now() + 15_000,
      run: async () => await effect("stop"),
    });
    await store.publish({ generation, binary });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("active generation missing");
    }
    await rm(join(projectRoot, "material/config"));
    let calls = 0;
    await expect(
      store.withMutation({
        generation: active,
        operation: "start",
        services: [],
        binary,
        deadline: Date.now() + 15_000,
        run: async () => {
          calls++;
          return 0;
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect((await state()).pendingOperation).toBeNull();
    expect(
      await store.withLease({
        generation: active,
        material: "saved",
        run: async () => "saved",
      })
    ).toBe("saved");
    await expect(
      store.withLease({ generation: active, run: async () => "exec" })
    ).rejects.toThrow();
    await store.withMutation({
      generation: active,
      operation: "stop",
      services: [],
      binary,
      deadline: Date.now() + 15_000,
      run: async (input) => {
        await input.assertFresh();
        return await effect("stop");
      },
    });
    await store.rollback();
    expect((await state()).publication.phase).toBe("rolled-back");
  } finally {
    await store.close();
  }
}, 30_000);
test("failed effect retains uncertainty and explicit stop recovery does not need material", async () => {
  const { store, generation } = await prepared();
  try {
    await store.withPreparationStop({
      generation,
      binary,
      deadline: Date.now() + 15_000,
      run: async () => await effect("stop"),
    });
    await store.publish({ generation, binary });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("active generation missing");
    }
    fixture.failed = true;
    fixture.running = false;
    await save();
    expect(
      await store.withMutation({
        generation: active,
        operation: "start",
        services: [],
        binary,
        deadline: Date.now() + 15_000,
        run: async () => await effect("start"),
      })
    ).toBe(7);
    expect((await state()).pendingOperation.operation).toBe("start");
    await expect(store.loadActive()).rejects.toThrow();
    await rm(join(projectRoot, "material/config"));
    fixture.failed = false;
    fixture.running = true;
    await save();
    const recovering = await store.loadActive({ recoverOperation: true });
    if (!recovering) {
      throw new Error("recovery missing");
    }
    expect(
      await store.withMutation({
        generation: recovering,
        operation: "stop",
        services: [],
        recover: true,
        binary,
        deadline: Date.now() + 15_000,
        run: async () => await effect("stop"),
      })
    ).toBe(0);
    expect((await state()).pendingOperation).toBeNull();
  } finally {
    await store.close();
  }
}, 30_000);
test("material change after an effect cannot clear its pending journal", async () => {
  const { store, generation } = await prepared();
  try {
    await store.withPreparationStop({
      generation,
      binary,
      deadline: Date.now() + 15_000,
      run: async () => await effect("stop"),
    });
    await store.publish({ generation, binary });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("active generation missing");
    }
    await expect(
      store.withMutation({
        generation: active,
        operation: "start",
        services: [],
        binary,
        deadline: Date.now() + 15_000,
        run: async () => {
          await effect("start");
          await chmod(join(projectRoot, "material/config"), 0o600);
          await writeFile(join(projectRoot, "material/config"), "drift");
          return 0;
        },
      })
    ).rejects.toThrow();
    expect((await state()).pendingOperation.operation).toBe("start");
    expect((await state()).publication.phase).toBe("active");
  } finally {
    await store.close();
  }
}, 30_000);
test("preview exposes field reports only, never private material identities or digests", async () => {
  const report = await previewLegacyComposeAdoption({
    projectRoot,
    binary,
    stop: true,
  });
  expect(report.complete).toBe(true);
  const publicText = JSON.stringify(report);
  expect(publicText).not.toContain(CANARY);
  expect(publicText).not.toContain(fixture.digest);
  expect(publicText).not.toContain(projectRoot);
  expect(publicText).not.toContain(ID);
  expect(await mutations()).toEqual([]);
}, 30_000);
test("saved exec material proof charges all guest queries to one remaining probe budget", async () => {
  const preparedOwner = await prepared();
  await preparedOwner.store.close();
  fixture.guestDelayMs = 800;
  await save();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot,
    mode: "saved",
    timeoutMs: 2000,
  });
  try {
    const generation = await store.loadPrepared();
    if (!generation) {
      throw new Error("prepared generation missing");
    }
    let callbacks = 0;
    await expect(
      store.withLease({
        generation,
        run: async () => {
          callbacks++;
          return 0;
        },
      })
    ).rejects.toThrow();
    expect(callbacks).toBe(0);
    const pids = (await readFile(join(root, "guest-pids"), "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    expect(pids.length).toBe(3);
    for (const pid of pids) {
      let code: unknown;
      try {
        process.kill(pid, 0);
      } catch (error: unknown) {
        code = (error as { code?: unknown }).code;
      }
      expect(code).toBe("ESRCH");
    }
    expect((await state()).pendingOperation).toBeNull();
    expect(await mutations()).toEqual([]);
  } finally {
    await store.close();
  }
}, 30_000);
test.each([
  "start",
  "stop",
] as const)("%s completion drift during final material fence keeps pending ownership", async (operation) => {
  const { store, generation } = await prepared();
  try {
    await store.withPreparationStop({
      generation,
      binary,
      deadline: Date.now() + 15_000,
      run: async () => await effect("stop"),
    });
    await store.publish({ generation, binary });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("active generation missing");
    }
    await expect(
      store.withMutation({
        generation: active,
        operation,
        services: [],
        binary,
        deadline: Date.now() + 15_000,
        run: async () => {
          const current = JSON.parse(
            await readFile(join(root, "fixture.json"), "utf8")
          );
          current.running = operation === "start";
          current.stateReads = 0;
          current.flipAfterState = operation === "start" ? 2 : 1;
          await writeFile(join(root, "fixture.json"), JSON.stringify(current));
          return 0;
        },
      })
    ).rejects.toThrow();
    expect((await state()).pendingOperation.operation).toBe(operation);
  } finally {
    await store.close();
  }
}, 30_000);
