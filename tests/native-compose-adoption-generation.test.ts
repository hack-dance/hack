import { afterEach, beforeEach, test as boundedTest, expect } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLegacyComposeAdoptedCommand } from "../src/lib/native-compose-adoption-command.ts";
import {
  LegacyComposeAdoptedGenerationError,
  openLegacyComposeAdoptedGenerationStore,
} from "../src/lib/native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import {
  assertLegacyProjectInputFamily,
  discoverProjectInputs,
} from "../src/lib/project-input-selection.ts";
import { restoreEnv } from "./helpers/env.ts";

// Each owner workflow performs multiple bounded child probes; allow their cumulative work on shared CI hosts.
const test = (name: string, run: () => Promise<void>) =>
  boundedTest(name, run, 20_000);
const CANARY = "synthetic-private-adoption-canary";
const ID = "a".repeat(64);
const NETWORK = "b".repeat(64);
const VOLUME = "original_private_database";
const CREATED = "2026-01-01T01:02:03Z";
type Fixture = {
  engine: string;
  container: Record<string, unknown>[];
  volume: Record<string, unknown>[];
  network: Record<string, unknown>[];
  mode?: string;
  configHash?: string;
  running?: boolean;
  mutationFailure?: boolean;
  states?: Record<string, boolean>;
};
let root: string;
let projectRoot: string;
let priorPath: string | undefined;
let fixture: Fixture;
beforeEach(async () => {
  priorPath = process.env.PATH;
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-adoption-binding-"))
  );
  projectRoot = join(root, "checkout");
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  await writeFile(
    join(projectRoot, ".hack/hack.config.json"),
    '{"name":"fixture"}\n'
  );
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    `name: fixture\nservices:\n  db:\n    image: ${CANARY}\n    environment:\n      PRIVATE: ${CANARY}\n      EMPTY: ""\n    volumes:\n      - data:/var/lib/database\nvolumes:\n  data:\n    name: ${VOLUME}\n`
  );
  fixture = {
    engine: CANARY,
    container: [
      {
        id: ID,
        name: "/fixture-db-1",
        project: "fixture",
        native: "",
        service: "db",
        number: "1",
        oneoff: "False",
        workingDir: join(projectRoot, ".hack"),
        configFiles: join(projectRoot, ".hack/docker-compose.yml"),
        mounts: [
          {
            type: "volume",
            name: VOLUME,
            source: "/var/lib/docker/volumes/original/_data",
            target: "/var/lib/database",
            rw: true,
          },
        ],
        networks: [{ name: "fixture_default", id: NETWORK }],
      },
    ],
    volume: [
      {
        id: VOLUME,
        name: VOLUME,
        project: "fixture",
        native: "",
        storage: "data",
        createdAt: CREATED,
        driver: "local",
        scope: "local",
        mountpoint: "/var/lib/docker/volumes/original/_data",
        options: null,
      },
    ],
    network: [
      {
        id: NETWORK,
        name: "fixture_default",
        project: "fixture",
        native: "",
        logical: "default",
        createdAt: CREATED,
        driver: "bridge",
        scope: "local",
        internal: false,
        containers: [ID],
      },
    ],
  };
  await writeFile(
    join(root, "docker"),
    `#!${process.execPath}
import {appendFileSync, readFileSync, writeFileSync} from "node:fs";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
const fixture = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const [kind, action] = args;
if (kind === 'container' && ['start','restart','stop'].includes(action)) {
 if (!args.slice(2).length || args.slice(2).some(id => !fixture.container.some(container => container.id === id))) { writeFileSync(root + '/mutation','unverified effect');process.exit(99); }
 fixture.running = action !== 'stop'; writeFileSync(root+'/fixture.json',JSON.stringify(fixture));process.exit(fixture.mutationFailure ? 7 : 0);
}
if (kind === 'container' && ['exec','logs'].includes(action)) { process.exit(0); }
if (kind === "compose") { for (const container of fixture.container) console.log(container.service + ' ' + 'd'.repeat(64)); process.exit(0); }
if (!(kind === "info" && action === "--format") && (!['container','volume','network'].includes(kind) || !['ls','inspect'].includes(action) || !args.includes('--format'))) {writeFileSync(root + "/mutation", "unauthorized command");process.exit(99);}
if (fixture.mode === "fail") {console.error(${JSON.stringify(CANARY)});process.exit(29);}
if (fixture.mode === "malformed") {console.log(${JSON.stringify(CANARY)});process.exit(0);}
if (fixture.mode === "hang") {writeFileSync(root + "/started", String(process.pid));await Bun.sleep(60_000);}
if (fixture.mode === "overflow") {await Bun.write(Bun.stdout, "x".repeat(9 * 1024 * 1024));process.exit(0);}
if (fixture.mode === "stderr-overflow") {await Bun.write(Bun.stderr, "x".repeat(17 * 1024));process.exit(0);}
if (kind === "info") {console.log(JSON.stringify({id: fixture.engine, os: "linux"}));}
else if (action === "ls") {for (const row of fixture[kind]) console.log(JSON.stringify({id: row.id, name: kind === 'container' ? row.name.slice(1) : row.name, project: row.project ?? ""}));}
else {
 const id = args.at(-1);const rows = fixture[kind].filter(row => row.id === id);
 if (!rows.length) process.exit(1);
 if (kind === "container" && args.join().includes('config-hash')) { console.log(JSON.stringify({id,hash:fixture.configHash ?? 'd'.repeat(64)})); process.exit(0); }
 if (kind === "container" && args.join().includes('.State.Running')) { const running=fixture.states?.[id] ?? fixture.running ?? false;console.log(JSON.stringify({id,running,paused:false,status:running ? 'running' : 'exited'})); process.exit(0); }
 for (const row of rows) console.log(JSON.stringify(row));
}
if (fixture.mode === "replace-volume" && kind === "volume" && action === "inspect") {fixture.volume[0].createdAt = '2026-02-02T01:02:03Z';delete fixture.mode;writeFileSync(root + '/fixture.json',JSON.stringify(fixture));}
if (fixture.mode === "source-change" && kind === "info") {appendFileSync(${JSON.stringify(join(projectRoot, ".hack/docker-compose.yml"))}, '\\n');}
if (fixture.mode === "inventory-change" && kind === "container" && action === "ls") {fixture.container.push({...fixture.container[0],id:'c'.repeat(64),name:'/fixture-db-2'});delete fixture.mode;writeFileSync(root+'/fixture.json',JSON.stringify(fixture));}
`
  );
  await chmod(join(root, "docker"), 0o700);
  process.env.PATH = root;
  await mkdir(join(projectRoot, ".git"));
  await save();
});
afterEach(async () => {
  restoreEnv("PATH", priorPath);
  await rm(root, { recursive: true, force: true });
});
async function save() {
  await writeFile(join(root, "fixture.json"), JSON.stringify(fixture));
}
function container() {
  const row = fixture.container[0];
  if (!row) {
    throw new Error("fixture missing");
  }
  return row;
}
function volume() {
  const row = fixture.volume[0];
  if (!row) {
    throw new Error("fixture missing");
  }
  return row;
}
function network() {
  const row = fixture.network[0];
  if (!row) {
    throw new Error("fixture missing");
  }
  return row;
}

async function compiler(body = "") {
  const binary = join(root, "compiler");
  await writeFile(
    binary,
    `#!${process.execPath}
if(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify({ transport_version: 1, authored_version: 1, plan_version: 1 }))})}
else { const raw=await Bun.stdin.text(); await Bun.write(${JSON.stringify(join(root, "candidate-received"))},raw); ${body}; console.log(${JSON.stringify(JSON.stringify({ transport_version: 1, ok: true, plan: { plan_version: 1 }, semantic_hash: "a".repeat(64) }))}); }
`
  );
  await chmod(binary, 0o700);
  return binary;
}

function stateRoot() {
  return join(projectRoot, ".hack/.internal/legacy-compose-adoption-v1");
}
async function prepared() {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary: await compiler() });
    return { store, generation };
  } catch (error: unknown) {
    await store.close();
    throw error;
  }
}
async function artifactPath(name: string) {
  const receipt = JSON.parse(
    await readFile(join(stateRoot(), "receipt.json"), "utf8")
  );
  return join(stateRoot(), "generations", receipt.prepared.id, name);
}
async function refusal(pending: Promise<unknown>, code?: string) {
  try {
    await pending;
    throw new Error("unexpected adoption success");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LegacyComposeAdoptedGenerationError);
    if (code) {
      expect(error).toMatchObject({ code });
    }
    for (const value of [CANARY, projectRoot, VOLUME, ID, NETWORK]) {
      expect(String(error)).not.toContain(value);
      expect(JSON.stringify(error)).not.toContain(value);
    }
  }
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
}

test("preparation durably binds original sources and resources without active publication or native labels", async () => {
  const originalConfig = await readFile(
    join(projectRoot, ".hack/hack.config.json"),
    "utf8"
  );
  const originalCompose = await readFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  const { store, generation } = await prepared();
  try {
    expect(generation.report).toEqual({
      adoption_generation_version: 1,
      owner: "legacy-compose",
      status: "prepared",
      containers: 1,
      volumes: 1,
    });
    expect(JSON.stringify(store)).toBe("{}");
    expect(Object.isFrozen(generation.report)).toBe(true);
    for (const text of [
      JSON.stringify(generation),
      JSON.stringify({ ...generation }),
    ]) {
      for (const value of [
        CANARY,
        VOLUME,
        ID,
        NETWORK,
        projectRoot,
        "hash",
        "revision",
        "generationId",
      ]) {
        expect(text).not.toContain(value);
      }
    }
    await store.withLease({
      generation,
      run: async (input) => {
        expect(input.configText).toBe(originalConfig);
        expect(input.composeText).toBe(originalCompose);
        expect(input.binding.volumes).toEqual([
          {
            storage: "data",
            name: VOLUME,
            createdAt: CREATED,
            mountpoint: "/var/lib/docker/volumes/original/_data",
          },
        ]);
        expect(JSON.stringify(input)).toBe("{}");
        expect(Object.isFrozen(input.binding.volumes)).toBe(true);
        expect(JSON.parse(input.candidateText).services.db.mounts).toEqual([
          {
            storage: "data",
            target: "/var/lib/database",
            access: "read-write",
          },
        ]);
      },
    });
    expect(
      await readFile(join(projectRoot, ".hack/hack.config.json"), "utf8")
    ).toBe(originalConfig);
    expect(
      await readFile(join(projectRoot, ".hack/docker-compose.yml"), "utf8")
    ).toBe(originalCompose);
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(projectRoot, ".hack/.internal/native-compose")
      ).exists()
    ).toBe(false);
    const receipt = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(Object.keys(receipt)).toEqual([
      "adoption_receipt_version",
      "kind",
      "checkout",
      "prepared",
      "publication",
      "pendingOperation",
    ]);
    expect(receipt.kind).toBe("legacy-compose-adopted");
    expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
  } finally {
    await store.close();
  }
});

test("saved lease uses anchored originals without decoding current authored inputs or reading keys", async () => {
  const first = await prepared();
  await first.store.close();
  await rm(join(projectRoot, ".hack/hack.config.json"));
  await rm(join(projectRoot, ".hack/docker-compose.yml"));
  await writeFile(
    join(projectRoot, ".hack/hack.project.json"),
    "malformed-private-current-input"
  );
  await writeFile(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    "malformed-private-env: ["
  );
  await symlink(
    join(root, "missing-private-key"),
    join(projectRoot, ".hack/hack.env.key")
  );
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot,
    mode: "saved",
  });
  try {
    const generation = await store.loadPrepared();
    expect(generation).not.toBeNull();
    if (!generation) {
      throw new Error("missing fixture generation");
    }
    await store.withLease({
      generation,
      run: async (input) => {
        expect(input.binding.volumes[0]?.name).toBe(VOLUME);
        expect(input.composeText).toContain(CANARY);
      },
    });
    await refusal(store.prepare({ binary: await compiler() }));
  } finally {
    await store.close();
  }
});

for (const changed of [
  "volume missing",
  "volume replacement",
  "container replacement",
  "network replacement",
  "engine replacement",
  "foreign volume",
  "conflicting native label",
] as const) {
  test(`saved original ownership refuses ${changed} before a lease callback`, async () => {
    const { store, generation } = await prepared();
    try {
      if (changed === "volume missing") {
        fixture.volume = [];
      }
      if (changed === "volume replacement") {
        volume().createdAt = "2026-02-02T01:02:03Z";
      }
      if (changed === "container replacement") {
        container().id = "c".repeat(64);
      }
      if (changed === "network replacement") {
        network().id = "c".repeat(64);
      }
      if (changed === "engine replacement") {
        fixture.engine = "different-engine";
      }
      if (changed === "foreign volume") {
        volume().project = "foreign";
      }
      if (changed === "conflicting native label") {
        volume().native = "1";
      }
      await save();
      let calls = 0;
      await refusal(
        store.withLease({
          generation,
          run: async () => {
            calls++;
          },
        })
      );
      expect(calls).toBe(0);
    } finally {
      await store.close();
    }
  });
}

for (const changed of [
  "content",
  "symlink",
  "hardlink",
  "permissions",
  "replacement",
] as const) {
  test(`saved immutable candidate ${changed} refuses before a callback`, async () => {
    const { store, generation } = await prepared();
    try {
      const path = await artifactPath("candidate.json");
      const original = await readFile(path);
      if (changed === "content") {
        await writeFile(path, `${original.toString()} `);
      }
      if (changed === "permissions") {
        await chmod(path, 0o644);
      }
      if (changed === "hardlink") {
        await link(path, join(root, "extra-candidate-link"));
      }
      if (changed === "symlink") {
        await rename(path, join(root, "candidate-original"));
        await symlink(join(root, "candidate-original"), path);
      }
      if (changed === "replacement") {
        await rename(path, join(root, "candidate-original"));
        await writeFile(path, original, { mode: 0o600 });
      }
      let calls = 0;
      await refusal(
        store.withLease({
          generation,
          run: async () => {
            calls++;
          },
        })
      );
      expect(calls).toBe(0);
    } finally {
      await store.close();
    }
  });
}

test("source change during compiler admission cannot commit a prepared generation", async () => {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  const source = join(projectRoot, ".hack/docker-compose.yml");
  try {
    const binary = await compiler(
      `await Bun.write(${JSON.stringify(source)}, raw + "\\n");`
    );
    await refusal(store.prepare({ binary }));
    expect(await store.loadPrepared()).toBeNull();
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
    ).toBe(false);
  } finally {
    await store.close();
  }
});

test("compiler refusal cannot commit a partially converted candidate", async () => {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const binary = await compiler(
      "console.error('synthetic-private-adoption-canary');process.exit(27);"
    );
    await refusal(store.prepare({ binary }));
    expect(await store.loadPrepared()).toBeNull();
  } finally {
    await store.close();
  }
});

test("saved receipt and duplicate fields remain strict and bound to this checkout", async () => {
  const { store } = await prepared();
  try {
    const path = join(stateRoot(), "receipt.json");
    const original = await readFile(path, "utf8");
    await writeFile(
      path,
      original.replace(
        '"adoption_receipt_version":1',
        '"adoption_receipt_version":9,"adoption_receipt_version":1'
      )
    );
    await refusal(store.loadPrepared());
  } finally {
    await store.close();
  }
});

test("leased original data refuses replacement after the callback without changing engine resources", async () => {
  const { store, generation } = await prepared();
  try {
    let calls = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
          volume().createdAt = "2026-02-02T01:02:03Z";
          await save();
        },
      }),
      "E_LEGACY_ADOPTION_CHANGED"
    );
    expect(calls).toBe(1);
  } finally {
    await store.close();
  }
});

test("forged and superseded public claims grant no private lease", async () => {
  const { store, generation } = await prepared();
  try {
    let calls = 0;
    await refusal(
      store.withLease({
        generation: { ...generation },
        run: async () => {
          calls++;
        },
      })
    );
    const newer = await store.prepare({ binary: await compiler() });
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
        },
      })
    );
    await store.withLease({
      generation: newer,
      run: async () => {
        calls++;
      },
    });
    expect(calls).toBe(1);
  } finally {
    await store.close();
  }
});

test("saved open with no state creates no private adoption paths", async () => {
  await refusal(
    openLegacyComposeAdoptedGenerationStore({ projectRoot, mode: "saved" })
  );
  expect(await Bun.file(stateRoot()).exists()).toBe(false);
});

test("original cancellation and immutable caller options protect later store use", async () => {
  const controller = new AbortController();
  const opts = { projectRoot, signal: controller.signal };
  const store = await openLegacyComposeAdoptedGenerationStore(opts);
  opts.projectRoot = join(root, "wrong-private-root");
  try {
    expect(await store.loadPrepared()).toBeNull();
    controller.abort(CANARY);
    await refusal(
      store.prepare({ binary: await compiler() }),
      "E_LEGACY_ADOPTION_CANCELLED"
    );
  } finally {
    await store.close();
  }
});

async function readReceipt() {
  return JSON.parse(await readFile(join(stateRoot(), "receipt.json"), "utf8"));
}
async function writeReceipt(value: unknown) {
  await writeFile(join(stateRoot(), "receipt.json"), JSON.stringify(value), {
    mode: 0o600,
  });
}
async function originalSnapshots() {
  return Promise.all(
    ["hack.config.json", "docker-compose.yml"].map(async (name) => {
      const path = join(projectRoot, ".hack", name);
      return {
        name,
        text: await readFile(path, "utf8"),
        info: await lstat(path),
      };
    })
  );
}
async function expectOriginals(
  originals: Awaited<ReturnType<typeof originalSnapshots>>
) {
  for (const original of originals) {
    const path = join(projectRoot, ".hack", original.name);
    expect(await readFile(path, "utf8")).toBe(original.text);
    const info = await lstat(path);
    expect([info.dev, info.ino, info.mode, info.nlink]).toEqual([
      original.info.dev,
      original.info.ino,
      original.info.mode,
      1,
    ]);
  }
  expect(
    await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
  ).toBe(false);
}

test("explicit stopped publication and rollback preserve exact original files and resource identities", async () => {
  const original = await originalSnapshots();
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    await store.publish({ generation, binary });
    expect((await store.loadActive())?.report.status).toBe("active");
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.config.json")).exists()
    ).toBe(false);
    expect(
      await Bun.file(join(projectRoot, ".hack/docker-compose.yml")).exists()
    ).toBe(false);
    expect((await readReceipt()).publication.phase).toBe("active");
    expect(
      await readFile(join(projectRoot, ".hack/hack.project.json"), "utf8")
    ).toBe(await readFile(await artifactPath("candidate.json"), "utf8"));
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    await store.rollback();
    expect((await readReceipt()).publication.phase).toBe("rolled-back");
    await expectOriginals(original);
    expect(await store.loadActive()).toBeNull();
  } finally {
    await store.close();
  }
});

for (const boundary of [
  "journal",
  "one-original",
  "both-originals",
  "candidate-pair",
  "candidate-anchored-pair",
  "candidate-anchored-single",
] as const) {
  for (const action of ["complete", "rollback"] as const) {
    test(`repair ${action} resumes an interrupted switch at ${boundary}`, async () => {
      const original = await originalSnapshots();
      const { store } = await prepared();
      try {
        const receipt = await readReceipt(),
          originals = await artifactPath("originals");
        receipt.publication = {
          generation: receipt.prepared,
          phase: "switching",
          native: null,
        };
        await writeReceipt(receipt);
        if (boundary !== "journal") {
          await rename(
            join(projectRoot, ".hack/hack.config.json"),
            join(originals, "legacy-config.original")
          );
        }
        if (!["journal", "one-original"].includes(boundary)) {
          await rename(
            join(projectRoot, ".hack/docker-compose.yml"),
            join(originals, "legacy-compose.original")
          );
        }
        if (boundary.startsWith("candidate")) {
          const candidateText = await readFile(
              await artifactPath("candidate.json"),
              "utf8"
            ),
            staged = join(originals, "native.publish"),
            active = join(projectRoot, ".hack/hack.project.json");
          await writeFile(staged, candidateText, { mode: 0o600 });
          await link(staged, active);
          if (boundary.startsWith("candidate-anchored")) {
            const info = await lstat(active);
            receipt.publication.native = {
              dev: info.dev,
              ino: info.ino,
              hash: (await import("node:crypto"))
                .createHash("sha256")
                .update(candidateText)
                .digest("hex"),
            };
            await writeReceipt(receipt);
          }
          if (boundary === "candidate-anchored-single") {
            await rm(staged);
          }
        }
        await refusal(store.loadPrepared(), "E_LEGACY_ADOPTION_BUSY");
        await store.repairPublication({ action, binary: await compiler() });
        expect((await readReceipt()).publication.phase).toBe(
          action === "complete" ? "active" : "rolled-back"
        );
        if (action === "complete") {
          await store.rollback();
        }
        await expectOriginals(original);
      } finally {
        await store.close();
      }
    });
  }
}

test("publication refuses a running original, changed source inode and config-hash drift before selection changes", async () => {
  const original = await originalSnapshots();
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    fixture.running = true;
    await save();
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_UNSUPPORTED"
    );
    fixture.running = false;
    fixture.configHash = "e".repeat(64);
    await save();
    await refusal(store.publish({ generation, binary }));
    fixture.configHash = "d".repeat(64);
    await save();
    const path = join(projectRoot, ".hack/hack.config.json");
    await rename(path, `${path}.old`);
    await writeFile(path, original[0]?.text ?? "");
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_CHANGED"
    );
    expect((await readReceipt()).publication).toBeNull();
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
    ).toBe(false);
  } finally {
    await store.close();
  }
});

test("active candidate edits and rollback conflicts retain pending evidence and refuse overwriting external bytes", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: await compiler() });
    const active = join(projectRoot, ".hack/hack.project.json");
    await writeFile(active, CANARY);
    await refusal(store.loadActive());
    await refusal(store.rollback());
    expect(await readFile(active, "utf8")).toBe(CANARY);
    expect((await readReceipt()).publication.phase).toBe("active");
  } finally {
    await store.close();
  }
});

test("dry-run reports storage provenance and existing counts without state, source values or engine effects", async () => {
  const report = await previewLegacyComposeAdoption({
    projectRoot,
    binary: await compiler(),
  });
  expect(report.complete).toBe(true);
  expect(report).toMatchObject({
    containers: 1,
    volumes: 1,
    adoption: "not_performed",
  });
  expect(
    report.fields.some((field) => field.pointer === "/volumes/data/name")
  ).toBe(true);
  for (const value of [
    CANARY,
    VOLUME,
    ID,
    NETWORK,
    projectRoot,
    "hash",
    "revision",
  ]) {
    expect(JSON.stringify(report)).not.toContain(value);
  }
  expect(await Bun.file(stateRoot()).exists()).toBe(false);
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
});

test("CLI adoption refuses other backends before probes, preparation or engine effects", async () => {
  for (const flags of [[], ["--dry-run"], ["--stop"], ["--recover"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../index.ts"),
        "config",
        "adopt",
        "--path",
        projectRoot,
        ...flags,
      ],
      {
        env: {
          ...process.env,
          HACK_RUNTIME_BACKEND: "native",
          HACK_HOME: join(root, "isolated-home"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("Compose backend");
    expect(stdout + stderr).not.toContain(CANARY);
    expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
    expect(await Bun.file(stateRoot()).exists()).toBe(false);
  }
});

test("upgraded discovery refuses an interrupted switch before ancestor selection or legacy writes", async () => {
  const { store } = await prepared();
  try {
    const receipt = await readReceipt();
    receipt.publication = {
      generation: receipt.prepared,
      phase: "switching",
      native: null,
    };
    await writeReceipt(receipt);
    await rename(
      join(projectRoot, ".hack/hack.config.json"),
      await artifactPath("originals/legacy-config.original")
    );
    const nested = join(projectRoot, "nested");
    await mkdir(nested);
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "pending"
    );
    await expect(discoverProjectInputs({ startDir: nested })).rejects.toThrow(
      "interrupted"
    );
    await expect(
      assertLegacyProjectInputFamily({ projectRoot })
    ).rejects.toThrow("interrupted");
    expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
  } finally {
    await store.close();
  }
});

test("failed retained-container effects stay pending and only explicit verified stop recovery clears them", async () => {
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    await store.publish({ generation, binary });
    const code = await store.withMutation({
      generation,
      binary,
      operation: "start",
      services: [],
      run: async () => {
        expect((await readReceipt()).pendingOperation).toMatchObject({
          operation: "start",
          services: ["db"],
        });
        fixture.running = true;
        await save();
        return 7;
      },
    });
    expect(code).toBe(7);
    await refusal(store.loadActive(), "E_LEGACY_ADOPTION_BUSY");
    await refusal(store.rollback(), "E_LEGACY_ADOPTION_BUSY");
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "pending"
    );
    const recovery = await store.loadActive({ recoverOperation: true });
    if (!recovery) {
      throw new Error("missing recovery claim");
    }
    await refusal(
      store.withMutation({
        generation: recovery,
        binary,
        operation: "start",
        services: [],
        recover: true,
        run: async () => 0,
      })
    );
    await store.withMutation({
      generation: recovery,
      binary,
      operation: "stop",
      services: [],
      recover: true,
      run: async () => {
        fixture.running = false;
        await save();
        return 0;
      },
    });
    expect((await readReceipt()).pendingOperation).toBeNull();
    await store.rollback();
  } finally {
    await store.close();
  }
});

test("post-effect resource loss cannot acknowledge success or enable automatic replay", async () => {
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    await store.publish({ generation, binary });
    await refusal(
      store.withMutation({
        generation,
        binary,
        operation: "start",
        services: ["db"],
        run: async () => {
          fixture.running = true;
          fixture.volume = [];
          await save();
          return 0;
        },
      })
    );
    expect((await readReceipt()).pendingOperation.operation).toBe("start");
    await refusal(store.loadActive());
  } finally {
    await store.close();
  }
});

test("retained command dispatch uses only original IDs and keeps anchors through stop and recovery", async () => {
  const original = await originalSnapshots(),
    { store, generation } = await prepared();
  const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
  try {
    const binary = await compiler();
    process.env.HACK_CONFIG_COMPILER_BINARY = binary;
    await store.publish({ generation, binary });
    const options = {
      cwd: projectRoot,
      operation: "up" as const,
      detach: true,
    };
    expect(await tryLegacyComposeAdoptedCommand(options)).toBe(0);
    expect(
      JSON.parse(await readFile(join(root, "fixture.json"), "utf8")).running
    ).toBe(true);
    expect(
      await tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "exec",
        service: "db",
        command: ["true"],
      })
    ).toBe(0);
    await expect(
      tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "run",
        service: "db",
        command: ["true"],
      })
    ).rejects.toThrow("Recreation");
    expect(
      await tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "down",
      })
    ).toBe(0);
    fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    fixture.mutationFailure = true;
    await save();
    expect(await tryLegacyComposeAdoptedCommand(options)).toBe(7);
    await expect(tryLegacyComposeAdoptedCommand(options)).rejects.toThrow(
      "busy"
    );
    fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
    fixture.mutationFailure = undefined;
    await save();
    expect(
      await tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "down",
        recover: true,
      })
    ).toBe(0);
    await store.rollback();
    await expectOriginals(original);
    const commands = (await readFile(join(root, "commands"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      commands
        .filter((args) => ["start", "stop", "restart"].includes(args[1]))
        .every((args) => args.join(" ").endsWith(ID))
    ).toBe(true);
    expect(
      commands.some(
        (args) =>
          args.includes("rm") ||
          args.includes("up") ||
          args.includes("down") ||
          args.includes("create")
      )
    ).toBe(false);
  } finally {
    restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
    await store.close();
  }
});

test("receipt changes during compile cannot overwrite a newer owner decision", async () => {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const body = `const receiptFile=${JSON.stringify(join(stateRoot(), "receipt.json"))}; const owner=JSON.parse(await Bun.file(receiptFile).text()); await Bun.write(receiptFile, JSON.stringify(owner)+' ');`;
    await refusal(store.prepare({ binary: await compiler(body) }));
    expect((await readReceipt()).prepared).toBeNull();
  } finally {
    await store.close();
  }
});

test("explicit preparation stop journals before effect and running dry-run needs the stop request", async () => {
  fixture.running = true;
  await save();
  const binary = await compiler();
  expect(
    (await previewLegacyComposeAdoption({ projectRoot, binary })).complete
  ).toBe(false);
  expect(
    await previewLegacyComposeAdoption({ projectRoot, binary, stop: true })
  ).toMatchObject({
    complete: true,
    stop: "requested",
    adoption: "not_performed",
  });
  expect(await Bun.file(stateRoot()).exists()).toBe(false);
  const { store, generation } = await prepared();
  try {
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_UNSUPPORTED"
    );
    let calls = 0;
    await store.withPreparationStop({
      generation,
      binary,
      run: async (input) => {
        expect(
          input.binding.containers.map((container) => container.id)
        ).toEqual([ID]);
        expect((await readReceipt()).pendingOperation).toMatchObject({
          operation: "stop",
          services: ["db"],
        });
        expect(
          await inspectLegacyComposeAdoptionSelection({ projectRoot })
        ).toBe("pending");
        calls++;
        fixture.running = false;
        await save();
        return 0;
      },
    });
    expect(calls).toBe(1);
    expect((await readReceipt()).pendingOperation).toBeNull();
    await store.publish({ generation, binary });
    await store.rollback();
  } finally {
    await store.close();
  }
});

test("partial preparation stop retains originals and only explicit all-container recovery enables adoption", async () => {
  const second = "c".repeat(64),
    originalCompose = join(projectRoot, ".hack/docker-compose.yml");
  const text = await readFile(originalCompose, "utf8"),
    insert = text.lastIndexOf("volumes:\n  data:");
  await writeFile(
    originalCompose,
    `${text.slice(0, insert)}  worker:\n    image: ${CANARY}\n    volumes:\n      - data:/var/lib/database\n${text.slice(insert)}`
  );
  fixture.container.push({
    ...container(),
    id: second,
    name: "/fixture-worker-1",
    service: "worker",
  });
  network().containers = [ID, second];
  fixture.states = { [ID]: true, [second]: true };
  await save();
  const original = await originalSnapshots(),
    { store, generation } = await prepared();
  try {
    const binary = await compiler();
    expect(
      await store.withPreparationStop({
        generation,
        binary,
        run: async () => {
          fixture.states = { [ID]: false, [second]: true };
          await save();
          return 7;
        },
      })
    ).toBe(7);
    await refusal(store.loadPrepared(), "E_LEGACY_ADOPTION_BUSY");
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_BUSY"
    );
    await expectOriginals(original);
    const recovered = await store.loadPrepared({ recoverOperation: true });
    if (!recovered) {
      throw new Error("missing stopped recovery generation");
    }
    await store.withPreparationStop({
      generation: recovered,
      binary,
      recover: true,
      run: async (input) => {
        expect(
          input.binding.containers.map((container) => container.id).sort()
        ).toEqual([ID, second]);
        fixture.states = { [ID]: false, [second]: false };
        await save();
        return 0;
      },
    });
    expect((await readReceipt()).pendingOperation).toBeNull();
    await store.publish({ generation: recovered, binary });
    await store.rollback();
    await expectOriginals(original);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("preparation stop refuses changed source, forged claims and config drift before callback", async () => {
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    let calls = 0;
    const run = async () => {
      calls++;
      return await Promise.resolve(0);
    };
    await refusal(
      store.withPreparationStop({ generation: { ...generation }, binary, run })
    );
    fixture.configHash = "e".repeat(64);
    await save();
    await refusal(store.withPreparationStop({ generation, binary, run }));
    fixture.configHash = "d".repeat(64);
    await save();
    await writeFile(
      join(projectRoot, ".hack/hack.config.json"),
      '{"name":"changed-private"}'
    );
    await refusal(
      store.withPreparationStop({ generation, binary, run }),
      "E_LEGACY_ADOPTION_CHANGED"
    );
    expect(calls).toBe(0);
    expect((await readReceipt()).pendingOperation).toBeNull();
  } finally {
    await store.close();
  }
});
