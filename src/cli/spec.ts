import pkg from "../../package.json";
import { agentCommand } from "../commands/agent.ts";
import { branchCommand } from "../commands/branch.ts";
import { commandsCommand } from "../commands/commands.ts";
import { configCommand } from "../commands/config.ts";
import { crashCaptureCommand } from "../commands/crash-capture.ts";
import { daemonCommand } from "../commands/daemon.ts";
import { devCommand } from "../commands/dev.ts";
import { dispatchCommand } from "../commands/dispatch.ts";
import { doctorCommand } from "../commands/doctor.ts";
import { envCommand, hostCommand } from "../commands/env.ts";
import { execSessionsCommand } from "../commands/exec-sessions.ts";
import { gatewayCommand } from "../commands/gateway.ts";
import { globalCommand } from "../commands/global.ts";
import { helpCommand } from "../commands/help.ts";
import { internalCommand } from "../commands/internal.ts";
import { logPipeCommand } from "../commands/log-pipe.ts";
import { mcpCommand } from "../commands/mcp.ts";
import { nativeCommand } from "../commands/native.ts";
import { nodeCommand } from "../commands/node.ts";
import {
  downCommand,
  execCommand,
  initCommand,
  logsCommand,
  openCommand,
  psCommand,
  restartCommand,
  runCommand,
  upCommand,
} from "../commands/project.ts";
import { projectCommand } from "../commands/project-admin.ts";
import { projectsCommand, statusCommand } from "../commands/projects.ts";
import { remoteCommand } from "../commands/remote.ts";
import { secretsCommand } from "../commands/secrets.ts";
import { sessionCommand } from "../commands/session.ts";
import { setupCommand } from "../commands/setup.ts";
import { sshCommand } from "../commands/ssh.ts";
import { theCommand } from "../commands/the.ts";
import { tuiCommand } from "../commands/tui.ts";
import { updateCommand } from "../commands/update.ts";
import { upgradeCommand } from "../commands/upgrade.ts";
import { usageCommand } from "../commands/usage.ts";
import { versionCommand } from "../commands/version.ts";
import { xCommand } from "../commands/x.ts";
import { defineCli } from "./command.ts";
import { optNoInteractive } from "./options.ts";

type PackageJsonType = {
  name: string;
  version: string;
} & Record<string, unknown>;
const packageJson = pkg as unknown as PackageJsonType;

/** Set only by the native prerelease compiler; ordinary builds use package.json. */
declare const __HACK_BUILD_VERSION__: string | undefined;

export const CLI_SPEC = defineCli({
  name: "hack",
  version:
    typeof __HACK_BUILD_VERSION__ === "string"
      ? __HACK_BUILD_VERSION__
      : packageJson.version,
  summary: "Local development without the port-collision tax",
  highlights: [
    "Run many projects and branches side by side, each at a real HTTPS hostname like https://myapp.hack.local.",
    "Manage project env and secrets safely.",
    "Sessions and lifecycle you can trust: up, down, restart, logs and doctor.",
  ] as const,
  globalOptions: [optNoInteractive],
  commands: [
    globalCommand,
    statusCommand,
    usageCommand,
    projectsCommand,
    projectCommand,
    initCommand,
    devCommand,
    upCommand,
    downCommand,
    restartCommand,
    psCommand,
    tuiCommand,
    runCommand,
    execCommand,
    execSessionsCommand,
    commandsCommand,
    logsCommand,
    openCommand,
    branchCommand,
    logPipeCommand,
    doctorCommand,
    crashCaptureCommand,
    daemonCommand,
    dispatchCommand,
    theCommand,
    secretsCommand,
    envCommand,
    hostCommand,
    configCommand,
    mcpCommand,
    setupCommand,
    nativeCommand,
    sessionCommand,
    sshCommand,
    agentCommand,
    gatewayCommand,
    nodeCommand,
    remoteCommand,
    internalCommand,
    xCommand,
    updateCommand,
    upgradeCommand,
    versionCommand,
    helpCommand,
  ],
} as const);
