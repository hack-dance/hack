import { expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  renderCodexSlimInstallScript,
  renderDownloadCodexSlimInstallScript,
  renderDownloadInstallScript,
  renderInstallScript,
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

// HACK-1976: an upgrade runs while the previous `hack` is still executing as
// hackd. Writing over a running executable fails with "Text file busy" on
// Linux, after the compiler was already replaced, leaving a mixed install.
for (const [kind, render, running] of [
  ["standard", renderInstallScript, "hack"],
  ["slim", renderCodexSlimInstallScript, "hack-real"],
  // A slim install over a standard one replaces the running `hack` with the wrapper.
  ["slim over standard", renderCodexSlimInstallScript, "hack"],
] as const) {
  test(`bundled ${kind} installer replaces an executable that is still running`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-bundled-installer-"));
    // bash keeps working under another file name. A system `sleep` may be a
    // multi-call binary that picks its applet from argv[0] and exits at once.
    const shell = Bun.which("bash", { PATH: "/usr/bin:/bin" });
    if (shell === null) {
      throw new Error("Bundled installer test needs a system bash binary");
    }
    let daemon: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const bundle = join(root, "bundle");
      const bin = join(root, "installed", "bin");
      const assets = join(root, "installed", "assets");
      const home = join(root, "home");
      await Promise.all(
        [bundle, bin, home].map((path) => mkdir(path, { recursive: true }))
      );
      // The previous install: a real executable, running from the install path.
      const previous = join(bin, running);
      await copyFile(shell, previous);
      await chmod(previous, 0o755);
      const before = await stat(previous);
      // A loop keeps this bash image running instead of exec-ing its last command.
      daemon = Bun.spawn(
        [previous, "-c", "while :; do sleep 1; done", "previous-hack"],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      // Let the previous install prove it is running before the upgrade.
      await Bun.sleep(200);
      expect(daemon.exitCode).toBeNull();
      // The new release bundle.
      await Bun.write(join(bundle, "hack"), "#!/bin/sh\necho new hack\n");
      await Bun.write(
        join(bundle, "hack-config-compiler"),
        "#!/bin/sh\necho new compiler\n"
      );
      const installer = join(bundle, "install.sh");
      await Bun.write(installer, render());
      const child = Bun.spawn(["bash", installer], {
        cwd: root,
        env: {
          // The install dir is on PATH, so the installer does not offer to edit a shell profile.
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          HACK_INSTALL_BIN: bin,
          HACK_INSTALL_ASSETS: assets,
        },
        // Decline `hack global install`.
        stdin: new TextEncoder().encode("n\n"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

      // The running copy was not written to or stopped: it kept its old file.
      expect(daemon.exitCode).toBeNull();
      const installedReal = join(
        bin,
        kind === "standard" ? "hack" : "hack-real"
      );
      expect(await Bun.file(installedReal).text()).toBe(
        "#!/bin/sh\necho new hack\n"
      );
      expect(await Bun.file(join(bin, "hack-config-compiler")).text()).toBe(
        "#!/bin/sh\necho new compiler\n"
      );
      // Replaced by rename, not rewritten in place.
      expect((await stat(previous)).ino).not.toBe(before.ino);
      for (const name of await readdir(bin)) {
        expect((await stat(join(bin, name))).mode & 0o777).toBe(0o755);
      }
      // Nothing staged is left behind.
      expect((await readdir(bin)).sort()).toEqual(
        kind === "standard"
          ? ["hack", "hack-config-compiler"]
          : ["hack", "hack-config-compiler", "hack-real"]
      );
      if (kind !== "standard") {
        expect(await Bun.file(join(bin, "hack")).text()).toContain(
          `exec "${join(bin, "hack-real")}" "$@"`
        );
      }
    } finally {
      daemon?.kill("SIGKILL");
      await daemon?.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}
