import {
  afterEach,
  beforeEach,
  test as boundedTest,
  expect,
  spyOn,
} from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLegacyComposeAdoptionBinding } from "../src/lib/native-compose-adoption-binding.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../src/lib/native-compose-adoption-generation.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import { restoreEnv } from "./helpers/env.ts";
import { retainedRoutingFixtureLifetime } from "./helpers/retained-routing-adoption.ts";

// The two compound workflows include preparation, publication, multiple bounded
// operations and saved rollback; their outer budget is separate from each 15s
// product mutation limit. Unknown callbacks/children permanently retain globals.
let lifetime: ReturnType<typeof retainedRoutingFixtureLifetime> | undefined;
let uncertain = false;
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">> | undefined;
const originalSpawn = Bun.spawn;
function ownedTest(name: string, run: () => Promise<void>, timeoutMs = 5000) {
  boundedTest(
    name,
    async () => {
      lifetime = retainedRoutingFixtureLifetime(Date.now() + timeoutMs);
      const owner = lifetime;
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((...args) => {
        const child = Reflect.apply(originalSpawn, Bun, args);
        owner.track(child.exited);
        return child;
      });
      await owner.track(run());
    },
    timeoutMs
  );
}
const test = Object.assign(ownedTest, {
  each:
    <T>(rows: readonly T[]) =>
    (name: string, run: (value: T) => Promise<void>, timeoutMs = 5000) => {
      for (const value of rows) {
        ownedTest(
          name.replace("%s", String(value)),
          () => run(value),
          timeoutMs
        );
      }
    },
});

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
  guestMode?: "400" | "600";
};
beforeEach(async () => {
  if (uncertain) {
    throw new Error(
      "Prior retained-file fixture settlement is unknown; values omitted."
    );
  }
  lifetime = undefined;
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
  if(args[2]==='stat' && args.length===7 && args[3]==='-c' && args[4]==='%d:%i:%u:%g:%s:%f:%a' && args[5]==='--') {const mode=value.guestMode??'444';console.log('7:'+value.guestIno+':'+value.uid+':321:'+value.size+':'+(0o100000|Number.parseInt(mode,8)).toString(16)+':'+mode);process.exit(0);}
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
  if (!lifetime?.canRestore()) {
    uncertain = true;
    throw new Error(
      "Retained-file fixture callback or child is unsettled; preserved values omitted."
    );
  }
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
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
}, 60_000);

test("file8 refuses foreign receipt families and extra proof fields before engine observation", async () => {
  const { store, generation } = await prepared();
  const receiptPath = join(
    projectRoot,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const originalReceipt = await state();
  const manifestPath = join(
    projectRoot,
    ".hack/.internal/legacy-compose-adoption-v1/generations",
    originalReceipt.prepared.id,
    "manifest.json"
  );
  const originalManifest = await readFile(manifestPath, "utf8");
  const meta = JSON.parse(originalManifest);
  const before = await commands();
  try {
    for (const version of [1, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14]) {
      await writeFile(
        receiptPath,
        JSON.stringify({
          ...originalReceipt,
          adoption_receipt_version: version,
        })
      );
      await expect(store.loadPrepared()).rejects.toThrow();
      expect(await commands()).toEqual(before);
    }
    for (const field of [
      "buildProof",
      "sourceBindProof",
      "branchProof",
      "projectionProof",
      "routingClaims",
    ]) {
      const changed = JSON.stringify({ ...meta, [field]: {} });
      await writeFile(manifestPath, changed);
      // Authenticate the changed bytes so closed schema refusal, rather than a
      // stale manifest hash, discriminates proof mixing between valid families.
      await writeFile(
        receiptPath,
        JSON.stringify({
          ...originalReceipt,
          prepared: {
            ...originalReceipt.prepared,
            manifest: {
              ...originalReceipt.prepared.manifest,
              hash: createHash("sha256").update(changed).digest("hex"),
            },
          },
        })
      );
      await expect(store.loadPrepared()).rejects.toThrow();
      expect(await commands()).toEqual(before);
    }
    await writeFile(manifestPath, originalManifest);
    await writeFile(receiptPath, JSON.stringify(originalReceipt));
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(generation.report.adoption_generation_version);
    expect(await mutations()).toEqual([]);
  } finally {
    await store.close();
  }
}, 15_000);

test("ordinary binding and unprotected original secret refuse without engine acquisition", async () => {
  await expect(
    acquireLegacyComposeAdoptionBinding({ projectRoot })
  ).rejects.toThrow();
  expect(await commands().catch(() => [])).toEqual([]);
  // File creation respects the caller's umask; establish the intended unsafe
  // secret permission on this disposable test source before admission.
  const material = join(projectRoot, "material/config");
  await chmod(material, 0o444);
  expect((await stat(material)).mode & 0o777).toBe(0o444);
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
  "400",
  "600",
] as const)("prepared file8 normalizes original protected secret %s with saved stop/recovery and rollback", async (mode) => {
  const material = join(projectRoot, "material/config");
  await chmod(material, Number.parseInt(mode, 8));
  const before = await stat(material);
  const authored = await readFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    authored
      .replaceAll("configs", "secrets")
      .replace(
        "secrets: [settings]",
        "secrets:\n      - source: settings\n        target: /settings"
      )
  );
  fixture.guestMode = mode;
  await save();
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(8);
    await store.withLease({
      generation,
      run: async (input) => {
        expect(
          JSON.parse(input.candidateText).services.app.mounts
        ).toContainEqual({
          secret: "settings",
          target: "/settings",
          access: "read-only",
          mode: `0${mode}`,
        });
        expect(JSON.stringify(input)).toBe("{}");
      },
    });
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
      throw new Error("active protected generation missing");
    }
    for (const operation of ["start", "restart", "stop"] as const) {
      expect(
        await store.withMutation({
          generation: active,
          operation,
          services: [],
          binary,
          deadline: Date.now() + 15_000,
          run: async (input) => {
            await input.assertFresh();
            return await effect(operation);
          },
        })
      ).toBe(0);
    }
    const after = await stat(material);
    expect([after.dev, after.ino, after.uid, after.gid, after.mode]).toEqual([
      before.dev,
      before.ino,
      before.uid,
      before.gid,
      before.mode,
    ]);
    expect(await readFile(material, "utf8")).toBe(CANARY);
    await rm(material);
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
      run: async () => await effect("stop"),
    });
    await store.rollback();
    expect((await state()).publication.phase).toBe("rolled-back");
    expect((await state()).pendingOperation).toBeNull();
  } finally {
    await store.close();
  }
}, 60_000);
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
