import * as p from "@clack/prompts";
import qrcode from "qrcode-terminal";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { exec, run } from "../lib/shell.ts";
import {
  buildDirectSshCommand,
  buildTailscaleSshCommand,
  validateTailscaleSetup,
} from "../lib/tailscale.ts";

/** Connection method: Tailscale or direct SSH */
type ConnectionMethod = "tailscale" | "direct";

/** Valid session name pattern: alphanumeric, dash, underscore, or dot */
const SESSION_NAME_PATTERN = /^[\w.-]+$/;

/**
 * Parsed tmux session info.
 */
interface TmuxSession {
  readonly name: string;
  readonly attached: boolean;
  readonly path: string | null;
}

const optHost = defineOption({
  name: "host",
  type: "string",
  long: "--host",
  short: "-H",
  description: "SSH host (hostname or IP)",
} as const);

const optUser = defineOption({
  name: "user",
  type: "string",
  long: "--user",
  short: "-u",
  description: "SSH username",
} as const);

const optTailscale = defineOption({
  name: "tailscale",
  type: "boolean",
  long: "--tailscale",
  short: "-t",
  description: "Use Tailscale SSH",
} as const);

const optDirect = defineOption({
  name: "direct",
  type: "boolean",
  long: "--direct",
  description: "Use direct SSH (requires --host)",
} as const);

const optPort = defineOption({
  name: "port",
  type: "string",
  long: "--port",
  short: "-p",
  description: "SSH port for direct connection (default: 22)",
} as const);

const sshSpec = defineCommand({
  name: "ssh",
  summary: "Show SSH connection info for remote access to this machine",
  group: "Project",
  options: [optHost, optUser, optTailscale, optDirect, optPort],
  positionals: [
    { name: "session", description: "Session to connect to", required: false },
  ],
  subcommands: [],
} as const);

type SshArgs = CommandArgs<typeof sshSpec.options, typeof sshSpec.positionals>;

/**
 * Main handler for hack ssh command.
 *
 * Shows SSH connection info for this machine so you can connect from other devices.
 */
async function handleSsh(opts: {
  readonly ctx: CliContext;
  readonly args: SshArgs;
}): Promise<number> {
  const { args } = opts;
  const hostOverride = args.options.host;
  const user = args.options.user;
  const portStr = args.options.port;
  const port = portStr ? Number.parseInt(portStr, 10) : undefined;

  p.intro("Remote Access");

  const connection = await resolveConnection({
    direct: args.options.direct === true,
    tailscale: args.options.tailscale === true,
    hostOverride,
  });
  if (!connection.ok) {
    if (connection.reason === "cancelled") {
      p.outro("Cancelled");
      return 0;
    }
    return 1;
  }
  const { method, hostname } = connection;

  // Step 2: Build and show SSH command
  const sshCommand =
    method === "tailscale"
      ? buildTailscaleSshCommand({ dnsName: hostname, user })
      : buildDirectSshCommand({ host: hostname, user, port });

  console.log("");
  p.log.step(`SSH Command:\n\n  ${sshCommand}\n`);

  // Step 3: Show QR code
  let sshUri = "ssh://";
  if (user) {
    sshUri += `${user}@`;
  }
  sshUri += hostname;
  if (port && port !== 22) {
    sshUri += `:${port}`;
  }

  console.log("Scan to connect from mobile (Blink, Termius, etc.):\n");
  qrcode.generate(sshUri, { small: true });
  console.log("");

  // Step 4: Show active sessions
  const sessions = await listTmuxSessions();

  if (sessions.length > 0) {
    const sessionList = sessions
      .map((s) => `  • ${s.name}${s.attached ? " (attached)" : ""}`)
      .join("\n");
    p.log.info(`Active tmux sessions:\n${sessionList}`);
  } else {
    p.log.info("No active tmux sessions");
  }

  // Step 5: Ask what to do
  const sessionArg = args.positionals.session;

  if (sessionArg) {
    if (!SESSION_NAME_PATTERN.test(sessionArg)) {
      p.log.error(
        "Invalid session name (only letters, numbers, dashes, underscores, or dots)"
      );
      return 1;
    }
    // Direct connect to specified session
    return await connectToSession({
      hostname,
      user,
      port,
      sessionName: sessionArg,
    });
  }

  const sessionName = await resolveSessionNameToConnect({ sessions });
  if (!sessionName) {
    p.outro("Copy the SSH command above to connect from other devices");
    return 0;
  }

  return await connectToSession({ hostname, user, port, sessionName });
}

async function resolveConnection(opts: {
  readonly direct: boolean;
  readonly tailscale: boolean;
  readonly hostOverride: string | undefined;
}): Promise<
  | {
      readonly ok: true;
      readonly method: ConnectionMethod;
      readonly hostname: string;
    }
  | { readonly ok: false; readonly reason: "cancelled" | "error" }
> {
  if (opts.direct || opts.hostOverride) {
    const hostname = await resolveDirectHost({
      hostOverride: opts.hostOverride,
    });
    if (!hostname) {
      return { ok: false, reason: "cancelled" };
    }
    return { ok: true, method: "direct", hostname };
  }

  if (opts.tailscale) {
    const result = await setupTailscale();
    if (!result.ok) {
      return { ok: false, reason: "error" };
    }
    return {
      ok: true,
      method: "tailscale",
      hostname: opts.hostOverride ?? result.hostname,
    };
  }

  const method = await selectConnectionMethod();
  if (!method) {
    return { ok: false, reason: "cancelled" };
  }

  if (method === "tailscale") {
    const result = await setupTailscale();
    if (!result.ok) {
      return { ok: false, reason: "error" };
    }
    return { ok: true, method, hostname: result.hostname };
  }

  const hostname = await resolveDirectHost({ hostOverride: opts.hostOverride });
  if (!hostname) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: true, method, hostname };
}

async function selectConnectionMethod(): Promise<ConnectionMethod | null> {
  const selected = await p.select({
    message: "Connection method",
    options: [
      {
        value: "tailscale" as const,
        label: "Tailscale",
        hint: "secure, no port forwarding",
      },
      {
        value: "direct" as const,
        label: "Direct SSH",
        hint: "traditional SSH",
      },
    ],
  });
  if (p.isCancel(selected)) {
    return null;
  }
  return selected;
}

async function resolveDirectHost(opts: {
  readonly hostOverride: string | undefined;
}): Promise<string | null> {
  const hostname = (opts.hostOverride ?? "").trim();
  if (hostname.length > 0) {
    return hostname;
  }

  const hostInput = await p.text({
    message: "SSH host (hostname or IP)",
    placeholder: "example.com or 192.168.1.100",
    validate: (value) => {
      if (!value?.trim()) {
        return "Host is required";
      }
      return undefined;
    },
  });

  if (p.isCancel(hostInput)) {
    return null;
  }

  return hostInput.trim();
}

async function resolveSessionNameToConnect(opts: {
  readonly sessions: readonly TmuxSession[];
}): Promise<string | null> {
  const action = await p.select({
    message: "What would you like to do?",
    options: [
      {
        value: "done" as const,
        label: "Done",
        hint: "just wanted the connection info",
      },
      {
        value: "connect" as const,
        label: "Connect to session",
        hint: "SSH into a tmux session",
      },
    ],
  });

  if (p.isCancel(action) || action === "done") {
    return null;
  }

  const sessionOptions = [
    ...opts.sessions.map((s) => ({
      value: s.name,
      label: s.name,
      hint: s.attached ? "attached" : undefined,
    })),
    { value: "__new__", label: "Create new session" },
  ];

  const selectedSession = await p.select({
    message: "Select session",
    options: sessionOptions,
  });

  if (p.isCancel(selectedSession)) {
    return null;
  }

  if (selectedSession !== "__new__") {
    return selectedSession;
  }

  const name = await p.text({
    message: "Session name",
    placeholder: "main",
    defaultValue: "main",
    validate: (value) => {
      if (value && !SESSION_NAME_PATTERN.test(value)) {
        return "Only letters, numbers, dashes, underscores, or dots";
      }
      return undefined;
    },
  });

  if (p.isCancel(name)) {
    return null;
  }

  return (name || "main").trim();
}

/**
 * Set up Tailscale connection, prompting to turn on if needed.
 */
async function setupTailscale(): Promise<
  { ok: true; hostname: string } | { ok: false }
> {
  const validation = await validateTailscaleSetup();
  const status = validation.status;

  if (!status.installed) {
    p.log.error("Tailscale is not installed");
    p.log.info("Install: https://tailscale.com/download");
    return { ok: false };
  }

  let tailscaleReady = status.loggedIn && status.backendState === "Running";

  if (!tailscaleReady) {
    p.log.warn(
      status.backendState === "Stopped"
        ? "Tailscale is stopped"
        : "Tailscale is not connected"
    );

    const turnOn = await p.confirm({
      message: "Turn on Tailscale?",
      initialValue: true,
    });

    if (p.isCancel(turnOn) || !turnOn) {
      return { ok: false };
    }

    p.log.step("Starting Tailscale...");
    const result = await run(["tailscale", "up"], { stdin: "inherit" });

    if (result !== 0) {
      p.log.error("Failed to start Tailscale");
      return { ok: false };
    }

    // Re-check
    const newValidation = await validateTailscaleSetup();
    tailscaleReady =
      newValidation.status.loggedIn &&
      newValidation.status.backendState === "Running";

    if (!tailscaleReady) {
      p.log.error("Tailscale still not connected");
      return { ok: false };
    }

    p.log.success("Tailscale connected!");
  }

  const currentStatus = (await validateTailscaleSetup()).status;
  const hostname = currentStatus.dnsName;

  if (!hostname) {
    p.log.error("Could not determine Tailscale hostname");
    return { ok: false };
  }

  return { ok: true, hostname };
}

/**
 * Connect to a tmux session via SSH.
 */
async function connectToSession(opts: {
  readonly hostname: string;
  readonly user?: string;
  readonly port?: number;
  readonly sessionName: string;
}): Promise<number> {
  p.log.step(`Connecting to ${opts.sessionName}...`);
  console.log("");

  // Use login shell to ensure PATH includes homebrew etc.
  // -d detaches other clients to avoid size conflicts from different terminals
  const tmuxCmd = `$SHELL -l -c 'tmux attach -d -t ${opts.sessionName} 2>/dev/null || tmux new -s ${opts.sessionName}'`;

  const sshArgs = [
    "ssh",
    ...(opts.port ? ["-p", String(opts.port)] : []),
    ...(opts.user ? ["-l", opts.user] : []),
    opts.hostname,
    "-t",
    tmuxCmd,
  ];

  return await run(sshArgs, { stdin: "inherit" });
}

/**
 * List all tmux sessions.
 */
async function listTmuxSessions(): Promise<TmuxSession[]> {
  const separator = "|||HACK_SESSION_FIELD|||";
  const format = [
    "#{session_name}",
    "#{session_attached}",
    "#{session_path}",
  ].join(separator);
  const result = await exec(["tmux", "list-sessions", "-F", format], {
    stdin: "ignore",
  });

  if (result.exitCode !== 0) {
    return [];
  }

  const sessions: TmuxSession[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const fields = parseTmuxSessionFields(line, separator, 3);
    if (!fields) {
      continue;
    }
    const [name, attached, path] = fields;
    if (name) {
      sessions.push({
        name,
        attached: attached === "1",
        path: path || null,
      });
    }
  }

  return sessions;
}

function parseTmuxSessionFields(
  line: string,
  separator: string,
  expectedCount: number
): readonly string[] | null {
  const bySeparator = line.split(separator);
  if (bySeparator.length === expectedCount) {
    return bySeparator;
  }
  const byTab = line.split("\t");
  if (byTab.length === expectedCount) {
    return byTab;
  }
  return null;
}

export const sshCommand = withHandler(sshSpec, handleSsh);
