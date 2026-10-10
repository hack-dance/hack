import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireNativeComposeFileSources,
  closeNativeComposeFileSources,
} from "../src/lib/native-compose-file-sources.ts";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import {
  VM_FIXTURE_BYTES,
  VM_FIXTURE_GUEST,
  VM_FIXTURE_OTHER,
  VM_FIXTURE_TARGETS,
} from "./e2e/native-vm-file-guest.ts";
import {
  captureCompletedJobFixtureCommand,
  createCompletedJobFixtureSettlement,
} from "./e2e/scenarios/native-compose-adoption-job-worktrees.ts";
import {
  nativeVmFileFixtureSource,
  nativeVmFixtureObserverMatched,
  observeNativeVmFileFixture,
} from "./e2e/scenarios/native-config-vm-files.ts";
import {
  cleanupVmFileFixtures,
  vmFileFixture,
} from "./helpers/native-compose-vm-files.ts";

afterEach(cleanupVmFileFixtures);

const ownerObservation = {
  stopped: false,
  pending: null,
  containers: [{ id: "a".repeat(64), service: "reader", state: "running" }],
  networks: 1,
  volumes: 0,
};
test.each([
  "capture",
  "nonzero",
  "decode",
  "row",
  "timeout",
] as const)("whole-owner %s failure permanently vetoes fixture teardown", async (kind) => {
  const settlement = createCompletedJobFixtureSettlement();
  const failure = new Error("Synthetic captured-owner refusal");
  let retained = 0,
    commands = 0;
  const result = observeNativeVmFileFixture({
    root: "/synthetic/owned-fixture",
    command: async () => {
      commands++;
      if (kind === "capture") {
        throw failure;
      }
      return {
        command: "synthetic whole-owner observation",
        exitCode: kind === "nonzero" ? 1 : 0,
        stdout:
          kind === "decode"
            ? "{"
            : JSON.stringify(
                kind === "row"
                  ? { ...ownerObservation, containers: [{ id: "foreign" }] }
                  : ownerObservation
              ),
        stderr: "",
        combined: "",
        timedOut: kind === "timeout",
        durationMs: 0,
      };
    },
    markUnconfirmed: settlement.markUnconfirmed,
    retain: () => {
      retained++;
    },
  });
  if (kind === "capture") {
    await expect(result).rejects.toBe(failure);
  } else {
    await expect(result).rejects.toThrow();
  }
  expect(commands).toBe(1);
  expect(retained).toBe(1);
  expect(() => settlement.assertConfirmed()).toThrow();
});
test("successful captured whole-owner facts retain the existing settlement admission", async () => {
  const settlement = createCompletedJobFixtureSettlement();
  const result = await observeNativeVmFileFixture({
    root: "/synthetic/owned-fixture",
    command: async (argv, cwd, timeout) => {
      expect(argv.slice(0, 3)).toEqual([
        process.execPath,
        "--no-env-file",
        "-e",
      ]);
      expect(argv[3]).toContain("observeNativeComposeFixture");
      expect(cwd).toBe("/synthetic/owned-fixture");
      expect(timeout).toBe(30_000);
      return {
        command: "synthetic whole-owner observation",
        exitCode: 0,
        stdout: JSON.stringify(ownerObservation),
        stderr: "",
        combined: "",
        timedOut: false,
        durationMs: 0,
      };
    },
    markUnconfirmed: settlement.markUnconfirmed,
    retain: () => {
      throw new Error("Must not retain a successful observation");
    },
  });
  expect(result).toEqual(ownerObservation);
  expect(() => settlement.assertConfirmed()).not.toThrow();
});

test("observer identity comparison permits only mount ordering, never fields/multiplicity/state drift", () => {
  const expected = {
    id: "a".repeat(64),
    name: "/owned-observer",
    readonly: true,
    mounts: [
      {
        Type: "volume",
        Name: "owned",
        Source: "/volume",
        Destination: "/material",
        RW: false,
      },
      {
        Type: "bind",
        Source: "/volume/member",
        Destination: "/projection/member",
        RW: false,
      },
    ],
  };
  const actual = {
    ...expected,
    running: true,
    status: "running",
    exitCode: 0,
    restarts: 0,
    execs: null,
    mounts: [...expected.mounts].reverse(),
  };
  expect(nativeVmFixtureObserverMatched(actual, expected)).toBe(true);
  for (const changed of [
    { ...actual, id: "b".repeat(64) },
    { ...actual, readonly: false },
    { ...actual, running: false },
    { ...actual, execs: ["a".repeat(64)] },
    { ...actual, mounts: [expected.mounts[0], expected.mounts[0]] },
    { ...actual, mounts: expected.mounts.map((row) => ({ ...row, RW: true })) },
    { ...actual, extra: "unauthored" },
  ]) {
    expect(nativeVmFixtureObserverMatched(changed, expected)).toBe(false);
  }
});

test("maintained ordinary VM fixture reaches authoritative compiler/file grant acquisition without engine or implicit grants", async () => {
  const fixture = await vmFileFixture();
  for (const name of ["owner.bin", "private.bin", "unused.bin"]) {
    await writeFile(join(fixture.checkout, name), VM_FIXTURE_BYTES, {
      mode: 0o600,
    });
  }
  await writeFile(
    join(fixture.checkout, ".hack/hack.project.json"),
    JSON.stringify(
      nativeVmFileFixtureSource({
        name: "vmfiles",
        image: "synthetic/reader:1",
      })
    )
  );
  const store = await openNativeComposeGenerationStore({
    projectRoot: fixture.checkout,
    instance: null,
  });
  try {
    await store.withMutation(async (mutation) => {
      const sources = await acquireNativeComposeFileSources({
        authority: mutation.materialAuthority,
        reservation: mutation.reserveGeneration(),
      });
      try {
        expect(sources.result.file_plan?.complete).toBe(true);
        expect(sources.result.file_plan?.workloads.reader).toHaveLength(2);
        expect(sources.result.file_plan?.workloads.reader).toEqual([
          expect.objectContaining({
            target: VM_FIXTURE_TARGETS[0],
            mode: "0400",
          }),
          expect.objectContaining({
            target: VM_FIXTURE_TARGETS[1],
            mode: "0600",
            uid: 10_001,
            gid: 10_002,
          }),
        ]);
        expect(sources.result.file_plan?.workloads.ungranted ?? []).toEqual([]);
        expect(JSON.stringify(sources)).not.toContain(
          VM_FIXTURE_BYTES.toString()
        );
        expect(fixture.requests()).toBe(0);
        expect(await fixture.commands().catch(() => [])).toEqual([]);
      } finally {
        await closeNativeComposeFileSources(sources);
      }
    });
  } finally {
    await store.close();
  }
});

const digest = new Bun.CryptoHasher("sha256")
  .update(VM_FIXTURE_BYTES)
  .digest("hex");
const rows = VM_FIXTURE_TARGETS.map((target, index) => ({
  target,
  digest,
  file: {
    dev: "1",
    ino: String(index + 2),
    ctime: "3",
    size: VM_FIXTURE_BYTES.length,
    mode: index === 0 ? 0o400 : 0o600,
    uid: index === 0 ? 0 : 10_001,
    gid: index === 0 ? 0 : 10_002,
  },
}));
const cases = [
  {
    name: "default owner read",
    kind: "owner",
    uid: 0,
    gid: 0,
    expected: 0,
    reads: 1,
  },
  {
    name: "explicit owner read",
    kind: "owner",
    uid: 10_001,
    gid: 10_002,
    expected: 0,
    reads: 1,
  },
  {
    name: "nonowner EACCES",
    kind: "denied",
    uid: VM_FIXTURE_OTHER,
    gid: VM_FIXTURE_OTHER,
    expected: 0,
    reads: 2,
  },
  {
    name: "nonowner success refuses",
    kind: "denied",
    uid: VM_FIXTURE_OTHER,
    gid: VM_FIXTURE_OTHER,
    allowRead: true,
    expected: 74,
    guard: "nonowner-read",
    reads: 1,
  },
  {
    name: "unknown read error refuses",
    kind: "denied",
    uid: VM_FIXTURE_OTHER,
    gid: VM_FIXTURE_OTHER,
    readError: "EIO",
    expected: 74,
    guard: "nonowner-error",
    reads: 1,
  },
  {
    name: "privileged EROFS",
    kind: "readonly",
    uid: 0,
    gid: 0,
    expected: 0,
    reads: 0,
  },
  {
    name: "writable mount refuses",
    kind: "readonly",
    uid: 0,
    gid: 0,
    writable: true,
    expected: 74,
    guard: "write-open",
    reads: 0,
  },
  {
    name: "identity mismatch stops before read",
    kind: "owner",
    uid: 0,
    gid: 0,
    wrongIdentity: true,
    expected: 74,
    guard: "identity",
    reads: 0,
  },
  {
    name: "ungranted absence",
    kind: "ungranted",
    uid: 0,
    gid: 0,
    expected: 0,
    reads: 0,
  },
  {
    name: "implicit grant refuses",
    kind: "ungranted",
    uid: 0,
    gid: 0,
    present: true,
    expected: 74,
    guard: "implicit-grant",
    reads: 0,
  },
] as const;
test.each([
  ...cases,
])("emitted VM app guest control: $name", async (control) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vm-app-guest-")));
  const settlement = createCompletedJobFixtureSettlement();
  try {
    const observations = join(root, "observations.json"),
      module = join(root, "fs.ts");
    await writeFile(
      module,
      `import {writeFileSync} from "node:fs";
const rows=${JSON.stringify(rows)},control=${JSON.stringify(control)};let reads=0;
process.on("exit",()=>writeFileSync(${JSON.stringify(observations)},JSON.stringify({reads})));
function error(code){return Object.assign(new Error("Synthetic guest refusal"),{code});}
export async function lstat(path){const row=rows.find(r=>r.target===path);if(!row)throw error("EIO");if(control.kind==="ungranted"&&!control.present)throw error("ENOENT");const s=row.file;return{isFile:()=>true,isSymbolicLink:()=>false,nlink:1n,dev:BigInt(s.dev),ino:BigInt(control.wrongIdentity?"99":s.ino),ctimeNs:BigInt(s.ctime),size:BigInt(s.size),mode:BigInt(s.mode),uid:BigInt(s.uid),gid:BigInt(s.gid)}}
export async function readFile(){reads++;if(control.kind==="denied"&&!control.allowRead)throw error(control.readError??"EACCES");return Buffer.from(${JSON.stringify(Array.from(VM_FIXTURE_BYTES))});}
export async function open(){if(!control.writable)throw error("EROFS");return{close:async()=>{}};}
export async function readdir(){return rows.map(r=>r.target.split("/").at(-1));}
`,
      { mode: 0o600 }
    );
    const needle = 'from "node:fs/promises";';
    expect(VM_FIXTURE_GUEST.split(needle)).toHaveLength(2);
    const guest = VM_FIXTURE_GUEST.replace(
      needle,
      `from ${JSON.stringify(module)};`
    );
    expect(guest.replace(`from ${JSON.stringify(module)};`, needle)).toBe(
      VM_FIXTURE_GUEST
    );
    const program = `Object.defineProperties(process,{getuid:{value:()=>${control.uid}},getgid:{value:()=>${control.gid}}});\n${guest}`;
    const result = await captureCompletedJobFixtureCommand({
      argv: [
        process.execPath,
        "--no-env-file",
        "-e",
        program,
        JSON.stringify({
          kind: control.kind,
          uid: control.uid,
          gid: control.gid,
          rows,
        }),
      ],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      captures: join(root, "child"),
      timeoutMs: 5000,
      onUnconfirmed: settlement.markUnconfirmed,
    });
    settlement.assertConfirmed();
    expect(result.exitCode).toBe(control.expected);
    expect(result.stdout).toBe(
      control.expected === 0 ? `vm-file-guest-${control.kind}-passed` : ""
    );
    expect(result.stderr).toBe(
      "guard" in control
        ? JSON.stringify({ stage: "vm-file-guest", guard: control.guard })
        : ""
    );
    expect(JSON.parse(await readFile(observations, "utf8"))).toEqual({
      reads: control.reads,
    });
    expect(result.combined).not.toContain(VM_FIXTURE_BYTES.toString());
  } finally {
    settlement.assertConfirmed();
    await rm(root, { recursive: true, force: true });
  }
});
