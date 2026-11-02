import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  renderDownloadCodexSlimInstallScript,
  renderDownloadInstallScript,
} from "../scripts/build-release.ts";

const version = "0.0.0-fixture";
const payload = "synthetic release payload\n";
const archiveProgram = `
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz", format=tarfile.USTAR_FORMAT) as archive:
    for name, text, mode in [
        ("hack", sys.argv[2], 0o755),
        ("install.sh", sys.argv[3], 0o755),
        ("install-codex-slim.sh", sys.argv[4], 0o755),
    ]:
        data = text.encode()
        entry = tarfile.TarInfo("hack-0.0.0-fixture-release/" + name)
        entry.uid = entry.gid = int(sys.argv[5])
        entry.mode, entry.size = mode, len(data)
        archive.addfile(entry, io.BytesIO(data))
`;

function fixtureInstaller(kind: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    // This asserts extraction ownership before cp could hide it.
    'test -O "$root/hack"',
    'test -x "$root/hack"',
    'mkdir -p "$HACK_INSTALL_BIN"',
    'cp "$root/hack" "$HACK_INSTALL_BIN/hack"',
    `printf '%s\\n' '${kind}' > "$HACK_INSTALL_BIN/installer-kind"`,
    "",
  ].join("\n");
}

async function run(opts: {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
}) {
  const child = Bun.spawn(opts.cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
}

for (const [kind, render] of [
  ["standard", renderDownloadInstallScript],
  ["slim", renderDownloadCodexSlimInstallScript],
] as const) {
  test(`generated ${kind} installer extracts foreign-owner archives as the current user`, async () => {
    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error(
        "Release installer ownership checks require a Unix user ID"
      );
    }
    const root = await mkdtemp(join(tmpdir(), "hack-download-installer-"));
    try {
      const temporary = join(root, "temporary");
      const home = join(root, "home");
      const releases = join(root, "releases");
      const release = join(releases, `v${version}`);
      await Promise.all(
        [temporary, home, release].map((path) =>
          mkdir(path, { recursive: true })
        )
      );
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: temporary,
        HACK_INSTALL_TAG: `v${version}`,
        HACK_RELEASE_BASE_URL: pathToFileURL(releases).href,
        HACK_INSTALL_BIN: join(root, "installed"),
      };
      const arch = process.arch === "x64" ? "x86_64" : process.arch;
      const archive = join(
        release,
        `hack-${version}-${process.platform}-${arch}.tar.gz`
      );
      await run({
        cmd: [
          "python3",
          "-I",
          "-S",
          "-c",
          archiveProgram,
          archive,
          payload,
          fixtureInstaller("standard"),
          fixtureInstaller("slim"),
          String(uid === 1001 ? 1002 : 1001),
        ],
        cwd: root,
        env,
      });
      const installer = join(root, "download.sh");
      const script = render();
      // Non-root tar defaults can hide regressions in root/capability-limited runners.
      expect(script).toContain('tar --no-same-owner -xzf "$tmpdir/$TARBALL"');
      await Bun.write(installer, script);
      await run({ cmd: ["bash", installer], cwd: root, env });
      const installed = join(env.HACK_INSTALL_BIN, "hack");
      expect(await Bun.file(installed).text()).toBe(payload);
      expect((await stat(installed)).uid).toBe(uid);
      expect((await stat(installed)).mode & 0o111).not.toBe(0);
      expect(
        await Bun.file(join(env.HACK_INSTALL_BIN, "installer-kind")).text()
      ).toBe(`${kind}\n`);
      expect(await readdir(temporary)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
