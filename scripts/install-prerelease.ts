#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { Channel, rollbackUninstall } from "./installer/channel.ts";
import {
  candidateVersion,
  compareCandidateVersions,
  requireThat,
} from "./installer/integrity.ts";

/**
 * The installed version `select` or `rollback` chooses. `select` moves to any
 * installed version, older or newer, and requires `--version`; `rollback`
 * without one returns to the previously selected version.
 */
export function selectionTarget(opts: {
  readonly command: "select" | "rollback";
  readonly version: string | undefined;
  readonly state: {
    readonly installed: Readonly<Record<string, unknown>>;
    readonly previous: string | null;
  };
}): string {
  if (opts.command === "select") {
    requireThat(
      opts.version !== undefined,
      "select requires --version with an installed version."
    );
  }
  const selected = opts.version ?? opts.state.previous;
  requireThat(
    selected !== null &&
      selected !== undefined &&
      Object.hasOwn(opts.state.installed, selected),
    opts.command === "select"
      ? "That version is not installed; status lists the installed versions."
      : "No retained rollback version."
  );
  return selected as string;
}

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
      "hack-next --manager install|upgrade --version 5.MINOR.PATCH-next.N [--archive /path --sha256 digest]\nhack-next --manager select --version VERSION (any installed version)\nhack-next --manager status|stable|rollback [--version VERSION]|upgrade-manager\nhack-next --manager uninstall [--apply | --rollback-manifest /path]\nStandalone manager: [--root /canonical/path] <command>; hack-next runs the selected CLI."
    );
    return 0;
  }
  requireThat(
    process.platform === "darwin" && process.arch === "arm64",
    "Native prereleases support Apple Silicon macOS only."
  );
  process.umask(0o077);
  // Also applies to uninstall rollback, whose original root no longer exists.
  requireThat(
    import.meta.path.startsWith("/$bunfs/"),
    "Build the standalone manager before installing; source is not an installable artifact."
  );
  const command = argv[0];
  requireThat(
    command &&
      [
        "install",
        "upgrade",
        "rollback",
        "select",
        "stable",
        "status",
        "upgrade-manager",
        "run",
        "uninstall",
      ].includes(command),
    "Expected install, upgrade, select, rollback, stable, status, upgrade-manager or run. Use --help."
  );
  const options: Record<string, string> = Object.create(null);
  const rest = argv.slice(1);
  if (command === "uninstall") {
    requireThat(
      rest.length === 0 ||
        (rest.length === 1 && rest[0] === "--apply") ||
        (rest.length === 2 &&
          rest[0] === "--rollback-manifest" &&
          Boolean(rest[1])),
      "Use uninstall, uninstall --apply or uninstall --rollback-manifest /path."
    );
    if (rest[0] === "--rollback-manifest") {
      console.log(
        JSON.stringify(
          rollbackUninstall(root, rest[1] as string, process.execPath)
        )
      );
      return 0;
    }
  } else if (command !== "run") {
    const allowed =
      command === "install" || command === "upgrade"
        ? ["--version", "--archive", "--sha256"]
        : command === "rollback" || command === "select"
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
    candidateVersion(version);
    requireThat(
      Boolean(options["--archive"]) === Boolean(options["--sha256"]),
      "--archive and --sha256 must be supplied together."
    );
  }
  const channel = new Channel(root, process.execPath);
  if (command === "install" || command === "upgrade") {
    channel.initialize();
  }
  const release = channel.lock(
    command === "run",
    command === "upgrade-manager"
  );
  try {
    if (command === "uninstall") {
      console.log(JSON.stringify(channel.uninstall(rest[0] === "--apply")));
      return 0;
    }
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
    } else if (command === "rollback" || command === "select") {
      channel.select(
        selectionTarget({ command, version, state: channel.state })
      );
    } else if (command === "run") {
      return await channel.run(rest[0] === "--" ? rest.slice(1) : rest);
    }
    console.log(
      JSON.stringify({
        selected: channel.state.selected,
        previous: channel.state.previous,
        installed: Object.keys(channel.state.installed).sort((a, b) =>
          compareCandidateVersions(a, b)
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
