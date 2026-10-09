import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeComposeMaterialBinding } from "../src/lib/native-compose-generation.ts";
import { holdDirectory } from "../src/lib/native-compose-private-state.ts";
import {
  beginNativeComposeStorageCarrierIntent,
  consumeNativeComposeStorageCarrierCompletion,
  initializeNativeComposeStorageCarrierJournal,
  readNativeComposeStorageReadonlyCarrierIntent,
} from "../src/lib/native-compose-storage-carrier-journal.ts";
import type { NativeComposeStorageXattrInvocation } from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";

let active = 0,
  unknown = false;
const owned: { root: string; close: () => Promise<void> }[] = [];
beforeEach(() => {
  if (unknown) {
    throw new Error("Prior journal case unavailable; values omitted.");
  }
});
afterEach(async () => {
  if (active || unknown) {
    unknown = true;
    return;
  }
  for (const entry of owned.splice(0)) {
    await entry.close();
    await rm(entry.root, { recursive: true, force: true });
  }
});
function whole(body: () => Promise<void>) {
  return async () => {
    active++;
    try {
      await body();
    } finally {
      active--;
    }
  };
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "carrier-completion-"))
  );
  const directory = await holdDirectory(root, true);
  owned.push({ root, close: () => directory.file.close() });
  let fence: () => Promise<void> = async () => {};
  const bound = {
    directory,
    token: "a".repeat(32),
    check: async () => await fence(),
  };
  const scope = {
    generationId: "b".repeat(32),
    currentGenerationId: "b".repeat(32),
    pendingGenerationId: "b".repeat(32),
    pendingToken: "c".repeat(32),
  };
  const input: Omit<NativeComposeStorageXattrInvocation, "recordCreated"> = {
    invocationId: "d".repeat(32),
    readonly: true,
    uid: 0,
    gid: 0,
    scope,
    artifact: {
      version: 1,
      kernelAbi: 1,
      platform: "linux/arm64",
      imageId: `sha256:${"e".repeat(64)}`,
      bunVersion: "1.4.2",
      bunHash: "e".repeat(64),
      libcHash: "f".repeat(64),
      helperHash: "e".repeat(64),
    },
    target: {
      name: "data",
      storage: "data",
      engineId: "synthetic",
      runtimeIdentity: "synthetic",
      ownerToken: "a".repeat(32),
      volume: {
        name: "data",
        storage: "data",
        createdAt: "2026-10-09T01:00:00Z",
      },
      driver: "local",
      options: {},
      mountpoint: "/var/lib/docker/volumes/data/_data",
      holders: [],
    },
    request: {
      kind: "directory-xattr",
      version: 1,
      operation: "verify",
      name: `user.hack.storage.${"a".repeat(64)}`,
      valueHex: "b".repeat(64),
      root: { device: "1", inode: "42", uid: 0, gid: 0 },
    },
  };
  const current: NativeComposeMaterialBinding = {
    identity: {
      checkoutRoot: root,
      repositoryRoot: root,
      instance: null,
      instanceId: "a".repeat(32),
      ownerToken: "a".repeat(32),
      composeProject: "synthetic",
    },
    ...scope,
    checkout: {
      dev: 1,
      ino: 2,
      projectDirectory: { dev: 1, ino: 3 },
      gitMarker: null,
    },
    generation: null,
    documentHash: null,
    receipt: { dev: 1, ino: 4, hash: "a".repeat(64) },
    lease: {
      token: "a".repeat(32),
      directory: { dev: 1, ino: 5 },
      owner: { dev: 1, ino: 6 },
    },
  };
  await initializeNativeComposeStorageCarrierJournal(bound);
  const intent = await beginNativeComposeStorageCarrierIntent({
    ...bound,
    input,
  });
  const created = { id: "e".repeat(64), createdAt: "2026-10-09T01:00:00Z" };
  await intent.recordCreated(created);
  const path = join(root, "carrier.json");
  const select = () =>
    readNativeComposeStorageReadonlyCarrierIntent({
      ...bound,
      current,
      engineId: "synthetic",
      volume: input.target.volume,
      artifact: input.artifact,
    });
  return {
    root,
    path,
    bound,
    input,
    intent,
    created,
    select,
    setFence: (value: typeof fence) => {
      fence = value;
    },
  };
}

test(
  "transport-return crash preserves exact intent; removed proof clears once without claiming original finish",
  whole(async () => {
    const f = await fixture(),
      prior = await readFile(f.path, "utf8"),
      selected = await f.select();
    expect(JSON.parse(prior).intent.created).toEqual(f.created);
    let proofs = 0;
    await selected.completeRemoved(async () => {
      proofs++;
    });
    expect(proofs).toBeGreaterThan(1);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
      version: 1,
      intent: null,
    });
    await expect(selected.completeRemoved(async () => {})).rejects.toThrow(
      "values omitted"
    );
    await expect(f.intent.complete(f.created)).rejects.toThrow(
      "values omitted"
    );
  })
);

test(
  "post-complete finish refusal cannot recreate intent or issue a second original finish",
  whole(async () => {
    const f = await fixture(),
      completion = await f.intent.complete(f.created);
    expect(() =>
      consumeNativeComposeStorageCarrierCompletion({
        completion: { ...completion },
        invocationId: f.input.invocationId,
      })
    ).toThrow("values omitted");
    const check = consumeNativeComposeStorageCarrierCompletion({
      completion,
      invocationId: f.input.invocationId,
    });
    f.setFence(async () => {
      throw new Error("source changed");
    });
    await expect(check()).rejects.toThrow("source changed");
    expect(JSON.parse(await readFile(f.path, "utf8")).intent).toBeNull();
    expect(() =>
      consumeNativeComposeStorageCarrierCompletion({
        completion,
        invocationId: f.input.invocationId,
      })
    ).toThrow("values omitted");
    await expect(f.intent.complete(f.created)).rejects.toThrow(
      "values omitted"
    );
  })
);
for (const boundary of [
  "proof-refusal",
  "last-await-replacement",
  "source-drift",
] as const) {
  test(
    `removed journal ${boundary} retains captured intent without overwrite`,
    whole(async () => {
      const f = await fixture(),
        selected = await f.select(),
        prior = await readFile(f.path, "utf8");
      let calls = 0;
      await expect(
        selected.completeRemoved(async () => {
          calls++;
          if (boundary === "proof-refusal") {
            throw new Error("unconfirmed");
          }
          if (boundary === "source-drift") {
            f.setFence(async () => {
              throw new Error("source changed");
            });
          }
          if (boundary === "last-await-replacement" && calls === 2) {
            await rename(f.path, `${f.path}.original`);
            await writeFile(f.path, prior, { mode: 0o600 });
          }
        })
      ).rejects.toThrow();
      expect(await readFile(f.path, "utf8")).toBe(prior);
      if (boundary === "last-await-replacement") {
        expect(await readFile(`${f.path}.original`, "utf8")).toBe(prior);
      }
      await expect(selected.completeRemoved(async () => {})).rejects.toThrow(
        "values omitted"
      );
    })
  );
}
