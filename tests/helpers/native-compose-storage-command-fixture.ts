import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  holdDirectory,
  writeExclusive,
} from "../../src/lib/native-compose-private-state.ts";
import { readNativeComposeStorageCommandObservation } from "../../src/lib/native-compose-storage-command-reader.ts";
import {
  armNativeComposeStorageCommand,
  createNativeComposeStorageCommandOwner,
  nativeComposeStorageCommandHash as hash,
  parseNativeComposeStorageCommandRecord,
  publishNativeComposeStorageCommandChild,
  settleNativeComposeStorageCommand,
} from "../../src/lib/native-compose-storage-command-record.ts";
import { createNativeComposeStorageDockerEmptyLeaf } from "../../src/lib/native-compose-storage-witness-docker-io.ts";
import {
  encodeNativeComposeStorageXattrResponse,
  type NativeComposeStorageXattrRequest,
} from "../../src/lib/native-compose-storage-witness-xattr-codec.ts";

const digest = "a".repeat(64);
const executable = {
  path: "/synthetic/docker",
  dev: "1",
  ino: "1152921500312751116",
  uid: 0,
  mode: 0o10_0755,
  size: 1,
  hash: digest,
};
const host = {
  pid: 100,
  uid: process.getuid?.() ?? 0,
  birth: "Fri Oct 9 01:00:00 2026",
  boot: "10000000-0000-0000-0000-000000000001",
};

/** Real private-file writer sequencing with synthetic original-child facts. No
 * subprocess/daemon effect or claim of original lifetime qualification. */
export async function commandReaderFixture(opts: {
  readonly root: string;
  readonly invocationId?: string;
  readonly created?: { readonly id: string; readonly createdAt: string };
  readonly request?: NativeComposeStorageXattrRequest;
  readonly helperState?: "created" | "exited" | "absent";
  readonly exitCode?: number;
}) {
  const directory = await holdDirectory(opts.root, true);
  try {
    const binding = {
      invocationId: opts.invocationId ?? "b".repeat(32),
      engineId: "synthetic-engine",
      materialHash: digest,
      helperHash: digest,
      requestHash: digest,
      invocationHash: digest,
      sourceHash: digest,
      fixedInvocationHash: digest,
      directory: { dev: directory.info.dev, ino: directory.info.ino },
    };
    const created = opts.created ?? {
      id: "c".repeat(64),
      createdAt: "2026-10-09T01:00:00Z",
    };
    const request = opts.request ?? {
      kind: "directory-xattr",
      version: 1,
      operation: "verify",
      name: `user.hack.storage.${digest}`,
      valueHex: digest,
      root: { device: "1", inode: "2", uid: 0, gid: 0 },
    };
    if (request.operation !== "verify") {
      throw new Error("Synthetic verification fixture required.");
    }
    const helperState = opts.helperState ?? "exited",
      exitCode = opts.exitCode ?? 0;
    const owner = await createNativeComposeStorageCommandOwner({
      directory,
      binding,
      check: async () => {},
      published: () => {},
    });
    const outputs: string[] = [];
    for (const [index, kind] of (
      [
        "create",
        ...(helperState !== "created" ? (["start"] as const) : []),
        ...(helperState === "absent" ? (["remove"] as const) : []),
      ] as const
    ).entries()) {
      const token = randomBytes(16).toString("hex");
      const stdout = `${token}.stdout`,
        stderr = `${token}.stderr`;
      const text =
        kind === "create" || kind === "remove"
          ? `${created.id}\n`
          : encodeNativeComposeStorageXattrResponse(
              exitCode === 1
                ? { kind: "directory-xattr", version: 1, outcome: "refused" }
                : {
                    kind: "directory-xattr",
                    version: 1,
                    outcome: "verified",
                    root: request.root,
                    valueHex: request.valueHex,
                  }
            );
      const out = await writeExclusive(join(opts.root, stdout), text);
      const err = await createNativeComposeStorageDockerEmptyLeaf(
        join(opts.root, stderr)
      );
      outputs.push(join(opts.root, stdout));
      const armed = await armNativeComposeStorageCommand({
        owner,
        kind,
        host,
        executable,
        argumentsHash: hash(kind),
        deadline: Date.now() + 60_000,
        stdout: { name: stdout, dev: out.dev, ino: out.ino },
        stderr: { name: stderr, dev: err.dev, ino: err.ino },
        carrier: kind === "create" ? null : created,
      });
      const pid = 2_000_000_001 + index;
      await publishNativeComposeStorageCommandChild(armed, {
        pid,
        group: pid,
        birth: host.birth,
        wrapper: executable,
      });
      await settleNativeComposeStorageCommand(armed, {
        exitCode: kind === "start" ? exitCode : 0,
        timedOut: false,
        cancelled: false,
        groupAbsent: true,
        captureMode: "held-files-quiescent",
        stdoutHash: hash(text),
        stderrHash: hash(""),
      });
    }
    const { materialHash: _, invocationHash: __, ...expected } = binding;
    const options = {
      directory,
      binding: expected,
      executable,
      wrapper: executable,
      createArgumentsHash: hash("create"),
      startArgumentsHash: hash("start"),
      removeArgumentsHash: hash("remove"),
      created,
      helperState,
      helperExitCode: exitCode,
      request,
      hostSession: async () => ({ boot: host.boot, uid: host.uid }),
      check: async () => {},
    };
    return {
      directory,
      binding,
      options,
      outputs,
      created,
      read: () => readNativeComposeStorageCommandObservation(options),
      record: async () =>
        parseNativeComposeStorageCommandRecord(
          await readFile(join(opts.root, "commands.json"), "utf8")
        ),
    };
  } catch (error) {
    await directory.file.close();
    throw error;
  }
}
