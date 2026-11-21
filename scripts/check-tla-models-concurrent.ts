#!/usr/bin/env bun
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const roots = [root, resolve(process.argv[2] ?? root)];
const scratch = await mkdtemp(resolve(tmpdir(), "hack-tla-concurrency-"));
const java = process.env.JAVA_BIN ?? "java";
const wrapper = resolve(scratch, "java-probe");
const children = new Set<Bun.Subprocess>();
let interrupted = false;
function interrupt(signal: "SIGINT" | "SIGTERM") {
  interrupted = true;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  for (const child of children) {
    child.kill("SIGTERM");
  }
}
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
try {
  await writeFile(
    wrapper,
    `#!/bin/sh
set -eu
for arg do
  case "$arg" in -Djava.io.tmpdir=*) temp=\${arg#*=} ;; esac
done
: "\${temp:?missing private Java temp directory}"
printf '%s\\n' "$temp" >> "$MODEL_PROBE_LOG"
test ! -e "$temp/$MODEL_OTHER.marker"
touch "$temp/$MODEL_ID.marker"
case "$MODEL_MODE" in
  fail) exit 7 ;;
  hold) exec sleep 60 ;;
  real) exec "$MODEL_REAL_JAVA" "$@" ;;
esac
`
  );
  await chmod(wrapper, 0o700);
  for (const mode of ["fail", "SIGINT", "SIGTERM"] as const) {
    await checkCleanup(mode);
  }
  for (let round = 1; round <= 3 && !interrupted; round++) {
    const results = await Promise.all([
      run({
        id: `a-${round}`,
        other: `b-${round}`,
        cwd: roots[0],
        mode: "real",
      }),
      run({
        id: `b-${round}`,
        other: `a-${round}`,
        cwd: roots[1],
        mode: "real",
      }),
    ]);
    if (interrupted) {
      break;
    }
    if (results.some((result) => result.exitCode !== 0)) {
      throw new Error(`Concurrent model round ${round} failed`);
    }
    if (results[0].temp === results[1].temp) {
      throw new Error("Concurrent gates shared a Java temp directory");
    }
    console.log(
      `round ${round}: both gates passed with distinct, removed temp directories`
    );
  }
} finally {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  await Promise.all([...children].map((child) => child.exited));
  await rm(scratch, { recursive: true, force: true });
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}

function launch(opts: {
  id: string;
  other: string;
  cwd: string;
  mode: string;
}) {
  const log = resolve(scratch, `${opts.id}.paths`);
  const child = Bun.spawn([process.execPath, "scripts/check-tla-models.ts"], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      JAVA_BIN: wrapper,
      MODEL_REAL_JAVA: java,
      MODEL_MODE: opts.mode,
      MODEL_ID: opts.id,
      MODEL_OTHER: opts.other,
      MODEL_PROBE_LOG: log,
    },
    stdin: "ignore",
    stdout: Bun.file(resolve(scratch, `${opts.id}.stdout`)),
    stderr: Bun.file(resolve(scratch, `${opts.id}.stderr`)),
    timeout: 1_800_000,
    killSignal: "SIGTERM",
  });
  children.add(child);
  return { child, log };
}

async function finish(opts: ReturnType<typeof launch>, id: string) {
  const exitCode = await opts.child.exited;
  children.delete(opts.child);
  const paths = new Set((await readFile(opts.log, "utf8")).trim().split("\n"));
  if (paths.size !== 1) {
    throw new Error("One gate used multiple Java temp roots");
  }
  const [temp] = paths;
  if (!temp || (await Bun.file(resolve(temp, `${id}.marker`)).exists())) {
    throw new Error("Gate left Java scratch behind");
  }
  const remaining = await stat(dirname(temp))
    .then(() => true)
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    });
  if (remaining) {
    throw new Error("Gate left its metadata/source scratch behind");
  }
  return { exitCode, temp };
}

async function run(opts: Parameters<typeof launch>[0]) {
  const result = await finish(launch(opts), opts.id);
  if (result.exitCode !== 0) {
    process.stderr.write(
      await readFile(resolve(scratch, `${opts.id}.stderr`), "utf8")
    );
  }
  return result;
}

async function checkCleanup(mode: "fail" | "SIGINT" | "SIGTERM") {
  const id = `cleanup-${mode}`;
  const launched = launch({
    id,
    other: "peer",
    cwd: root,
    mode: mode === "fail" ? "fail" : "hold",
  });
  if (mode !== "fail") {
    const deadline = Date.now() + 10_000;
    while (!(await Bun.file(launched.log).exists())) {
      if (Date.now() > deadline || launched.child.exitCode !== null) {
        throw new Error("Java probe failed to start");
      }
      await Bun.sleep(10);
    }
    launched.child.kill(mode);
  }
  const result = await finish(launched, id);
  const expected = mode === "fail" ? 1 : mode === "SIGINT" ? 130 : 143;
  if (result.exitCode !== expected) {
    throw new Error(`${mode} returned ${result.exitCode}`);
  }
  console.log(`${mode}: gate removed Java and metadata scratch`);
}
