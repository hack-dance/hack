import pkg from "../../package.json";
import { agentCommand } from "../commands/agent.ts";
import { branchCommand } from "../commands/branch.ts";
import { configCommand } from "../commands/config.ts";
import { daemonCommand } from "../commands/daemon.ts";
import { doctorCommand } from "../commands/doctor.ts";
import { gatewayCommand } from "../commands/gateway.ts";
import { globalCommand } from "../commands/global.ts";
import { helpCommand } from "../commands/help.ts";
import { internalCommand } from "../commands/internal.ts";
import { logPipeCommand } from "../commands/log-pipe.ts";
import { mcpCommand } from "../commands/mcp.ts";
import {
  downCommand,
  initCommand,
  logsCommand,
  openCommand,
  psCommand,
  restartCommand,
  runCommand,
  upCommand,
} from "../commands/project.ts";
import { projectsCommand, statusCommand } from "../commands/projects.ts";
import { remoteCommand } from "../commands/remote.ts";
import { secretsCommand } from "../commands/secrets.ts";
import { sessionCommand } from "../commands/session.ts";
import { setupCommand } from "../commands/setup.ts";
import { sshCommand } from "../commands/ssh.ts";
import { theCommand } from "../commands/the.ts";
import { ticketsCommand } from "../commands/tickets.ts";
import { tuiCommand } from "../commands/tui.ts";
import { usageCommand } from "../commands/usage.ts";
import { versionCommand } from "../commands/version.ts";
import { xCommand } from "../commands/x.ts";
import { defineCli } from "./command.ts";

type PackageJsonType = {
  name: string;
  version: string;
} & Record<string, unknown>;
const packageJson = pkg as unknown as PackageJsonType;

export const CLI_SPEC = defineCli({
  name: "hack",
  version: packageJson.version,
  summary:
    "run multiple local projects concurrently (network isolation + https://*.hack)",
  globalOptions: [],
  commands: [
    globalCommand,
    statusCommand,
    usageCommand,
    projectsCommand,
    initCommand,
    upCommand,
    downCommand,
    restartCommand,
    psCommand,
    tuiCommand,
    runCommand,
    logsCommand,
    openCommand,
    branchCommand,
    logPipeCommand,
    doctorCommand,
    daemonCommand,
    theCommand,
    secretsCommand,
    configCommand,
    mcpCommand,
    setupCommand,
    sessionCommand,
    sshCommand,
    ticketsCommand,
    agentCommand,
    gatewayCommand,
    remoteCommand,
    internalCommand,
    xCommand,
    versionCommand,
    helpCommand,
  ],
} as const);
