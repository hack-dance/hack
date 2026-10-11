import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type HeldDirectory,
  recheckDirectories,
  sameFile,
} from "./native-compose-private-state.ts";
import {
  parseNativeComposeStorageCommandRecord as decode,
  nativeComposeStorageCommandHash as hash,
  type NativeComposeStorageCommandExecutable,
} from "./native-compose-storage-command-record.ts";
import { readNativeComposeStorageSavedCapture } from "./native-compose-storage-witness-docker-io.ts";
import {
  type NativeComposeStorageXattrRequest,
  parseNativeComposeStorageXattrResponse,
  refuseNativeComposeStorageXattr as refuse,
  sameNativeComposeStorageXattrRoot,
} from "./native-compose-storage-witness-xattr-codec.ts";

type RecordV2 = ReturnType<typeof decode>;
type Binding = Omit<RecordV2["binding"], "materialHash" | "invocationHash">;
type Selection = {
  readonly invocationId: string;
  readonly created: { readonly id: string; readonly createdAt: string };
  readonly helperState: "created" | "exited" | "absent";
};
export type NativeComposeStorageCommandObservation = Readonly<
  Record<never, never>
>;
const observations = new WeakMap<
  NativeComposeStorageCommandObservation,
  Selection & { readonly recheck?: () => Promise<void> }
>();
function sameExecutable(
  left: NativeComposeStorageCommandExecutable,
  right: NativeComposeStorageCommandExecutable
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.path === right.path &&
    left.hash === right.hash &&
    left.size === right.size &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}
function sameBinding(left: Binding, right: Binding): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.engineId === right.engineId &&
    left.sourceHash === right.sourceHash &&
    left.fixedInvocationHash === right.fixedInvocationHash &&
    left.helperHash === right.helperHash &&
    left.requestHash === right.requestHash &&
    left.directory.dev === right.directory.dev &&
    left.directory.ino === right.directory.ino
  );
}

function checkedCommand(opts: {
  readonly command: RecordV2["commands"][number];
  readonly first: RecordV2["commands"][number];
  readonly expected: {
    readonly executable: NativeComposeStorageCommandExecutable;
    readonly wrapper: NativeComposeStorageCommandExecutable;
    readonly createArgumentsHash: string;
    readonly startArgumentsHash: string;
    readonly removeArgumentsHash?: string;
    readonly created: Selection["created"];
    readonly helperExitCode: number;
  };
}) {
  const { command, first, expected } = opts;
  const settlement = command.settlement,
    child = command.child;
  if (
    !(settlement && child) ||
    settlement.timedOut ||
    settlement.cancelled ||
    command.host.boot !== first.host.boot ||
    command.host.uid !== first.host.uid ||
    command.host.pid !== first.host.pid ||
    command.host.birth !== first.host.birth ||
    !sameExecutable(command.executable, expected.executable) ||
    !sameExecutable(child.wrapper, expected.wrapper) ||
    command.argumentsHash !==
      {
        create: expected.createArgumentsHash,
        start: expected.startArgumentsHash,
        remove: expected.removeArgumentsHash,
      }[command.kind] ||
    (command.kind === "create"
      ? command.carrier !== null || settlement.exitCode !== 0
      : command.carrier?.id !== expected.created.id ||
        command.carrier.createdAt !== expected.created.createdAt ||
        settlement.exitCode !==
          (command.kind === "start" ? expected.helperExitCode : 0))
  ) {
    return refuse();
  }
  return { settlement, child };
}

/** Strict current absence observation only. No signal other than zero, no PID
 * reacquisition, and no permission/error-as-absence path. */
export function assertNativeComposeStorageCommandAbsent(child: {
  readonly pid: number;
  readonly group: number;
}): void {
  if (
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 1 ||
    child.group !== child.pid
  ) {
    refuse();
  }
  for (const pid of [child.pid, -child.group]) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") {
        continue;
      }
      refuse();
    }
    refuse();
  }
}

/** Existing private v2 records only. An issued observation proves matching saved
 * settled-prefix bytes plus current absence, never original success/durable commit
 * or cleanup authority. Missing/legacy/incomplete input throws fixed refusal. */
export async function readNativeComposeStorageCommandObservation(opts: {
  readonly directory: HeldDirectory;
  readonly binding: Binding;
  readonly executable: NativeComposeStorageCommandExecutable;
  readonly wrapper: NativeComposeStorageCommandExecutable;
  readonly createArgumentsHash: string;
  readonly startArgumentsHash: string;
  readonly removeArgumentsHash?: string;
  readonly created: Selection["created"];
  readonly helperState: Selection["helperState"];
  readonly helperExitCode: number;
  readonly request: NativeComposeStorageXattrRequest;
  readonly hostSession: () => Promise<{
    readonly boot: string;
    readonly uid: number;
  }>;
  readonly check: () => Promise<void>;
}): Promise<NativeComposeStorageCommandObservation> {
  const { directory, hostSession, check } = opts;
  const expected = structuredClone({
    binding: opts.binding,
    executable: opts.executable,
    wrapper: opts.wrapper,
    createArgumentsHash: opts.createArgumentsHash,
    startArgumentsHash: opts.startArgumentsHash,
    removeArgumentsHash: opts.removeArgumentsHash,
    created: opts.created,
    helperState: opts.helperState,
    helperExitCode: opts.helperExitCode,
    request: opts.request,
  });
  const path = join(directory.path, "commands.json");
  const readRecord = async () =>
    await readNativeComposeStorageSavedCapture({
      directories: [directory],
      leaf: { path, info: await lstat(path) },
      limit: 32_768,
    });
  try {
    await check();
    await recheckDirectories([directory]);
    const saved = await readRecord(),
      record = decode(saved.text);
    const request = expected.request;
    if (
      !sameBinding(record.binding, expected.binding) ||
      record.commands.length !==
        { created: 1, exited: 2, absent: 3 }[expected.helperState] ||
      request.operation !== "verify" ||
      (expected.helperState === "absent" &&
        (expected.helperExitCode !== 0 || !expected.removeArgumentsHash))
    ) {
      return refuse();
    }
    const first = record.commands[0] ?? refuse();
    const captures: {
      readonly leaf: {
        readonly path: string;
        readonly info: { readonly dev: number; readonly ino: number };
      };
      readonly saved: Awaited<
        ReturnType<typeof readNativeComposeStorageSavedCapture>
      >;
    }[] = [];
    const names = new Set<string>();
    const session = async () => {
      const fresh = await hostSession();
      if (fresh.boot !== first.host.boot || fresh.uid !== first.host.uid) {
        return refuse();
      }
      for (const command of record.commands) {
        assertNativeComposeStorageCommandAbsent(command.child ?? refuse());
      }
    };
    for (const command of record.commands) {
      const { settlement, child } = checkedCommand({
        command,
        first,
        expected,
      });
      assertNativeComposeStorageCommandAbsent(child);
      const output: string[] = [];
      for (const [capture, digest] of [
        [command.stdout, settlement.stdoutHash],
        [command.stderr, settlement.stderrHash],
      ] as const) {
        if (names.has(capture.name)) {
          return refuse();
        }
        names.add(capture.name);
        const leaf = {
          path: join(directory.path, capture.name),
          info: { dev: capture.dev, ino: capture.ino },
        };
        const observed = await readNativeComposeStorageSavedCapture({
          directories: [directory],
          leaf,
        });
        if (hash(observed.text) !== digest) {
          return refuse();
        }
        captures.push({ leaf, saved: observed });
        output.push(observed.text);
      }
      if (command.kind === "create" || command.kind === "remove") {
        if (output[0]?.trim() !== expected.created.id) {
          return refuse();
        }
      } else {
        const response = parseNativeComposeStorageXattrResponse(
          output[0] ?? refuse()
        );
        if (
          settlement.exitCode === 1
            ? response.outcome !== "refused"
            : settlement.exitCode !== 0 ||
              response.outcome !== "verified" ||
              !sameNativeComposeStorageXattrRoot(response.root, request.root) ||
              response.valueHex !== request.valueHex
        ) {
          return refuse();
        }
      }
    }
    const recheck = async () => {
      await check();
      await session();
      for (const capture of captures) {
        const fresh = await readNativeComposeStorageSavedCapture({
          directories: [directory],
          leaf: capture.leaf,
        });
        if (
          fresh.text !== capture.saved.text ||
          fresh.info.size !== capture.saved.info.size ||
          fresh.info.mtimeMs !== capture.saved.info.mtimeMs ||
          fresh.info.ctimeMs !== capture.saved.info.ctimeMs
        ) {
          return refuse();
        }
      }
      await recheckDirectories([directory]);
      const fresh = await readRecord();
      if (
        !sameFile(fresh.info, saved.info) ||
        fresh.text !== saved.text ||
        fresh.info.mtimeMs !== saved.info.mtimeMs ||
        fresh.info.ctimeMs !== saved.info.ctimeMs
      ) {
        return refuse();
      }
      await check();
      await session();
      await check();
    };
    await recheck();
    const observation = Object.freeze({});
    observations.set(
      observation,
      Object.freeze({
        invocationId: expected.binding.invocationId,
        created: Object.freeze(expected.created),
        helperState: expected.helperState,
        recheck: expected.helperState === "absent" ? recheck : undefined,
      })
    );
    return observation;
  } catch {
    return refuse();
  }
}

/** Consume only an issued, exact-selection observation. It describes the earlier
 * checked read; it neither holds resources nor grants later mutation authority. */
export function observeNativeComposeStorageCommandSettlement(
  opts: Selection & {
    readonly observation: NativeComposeStorageCommandObservation;
  }
): "records-settled" {
  const saved = observations.get(opts.observation) ?? refuse();
  if (
    saved.invocationId !== opts.invocationId ||
    saved.helperState !== opts.helperState ||
    saved.created.id !== opts.created.id ||
    saved.created.createdAt !== opts.created.createdAt
  ) {
    return refuse();
  }
  return "records-settled";
}

/** Held-scope fresh proof only, exclusively for the removed successful prefix.
 * It does not issue journal, resource or file retirement authority. */
export async function recheckNativeComposeStorageRemovedCommands(
  observation: NativeComposeStorageCommandObservation
): Promise<void> {
  const selected = observations.get(observation) ?? refuse();
  if (selected.helperState !== "absent" || !selected.recheck) {
    return refuse();
  }
  await selected.recheck();
}
