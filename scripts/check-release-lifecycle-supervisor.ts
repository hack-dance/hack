#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

const name = "hack-lifecycle-supervisor";
const release = resolve(Bun.argv[2] ?? "dist/release");
const suffix = `-${process.platform}-${process.arch === "x64" ? "x86_64" : process.arch}.tar.gz`;
const archives = (await readdir(release)).filter(
  (file) => file.startsWith("hack-") && file.endsWith(suffix)
);
assert(archives.length === 1, "exactly one host archive");
const archive = archives[0];
assert(archive, "host archive");
const version = archive.slice(5, -suffix.length);
const root = await mkdtemp(join(tmpdir(), "hack-release-supervisor-"));
try {
  await run([
    "tar",
    "--no-same-owner",
    "-xzf",
    join(release, archive),
    "-C",
    root,
  ]);
  const bundle = join(root, `hack-${version}-release`);
  const bytes = await Bun.file(join(bundle, name)).bytes();
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert(
    (await Bun.file(join(bundle, "SHA256SUMS")).text())
      .split("\n")
      .includes(`${hash}  ${name}`),
    "archive checksum"
  );
  for (const kind of ["standard", "slim", "local-bin"]) {
    const fixture = join(root, kind);
    const bin = join(fixture, "bin");
    const home = join(fixture, "home");
    await mkdir(home, { recursive: true });
    const env = {
      HOME: home,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_HOME: join(home, ".hack"),
      HACK_INSTALL_BIN: bin,
      HACK_INSTALL_ASSETS: join(fixture, "assets"),
      PATH: `${bin}:/usr/bin:/bin`,
    };
    if (kind === "local-bin") {
      await run(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "install-cli.ts"),
          "--mode=bin",
          `--dir=${bin}`,
        ],
        env
      );
    } else {
      await run(
        [
          "bash",
          join(
            bundle,
            kind === "slim" ? "install-codex-slim.sh" : "install.sh"
          ),
        ],
        env,
        "n\n"
      );
    }
    const installed = join(bin, name);
    const info = await lstat(installed);
    assert(
      kind === "local-bin"
        ? info.isSymbolicLink()
        : info.isFile() &&
            !info.isSymbolicLink() &&
            info.nlink === 1 &&
            (info.mode & 0o777) === 0o755,
      "independent executable install"
    );
    assert(
      Buffer.from(await Bun.file(installed).bytes()).equals(Buffer.from(bytes)),
      "installed bytes"
    );
    const relocated = join(fixture, name);
    await copyFile(installed, relocated);
    await chmod(relocated, 0o755);
    for (const binary of [installed, relocated]) {
      if (process.platform === "darwin") {
        await run(["/usr/bin/codesign", "--verify", "--strict", binary], env);
      }
      // Empty framed input must refuse without launching work or consulting any home.
      const child = Bun.spawn([binary, "status"], {
        env,
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      const [code, output, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
      ]);
      const frame = Buffer.from(output);
      assert(
        code === 1 &&
          frame.length >= 4 &&
          frame.readUInt32BE(0) === frame.length - 4,
        "installed refusal frame"
      );
      const receipt: unknown = JSON.parse(frame.subarray(4).toString());
      assert(
        isRecord(receipt) &&
          receipt.version === 1 &&
          receipt.outcome === "refused",
        "installed protocol receipt"
      );
      assert(
        diagnostic ===
          "Lifecycle supervisor refused or failed; values omitted.\n",
        "value-free refusal"
      );
    }
    assert((await readdir(home)).length === 0, "no home mutation");
  }
  process.stdout.write(
    `Release supervisor acceptance (${process.platform}/${process.arch}): archive checksum, normal/slim/local-bin installs, exact bytes, modes, relocation and framed refusal passed\n`
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(`Release supervisor acceptance failed: ${message}`);
  }
}
async function run(
  command: string[],
  env?: Record<string, string>,
  input?: string
) {
  const child = Bun.spawn(command, {
    env: env ?? { PATH: "/usr/bin:/bin" },
    stdin: input ? new TextEncoder().encode(input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [code, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert(code === 0, `installer/extraction: ${stderr}`);
}
