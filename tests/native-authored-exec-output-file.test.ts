import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * HACK-2744: an authored `hack exec` whose stdout (or stderr) is redirected to
 * a regular file. `Bun.write` with an empty payload truncates a file
 * destination, even one opened for append, so a command with no stderr erased
 * a `>> log 2>&1` file: its earlier content and the command's stdout. These
 * cases point the worker's real stdout and stderr at files the way a shell
 * redirect does, then read the files back.
 */
const WORKER = resolve(
  import.meta.dir,
  "fixtures/native-authored-exec-output-worker.ts"
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function scratch() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-exec-output-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"), { mode: 0o700 });
  await mkdir(join(root, "candidate"), { mode: 0o700 });
  return root;
}

type Redirect = { readonly path: string; readonly flags: "a" | "w" };

async function run(opts: {
  readonly root: string;
  readonly mode: "command" | "helper";
  readonly stdout: string;
  readonly stderr: string;
  readonly out: Redirect;
  /** Omitted: stderr shares stdout's open file, as `2>&1` does. */
  readonly err?: Redirect;
}): Promise<number> {
  const outFd = openSync(opts.out.path, opts.out.flags);
  const errFd = opts.err ? openSync(opts.err.path, opts.err.flags) : outFd;
  try {
    const child = Bun.spawn([process.execPath, WORKER], {
      cwd: opts.root,
      stdin: "ignore",
      stdout: outFd,
      stderr: errFd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: opts.root,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        HACK_NO_INTERACTIVE: "1",
        HACK_TEST_MODE: opts.mode,
        HACK_TEST_STDOUT_BASE64: Buffer.from(opts.stdout).toString("base64"),
        HACK_TEST_STDERR_BASE64: Buffer.from(opts.stderr).toString("base64"),
        HACK_TEST_PROJECT_ROOT: opts.root,
        HACK_TEST_NATIVE_HOME: join(opts.root, "candidate"),
      },
    });
    return await child.exited;
  } finally {
    closeSync(outFd);
    if (errFd !== outFd) {
      closeSync(errFd);
    }
  }
}

const cases = [
  {
    name: ">> log 2>&1 keeps the earlier line and adds stdout (no stderr)",
    stdout: "hello\n",
    stderr: "",
    before: "earlier\n",
    out: "a" as const,
    shared: true,
    expected: { out: "earlier\nhello\n" },
  },
  {
    name: "> out 2>&1 holds stdout (no stderr)",
    stdout: "hello\n",
    stderr: "",
    before: "stale\n",
    out: "w" as const,
    shared: true,
    expected: { out: "hello\n" },
  },
  {
    name: ">> log 2>&1 keeps both streams in order",
    stdout: "hello\n",
    stderr: "warn\n",
    before: "earlier\n",
    out: "a" as const,
    shared: true,
    expected: { out: "earlier\nhello\nwarn\n" },
  },
  {
    name: ">> out with no stdout keeps the file, and 2>> err with no stderr keeps it",
    stdout: "",
    stderr: "",
    before: "earlier\n",
    out: "a" as const,
    shared: false,
    expected: { out: "earlier\n", err: "earlier-err\n" },
  },
  {
    name: ">> out with stdout and 2>> err with no stderr keep both files",
    stdout: "hello\n",
    stderr: "",
    before: "earlier\n",
    out: "a" as const,
    shared: false,
    expected: { out: "earlier\nhello\n", err: "earlier-err\n" },
  },
  {
    name: "> out and 2> err each get their own stream",
    stdout: "hello\n",
    stderr: "warn\n",
    before: "stale\n",
    out: "w" as const,
    shared: false,
    expected: { out: "hello\n", err: "warn\n" },
  },
];

async function check(mode: "command" | "helper", c: (typeof cases)[number]) {
  const root = await scratch();
  const out = join(root, "out.txt");
  const err = join(root, "err.txt");
  await writeFile(out, c.before);
  await writeFile(err, c.before.replace("\n", "-err\n"));
  const code = await run({
    root,
    mode,
    stdout: c.stdout,
    stderr: c.stderr,
    out: { path: out, flags: c.out },
    err: c.shared ? undefined : { path: err, flags: c.out },
  });
  expect(code).toBe(0);
  expect(await readFile(out, "utf8")).toBe(c.expected.out);
  const expectedErr: string | undefined =
    "err" in c.expected ? c.expected.err : undefined;
  if (expectedErr !== undefined) {
    expect(await readFile(err, "utf8")).toBe(expectedErr);
  }
}

test.each(cases)("HACK-2744 stream writer: $name", (c) => check("helper", c));

const macTest = process.platform === "darwin" ? test : test.skip;
macTest.each(cases)("HACK-2744 authored hack exec: $name", (c) =>
  check("command", c)
);
