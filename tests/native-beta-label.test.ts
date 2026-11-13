import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_BETA_DOCS_URL,
  nativeBetaNotice,
} from "../src/backends/native-beta.ts";
import { resolveNativeRuntimeSelection } from "../src/backends/native-runtime-client.ts";
import { noteNativeBackendBeta } from "../src/commands/native-beta-notice.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2026. In 5.0.0 the native backend is an opt-in beta: Apple Silicon
 * macOS only, delivered by the `hack-next` channel, absent from the stable
 * archives. Stable `hack` has to say so when native is selected without a
 * candidate, and `up`, `status` and `doctor` have to say which backend they
 * are reporting on.
 */

const repoRoot = join(import.meta.dir, "..");
const LABEL = "Native backend (beta)";
let root = "";
let project = "";
let outside = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-native-beta-")));
  project = join(root, "project");
  outside = join(root, "outside");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, "native-home"), { mode: 0o700 });
  await Bun.write(
    join(project, ".hack", "hack.config.json"),
    '{"name":"beta-fixture"}\n'
  );
  await Bun.write(
    join(project, ".hack", "docker-compose.yml"),
    "services:\n  web:\n    image: example/web:1\n"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function hack(opts: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}) {
  const child = Bun.spawn(
    [process.execPath, join(repoRoot, "index.ts"), ...opts.args],
    {
      cwd: opts.cwd,
      env: privateCliEnv({
        root,
        env: { HACK_LOGGER: "console", NO_COLOR: "1", ...opts.env },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("native selection without a candidate says where the native backend comes from", () => {
  let refusal: unknown;
  try {
    resolveNativeRuntimeSelection({ HACK_RUNTIME_BACKEND: "native" });
  } catch (error: unknown) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(ClosedCliError);
  const message = String((refusal as Error).message);
  // The contract the candidate launcher relies on stays the first sentence.
  expect(message).toStartWith(
    "Native runtime requires absolute HACK_NATIVE_BINARY and HACK_NATIVE_HOME paths."
  );
  expect(message).toContain("beta");
  expect(message).toContain("Apple Silicon macOS");
  expect(message).toContain("hack-next");
  expect(message).toContain("not part of stable hack");
  expect(message).toContain("unset HACK_RUNTIME_BACKEND");
  expect(message).toContain(NATIVE_BETA_DOCS_URL);
  // A relative candidate path is the same refusal.
  expect(() =>
    resolveNativeRuntimeSelection({
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "hack-native",
      HACK_NATIVE_HOME: "/tmp/native-home",
    })
  ).toThrow(NATIVE_BETA_DOCS_URL);
  // Compose selection is untouched.
  expect(resolveNativeRuntimeSelection({})).toBeNull();
});

test("the docs link points at the candidate install guide on the stable branch", () => {
  expect(NATIVE_BETA_DOCS_URL).toBe(
    "https://github.com/hack-dance/hack/blob/main/docs/guides/candidate-install.md"
  );
});

test("the beta notice is one line and stays out of --json output", () => {
  expect(nativeBetaNotice()).toStartWith(`${LABEL}: `);
  expect(nativeBetaNotice()).not.toContain("\n");
  expect(nativeBetaNotice()).toContain("Apple Silicon macOS");
  expect(nativeBetaNotice()).toContain(NATIVE_BETA_DOCS_URL);
  // An injected sink, not a spy on the shared logger: with every test file
  // in one process, the logger this file imports is not always the object
  // the command module calls, and the spy then sees nothing.
  const lines: { readonly message: string }[] = [];
  const info = (line: { readonly message: string }) => {
    lines.push(line);
  };
  noteNativeBackendBeta({ json: true, info });
  expect(lines).toEqual([]);
  noteNativeBackendBeta({ json: false, info });
  expect(lines).toEqual([{ message: nativeBetaNotice() }]);
});

for (const command of ["up", "status", "doctor"] as const) {
  test(`stable hack ${command} with HACK_RUNTIME_BACKEND=native and no candidate refuses with the beta pointer`, async () => {
    const result = await hack({
      args: [command],
      cwd: project,
      env: { HACK_RUNTIME_BACKEND: "native" },
    });
    expect(result.code).toBe(1);
    expect(count(result.stderr, NATIVE_BETA_DOCS_URL)).toBe(1);
    expect(result.stderr).toContain("hack-next");
    expect(result.stderr).toContain("not part of stable hack");
    // A closed refusal: no stack frames.
    expect(result.stderr).not.toContain("    at ");
    expect(result.stdout).toBe("");
  }, 90_000);
}

for (const [command, cwd] of [
  ["up", "outside"],
  ["status", "project"],
  ["doctor", "project"],
] as const) {
  test(`hack ${command} under native selection prints one native backend (beta) line`, async () => {
    const result = await hack({
      args: [command],
      cwd: cwd === "project" ? project : outside,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        // Selected, but nothing is installed there: no VM or engine can start.
        HACK_NATIVE_BINARY: join(root, "candidate", "hack-native"),
        HACK_NATIVE_HOME: join(root, "native-home"),
      },
    });
    expect(count(result.stderr + result.stdout, LABEL)).toBe(1);
    expect(result.stderr).toContain(`INFO: ${nativeBetaNotice()}\n`);
  }, 90_000);
}

test("hack status --json under native selection keeps stdout a single JSON document", async () => {
  const result = await hack({
    args: ["status", "--json"],
    cwd: project,
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: join(root, "candidate", "hack-native"),
      HACK_NATIVE_HOME: join(root, "native-home"),
    },
  });
  expect(result.stdout + result.stderr).not.toContain(LABEL);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
}, 90_000);

test("without native selection nothing mentions the native backend", async () => {
  const result = await hack({
    args: ["status"],
    cwd: project,
    env: {},
  });
  expect(result.stdout + result.stderr).not.toContain(LABEL);
}, 90_000);
