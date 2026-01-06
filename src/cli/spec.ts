import pkg from "../../package.json"

import { defineCli } from "./command.ts"
import { versionCommand } from "../commands/version.ts"
import { theCommand } from "../commands/the.ts"
import { secretsCommand } from "../commands/secrets.ts"
import { projectsCommand, statusCommand } from "../commands/projects.ts"
import { usageCommand } from "../commands/usage.ts"
import {
  downCommand,
  initCommand,
  logsCommand,
  openCommand,
  psCommand,
  runCommand,
  restartCommand,
  upCommand
} from "../commands/project.ts"
import { branchCommand } from "../commands/branch.ts"
import { configCommand } from "../commands/config.ts"
import { logPipeCommand } from "../commands/log-pipe.ts"
import { helpCommand } from "../commands/help.ts"
import { globalCommand } from "../commands/global.ts"
import { doctorCommand } from "../commands/doctor.ts"
import { daemonCommand } from "../commands/daemon.ts"
import { mcpCommand } from "../commands/mcp.ts"
import { setupCommand } from "../commands/setup.ts"
import { agentCommand } from "../commands/agent.ts"
import { tuiCommand } from "../commands/tui.ts"
import { gatewayCommand } from "../commands/gateway.ts"
import { remoteCommand } from "../commands/remote.ts"
import { xCommand } from "../commands/x.ts"

type PackageJsonType = {
  name: string
  version: string
} & Record<string, unknown>
const packageJson = pkg as unknown as PackageJsonType

export const CLI_SPEC = defineCli({
  name: "hack",
  version: packageJson.version,
  summary: "run multiple local projects concurrently (network isolation + https://*.hack)",
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
    agentCommand,
    gatewayCommand,
    remoteCommand,
    xCommand,
    versionCommand,
    helpCommand
  ]
} as const)
