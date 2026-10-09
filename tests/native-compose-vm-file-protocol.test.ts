import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeComposeVmFileClient } from "../src/lib/native-compose-vm-file-client.ts";
import {
  parseVmFileFacts,
  parseVmFileJournal,
  resolveVmFileOwnership,
  VM_FILE_ACCESS_PROGRAM,
  VM_FILE_VERIFY_PROGRAM,
  type VmFileFacts,
  vmFileJournalReady,
} from "../src/lib/native-compose-vm-file-protocol.ts";
import {
  cleanupVmFileFixtures,
  VM_BYTES,
  VM_ENGINE,
  vmFileFixture,
} from "./helpers/native-compose-vm-files.ts";

afterEach(cleanupVmFileFixtures);

const token = "a".repeat(32),
  memberId = "b".repeat(32),
  hash = (bytes: Uint8Array | string) =>
    createHash("sha256").update(bytes).digest("hex");
function facts(): VmFileFacts {
  const identity = (ino: number, size: number, mode: number) => ({
    dev: "1",
    ino: String(ino),
    ctime: "123",
    size,
    mode,
    uid: 0,
    gid: 0,
  });
  return {
    version: 1,
    token,
    root: identity(1, 4096, 0o711),
    witness: identity(2, 32, 0o400),
    members: [
      {
        id: memberId,
        workload: "reader",
        target: "/run/secret",
        mode: "0400",
        uid: 0,
        gid: 0,
        digest: hash(VM_BYTES),
        file: identity(3, VM_BYTES.length, 0o400),
      },
    ],
  };
}
test("closed VM facts preserve protected mode and private incarnation", () => {
  const value = facts();
  expect(parseVmFileFacts(JSON.stringify(value))).toEqual(value);
  for (const changed of [
    { ...value, version: 2 },
    { ...value, extra: true },
    { ...value, members: [] },
    { ...value, members: [{ ...value.members[0], id: "../escape" }] },
    { ...value, members: [{ ...value.members[0], uid: 1 }] },
    {
      ...value,
      members: [
        {
          ...value.members[0],
          file: { ...value.members[0]?.file, mode: 0o444 },
        },
      ],
    },
    { ...value, members: [value.members[0], value.members[0]] },
  ]) {
    expect(() => parseVmFileFacts(JSON.stringify(changed))).toThrow();
  }
  expect(() => parseVmFileFacts('{"private":"not-json"')).toThrow();
});
test("ownership defaults require the exact empty pinned image USER", () => {
  expect(resolveVmFileOwnership({ imageUser: "" })).toEqual({ uid: 0, gid: 0 });
  expect(
    resolveVmFileOwnership({ imageUser: "named", uid: 1001, gid: 1002 })
  ).toEqual({ uid: 1001, gid: 1002 });
  expect(resolveVmFileOwnership({ imageUser: "", uid: 1001 })).toEqual({
    uid: 1001,
    gid: 0,
  });
  for (const input of [
    { imageUser: "named" },
    { imageUser: "1001:1002" },
    { imageUser: "named", uid: 1 },
    { imageUser: "", uid: -1, gid: 0 },
    { imageUser: "", uid: 0xff_ff_ff_ff, gid: 0 },
    { imageUser: "", uid: "0", gid: 0 },
  ]) {
    expect(() => resolveVmFileOwnership(input)).toThrow();
  }
});
const initial = [
  "volume-created",
  "writer-created",
  "writer-armed",
  "writer-complete",
  "observer-created",
  "observer-armed",
  "writer-removed",
  "observe-armed",
  "observe-complete",
  "ready",
];
const header = `${JSON.stringify({
  version: 1,
  kind: "native-compose-vm-file-journal",
  token,
  generationId: "c".repeat(32),
})}\n`;
const journal = (phases: readonly string[]) =>
  header + phases.map((phase) => `${JSON.stringify({ phase })}\n`).join("");
test("only the complete ordered proof can observe or retire; armed unknown stays unqualified", () => {
  expect(
    vmFileJournalReady(parseVmFileJournal({ text: journal(initial), header }))
  ).toBe(true);
  expect(
    vmFileJournalReady(
      parseVmFileJournal({
        text: journal([...initial, "observe-armed"]),
        header,
      })
    )
  ).toBe(false);
  expect(() =>
    parseVmFileJournal({
      text: journal([...initial, "observe-armed", "retiring"]),
      header,
    })
  ).toThrow();
  expect(
    parseVmFileJournal({
      text: journal([
        ...initial,
        "observe-armed",
        "observe-complete",
        "retiring",
        "observer-stopped",
        "observer-removed",
        "retired",
      ]),
      header,
    })
  ).toHaveLength(16);
  for (const text of [
    journal(["writer-complete"]),
    journal([...initial, "retired"]),
    journal(initial).slice(0, -1),
    journal([...initial, "unknown"]),
    `${header}{"phase":"observe-armed","extra":true}\n`,
  ]) {
    expect(() => parseVmFileJournal({ text, header })).toThrow();
  }
});

type Observation = {
  nonowner?: "EACCES" | "success" | "ENOENT";
  write?: "EROFS" | "success" | "EACCES";
  projectionUid?: number;
  wrongSelf?: boolean;
};
/** Replace only the filesystem import in the actual emitted programs. UID
 * operations are child-local observations; no host permission or material changes. */
async function emitted(
  kind: "access" | "verify",
  observation: Observation = {},
  changeInput?: (value: Record<string, unknown>) => void
) {
  const fixture = await vmFileFixture(),
    selected = facts();
  const modulePath = join(fixture.root, "observations.mjs"),
    countsPath = join(fixture.root, "counts.json");
  const accessImport = 'import { readFile } from "node:fs/promises";';
  const accessReplacement = 'import { readFile } from "./observations.mjs";';
  expect(VM_FILE_ACCESS_PROGRAM.split(accessImport)).toHaveLength(2);
  const access = VM_FILE_ACCESS_PROGRAM.replace(
    accessImport,
    accessReplacement
  );
  expect(access.replace(accessReplacement, accessImport)).toBe(
    VM_FILE_ACCESS_PROGRAM
  );
  const verifyImport =
    'import { open, lstat, readdir } from "node:fs/promises";';
  const verifyReplacement =
    'import { open, lstat, readdir } from "./observations.mjs";';
  const embedded = `const access = ${JSON.stringify(VM_FILE_ACCESS_PROGRAM)};`;
  const replacedEmbedded = `const access = ${JSON.stringify(access)};`;
  expect(VM_FILE_VERIFY_PROGRAM.split(verifyImport)).toHaveLength(2);
  expect(VM_FILE_VERIFY_PROGRAM.split(embedded)).toHaveLength(2);
  const program =
    kind === "access"
      ? access
      : VM_FILE_VERIFY_PROGRAM.replace(verifyImport, verifyReplacement).replace(
          embedded,
          replacedEmbedded
        );
  if (kind === "verify") {
    expect(
      program
        .replace(verifyReplacement, verifyImport)
        .replace(replacedEmbedded, embedded)
    ).toBe(VM_FILE_VERIFY_PROGRAM);
  }
  await writeFile(
    modulePath,
    [
      'import {writeFileSync} from "node:fs";',
      "const control=" +
        JSON.stringify(observation) +
        ",facts=" +
        JSON.stringify(selected) +
        ",bytes=Buffer.from(" +
        JSON.stringify(Array.from(VM_BYTES)) +
        ");",
      "let uid=0,gid=0,reads=0,writes=0,groups=0;",
      "Object.defineProperties(process,{setgroups:{value:()=>{groups++}},setgid:{value:value=>{gid=value}},setuid:{value:value=>{uid=value}},getuid:{value:()=>control.wrongSelf?uid+1:uid},getgid:{value:()=>gid}});",
      "process.on('exit',()=>{if(uid===0)writeFileSync(" +
        JSON.stringify(countsPath) +
        ",JSON.stringify({reads,writes,groups}))});",
      "function value(path){if(path==='/material')return facts.root;if(path==='/material/.owner')return facts.witness;if(path==='/material/'+facts.members[0].id)return facts.members[0].file;if(path==='/projection/'+facts.members[0].id)return {...facts.members[0].file,uid:control.projectionUid??0};throw new Error('Unexpected synthetic file');}",
      "function stat(path){const row=value(path);return{isFile:()=>path!=='/material',isDirectory:()=>path==='/material',isSymbolicLink:()=>false,nlink:1n,dev:BigInt(row.dev),ino:BigInt(row.ino),ctimeNs:BigInt(row.ctime),size:BigInt(row.size),mode:BigInt(row.mode),uid:BigInt(row.uid),gid:BigInt(row.gid)}}",
      "export async function lstat(path){return stat(path)}",
      "export async function readdir(path){value(path);return['.owner',facts.members[0].id]}",
      "function contents(path){value(path);return path.endsWith('/.owner')?Buffer.from(facts.token):Buffer.from(bytes)}",
      "export async function readFile(path){value(path);reads++;if(uid!==0&&control.nonowner!=='success')throw Object.assign(new Error('Synthetic refusal'),{code:control.nonowner??'EACCES'});return contents(path)}",
      "export async function open(path,flags){value(path);if((flags&3)===1){writes++;if(control.write!=='success')throw Object.assign(new Error('Synthetic refusal'),{code:control.write??'EROFS'})}return{stat:async()=>stat(path),readFile:async()=>{reads++;return contents(path)},close:async()=>{}}}",
    ].join("\n"),
    { flag: "wx", mode: 0o600 }
  );
  await writeFile(join(fixture.root, "program.mjs"), program, {
    flag: "wx",
    mode: 0o600,
  });
  const input: Record<string, unknown> =
    kind === "verify"
      ? selected
      : {
          uid: 65_534,
          gid: 65_534,
          root: "/projection",
          rows: [{ id: memberId, digest: hash(VM_BYTES), denied: true }],
        };
  changeInput?.(input);
  const client = createNativeComposeVmFileClient({
    engineId: VM_ENGINE,
    signal: new AbortController().signal,
    deadline: Date.now() + 5000,
    assertFresh: async () => {},
  });
  let passed = false;
  try {
    await client.call(
      ["synthetic-program", join(fixture.root, "program.mjs")],
      Buffer.from(JSON.stringify(input))
    );
    passed = true;
  } catch {
    passed = false;
  }
  const counts = (await Bun.file(countsPath).exists())
    ? (JSON.parse(await readFile(countsPath, "utf8")) as unknown)
    : null;
  return { passed, counts, commands: await fixture.commands() };
}
test("actual emitted VM verification proves owner read, distinct-UID EACCES and root EROFS", async () => {
  const result = await emitted("verify");
  expect(result.passed).toBe(true);
  expect(result.counts).toMatchObject({ writes: 1 });
});
test.each([
  "success",
  "ENOENT",
] as const)("actual nonowner %s never qualifies protected delivery", async (nonowner) => {
  expect((await emitted("verify", { nonowner })).passed).toBe(false);
});
test.each([
  "success",
  "EACCES",
] as const)("root write %s is not the required readonly-filesystem refusal", async (write) => {
  const result = await emitted("verify", { write });
  expect(result.passed).toBe(false);
  expect(result.counts).toMatchObject({ writes: 1 });
});
test("projection ownership mismatch refuses before any projection write or child read", async () => {
  const result = await emitted("verify", { projectionUid: 65_534 });
  expect(result.passed).toBe(false);
  expect(result.counts).toMatchObject({ writes: 0, groups: 0 });
});
test("malformed member path refuses before UID selection or material reads", async () => {
  const result = await emitted("access", {}, (value) => {
    value.rows = [{ id: "../escape", digest: hash(VM_BYTES), denied: true }];
  });
  expect(result.passed).toBe(false);
  expect(result.counts).toEqual({ reads: 0, writes: 0, groups: 0 });
});
test("a failed UID transition cannot qualify EACCES by running as the wrong observer", async () => {
  expect((await emitted("access", { wrongSelf: true })).passed).toBe(false);
});
