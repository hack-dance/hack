import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  link,
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
import type { NativeComposeMaterialBinding } from "../src/lib/native-compose-generation.ts";
import {
  assertNativeComposeStorageCommandAbsent,
  observeNativeComposeStorageCommandSettlement,
  readNativeComposeStorageCommandObservation,
  recheckNativeComposeStorageRemovedCommands,
} from "../src/lib/native-compose-storage-command-reader.ts";
import {
  nativeComposeStorageCommandHash as hash,
  nativeComposeStorageCommandFixedInvocationHash,
  nativeComposeStorageCommandSourceHash,
} from "../src/lib/native-compose-storage-command-record.ts";
import type { NativeComposeStorageXattrInvocation } from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";
import { commandReaderFixture } from "./helpers/native-compose-storage-command-fixture.ts";

const fixtures: Awaited<ReturnType<typeof commandReaderFixture>>[] = [],
  roots: string[] = [];
let active = 0,
  unknown = false;
beforeEach(() => {
  if (unknown) {
    throw new Error("Private test lifetime unavailable; values omitted.");
  }
});
afterEach(async () => {
  if (active || unknown) {
    unknown = true;
    return;
  }
  for (const f of fixtures.splice(0)) {
    await f.directory.file.close();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
function owned(operation: () => Promise<void>) {
  return async () => {
    active++;
    try {
      await operation();
    } finally {
      active--;
    }
  };
}
async function fixture(
  opts: Omit<Parameters<typeof commandReaderFixture>[0], "root"> = {}
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-command-read-"))
  );
  roots.push(root);
  const f = await commandReaderFixture({ root, ...opts });
  fixtures.push(f);
  return f;
}
function status(
  f: Awaited<ReturnType<typeof fixture>>,
  observation: Awaited<ReturnType<typeof f.read>>
) {
  return observeNativeComposeStorageCommandSettlement({
    observation,
    invocationId: f.binding.invocationId,
    created: f.created,
    helperState: f.options.helperState,
  });
}
async function change(
  f: Awaited<ReturnType<typeof fixture>>,
  edit: (record: Awaited<ReturnType<typeof f.record>>) => unknown
) {
  await writeFile(
    join(f.directory.path, "commands.json"),
    JSON.stringify(edit(await f.record()))
  );
}

for (const mode of ["created", "exited", "refused"] as const) {
  test(
    `matching ${mode} prefix is observation only and copies cannot carry status`,
    owned(async () => {
      const f = await fixture({
        helperState: mode === "created" ? "created" : "exited",
        exitCode: mode === "refused" ? 1 : 0,
      });
      const before = await readFile(
        join(f.directory.path, "commands.json"),
        "utf8"
      );
      const observation = await f.read();
      expect(status(f, observation)).toBe("records-settled");
      expect(() => status(f, { ...observation })).toThrow("values omitted");
      expect(() =>
        observeNativeComposeStorageCommandSettlement({
          observation,
          invocationId: "e".repeat(32),
          created: f.created,
          helperState: f.options.helperState,
        })
      ).toThrow("values omitted");
      expect(JSON.stringify(observation)).toBe("{}");
      expect(
        await readFile(join(f.directory.path, "commands.json"), "utf8")
      ).toBe(before);
    })
  );
}
for (const failure of [
  "missing",
  "legacy",
  "extra",
  "old-v2",
  "empty",
  "armed",
  "published",
  "timeout",
  "cancel",
  "remove",
  "host",
  "output",
  "arguments",
  "wrapper",
  "capture-alias",
] as const) {
  test(
    `saved ${failure} boundary refuses rather than inferring settlement`,
    owned(async () => {
      const f = await fixture({
          helperState:
            failure === "armed" || failure === "published"
              ? "created"
              : "exited",
        }),
        path = join(f.directory.path, "commands.json");
      if (failure === "missing") {
        await rename(path, `${path}.original`);
      } else {
        await change(f, (record) => {
          const first = record.commands[0];
          if (!first) {
            throw new Error("fixture missing command");
          }
          const last = record.commands[1] ?? first;
          switch (failure) {
            case "legacy":
              return { ...record, version: 1 };
            case "extra":
              return { ...record, secret: "PRIVATE_CANARY" };
            case "old-v2": {
              const { sourceHash: _, ...binding } = record.binding;
              return { ...record, binding };
            }
            case "empty":
              return { ...record, commands: [] };
            case "armed":
              return {
                ...record,
                commands: [{ ...first, child: null, settlement: null }],
              };
            case "published":
              return { ...record, commands: [{ ...first, settlement: null }] };
            case "timeout":
              return {
                ...record,
                commands: [
                  first,
                  {
                    ...last,
                    settlement: { ...last.settlement, timedOut: true },
                  },
                ],
              };
            case "cancel":
              return {
                ...record,
                commands: [
                  first,
                  {
                    ...last,
                    settlement: { ...last.settlement, cancelled: true },
                  },
                ],
              };
            case "remove":
              return {
                ...record,
                commands: [
                  ...record.commands,
                  {
                    ...last,
                    kind: "remove",
                    sequence: 2,
                    token: "e".repeat(32),
                  },
                ],
              };
            case "host":
              return {
                ...record,
                commands: [
                  first,
                  {
                    ...last,
                    host: { ...last.host, birth: "Fri Oct 9 02:00:00 2026" },
                  },
                ],
              };
            case "output":
              return {
                ...record,
                commands: [
                  first,
                  {
                    ...last,
                    settlement: {
                      ...last.settlement,
                      stdoutHash: hash("wrong"),
                    },
                  },
                ],
              };
            case "arguments":
              return {
                ...record,
                commands: [
                  { ...first, argumentsHash: hash("different-create") },
                  last,
                ],
              };
            case "wrapper":
              return {
                ...record,
                commands: [
                  {
                    ...first,
                    child: {
                      ...first.child,
                      wrapper: { ...f.options.wrapper, ino: "2" },
                    },
                  },
                  last,
                ],
              };
            case "capture-alias":
              return {
                ...record,
                commands: [first, { ...last, stdout: first.stdout }],
              };
            default:
              return record;
          }
        });
      }
      await expect(f.read()).rejects.toThrow("values omitted");
      expect(await readFile(f.outputs[0] ?? "", "utf8")).toBe(
        `${f.created.id}\n`
      );
    })
  );
}
for (const field of [
  "sourceHash",
  "fixedInvocationHash",
  "helperHash",
  "requestHash",
  "engineId",
  "invocationId",
] as const) {
  test(
    `independent ${field} drift refuses`,
    owned(async () => {
      const f = await fixture();
      const binding = {
        ...f.options.binding,
        [field]: "d".repeat(field === "invocationId" ? 32 : 64),
      };
      await expect(
        readNativeComposeStorageCommandObservation({ ...f.options, binding })
      ).rejects.toThrow("values omitted");
    })
  );
}
for (const failure of [
  "birth",
  "request",
  "boot",
  "uid",
  "exit",
  "executable",
  "source",
] as const) {
  test(
    `current ${failure} mismatch refuses`,
    owned(async () => {
      const f = await fixture();
      const options = { ...f.options };
      switch (failure) {
        case "birth":
          options.created = {
            ...options.created,
            createdAt: "2026-10-09T02:00:00Z",
          };
          break;
        case "request":
          options.request = { ...options.request, valueHex: "d".repeat(64) };
          break;
        case "boot":
          options.hostSession = async () => ({
            boot: "20000000-0000-0000-0000-000000000002",
            uid: process.getuid?.() ?? 0,
          });
          break;
        case "uid":
          options.hostSession = async () => ({
            boot: "10000000-0000-0000-0000-000000000001",
            uid: 9876,
          });
          break;
        case "exit":
          options.helperExitCode = 1;
          break;
        case "executable":
          options.executable = { ...options.executable, ino: "2" };
          break;
        case "source":
          options.check = async () => {
            throw new Error("PRIVATE_CANARY");
          };
          break;
        default:
          break;
      }
      await expect(
        readNativeComposeStorageCommandObservation(options)
      ).rejects.toThrow("values omitted");
    })
  );
}
for (const failure of [
  "changed",
  "replaced",
  "symlink",
  "hardlink",
  "mode",
  "overflow",
  "utf8",
] as const) {
  test(
    `private capture ${failure} refuses with no repair`,
    owned(async () => {
      const f = await fixture(),
        path = f.outputs[0];
      if (!path) {
        throw new Error("fixture missing capture");
      }
      switch (failure) {
        case "changed":
          await writeFile(path, "different");
          break;
        case "replaced": {
          const text = await readFile(path);
          await rename(path, `${path}.original`);
          await writeFile(path, text, { mode: 0o600 });
          break;
        }
        case "symlink":
          await rename(path, `${path}.original`);
          await symlink(`${path}.original`, path);
          break;
        case "hardlink":
          await link(path, `${path}.link`);
          break;
        case "mode":
          await chmod(path, 0o644);
          break;
        case "overflow":
          await writeFile(path, "x".repeat(4097));
          break;
        case "utf8":
          await writeFile(path, Buffer.from([255]));
          break;
        default:
          break;
      }
      await expect(f.read()).rejects.toThrow("values omitted");
    })
  );
}
test(
  "record replacement across the final source await refuses",
  owned(async () => {
    const f = await fixture();
    let calls = 0;
    const check = async () => {
      if (++calls === 2) {
        const path = join(f.directory.path, "commands.json"),
          text = await readFile(path);
        await rename(path, `${path}.original`);
        await writeFile(path, text, { mode: 0o600 });
      }
    };
    await expect(
      readNativeComposeStorageCommandObservation({ ...f.options, check })
    ).rejects.toThrow("values omitted");
  })
);
test("strict absence rejects invalid PID, live PID, EPERM and EIO", () => {
  expect(() =>
    assertNativeComposeStorageCommandAbsent({
      pid: Number.NaN,
      group: Number.NaN,
    })
  ).toThrow("values omitted");
  expect(() =>
    assertNativeComposeStorageCommandAbsent({
      pid: process.pid,
      group: process.pid,
    })
  ).toThrow("values omitted");
  for (const code of ["EPERM", "EIO"]) {
    const spy = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("PRIVATE_CANARY"), { code });
    });
    try {
      expect(() =>
        assertNativeComposeStorageCommandAbsent({
          pid: 2_000_000_001,
          group: 2_000_000_001,
        })
      ).toThrow("values omitted");
    } finally {
      spy.mockRestore();
    }
  }
});
test("source projection preserves every stable selection while excluding only receipt and lease incarnations", () => {
  const identity = {
    checkoutRoot: "/synthetic",
    repositoryRoot: "/synthetic",
    instance: null,
    instanceId: "a".repeat(32),
    composeProject: "synthetic",
    ownerToken: "b".repeat(32),
  };
  const binding: NativeComposeMaterialBinding = {
    identity,
    generationId: "c".repeat(32),
    checkout: {
      dev: 1,
      ino: 2,
      projectDirectory: { dev: 1, ino: 3 },
      gitMarker: null,
    },
    receipt: { dev: 1, ino: 4, hash: hash("receipt") },
    lease: {
      token: "d".repeat(32),
      directory: { dev: 1, ino: 5 },
      owner: { dev: 1, ino: 6 },
    },
    generation: {
      generationId: "c".repeat(32),
      manifestHash: hash("manifest"),
      manifest: { dev: 1, ino: 7 },
    },
    documentHash: hash("document"),
    currentGenerationId: null,
    pendingGenerationId: "c".repeat(32),
    pendingToken: "e".repeat(32),
  };
  const original = nativeComposeStorageCommandSourceHash(binding);
  expect(
    nativeComposeStorageCommandSourceHash({
      ...binding,
      receipt: { dev: 2, ino: 8, hash: hash("recovery-receipt") },
      lease: { ...binding.lease, token: "f".repeat(32) },
    })
  ).toBe(original);
  for (const changed of [
    { ...binding, identity: { ...identity, ownerToken: "f".repeat(32) } },
    { ...binding, generationId: "f".repeat(32) },
    { ...binding, checkout: { ...binding.checkout, ino: 9 } },
    { ...binding, generation: null },
    { ...binding, documentHash: hash("other") },
    { ...binding, currentGenerationId: "f".repeat(32) },
    { ...binding, pendingGenerationId: "f".repeat(32) },
    { ...binding, pendingToken: "f".repeat(32) },
  ]) {
    expect(nativeComposeStorageCommandSourceHash(changed)).not.toBe(original);
  }
});
test(
  "fixed invocation projection omits only live holders and callback, preserving birth/owner/request/operation",
  owned(async () => {
    const f = await fixture();
    const input: NativeComposeStorageXattrInvocation = {
      recordCreated: async () => {},
      invocationId: f.binding.invocationId,
      artifact: {
        version: 1,
        imageId: `sha256:${"a".repeat(64)}`,
        platform: "linux/arm64",
        bunVersion: "1.4.2",
        bunHash: "a".repeat(64),
        libcHash: "b".repeat(64),
        helperHash: "c".repeat(64),
        kernelAbi: 1,
      },
      target: {
        engineId: "synthetic-engine",
        runtimeIdentity: "synthetic",
        ownerToken: "b".repeat(32),
        name: "data",
        storage: "data",
        volume: {
          name: "data",
          storage: "data",
          createdAt: "2026-10-09T01:00:00Z",
        },
        mountpoint: "/var/lib/docker/volumes/data/_data",
        driver: "local",
        options: {},
        holders: [],
      },
      readonly: true,
      uid: 0,
      gid: 0,
      request: f.options.request,
      scope: {
        generationId: "c".repeat(32),
        currentGenerationId: null,
        pendingGenerationId: "c".repeat(32),
        pendingToken: "d".repeat(32),
      },
    };
    const original = nativeComposeStorageCommandFixedInvocationHash(input);
    expect(
      nativeComposeStorageCommandFixedInvocationHash({
        ...input,
        recordCreated: async () => {
          throw new Error("never called");
        },
        target: {
          ...input.target,
          holders: [
            {
              id: "f".repeat(64),
              runtimeIdentity: "synthetic",
              ownerToken: "b".repeat(32),
              generationId: "e".repeat(32),
              running: false,
            },
          ],
        },
      })
    ).toBe(original);
    for (const changed of [
      { ...input, readonly: false },
      { ...input, target: { ...input.target, ownerToken: "e".repeat(32) } },
      {
        ...input,
        target: {
          ...input.target,
          volume: {
            name: "data",
            storage: "data",
            createdAt: "2026-10-09T02:00:00Z",
          },
        },
      },
      { ...input, request: { ...f.options.request, valueHex: "e".repeat(64) } },
      { ...input, scope: { ...input.scope, pendingToken: "e".repeat(32) } },
    ]) {
      expect(nativeComposeStorageCommandFixedInvocationHash(changed)).not.toBe(
        original
      );
    }
  })
);

for (const failure of [
  "id",
  "json",
  "root",
  "refused-exit",
  "extra",
] as const) {
  test(
    `hash-matching ${failure} output still refuses semantic mismatch`,
    owned(async () => {
      const f = await fixture(),
        record = await f.record();
      const index = failure === "id" ? 0 : 1,
        command = record.commands[index];
      if (!command?.settlement) {
        throw new Error("fixture requires settled command");
      }
      const path = f.outputs[index];
      if (!path) {
        throw new Error("fixture requires output");
      }
      let text = `${"e".repeat(64)}\n`;
      if (failure !== "id") {
        const response = JSON.parse(await readFile(path, "utf8"));
        if (failure === "json") {
          text = "{";
        } else if (failure === "root") {
          text = JSON.stringify({
            ...response,
            root: { ...response.root, inode: "3" },
          });
        } else if (failure === "refused-exit") {
          text = JSON.stringify({
            kind: "directory-xattr",
            version: 1,
            outcome: "refused",
          });
        } else {
          text = JSON.stringify({ ...response, extra: "PRIVATE_CANARY" });
        }
      }
      await writeFile(path, text);
      await change(f, (saved) => ({
        ...saved,
        commands: saved.commands.map((value, at) =>
          at === index
            ? {
                ...value,
                settlement: { ...value.settlement, stdoutHash: hash(text) },
              }
            : value
        ),
      }));
      await expect(f.read()).rejects.toThrow("values omitted");
    })
  );
}
for (const failure of [
  "symlink",
  "mode",
  "hardlink",
  "invalid-json",
  "oversize",
] as const) {
  test(
    `record ${failure} refuses without repair`,
    owned(async () => {
      const f = await fixture(),
        path = join(f.directory.path, "commands.json");
      switch (failure) {
        case "symlink":
          await rename(path, `${path}.original`);
          await symlink(`${path}.original`, path);
          break;
        case "mode":
          await chmod(path, 0o644);
          break;
        case "hardlink":
          await link(path, `${path}.link`);
          break;
        case "invalid-json":
          await writeFile(path, "{");
          break;
        case "oversize":
          await writeFile(path, "x".repeat(32_769));
          break;
        default:
          break;
      }
      await expect(f.read()).rejects.toThrow("values omitted");
    })
  );
}

for (const failure of [
  "none",
  "missing-remove",
  "failed-start",
  "failed-remove",
  "remove-output",
  "record-replaced",
  "capture-drift",
  "copied-proof",
] as const) {
  test(
    `removed successful prefix ${failure} retains strict fresh evidence`,
    owned(async () => {
      const f = await fixture({
        helperState: "absent",
        exitCode: failure === "failed-start" ? 1 : 0,
      });
      if (failure === "missing-remove") {
        await change(f, (r) => ({ ...r, commands: r.commands.slice(0, 2) }));
      }
      if (failure === "failed-remove") {
        await change(f, (r) => ({
          ...r,
          commands: r.commands.map((c) =>
            c.kind === "remove"
              ? { ...c, settlement: { ...c.settlement, exitCode: 1 } }
              : c
          ),
        }));
      }
      if (failure === "remove-output") {
        await writeFile(f.outputs[2] ?? "", "foreign\n");
      }
      if (
        [
          "missing-remove",
          "failed-start",
          "failed-remove",
          "remove-output",
        ].includes(failure)
      ) {
        await expect(f.read()).rejects.toThrow("values omitted");
        return;
      }
      const observed = await f.read();
      if (failure === "record-replaced") {
        const path = join(f.directory.path, "commands.json"),
          text = await readFile(path);
        await rename(path, `${path}.original`);
        await writeFile(path, text, { mode: 0o600 });
      }
      if (failure === "capture-drift") {
        await writeFile(f.outputs[0] ?? "", "foreign\n");
      }
      if (failure === "none") {
        await recheckNativeComposeStorageRemovedCommands(observed);
      } else {
        await expect(
          recheckNativeComposeStorageRemovedCommands(
            failure === "copied-proof" ? { ...observed } : observed
          )
        ).rejects.toThrow("values omitted");
      }
    })
  );
}
