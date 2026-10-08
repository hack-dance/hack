import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = join(import.meta.dir, "fixtures/cli-renderer-loading.ts");
const childBudgetMs = 10_000;
const canary = "renderer-loading-canary";

async function capture(opts: {
  readonly stream: ReadableStream<Uint8Array>;
  readonly signal: AbortSignal;
}): Promise<string> {
  const reader = opts.stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    reader.cancel().catch(() => {
      // Closing the independently owned pipe also completes capture cleanup.
    });
  };
  opts.signal.addEventListener("abort", cancel, { once: true });
  if (opts.signal.aborted) {
    cancel();
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > 32_768) {
        throw new Error("Renderer loading control exceeded its output budget.");
      }
      chunks.push(next.value);
    }
  } finally {
    opts.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks)
  );
}

async function invoke(opts: {
  readonly command: readonly string[];
  readonly root: string;
}): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn([...opts.command], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: opts.root,
      HACK_HOME: join(opts.root, "home"),
      HACK_LOGGER: "console",
      HACK_EXPERIMENTAL_ACK: "1",
      DOCKER_HOST: `unix://${join(opts.root, "unreachable-docker.sock")}`,
      DOCKER_CONFIG: join(opts.root, "docker-config"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  const io = new AbortController();
  let settled = false;
  let stopped = false;
  let cleanupFailed = false;
  const stop = () => {
    if (!(settled || stopped)) {
      stopped = true;
      try {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch (error: unknown) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ESRCH"
        ) {
          cleanupFailed = true;
        }
      }
    }
    io.abort();
  };
  const stdout = capture({ stream: child.stdout, signal: io.signal });
  const stderr = capture({ stream: child.stderr, signal: io.signal });
  const timer = setTimeout(stop, childBudgetMs);
  let outcome:
    | {
        readonly ok: true;
        readonly stdout: string;
        readonly stderr: string;
        readonly exit: number;
      }
    | { readonly ok: false; readonly error: unknown }
    | undefined;
  try {
    const [out, err, exit] = await Promise.all([stdout, stderr, child.exited]);
    settled = true;
    if (stopped || cleanupFailed) {
      throw new Error(
        "Renderer loading control exceeded its owned process budget."
      );
    }
    outcome = { ok: true, stdout: out, stderr: err, exit };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  } finally {
    clearTimeout(timer);
    stop();
    await Promise.allSettled([stdout, stderr, child.exited]);
  }
  if (cleanupFailed) {
    throw new Error("Renderer loading control cleanup was not verified.");
  }
  if (!outcome) {
    throw new Error("Renderer loading control did not settle.");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return { stdout: outcome.stdout, stderr: outcome.stderr, exit: outcome.exit };
}

async function createFixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-renderer-loading-"))
  );
  await mkdir(join(root, "home"), { mode: 0o700 });
  await mkdir(join(root, "missing"), { mode: 0o700 });
  await mkdir(join(root, "project", ".hack"), { recursive: true, mode: 0o700 });
  await Bun.write(
    join(root, "project", ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await Bun.write(
    join(root, "project", ".hack", "hack.config.json"),
    '{"name":"renderer-control"}\n'
  );
  return root;
}

const controls = [
  { mode: "version", exit: 0, text: "hack v", loads: false },
  { mode: "help", exit: 0, text: "hack", loads: false },
  { mode: "remote-help", exit: 0, text: "hack remote", loads: false },
  { mode: "tui-help", exit: 0, text: "hack tui", loads: false },
  { mode: "tui-refused", exit: 1, text: "TUI requires a TTY", loads: false },
  { mode: "tui-missing-project", exit: 1, text: "No .hack/", loads: false },
  { mode: "remote-missing-project", exit: 1, text: "No .hack/", loads: false },
  {
    mode: "tui-selected",
    exit: 1,
    text: "Renderer loading canary reached.",
    loads: true,
  },
  {
    mode: "remote-selected",
    exit: 1,
    text: "Renderer loading canary reached.",
    loads: true,
  },
] as const;

function assertControl(opts: {
  readonly control: (typeof controls)[number];
  readonly result: Awaited<ReturnType<typeof invoke>>;
}): void {
  expect(opts.result.exit).toBe(opts.control.exit);
  expect(opts.result.stdout + opts.result.stderr).toContain(opts.control.text);
  expect(
    opts.result.stderr.split("\n").filter((line) => line === canary)
  ).toHaveLength(opts.control.loads ? 1 : 0);
}

for (const control of controls) {
  test(
    `renderer loads only for selected source path: ${control.mode}`,
    async () => {
      const root = await createFixture();
      try {
        assertControl({
          control,
          result: await invoke({
            command: [process.execPath, fixture, control.mode, root],
            root,
          }),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    childBudgetMs + 5000
  );
}

test("standalone compilation includes both lazy renderer paths without evaluating them for help", async () => {
  const root = await createFixture();
  try {
    const binary = join(
      root,
      process.platform === "win32" ? "loading.exe" : "loading"
    );
    const build = await invoke({
      command: [process.execPath, fixture, "build", binary],
      root,
    });
    expect(build).toEqual({ exit: 0, stdout: "built\n", stderr: "" });
    for (const mode of [
      "version",
      "tui-refused",
      "tui-selected",
      "remote-selected",
    ] as const) {
      const control = controls.find((entry) => entry.mode === mode);
      if (!control) {
        throw new Error("Missing renderer loading control.");
      }
      assertControl({
        control,
        result: await invoke({ command: [binary, mode, root], root }),
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
