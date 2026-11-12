import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderStdinInstallScript,
  STDIN_INSTALL_MAX_BYTES,
  STDIN_INSTALL_SCRIPT,
  sha256Hex,
  stdinInstallStep,
} from "../src/lib/privileged-install.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A sandbox for the root script run as this (non-root) user. `chown` is a
 * recorder, `install` drops its owner flags, and, unless `realOwnershipCheck`, `find` reports nothing (as the
 * real one does for a root-owned, non-writable directory). Every other tool
 * is the real one.
 */
async function sandbox(opts?: {
  readonly realOwnershipCheck?: boolean;
  /** Replace `find` with one that fails without output. */
  readonly failingFind?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "hack-stdin-install-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const dest = join(root, "etc");
  await mkdir(bin);
  await mkdir(dest);
  const log = join(root, "chown.log");
  await writeFile(join(bin, "chown"), `#!/bin/sh\necho "$*" >> "${log}"\n`, {
    mode: 0o755,
  });
  // install(1) as non-root cannot chown: drop only the owner flags.
  await writeFile(
    join(bin, "install"),
    [
      "#!/bin/sh",
      'for a; do shift; case "$skip$a" in -o|-g) skip=1;; 1*) skip=;; *) set -- "$@" "$a";; esac; done',
      'exec /usr/bin/install "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  if (opts?.failingFind) {
    await writeFile(join(bin, "find"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  } else if (!opts?.realOwnershipCheck) {
    await writeFile(join(bin, "find"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const run = async (args: {
    readonly argv: readonly string[];
    readonly input: Uint8Array | ReadableStream<Uint8Array>;
    readonly script?: string;
  }) => {
    const [, , script, ...rest] = args.argv;
    const proc = Bun.spawn(["sh", "-c", args.script ?? script ?? "", ...rest], {
      stdin:
        args.input instanceof Uint8Array
          ? new Blob([args.input.slice()])
          : args.input,
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    return await proc.exited;
  };
  return { root, dest, log, run };
}

const leftovers = async (dir: string) =>
  (await readdir(dir)).filter((name) => name.startsWith(".hack-install."));

describe("stdinInstallStep", () => {
  test("argv carries only the byte count, digest, destination and mode", () => {
    const step = stdinInstallStep({
      target: "/etc/x/a.rules",
      content: "hi\n",
    });
    expect(step.argv).toEqual([
      "/bin/sh",
      "-c",
      STDIN_INSTALL_SCRIPT,
      "hack-install",
      "3",
      sha256Hex("hi\n"),
      "/etc/x/a.rules",
      "0644",
    ]);
    expect([...step.input]).toEqual([...new TextEncoder().encode("hi\n")]);
    // No source path anywhere: root reads only stdin.
    expect(STDIN_INSTALL_SCRIPT).not.toContain("$5");
    expect(STDIN_INSTALL_SCRIPT).toContain('sync -- "$tmp"; mv -fT');
    expect(STDIN_INSTALL_SCRIPT).toContain(
      'head -c "$((n + 1))" <&3 > "$tmp" & reader=$!'
    );
    // Cleanup is armed before the temporary file exists.
    expect(STDIN_INSTALL_SCRIPT.indexOf('trap \'[ -z "$tmp" ]')).toBeLessThan(
      STDIN_INSTALL_SCRIPT.indexOf('set -C; : > "$tmp"')
    );
  });
});

describe("root stdin install script", () => {
  test("installs exactly the stdin bytes via a temp file in the destination directory", async () => {
    const box = await sandbox();
    const target = join(box.dest, "hack.rules");
    const step = stdinInstallStep({ target, content: "rule one\n" });
    expect(await box.run(step)).toBe(0);
    expect(await readFile(target, "utf8")).toBe("rule one\n");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    const chown = (await readFile(box.log, "utf8")).trim();
    expect(chown).toStartWith(`root:root -- ${box.dest}/.hack-install.`);
    expect(await leftovers(box.dest)).toEqual([]);
  });

  test("a link at the destination is replaced, never written through", async () => {
    const box = await sandbox();
    const victim = join(box.root, "victim");
    await writeFile(victim, "untouched\n");
    const target = join(box.dest, "hack.rules");
    await symlink(victim, target);
    expect(await box.run(stdinInstallStep({ target, content: "new\n" }))).toBe(
      0
    );
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await readFile(victim, "utf8")).toBe("untouched\n");
  });

  test("bytes other than the approved ones are refused and nothing is left", async () => {
    const box = await sandbox();
    const target = join(box.dest, "hack.rules");
    const step = stdinInstallStep({ target, content: "approved\n" });
    const swapped = new TextEncoder().encode("swapped!\n");
    expect(swapped.byteLength).toBe(step.input.byteLength);
    expect(await box.run({ argv: step.argv, input: swapped })).toBe(67);
    expect(await Bun.file(target).exists()).toBe(false);
    expect(await leftovers(box.dest)).toEqual([]);
  });

  test("an ownership probe that fails without output refuses the directory", async () => {
    const box = await sandbox({ failingFind: true });
    const target = join(box.dest, "hack.rules");
    expect(await box.run(stdinInstallStep({ target, content: "x\n" }))).toBe(
      65
    );
    expect(await readdir(box.dest)).toEqual([]);
  });

  test("longer input is refused, not truncated", async () => {
    const box = await sandbox();
    const target = join(box.dest, "hack.rules");
    const step = stdinInstallStep({ target, content: "approved\n" });
    const longer = new Uint8Array([
      ...step.input,
      ...new TextEncoder().encode("extra"),
    ]);
    expect(await box.run({ argv: step.argv, input: longer })).toBe(66);
    expect(await Bun.file(target).exists()).toBe(false);
    expect(await leftovers(box.dest)).toEqual([]);
  });

  test("short input is refused", async () => {
    const box = await sandbox();
    const target = join(box.dest, "hack.rules");
    const step = stdinInstallStep({ target, content: "approved\n" });
    expect(
      await box.run({ argv: step.argv, input: step.input.slice(0, 3) })
    ).toBe(66);
    expect(await Bun.file(target).exists()).toBe(false);
    expect(await leftovers(box.dest)).toEqual([]);
  });

  test("stdin that stalls is cut off by the time limit", async () => {
    const box = await sandbox();
    const target = join(box.dest, "hack.rules");
    const step = stdinInstallStep({ target, content: "approved\n" });
    let close: (() => void) | undefined;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("app"));
        close = () => controller.close();
      },
    });
    const started = Date.now();
    const code = await box.run({
      argv: step.argv,
      input: stalled,
      script: renderStdinInstallScript({ timeoutSeconds: 1 }),
    });
    try {
      close?.();
    } catch {
      // Bun already closed the stream when the child exited.
    }
    expect(code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await Bun.file(target).exists()).toBe(false);
    expect(await leftovers(box.dest)).toEqual([]);
  });

  test("a signal during the stdin wait still removes the temporary file", async () => {
    const box = await sandbox();
    const target = join(box.dest, "hack.rules");
    const step = stdinInstallStep({ target, content: "approved\n" });
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("app"));
      },
    });
    const [, , , ...rest] = step.argv;
    // dash, as /bin/sh on Debian and Ubuntu, skips EXIT traps on signals
    // unless the script traps them itself.
    const shell = Bun.which("dash") ?? "sh";
    const proc = Bun.spawn(
      [shell, "-c", renderStdinInstallScript({ timeoutSeconds: 20 }), ...rest],
      {
        stdin: stalled,
        stdout: "ignore",
        stderr: "ignore",
        env: { PATH: `${join(box.root, "bin")}:/usr/bin:/bin` },
      }
    );
    for (let tries = 0; tries < 50; tries += 1) {
      if ((await leftovers(box.dest)).length > 0) {
        break;
      }
      await Bun.sleep(20);
    }
    expect(await leftovers(box.dest)).toHaveLength(1);
    proc.kill("SIGTERM");
    expect(await proc.exited).not.toBe(0);
    expect(await leftovers(box.dest)).toEqual([]);
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("invalid arguments are refused before anything is created", async () => {
    const box = await sandbox();
    const good = stdinInstallStep({
      target: join(box.dest, "a"),
      content: "x",
    });
    const withArgs = (n: string, sum: string, dest: string, mode: string) => [
      "/bin/sh",
      "-c",
      STDIN_INSTALL_SCRIPT,
      "hack-install",
      n,
      sum,
      dest,
      mode,
    ];
    const sum = sha256Hex("x");
    for (const argv of [
      withArgs("1", sum, "relative/a", "0644"),
      withArgs("1", sum, `${box.dest}/`, "0644"),
      withArgs("1", sum, `${box.dest}/../etc/a`, "0644"),
      withArgs("1", sum, `${box.dest}/./a`, "0644"),
      withArgs("1", sum, `${box.dest}/..`, "0644"),
      withArgs("one", sum, join(box.dest, "a"), "0644"),
      withArgs(
        String(STDIN_INSTALL_MAX_BYTES + 1),
        sum,
        join(box.dest, "a"),
        "0644"
      ),
      withArgs("1", "ZZ", join(box.dest, "a"), "0644"),
      withArgs("1", sum.slice(1), join(box.dest, "a"), "0644"),
      withArgs("1", sum, join(box.dest, "a"), "4755"),
    ]) {
      expect(await box.run({ argv, input: good.input })).toBe(64);
    }
    expect(await readdir(box.dest)).toEqual([]);
  });

  test("a directory at the destination fails the step and receives nothing", async () => {
    const box = await sandbox();
    const target = join(box.dest, "hack.rules");
    await mkdir(target);
    expect(
      await box.run(stdinInstallStep({ target, content: "x\n" }))
    ).not.toBe(0);
    expect(await readdir(target)).toEqual([]);
    expect(await leftovers(box.dest)).toEqual([]);
  });

  test("a missing destination directory is created only under a checked chain", async () => {
    const box = await sandbox();
    const target = join(box.dest, "new", "deeper", "hack.rules");
    expect(await box.run(stdinInstallStep({ target, content: "x\n" }))).toBe(0);
    expect(await readFile(target, "utf8")).toBe("x\n");
  });

  test("a link anywhere on the directory chain is refused before anything is created", async () => {
    const box = await sandbox();
    const elsewhere = join(box.root, "elsewhere");
    await mkdir(elsewhere);
    const linked = join(box.dest, "linked");
    await symlink(elsewhere, linked);
    for (const target of [
      join(linked, "hack.rules"),
      join(linked, "missing", "hack.rules"),
    ]) {
      expect(await box.run(stdinInstallStep({ target, content: "x\n" }))).toBe(
        65
      );
    }
    expect(await readdir(elsewhere)).toEqual([]);
  });

  test("a destination directory the user can write is refused", async () => {
    const box = await sandbox({ realOwnershipCheck: true });
    const target = join(box.dest, "hack.rules");
    expect(await box.run(stdinInstallStep({ target, content: "x\n" }))).toBe(
      65
    );
    expect(await readdir(box.dest)).toEqual([]);
  });
});
