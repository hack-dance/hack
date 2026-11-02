import {
  afterEach,
  beforeEach,
  test as bunTest,
  expect,
  spyOn,
} from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResultFromUnknown, HackCliError } from "../src/lib/cli-result.ts";
import type { LegacyComposeVerifiedBinding } from "../src/lib/native-compose-adoption-binding.ts";
import {
  type LegacyComposeOrderedRefusal,
  legacyComposeOrderedRefusal,
} from "../src/lib/native-compose-adoption-diagnostics.ts";
import { inspectLegacyComposeJobStates } from "../src/lib/native-compose-adoption-runtime.ts";
import {
  createNativeComposeProbe,
  NativeComposeOwnershipError,
  nativeComposeProbeFailure,
} from "../src/lib/native-compose-ownership.ts";
import { restoreEnv } from "./helpers/env.ts";

const ID = "a".repeat(64);
const CANARY = "synthetic-private-probe-canary";
const binding: LegacyComposeVerifiedBinding = {
  binding_version: 1,
  projectRoot: "/synthetic",
  composeFile: "/synthetic/.hack/docker-compose.yml",
  composeProject: "fixture",
  engineId: "synthetic",
  containers: [{ id: ID, service: "seed", name: "fixture-seed-1" }],
  volumes: [],
  mounts: [],
  network: {
    id: "b".repeat(64),
    name: "fixture_default",
    createdAt: "2026-10-08T00:00:00Z",
  },
};
let root: string;
let previousPath: string | undefined;
let activeCases = 0;
let unconfirmed = false;
async function ownedCase(run: () => Promise<void>) {
  if (unconfirmed) {
    throw new Error("Probe fixture settlement unconfirmed; globals retained.");
  }
  activeCases++;
  try {
    await run();
  } finally {
    activeCases--;
  }
}
const test = (name: string, run: () => Promise<void>) =>
  bunTest(name, () => ownedCase(run));
beforeEach(async () =>
  ownedCase(async () => {
    previousPath = process.env.PATH;
    root = await mkdtemp(join(tmpdir(), "adoption-probe-"));
    process.env.PATH = root;
    await Bun.write(
      join(root, "docker"),
      `#!${process.execPath}
import {readFileSync,writeFileSync} from "node:fs";
const root=${JSON.stringify(root)};
const args=process.argv.slice(2);
if(args.length!==5 || args[0]!=="container" || args[1]!=="inspect" || args[2]!=="--format" || args[4]!==${JSON.stringify(ID)}) {writeFileSync(root+"/mutation","unexpected");process.exit(99);}
writeFileSync(root+"/started",String(process.pid));
const mode=readFileSync(root+"/mode","utf8");
if(mode==="child") {console.error(${JSON.stringify(CANARY)});process.exit(29);}
if(mode==="hang") {await Bun.sleep(60_000);process.exit(0);}
if(mode==="budget") {await Bun.write(Bun.stderr,"x".repeat(17*1024));process.exit(0);}
if(mode==="decode") {await Bun.write(Bun.stdout,new Uint8Array([255]));process.exit(0);}
if(mode==="json") {console.log(${JSON.stringify(CANARY)});process.exit(0);}
if(mode==="row") {console.log("[]");process.exit(0);}
const row={id:${JSON.stringify(ID)},running:false,paused:false,status:"exited",health:"",exitCode:0,startedAt:"2026-10-08T00:00:01Z",finishedAt:"2026-10-08T00:00:02Z",restartPolicy:"no",maximumRetryCount:0};
if(mode.startsWith("format-")) {
 if(mode==="format-health") row.health="healthy";
 const health=${JSON.stringify('{{with (index .State "Health")}}{{json .Status}}{{else}}""{{end}}')};
 const fields={".Id":"id",".State.Running":"running",".State.Paused":"paused",".State.Status":"status",".State.ExitCode":"exitCode",".State.StartedAt":"startedAt",".State.FinishedAt":"finishedAt",".HostConfig.RestartPolicy.Name":"restartPolicy",".HostConfig.RestartPolicy.MaximumRetryCount":"maximumRetryCount"};
 let rendered=args[3].replace(health,JSON.stringify(row.health)).replace(/\\{\\{json ([^}]+)\\}\\}/g,(_,path)=>{if(!Object.hasOwn(fields,path)){writeFileSync(root+"/mutation","unsupported format");process.exit(99);}return JSON.stringify(row[fields[path]]);});
 if(rendered.includes("{{") || rendered.includes("}}")) {writeFileSync(root+"/mutation","unrendered format");process.exit(99);}
 if(mode==="format-unterminated") rendered=rendered.slice(0,-1);
 writeFileSync(root+"/format-rendered",rendered);
 console.log(rendered);process.exit(0);
}
if(mode==="shape") delete row.health;
if(mode==="timestamp") row.startedAt=${JSON.stringify(CANARY)};
if(mode==="restart-policy") row.restartPolicy=${JSON.stringify(CANARY)};
if(mode==="membership") row.id="c".repeat(64);
console.log(JSON.stringify(row));
`
    );
    await chmod(join(root, "docker"), 0o700);
  })
);
afterEach(async () => {
  if (activeCases !== 0) {
    unconfirmed = true;
  }
  if (unconfirmed) {
    // An outer timeout cannot cancel its callback. Keep PATH, spies and roots until process exit.
    return;
  }
  restoreEnv("PATH", previousPath);
  await rm(root, { recursive: true, force: true });
});
async function mode(value: string) {
  await Bun.write(join(root, "mode"), value);
}
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected probe refusal");
}
function publicRefusal(
  error: unknown,
  reason: Extract<
    LegacyComposeOrderedRefusal,
    { stage: "ordered-observation" }
  >["reason"]
) {
  const detail = legacyComposeOrderedRefusal(error);
  expect(detail).toEqual({ stage: "ordered-observation", reason });
  expect(Object.isFrozen(detail)).toBe(true);
  const result = errorResultFromUnknown({
    error: new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "fixed values omitted",
      detail: { legacy_adoption_refusal: detail },
    }),
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "E_CONFIG_INVALID",
      message: "fixed values omitted",
      detail: {
        legacy_adoption_refusal: { stage: "ordered-observation", reason },
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify(result)).not.toContain(ID);
}

function capturedPidAbsent(
  pid: number,
  probe: (pid: number) => unknown = (value) => process.kill(value, 0)
): boolean {
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return false;
  }
  try {
    probe(pid);
  } catch (error: unknown) {
    return (
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "ESRCH"
    );
  }
  return false;
}
async function observedChild(
  run: (
    child: () => { readonly pid: number; readonly completion: ChildCompletion }
  ) => Promise<void>
) {
  const children: { readonly pid: number; completion: ChildCompletion }[] = [];
  const spawn = Bun.spawn.bind(Bun);
  // Preserve every spawn overload and the real owning subprocess; this spy never substitutes/reaps it.
  const observed = spyOn(Bun, "spawn").mockImplementation(((
    ...args: unknown[]
  ) => {
    const child = Reflect.apply(spawn, Bun, args);
    const observedChild: { readonly pid: number; completion: ChildCompletion } =
      {
        pid: child.pid,
        completion: { status: "pending" },
      };
    children.push(observedChild);
    // Observe the owning promise immediately; assertions never await it later to supply missing reaping.
    child.exited.then(
      (code: number) => {
        observedChild.completion = { status: "fulfilled", code };
      },
      () => {
        observedChild.completion = { status: "rejected" };
        unconfirmed = true;
      }
    );
    return child;
  }) as typeof Bun.spawn);
  try {
    await run(() => {
      expect(children).toHaveLength(1);
      const child = children[0];
      if (!child) {
        throw new Error("Missing exact probe child");
      }
      return child;
    });
  } finally {
    if (
      children.some(
        (child) =>
          child.completion.status !== "fulfilled" ||
          !Number.isSafeInteger(child.completion.code)
      )
    ) {
      // Assertion failure cannot bypass the owned child's already-observed settlement gate.
      unconfirmed = true;
    }
    if (!unconfirmed) {
      observed.mockRestore();
    }
  }
}
type ChildCompletion =
  | { readonly status: "pending" }
  | { readonly status: "fulfilled"; readonly code: number }
  | { readonly status: "rejected" };
function alreadyExited(child: { readonly completion: ChildCompletion }) {
  const result = child.completion;
  if (
    !(
      result.status === "fulfilled" &&
      Number.isSafeInteger(result.code) &&
      result.code > 0
    )
  ) {
    unconfirmed = true;
    throw new Error(
      "Probe child exit was not already confirmed; fixture retained."
    );
  }
}

for (const [value, reason] of [
  ["child", "probe-child"],
  ["budget", "probe-budget"],
  ["decode", "probe-decode"],
  ["json", "probe-json"],
  ["row", "probe-row"],
  ["shape", "shape"],
  ["timestamp", "timestamp"],
  ["restart-policy", "restart-policy"],
  ["membership", "membership"],
] as const) {
  test(`owned observer classifies ${value} without private output`, async () => {
    await mode(value);
    publicRefusal(
      await rejection(() => inspectLegacyComposeJobStates({ binding })),
      reason
    );
    expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
  });
}

test("valid decoded row still traverses the closed job codec", async () => {
  await mode("valid");
  expect((await inspectLegacyComposeJobStates({ binding }))[0]).toMatchObject({
    id: ID,
    restartPolicy: "no",
    exitCode: 0,
  });
});

for (const [value, health] of [
  ["format-no-health", ""],
  ["format-health", "healthy"],
] as const) {
  test(`shipping inspect format renders a closed job row with ${value}`, async () => {
    await mode(value);
    const expected = {
      id: ID,
      running: false,
      paused: false,
      status: "exited",
      health,
      exitCode: 0,
      startedAt: "2026-10-08T00:00:01Z",
      finishedAt: "2026-10-08T00:00:02Z",
      restartPolicy: "no",
      maximumRetryCount: 0,
    } as const;
    expect(await inspectLegacyComposeJobStates({ binding })).toEqual([
      expected,
    ]);
    expect(
      JSON.parse(await readFile(join(root, "format-rendered"), "utf8"))
    ).toEqual(expected);
    expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
  });
}

test("unterminated shipping-format output refuses as probe-json without weakening the codec", async () => {
  await mode("format-unterminated");
  publicRefusal(
    await rejection(() => inspectLegacyComposeJobStates({ binding })),
    "probe-json"
  );
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
});

test("operation admission and spawn failure remain distinct from child failure", async () => {
  await mode("valid");
  publicRefusal(
    await rejection(() =>
      inspectLegacyComposeJobStates({ binding, timeoutMs: 0 })
    ),
    "probe-operation"
  );
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error(CANARY);
  });
  try {
    publicRefusal(
      await rejection(() => inspectLegacyComposeJobStates({ binding })),
      "probe-operation"
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    if (!unconfirmed) {
      spawn.mockRestore();
    }
  }
  expect(await Bun.file(join(root, "started")).exists()).toBe(false);
});

test("missing executable refuses before any child", async () => {
  await rm(join(root, "docker"));
  publicRefusal(
    await rejection(() => inspectLegacyComposeJobStates({ binding })),
    "probe-operation"
  );
  expect(await Bun.file(join(root, "started")).exists()).toBe(false);
});

test("real timed out capture retains timeout classification and settles its exact child", async () => {
  await observedChild(async (child) => {
    await mode("hang");
    publicRefusal(
      await rejection(() =>
        inspectLegacyComposeJobStates({ binding, timeoutMs: 500 })
      ),
      "probe-timeout"
    );
    const exact = child();
    alreadyExited(exact);
    const pid = Number(await readFile(join(root, "started"), "utf8"));
    expect(pid).toBe(exact.pid);
    expect(capturedPidAbsent(pid)).toBe(true);
  });
});

test("pre-spawn cancellation has no child and is not an operation refusal", async () => {
  publicRefusal(
    await rejection(() =>
      inspectLegacyComposeJobStates({ binding, signal: AbortSignal.abort() })
    ),
    "probe-cancel"
  );
  expect(await Bun.file(join(root, "started")).exists()).toBe(false);
});

test("in-flight cancellation keeps the closed reason and settles its exact child", async () => {
  await observedChild(async (child) => {
    await mode("hang");
    const controller = new AbortController();
    const attempt = rejection(() =>
      inspectLegacyComposeJobStates({ binding, signal: controller.signal })
    );
    let failure: unknown;
    try {
      const deadline = Date.now() + 2000;
      while (
        !(await Bun.file(join(root, "started")).exists()) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(5);
      }
      expect(await Bun.file(join(root, "started")).exists()).toBe(true);
    } finally {
      controller.abort();
      // Even marker/polling failure must await this exact owned attempt before fixture teardown.
      failure = await attempt;
      alreadyExited(child());
    }
    publicRefusal(failure, "probe-cancel");
    const exact = child();
    const pid = Number(await readFile(join(root, "started"), "utf8"));
    expect(pid).toBe(exact.pid);
    expect(capturedPidAbsent(pid)).toBe(true);
  });
});

test("absence oracle accepts only ESRCH for a valid captured PID", async () => {
  const failure = (code: string) => () => {
    throw Object.assign(new Error("fixed"), { code });
  };
  expect(capturedPidAbsent(123, failure("ESRCH"))).toBe(true);
  for (const code of ["EPERM", "EIO", "EINVAL", "unknown"]) {
    expect(capturedPidAbsent(123, failure(code))).toBe(false);
  }
  for (const pid of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    expect(capturedPidAbsent(pid, failure("ESRCH"))).toBe(false);
  }
  expect(capturedPidAbsent(123, () => true)).toBe(false);
});

test("capture rejection is classified without reading arbitrary error metadata", async () => {
  await mode("valid");
  let reads = 0;
  const error = Object.defineProperty(new Error(CANARY), "code", {
    get: () => {
      reads++;
      throw new Error(CANARY);
    },
  });
  let restoreRead: (() => void) | undefined;
  try {
    await observedChild(async () => {
      const read = spyOn(
        ReadableStreamDefaultReader.prototype,
        "read"
      ).mockRejectedValue(error);
      restoreRead = () => read.mockRestore();
      publicRefusal(
        await rejection(() => inspectLegacyComposeJobStates({ binding })),
        "probe-capture"
      );
    });
  } finally {
    if (!unconfirmed) {
      restoreRead?.();
    }
  }
  expect(reads).toBe(0);
});

test("unknown errors do not inherit classifications or execute getters", async () => {
  let reads = 0;
  const error = Object.defineProperty(
    new NativeComposeOwnershipError("E_NATIVE_COMPOSE_PROBE"),
    "code",
    {
      get: () => {
        reads++;
        throw new Error(CANARY);
      },
    }
  );
  const unknownBinding = Object.defineProperty({ ...binding }, "containers", {
    get: () => {
      throw error;
    },
  });
  publicRefusal(
    await rejection(() =>
      inspectLegacyComposeJobStates({ binding: unknownBinding })
    ),
    "probe-unknown"
  );
  expect(reads).toBe(0);
  expect(nativeComposeProbeFailure(error)).toBeUndefined();
});

test("probe metadata remains owner-issued across copies and accessor-bearing errors", async () => {
  let issued: unknown;
  try {
    createNativeComposeProbe({ timeoutMs: 0 });
  } catch (error: unknown) {
    issued = error;
  }
  expect(nativeComposeProbeFailure(issued)).toBe("operation");
  if (typeof issued !== "object" || issued === null) {
    throw new Error("missing issued error");
  }
  for (const copy of [
    { ...issued },
    Object.create(issued),
    new NativeComposeOwnershipError("E_NATIVE_COMPOSE_OWNERSHIP"),
    { failure: "operation" },
  ]) {
    expect(nativeComposeProbeFailure(copy)).toBeUndefined();
  }
});
