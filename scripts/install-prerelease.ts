#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { Channel } from "./installer/channel.ts";
import { requireThat, versionNumber } from "./installer/integrity.ts";

/** Compiled entry point. There is no interpreter lookup or automatic dependency install. */
export async function main(inputArgv: string[]) {
  let argv = inputArgv;
  let root = join(homedir(), ".hack-next");
  if (argv[0] === "--root") {
    const value = argv[1];
    requireThat(value, "--root requires a path.");
    root = value;
    argv = argv.slice(2);
  }
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0] ?? "")) {
    console.log(
      "hack-next --manager install|upgrade --version 5.0.0-next.N [--archive /path --sha256 digest]\nhack-next --manager status|stable|rollback [--version VERSION]|upgrade-manager\nStandalone manager: [--root /canonical/path] <command>; hack-next runs the selected CLI."
    );
    return 0;
  }
  requireThat(
    process.platform === "darwin" && process.arch === "arm64",
    "Native prereleases support Apple Silicon macOS only."
  );
  const command = argv[0];
  requireThat(
    command &&
      [
        "install",
        "upgrade",
        "rollback",
        "stable",
        "status",
        "upgrade-manager",
        "run",
      ].includes(command),
    "Expected install, upgrade, rollback, stable, status, upgrade-manager or run. Use --help."
  );
  const options: Record<string, string> = Object.create(null);
  const rest = argv.slice(1);
  if (command !== "run") {
    const allowed =
      command === "install" || command === "upgrade"
        ? ["--version", "--archive", "--sha256"]
        : command === "rollback"
          ? ["--version"]
          : [];
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index];
      const value = rest[index + 1];
      requireThat(
        key &&
          allowed.includes(key) &&
          !Object.hasOwn(options, key) &&
          value &&
          !value.startsWith("--"),
        "Unknown, duplicate or incomplete option."
      );
      options[key] = value;
    }
  }
  const version = options["--version"];
  if (command === "install" || command === "upgrade") {
    versionNumber(version);
    requireThat(
      Boolean(options["--archive"]) === Boolean(options["--sha256"]),
      "--archive and --sha256 must be supplied together."
    );
  }
  process.umask(0o077);
  // Source invocation is development-only; releases always copy the compiled executable.
  requireThat(
    import.meta.path.startsWith("/$bunfs/"),
    "Build the standalone manager before installing; source is not an installable artifact."
  );
  const channel = new Channel(root, process.execPath);
  if (command === "install" || command === "upgrade") {
    channel.initialize();
  }
  const release = channel.lock(
    command === "run",
    command === "upgrade-manager"
  );
  try {
    if (command === "install" || command === "upgrade") {
      await channel.install(
        version as string,
        options["--archive"],
        options["--sha256"],
        command === "upgrade"
      );
    } else if (command === "upgrade-manager") {
      channel.upgradeManager();
    } else if (command === "stable") {
      channel.select(null);
    } else if (command === "rollback") {
      const selected = version ?? channel.state.previous;
      requireThat(
        selected && Object.hasOwn(channel.state.installed, selected),
        "No retained rollback version."
      );
      channel.select(selected);
    } else if (command === "run") {
      return await channel.run(rest[0] === "--" ? rest.slice(1) : rest);
    }
    console.log(
      JSON.stringify({
        selected: channel.state.selected,
        previous: channel.state.previous,
        installed: Object.keys(channel.state.installed).sort((a, b) =>
          versionNumber(a) < versionNumber(b) ? -1 : 1
        ),
        launcher: join(root, "bin/hack-next"),
      })
    );
    return 0;
  } finally {
    release();
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(
      `hack-next: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
