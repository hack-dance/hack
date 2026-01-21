import { lookup } from "node:dns/promises";
import { dirname, resolve } from "node:path";
import { confirm, isCancel, note, spinner } from "@clack/prompts";
import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import {
  DEFAULT_CADDY_IP,
  DEFAULT_GRAFANA_HOST,
  DEFAULT_INGRESS_GATEWAY,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_INGRESS_SUBNET,
  DEFAULT_LOGGING_NETWORK,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  HACK_PROJECT_DIR_PRIMARY,
} from "../constants.ts";
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts";
import { listGatewayTokens } from "../control-plane/extensions/gateway/tokens.ts";
import { requestDaemonJson } from "../daemon/client.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { buildDaemonStatusReport, readDaemonStatus } from "../daemon/status.ts";
import {
  readInternalExtraHostsIp,
  resolveGlobalCaddyIp,
} from "../lib/caddy-hosts.ts";
import { resolveGlobalConfigPath } from "../lib/config-paths.ts";
import { parseDotEnv } from "../lib/env.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { isMac } from "../lib/os.ts";
import {
  findProjectContext,
  readProjectConfig,
  readProjectDevHost,
} from "../lib/project.ts";
import { exec, findExecutableInPath, run } from "../lib/shell.ts";
import {
  renderGlobalCaddyCompose,
  renderGlobalCoreDnsConfig,
} from "../templates.ts";
import { getFzfPath } from "../ui/fzf.ts";
import { getGumPath } from "../ui/gum.ts";
import { isColorEnabled } from "../ui/terminal.ts";
import {
  analyzeComposeNetworkHygiene,
  dnsmasqConfigHasDomain,
  resolverHasNameserver,
} from "./doctor-utils.ts";

type CheckStatus = "ok" | "warn" | "error";

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
}

interface TimedCheckResult extends CheckResult {
  readonly durationMs: number;
}

const optFix = defineOption({
  name: "fix",
  type: "boolean",
  long: "--fix",
  description: "Attempt safe auto-remediations (network + CoreDNS + CA)",
} as const);

const doctorOptions = [optPath, optFix] as const;
const doctorPositionals = [] as const;

const doctorSpec = defineCommand({
  name: "doctor",
  summary:
    "Validate local setup (docker, networks, DNS, global infra, project config)",
  group: "Diagnostics",
  options: doctorOptions,
  positionals: doctorPositionals,
  subcommands: [],
} as const);

const handleDoctor: CommandHandlerFor<typeof doctorSpec> = async ({
  args,
}): Promise<number> => {
  const results: TimedCheckResult[] = [];
  const s = spinner();

  // Tools
  results.push(
    await runCheck(s, "bun", () => checkTool({ name: "bun", cmd: "bun" }))
  );
  results.push(
    await runCheck(s, "docker", () =>
      checkTool({ name: "docker", cmd: "docker" })
    )
  );
  results.push(
    await runCheck(s, "docker compose", () =>
      checkTool({ name: "docker compose", cmd: "docker" })
    )
  );
  results.push(
    await runCheck(s, "brew", () =>
      checkTool({ name: "brew (optional)", cmd: "brew", optional: true })
    )
  );
  results.push(
    await runCheck(s, "dnsmasq", () =>
      checkTool({ name: "dnsmasq (optional)", cmd: "dnsmasq", optional: true })
    )
  );
  results.push(
    await runCheck(s, "mkcert", () =>
      checkTool({ name: "mkcert (optional)", cmd: "mkcert", optional: true })
    )
  );
  results.push(await runCheck(s, "gum", () => checkOptionalGum()));
  results.push(await runCheck(s, "fzf", () => checkOptionalFzf()));
  results.push(
    await runCheck(s, "tmux", () =>
      checkTool({ name: "tmux (sessions)", cmd: "tmux", optional: true })
    )
  );
  results.push(
    await runCheck(s, "go", () =>
      checkTool({ name: "go (optional)", cmd: "go", optional: true })
    )
  );
  results.push(
    await runCheck(s, "caddy", () =>
      checkTool({ name: "caddy (optional)", cmd: "caddy", optional: true })
    )
  );
  results.push(
    await runCheck(s, "asdf", () =>
      checkTool({ name: "asdf (optional)", cmd: "asdf", optional: true })
    )
  );

  // Docker running
  results.push(
    await runCheck(s, "docker daemon", () => checkDockerRunning(), {
      timeoutMs: 5000,
    })
  );

  // Networks
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_INGRESS_NETWORK}`,
      () => checkDockerNetwork(DEFAULT_INGRESS_NETWORK),
      {
        timeoutMs: 5000,
      }
    )
  );
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_LOGGING_NETWORK}`,
      () => checkDockerNetwork(DEFAULT_LOGGING_NETWORK),
      {
        timeoutMs: 5000,
      }
    )
  );
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      () => checkIngressSubnet(),
      {
        timeoutMs: 5000,
      }
    )
  );

  // Global files
  results.push(await runCheck(s, "global files", () => checkGlobalFiles()));
  results.push(await runCheck(s, "daemon", () => checkDaemonStatus()));
  results.push(await runCheck(s, "gateway config", () => checkGatewayConfig()));
  results.push(await runCheck(s, "gateway tokens", () => checkGatewayTokens()));

  if (isMac()) {
    results.push(
      await runCheck(
        s,
        `resolver:${DEFAULT_PROJECT_TLD}`,
        () => checkMacResolverForDomain(DEFAULT_PROJECT_TLD),
        {
          timeoutMs: 1000,
        }
      )
    );
    results.push(
      await runCheck(
        s,
        `resolver:${DEFAULT_OAUTH_ALIAS_ROOT}`,
        () => checkMacResolverForDomain(DEFAULT_OAUTH_ALIAS_ROOT),
        {
          timeoutMs: 1000,
        }
      )
    );
    results.push(
      await runCheck(
        s,
        `dnsmasq.conf:${DEFAULT_PROJECT_TLD}`,
        () => checkMacDnsmasqConfigForDomain(DEFAULT_PROJECT_TLD),
        {
          timeoutMs: 1500,
        }
      )
    );
    results.push(
      await runCheck(
        s,
        `dnsmasq.conf:${DEFAULT_OAUTH_ALIAS_ROOT}`,
        () => checkMacDnsmasqConfigForDomain(DEFAULT_OAUTH_ALIAS_ROOT),
        {
          timeoutMs: 1500,
        }
      )
    );
    results.push(
      await runCheck(s, "dnsmasq:53", () => checkMacDnsmasqPort53(), {
        timeoutMs: 2000,
      })
    );
  }

  // DNS (can be very slow if wildcard DNS isn't configured)
  const dns = await runCheck(
    s,
    `dns:${DEFAULT_PROJECT_TLD}`,
    () => checkHackDns(),
    {
      timeoutMs: 1500,
    }
  );
  results.push(dns);

  const oauthDns = await runCheck(
    s,
    `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
    () => checkOauthAliasDns(),
    {
      timeoutMs: 1500,
    }
  );
  results.push(oauthDns);

  // Endpoint reachability (best-effort). Skip if DNS isn't set up.
  if (dns.status === "ok") {
    results.push(
      await runCheck(s, "grafana", () => checkGrafanaReachable(), {
        timeoutMs: 2000,
      })
    );
  } else {
    results.push({
      name: "grafana",
      status: "warn",
      message: `Skipped reachability (DNS for ${DEFAULT_GRAFANA_HOST} not configured)`,
      durationMs: 0,
    });
  }

  // Check proxy port forwarding (detects VPN/Tailscale conflicts)
  results.push(
    await runCheck(s, "proxy ports", () => checkProxyPortForwarding(), {
      timeoutMs: 5000,
    })
  );

  results.push(
    await runCheck(s, "coredns forwarding", () => checkCoreDnsForwarding(), {
      timeoutMs: 2000,
    })
  );
  results.push(
    await runCheck(s, "caddy local ca", () => checkCaddyLocalCa(), {
      timeoutMs: 1500,
    })
  );

  // Project (if in a repo or --path)
  const startDir = args.options.path
    ? resolve(process.cwd(), args.options.path)
    : process.cwd();
  const projectCtx = await runCheck(s, "project", () =>
    checkProject({ startDir })
  );
  results.push(projectCtx);

  if (projectCtx.status === "ok") {
    results.push(
      await runCheck(s, "compose networks", () =>
        checkComposeNetworkHygiene({ startDir })
      )
    );
    results.push(
      await runCheck(s, "DEV_HOST", () => checkDevHost({ startDir }))
    );
    results.push(
      await runCheck(
        s,
        "caddy hosts",
        () => checkCaddyHostMapping({ startDir }),
        {
          timeoutMs: 2000,
        }
      )
    );
  } else {
    results.push({
      name: "DEV_HOST",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
      durationMs: 0,
    });
  }

  emitSlowChecksNote(results);
  renderMacNote();

  if (args.options.fix) {
    await runDoctorFix();
    note("Re-run: hack doctor", "doctor");
  }

  const hasError = results.some((r) => r.status === "error");
  if (hasError) {
    note("Fix the errors above, then rerun: hack doctor", "doctor");
    return 1;
  }

  return 0;
};

export const doctorCommand = withHandler(doctorSpec, handleDoctor);

async function checkTool(opts: {
  readonly name: string;
  readonly cmd: string;
  readonly optional?: boolean;
}): Promise<CheckResult> {
  const path = await findExecutableInPath(opts.cmd);
  return {
    name: opts.name,
    status: path ? "ok" : opts.optional ? "warn" : "error",
    message: path
      ? path
      : opts.optional
        ? "Not found (optional)"
        : "Not found in PATH",
  };
}

async function checkOptionalGum(): Promise<CheckResult> {
  const gum = getGumPath();
  if (!gum) {
    return {
      name: "gum (optional)",
      status: "warn",
      message: "gum not found (optional)",
    };
  }
  return { name: "gum (optional)", status: "ok", message: gum };
}

async function checkOptionalFzf(): Promise<CheckResult> {
  const fzf = getFzfPath();
  if (!fzf) {
    return {
      name: "fzf (sessions)",
      status: "warn",
      message: "fzf not found (needed for hack session picker)",
    };
  }
  return { name: "fzf (sessions)", status: "ok", message: fzf };
}

async function checkDockerRunning(): Promise<CheckResult> {
  const res = await exec(["docker", "info"], { stdin: "ignore" });
  return {
    name: "docker daemon",
    status: res.exitCode === 0 ? "ok" : "error",
    message:
      res.exitCode === 0
        ? "Docker is running"
        : "Docker daemon is not reachable",
  };
}

async function checkDockerNetwork(name: string): Promise<CheckResult> {
  const res = await exec(["docker", "network", "inspect", name], {
    stdin: "ignore",
  });
  return {
    name: `network:${name}`,
    status: res.exitCode === 0 ? "ok" : "error",
    message:
      res.exitCode === 0
        ? `Exists (${name})`
        : `Missing (${name}) (run: hack global install)`,
  };
}

async function checkIngressSubnet(): Promise<CheckResult> {
  const inspect = await inspectDockerNetwork(DEFAULT_INGRESS_NETWORK);
  if (!inspect.exists) {
    return {
      name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      status: "warn",
      message: `Missing ${DEFAULT_INGRESS_NETWORK} (run: hack global install)`,
    };
  }

  if (!inspect.hasSubnet) {
    return {
      name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      status: "warn",
      message: `Missing subnet ${DEFAULT_INGRESS_SUBNET} (run: hack doctor --fix)`,
    };
  }

  return {
    name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
    status: "ok",
    message: `Subnet ${DEFAULT_INGRESS_SUBNET} present`,
  };
}

async function checkGlobalFiles(): Promise<CheckResult> {
  const home = getHomeDir();
  if (!home) {
    return {
      name: "global files",
      status: "error",
      message: "HOME is not set",
    };
  }

  const root = resolve(home, GLOBAL_HACK_DIR_NAME);
  const caddyCompose = resolve(
    root,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  const loggingCompose = resolve(
    root,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  );

  const ok =
    (await pathExists(caddyCompose)) && (await pathExists(loggingCompose));
  return {
    name: "global files",
    status: ok ? "ok" : "warn",
    message: ok
      ? root
      : `Missing compose files under ${root} (run: hack global install)`,
  };
}

async function checkDaemonStatus(): Promise<CheckResult> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });
  let apiOk = false;
  if (status.socketExists) {
    const ping = await requestDaemonJson({
      path: "/v1/status",
      timeoutMs: 500,
      allowIncompatible: true,
    });
    apiOk = ping?.ok ?? false;
  }

  const report = buildDaemonStatusReport({
    pid: status.pid,
    processRunning: status.running,
    socketExists: status.socketExists,
    logExists: status.logExists,
    apiOk,
  });

  if (report.status === "running") {
    return {
      name: "daemon",
      status: "ok",
      message: `hackd running (pid ${report.pid ?? "unknown"})`,
    };
  }

  if (report.status === "starting") {
    return {
      name: "daemon",
      status: "warn",
      message: `hackd starting (pid ${report.pid ?? "unknown"}): API not responding`,
    };
  }

  if (report.status === "stale") {
    return {
      name: "daemon",
      status: "warn",
      message: "hackd not running (stale pid/socket; run: hack daemon clear)",
    };
  }

  return {
    name: "daemon",
    status: "warn",
    message: "hackd not running (run: hack daemon start)",
  };
}

async function checkGatewayConfig(): Promise<CheckResult> {
  const resolved = await resolveGatewayConfig();
  const configPath = resolveGlobalConfigPath();
  if (!resolved.config.enabled) {
    return {
      name: "gateway config",
      status: "ok",
      message: `Gateway disabled (enable per project if needed). Global config: ${configPath}`,
    };
  }

  const warningSuffix =
    resolved.warnings.length > 0
      ? ` | warnings: ${resolved.warnings.join(" | ")}`
      : "";

  return {
    name: "gateway config",
    status: resolved.warnings.length > 0 ? "warn" : "ok",
    message: [
      `Enabled (projects: ${resolved.enabledProjects.length})`,
      `bind=${resolved.config.bind}`,
      `port=${resolved.config.port}`,
      `allowWrites=${resolved.config.allowWrites}`,
      `global=${configPath}${warningSuffix}`,
    ].join(" | "),
  };
}

async function checkGatewayTokens(): Promise<CheckResult> {
  const daemonPaths = resolveDaemonPaths({});
  const tokens = await listGatewayTokens({ rootDir: daemonPaths.root });
  const active = tokens.filter((token) => !token.revokedAt);
  const revoked = tokens.filter((token) => token.revokedAt);
  const writeTokens = active.filter((token) => token.scope === "write");
  const readTokens = active.filter((token) => token.scope === "read");

  const gateway = await resolveGatewayConfig();
  if (gateway.config.enabled && active.length === 0) {
    return {
      name: "gateway tokens",
      status: "warn",
      message: "No active tokens (run: hack x gateway token-create)",
    };
  }

  return {
    name: "gateway tokens",
    status: "ok",
    message: `active=${active.length} (write=${writeTokens.length}, read=${readTokens.length}), revoked=${revoked.length}`,
  };
}

export async function checkCoreDnsForwarding(): Promise<CheckResult> {
  const server = await resolveCoreDnsServer();
  if (!server) {
    return {
      name: "coredns forwarding",
      status: "warn",
      message: "CoreDNS not running (run: hack global up)",
    };
  }

  const ip = await queryDnsARecord({
    hostname: "example.com",
    server,
    port: 53,
    timeoutMs: 900,
  });

  return {
    name: "coredns forwarding",
    status: ip ? "ok" : "warn",
    message: ip
      ? `example.com → ${ip} (via ${server})`
      : "SERVFAIL (run: hack doctor --fix)",
  };
}

export async function checkCaddyLocalCa(): Promise<CheckResult> {
  const paths = getGlobalPaths();
  const exists = await pathExists(paths.caddyCaCert);
  return {
    name: "caddy local ca",
    status: exists ? "ok" : "warn",
    message: exists
      ? paths.caddyCaCert
      : "Missing Caddy Local CA (run: hack doctor --fix)",
  };
}

async function checkMacResolverForDomain(domain: string): Promise<CheckResult> {
  const resolverPath = `/etc/resolver/${domain}`;
  const exists = await pathExists(resolverPath);
  if (!exists) {
    return {
      name: `resolver:${domain}`,
      status: "warn",
      message: `Missing ${resolverPath} (run: hack global install)`,
    };
  }

  const text = (await readTextFile(resolverPath)) ?? "";
  const hasNameserver = resolverHasNameserver({
    text,
    nameserver: "127.0.0.1",
  });

  return {
    name: `resolver:${domain}`,
    status: hasNameserver ? "ok" : "warn",
    message: hasNameserver
      ? resolverPath
      : `Unexpected contents in ${resolverPath} (expected "nameserver 127.0.0.1")`,
  };
}

async function checkMacDnsmasqConfigForDomain(
  domain: string
): Promise<CheckResult> {
  const desiredLine = `address=/.${domain}/${DEFAULT_CADDY_IP}`;

  const brew = await findExecutableInPath("brew");
  if (!brew) {
    return {
      name: `dnsmasq.conf:${domain}`,
      status: "warn",
      message: "Homebrew not found; cannot locate dnsmasq.conf",
    };
  }

  const prefixRes = await exec(["brew", "--prefix"], { stdin: "ignore" });
  const brewPrefix =
    prefixRes.exitCode === 0 ? prefixRes.stdout.trim() : "/opt/homebrew";
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf");
  const text = await readTextFile(dnsmasqConf);

  if (text === null) {
    return {
      name: `dnsmasq.conf:${domain}`,
      status: "warn",
      message: `Unable to read ${dnsmasqConf} (run: hack global install)`,
    };
  }

  const ok = dnsmasqConfigHasDomain({ text, domain });
  return {
    name: `dnsmasq.conf:${domain}`,
    status: ok ? "ok" : "warn",
    message: ok
      ? dnsmasqConf
      : `Missing "${desiredLine}" in ${dnsmasqConf} (run: hack global install)`,
  };
}

async function checkMacDnsmasqPort53(): Promise<CheckResult> {
  const ip = await queryDnsARecord({
    hostname: DEFAULT_GRAFANA_HOST,
    server: "127.0.0.1",
    port: 53,
    timeoutMs: 900,
  });

  if (!ip) {
    return {
      name: "dnsmasq:53",
      status: "warn",
      message:
        "No DNS response from 127.0.0.1:53 (run: sudo brew services restart dnsmasq)",
    };
  }

  const ok = ip === DEFAULT_CADDY_IP || ip === "::1" || ip === "127.0.0.1";
  return {
    name: "dnsmasq:53",
    status: ok ? "ok" : "warn",
    message: `${DEFAULT_GRAFANA_HOST} → ${ip} (from 127.0.0.1:53)`,
  };
}

async function queryDnsARecord(opts: {
  readonly hostname: string;
  readonly server: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Promise<string | null> {
  // Try AAAA (IPv6) first, then fall back to A (IPv4)
  const ipv6 = await queryDnsRecord({ ...opts, recordType: "AAAA" });
  if (ipv6) {
    return ipv6;
  }
  return await queryDnsRecord({ ...opts, recordType: "A" });
}

async function queryDnsRecord(opts: {
  readonly hostname: string;
  readonly server: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly recordType: "A" | "AAAA";
}): Promise<string | null> {
  const { createSocket } = await import("node:dgram");

  const id = Math.floor(Math.random() * 65_535);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x01_00, 2); // recursion desired
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  const qname = encodeDnsName(opts.hostname);
  // A = 0x0001, AAAA = 0x001c, IN = 0x0001
  const qtype = opts.recordType === "AAAA" ? 0x00_1c : 0x00_01;
  const question = Buffer.concat([
    qname,
    Buffer.from([(qtype >> 8) & 0xff, qtype & 0xff, 0x00, 0x01]),
  ]);
  const packet = Buffer.concat([header, question]);

  return await new Promise<string | null>((resolve) => {
    const socket = createSocket("udp4");

    const finish = (value: string | null) => {
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timeout = setTimeout(() => finish(null), opts.timeoutMs);

    socket.on("message", (msg: Buffer) => {
      clearTimeout(timeout);
      finish(
        parseDnsResponse({ msg, expectedId: id, recordType: opts.recordType })
      );
    });

    socket.send(packet, opts.port, opts.server, (err: Error | null) => {
      if (err) {
        clearTimeout(timeout);
        finish(null);
      }
    });
  });
}

function encodeDnsName(hostname: string): Buffer {
  const parts = hostname.split(".").filter((p) => p.length > 0);
  const bytes: number[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, "utf8");
    bytes.push(buf.length);
    for (const b of buf) {
      bytes.push(b);
    }
  }
  bytes.push(0);
  return Buffer.from(bytes);
}

function parseDnsResponse(opts: {
  readonly msg: Buffer;
  readonly expectedId: number;
  readonly recordType: "A" | "AAAA";
}): string | null {
  if (opts.msg.length < 12) {
    return null;
  }
  const id = opts.msg.readUInt16BE(0);
  if (id !== opts.expectedId) {
    return null;
  }

  const qd = opts.msg.readUInt16BE(4);
  const an = opts.msg.readUInt16BE(6);

  let offset = 12;

  for (let i = 0; i < qd; i += 1) {
    offset = skipDnsName(opts.msg, offset);
    offset += 4; // QTYPE + QCLASS
    if (offset > opts.msg.length) {
      return null;
    }
  }

  const expectedType = opts.recordType === "AAAA" ? 28 : 1;
  const expectedRdlength = opts.recordType === "AAAA" ? 16 : 4;

  for (let i = 0; i < an; i += 1) {
    offset = skipDnsName(opts.msg, offset);
    if (offset + 10 > opts.msg.length) {
      return null;
    }
    const type = opts.msg.readUInt16BE(offset);
    const klass = opts.msg.readUInt16BE(offset + 2);
    const rdlength = opts.msg.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdlength > opts.msg.length) {
      return null;
    }

    if (type === expectedType && klass === 1 && rdlength === expectedRdlength) {
      if (opts.recordType === "A") {
        const a = opts.msg[offset];
        const b = opts.msg[offset + 1];
        const c = opts.msg[offset + 2];
        const d = opts.msg[offset + 3];
        return `${a}.${b}.${c}.${d}`;
      }
      // AAAA record - parse IPv6 address
      const parts: string[] = [];
      for (let j = 0; j < 16; j += 2) {
        const word = opts.msg.readUInt16BE(offset + j);
        parts.push(word.toString(16));
      }
      // Simplify ::1 representation
      const ipv6 = parts.join(":");
      if (ipv6 === "0:0:0:0:0:0:0:1") {
        return "::1";
      }
      return ipv6;
    }

    offset += rdlength;
  }

  return null;
}

function skipDnsName(buf: Buffer, startOffset: number): number {
  let offset = startOffset;
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === undefined) {
      return offset;
    }
    if ((len & 0b1100_0000) === 0b1100_0000) {
      return offset + 2; // pointer
    }
    if (len === 0) {
      return offset + 1;
    }
    offset += 1 + len;
  }
  return offset;
}

async function checkHackDns(): Promise<CheckResult> {
  try {
    const res = await lookup(DEFAULT_GRAFANA_HOST);
    const ok =
      res.address === DEFAULT_CADDY_IP ||
      res.address === "127.0.0.1" ||
      res.address === "::1";
    return {
      name: `dns:${DEFAULT_PROJECT_TLD}`,
      status: ok ? "ok" : "warn",
      message: `${DEFAULT_GRAFANA_HOST} → ${res.address}`,
    };
  } catch {
    return {
      name: `dns:${DEFAULT_PROJECT_TLD}`,
      status: "warn",
      message: `Unable to resolve ${DEFAULT_GRAFANA_HOST} (run: hack global install)`,
    };
  }
}

async function checkOauthAliasDns(): Promise<CheckResult> {
  const host = `logs.${DEFAULT_OAUTH_ALIAS_ROOT}`;
  try {
    const res = await lookup(host);
    const ok =
      res.address === DEFAULT_CADDY_IP ||
      res.address === "127.0.0.1" ||
      res.address === "::1";
    return {
      name: `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      status: ok ? "ok" : "warn",
      message: `${host} → ${res.address}`,
    };
  } catch {
    return {
      name: `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      status: "warn",
      message: `Unable to resolve ${host} (run: hack global install)`,
    };
  }
}

async function checkGrafanaReachable(): Promise<CheckResult> {
  // Best-effort; TLS may fail if CA isn't trusted. Don't error on this.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://${DEFAULT_GRAFANA_HOST}`, {
      signal: controller.signal,
      redirect: "manual",
    });
    clearTimeout(timeout);
    return {
      name: "grafana",
      status:
        res.ok ||
        res.status === 301 ||
        res.status === 302 ||
        res.status === 307 ||
        res.status === 308
          ? "ok"
          : "warn",
      message: `http://${DEFAULT_GRAFANA_HOST} → ${res.status}`,
    };
  } catch {
    return {
      name: "grafana",
      status: "warn",
      message: `Unable to reach http://${DEFAULT_GRAFANA_HOST} (is global infra up?)`,
    };
  }
}

/**
 * Checks if proxy port forwarding is working correctly.
 * Detects the specific issue where IPv4 port 443 fails while IPv6 works,
 * which is often caused by VPN software (e.g., Tailscale) interfering
 * with Docker/OrbStack port forwarding.
 */
async function checkProxyPortForwarding(): Promise<CheckResult> {
  const { createConnection } = await import("node:net");

  const testTcpConnect = (
    host: string,
    port: number,
    timeoutMs: number
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = createConnection({ host, port, timeout: timeoutMs });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
  };

  // Test container IP directly (primary method - bypasses port forwarding)
  const containerPort443 = await testTcpConnect(DEFAULT_CADDY_IP, 443, 2000);

  // If container IP works, everything is fine
  if (containerPort443) {
    return {
      name: "proxy ports",
      status: "ok",
      message: `Caddy reachable (${DEFAULT_CADDY_IP}:443)`,
    };
  }

  // Container IP failed, check localhost as fallback
  const [ipv4Port80, ipv4Port443] = await Promise.all([
    testTcpConnect("127.0.0.1", 80, 2000),
    testTcpConnect("127.0.0.1", 443, 2000),
  ]);

  // If localhost port 443 works, still OK
  if (ipv4Port443) {
    return {
      name: "proxy ports",
      status: "ok",
      message: "Port 80 and 443 forwarding OK (127.0.0.1)",
    };
  }

  // Both container IP and localhost fail - Caddy probably isn't running
  if (!(ipv4Port80 || ipv4Port443)) {
    return {
      name: "proxy ports",
      status: "warn",
      message: "Caddy not reachable (run: hack global up)",
    };
  }

  // Port 80 works but 443 fails - OrbStack port forwarding issue
  if (ipv4Port80 && !ipv4Port443) {
    return {
      name: "proxy ports",
      status: "warn",
      message:
        "Port 443 not forwarding properly. Fix: hack global install (configures DNS to use container IP)",
    };
  }

  return {
    name: "proxy ports",
    status: "warn",
    message: `Port forwarding partial: container=${containerPort443}, localhost:443=${ipv4Port443}`,
  };
}

async function checkProject({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (ctx) {
    return {
      name: "project",
      status: "ok",
      message: `Found ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) at ${dirname(ctx.composeFile)}`,
    };
  }
  return {
    name: "project",
    status: "warn",
    message: `No ${HACK_PROJECT_DIR_PRIMARY}/ found in current path (run 'hack init' in a repo)`,
  };
}

async function checkDevHost({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: `Missing ${HACK_PROJECT_DIR_PRIMARY}/ (run 'hack init' in a repo)`,
    };
  }

  const cfg = await readProjectConfig(ctx);
  const envHost = await readLegacyEnvDevHost(ctx.envFile);
  const configPath = cfg.configPath ?? ctx.configFile;

  if (cfg.parseError) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: envHost
        ? `Invalid ${configPath}: ${cfg.parseError} (legacy DEV_HOST=${envHost} in ${ctx.envFile})`
        : `Invalid ${configPath}: ${cfg.parseError}`,
    };
  }

  if (cfg.devHost) {
    return {
      name: "DEV_HOST",
      status: "ok",
      message: cfg.devHost,
    };
  }

  if (envHost) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: `Using legacy DEV_HOST=${envHost} from ${ctx.envFile} (move to ${ctx.configFile})`,
    };
  }

  const devHost = await readProjectDevHost(ctx);
  return {
    name: "DEV_HOST",
    status: devHost ? "ok" : "warn",
    message: devHost ? devHost : `Missing dev_host in ${configPath}`,
  };
}

async function checkCaddyHostMapping({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: `Missing ${HACK_PROJECT_DIR_PRIMARY}/ (run 'hack init' in a repo)`,
    };
  }

  const caddyIp = await resolveGlobalCaddyIp();
  if (!caddyIp) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: "Caddy not running (run: hack global up)",
    };
  }

  const mappedIp = await readInternalExtraHostsIp({
    projectDir: ctx.projectDir,
  });
  if (!mappedIp) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: "No internal extra_hosts mapping found (run: hack restart)",
    };
  }

  if (mappedIp !== caddyIp) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: `Caddy IP ${caddyIp} does not match hosts ${mappedIp} (run: hack restart)`,
    };
  }

  return {
    name: "caddy hosts",
    status: "ok",
    message: `Caddy IP ${caddyIp} matches internal host mapping`,
  };
}

async function checkComposeNetworkHygiene({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "compose networks",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }

  const yamlText = await readTextFile(ctx.composeFile);
  if (!yamlText) {
    return {
      name: "compose networks",
      status: "warn",
      message: `Unable to read ${ctx.composeFile}`,
    };
  }

  const analysis = analyzeComposeNetworkHygiene({ yamlText });
  if ("error" in analysis) {
    const message =
      analysis.error === "invalid-yaml"
        ? `Invalid YAML in ${ctx.composeFile}`
        : analysis.error === "missing-services"
          ? `Missing services in ${ctx.composeFile}`
          : `Unexpected compose format in ${ctx.composeFile}`;
    return {
      name: "compose networks",
      status: "warn",
      message,
    };
  }

  return {
    name: "compose networks",
    status: analysis.offenders.length > 0 ? "warn" : "ok",
    message:
      analysis.offenders.length > 0
        ? `Internal services attached to ${DEFAULT_INGRESS_NETWORK} without Caddy labels: ${analysis.offenders.join(", ")}`
        : "OK",
  };
}

async function readLegacyEnvDevHost(envFile: string): Promise<string | null> {
  const envText = await readTextFile(envFile);
  if (!envText) {
    return null;
  }
  const env = parseDotEnv(envText);
  const host = env.DEV_HOST;
  return typeof host === "string" && host.length > 0 ? host : null;
}

async function runDoctorFix(): Promise<void> {
  const ok = await confirm({
    message: "Attempt safe auto-remediations now? (network + CoreDNS + CA)",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    return;
  }

  const dockerOk = await exec(["docker", "info"], { stdin: "ignore" });
  if (dockerOk.exitCode !== 0) {
    note("Docker is not reachable; cannot apply fixes.", "doctor");
    return;
  }

  const daemonPaths = resolveDaemonPaths({});
  const daemonStatus = await readDaemonStatus({ paths: daemonPaths });
  let apiOk = false;
  if (daemonStatus.socketExists) {
    const ping = await requestDaemonJson({
      path: "/v1/status",
      timeoutMs: 500,
      allowIncompatible: true,
    });
    apiOk = ping?.ok ?? false;
  }

  const daemonReport = buildDaemonStatusReport({
    pid: daemonStatus.pid,
    processRunning: daemonStatus.running,
    socketExists: daemonStatus.socketExists,
    logExists: daemonStatus.logExists,
    apiOk,
  });

  if (daemonReport.status !== "running") {
    if (daemonReport.status === "stale") {
      const okStale = await confirm({
        message: "Clear stale hackd pid/socket files?",
        initialValue: true,
      });
      if (isCancel(okStale)) {
        throw new Error("Canceled");
      }
      if (okStale) {
        const invocation = await resolveHackInvocation();
        await run([invocation.bin, ...invocation.args, "daemon", "clear"], {
          stdin: "inherit",
        });
      }
    }

    const okStart = await confirm({
      message: "Start hackd now?",
      initialValue: true,
    });
    if (isCancel(okStart)) {
      throw new Error("Canceled");
    }
    if (okStart) {
      const invocation = await resolveHackInvocation();
      await run([invocation.bin, ...invocation.args, "daemon", "start"], {
        stdin: "inherit",
      });
    }
  }

  const paths = getGlobalPaths();
  await ensureDir(paths.caddyDir);

  const ingress = await inspectDockerNetwork(DEFAULT_INGRESS_NETWORK);
  if (!(ingress.exists && ingress.hasSubnet)) {
    const action = ingress.exists ? "Recreate" : "Create";
    const okNetwork = await confirm({
      message: `${action} ${DEFAULT_INGRESS_NETWORK} with subnet ${DEFAULT_INGRESS_SUBNET}?`,
      initialValue: true,
    });
    if (isCancel(okNetwork)) {
      throw new Error("Canceled");
    }
    if (okNetwork) {
      if (ingress.exists) {
        await run(["docker", "network", "rm", DEFAULT_INGRESS_NETWORK], {
          stdin: "inherit",
        });
      }
      await run(
        [
          "docker",
          "network",
          "create",
          DEFAULT_INGRESS_NETWORK,
          "--subnet",
          DEFAULT_INGRESS_SUBNET,
          "--gateway",
          DEFAULT_INGRESS_GATEWAY,
        ],
        { stdin: "inherit" }
      );
    }
  }

  const logging = await inspectDockerNetwork(DEFAULT_LOGGING_NETWORK);
  if (!logging.exists) {
    await run(["docker", "network", "create", DEFAULT_LOGGING_NETWORK], {
      stdin: "inherit",
    });
  }

  const useStaticIps = false;
  await writeWithPromptIfDifferent(
    paths.caddyCompose,
    renderGlobalCaddyCompose({
      useStaticCoreDnsIp: useStaticIps,
      useStaticCaddyIp: useStaticIps,
    })
  );
  await writeWithPromptIfDifferent(
    paths.coreDnsConfig,
    renderGlobalCoreDnsConfig({ useStaticCaddyIp: useStaticIps })
  );

  if (await pathExists(paths.caddyCompose)) {
    await run(
      [
        "docker",
        "compose",
        "-f",
        paths.caddyCompose,
        "up",
        "-d",
        "--remove-orphans",
      ],
      {
        cwd: dirname(paths.caddyCompose),
        stdin: "inherit",
      }
    );
  }

  if (!(await pathExists(paths.caddyCaCert))) {
    const okCa = await confirm({
      message: "Export Caddy Local CA cert for container trust?",
      initialValue: true,
    });
    if (isCancel(okCa)) {
      throw new Error("Canceled");
    }
    if (okCa) {
      await exportCaddyLocalCaCert({ paths });
    }
  }

  // Check for legacy localhost dnsmasq config and offer to migrate to container IP
  if (isMac()) {
    const migrationResult = await migrateDnsmasqToContainerIpIfNeeded();
    if (migrationResult === "migrated") {
      note(
        "dnsmasq migrated to container IP - port forwarding issues resolved",
        "doctor"
      );
    }
  }
}

/**
 * Check if dnsmasq has legacy localhost config and offer to migrate to container IP.
 * Using the container IP directly bypasses OrbStack port forwarding issues.
 */
async function migrateDnsmasqToContainerIpIfNeeded(): Promise<
  "migrated" | "skipped" | "not-needed"
> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    return "skipped";
  }

  const prefixRes = await exec(["brew", "--prefix"], { stdin: "ignore" });
  const brewPrefix =
    prefixRes.exitCode === 0 ? prefixRes.stdout.trim() : "/opt/homebrew";
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf");
  const text = await readTextFile(dnsmasqConf);

  if (!text) {
    return "skipped";
  }

  const containerIpHackLine = `address=/.${DEFAULT_PROJECT_TLD}/${DEFAULT_CADDY_IP}`;
  const containerIpOauthLine = `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/${DEFAULT_CADDY_IP}`;
  const legacyLines = [
    `address=/.${DEFAULT_PROJECT_TLD}/127.0.0.1`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/127.0.0.1`,
    `address=/.${DEFAULT_PROJECT_TLD}/::1`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/::1`,
  ];

  const hasContainerIp =
    text.includes(containerIpHackLine) && text.includes(containerIpOauthLine);
  const hasLegacy = legacyLines.some((line) => text.includes(line));

  if (hasContainerIp || !hasLegacy) {
    return "not-needed";
  }

  const okMigrate = await confirm({
    message: "Migrate dnsmasq to container IP? (fixes port forwarding issues)",
    initialValue: true,
  });
  if (isCancel(okMigrate)) {
    throw new Error("Canceled");
  }
  if (!okMigrate) {
    return "skipped";
  }

  // Remove legacy lines and add container IP
  let updated = text;
  for (const legacyLine of legacyLines) {
    updated = updated.replace(legacyLine, "");
  }
  updated = updated.replace(/\n{3,}/g, "\n\n").trim();
  updated = `${updated}\n${containerIpHackLine}\n${containerIpOauthLine}\n`;

  await writeTextFileIfChanged(dnsmasqConf, updated);

  // Restart dnsmasq (requires sudo)
  note("Restarting dnsmasq (requires sudo)...", "doctor");
  const restartExit = await run(
    ["sudo", "brew", "services", "restart", "dnsmasq"],
    {
      stdin: "inherit",
    }
  );

  if (restartExit !== 0) {
    note(
      `Failed to restart dnsmasq (exit ${restartExit}). Run: sudo brew services restart dnsmasq`,
      "doctor"
    );
    return "skipped";
  }

  // Flush macOS DNS cache to clear stale entries
  note("Flushing DNS cache...", "doctor");
  await run(["sudo", "dscacheutil", "-flushcache"], { stdin: "inherit" });
  await run(["sudo", "killall", "-HUP", "mDNSResponder"], { stdin: "inherit" });

  return "migrated";
}

async function inspectDockerNetwork(
  name: string
): Promise<{ exists: boolean; hasSubnet: boolean }> {
  const res = await exec(["docker", "network", "inspect", name], {
    stdin: "ignore",
  });
  if (res.exitCode !== 0) {
    return { exists: false, hasSubnet: false };
  }
  return {
    exists: true,
    hasSubnet: networkHasSubnet(res.stdout, DEFAULT_INGRESS_SUBNET),
  };
}

function networkHasSubnet(raw: string, subnet: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const ipam = (item as { IPAM?: { Config?: Array<{ Subnet?: string }> } })
      .IPAM;
    const configs = ipam?.Config ?? [];
    if (configs.some((cfg) => cfg?.Subnet === subnet)) {
      return true;
    }
  }
  return false;
}

async function resolveCoreDnsServer(): Promise<string | null> {
  const paths = getGlobalPaths();
  if (!(await pathExists(paths.caddyCompose))) {
    return null;
  }

  const ps = await exec(
    ["docker", "compose", "-f", paths.caddyCompose, "ps", "-q", "coredns"],
    {
      cwd: dirname(paths.caddyCompose),
      stdin: "ignore",
    }
  );
  const id = ps.exitCode === 0 ? ps.stdout.trim() : "";
  if (!id) {
    return null;
  }

  const inspect = await exec(
    ["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id],
    { stdin: "ignore" }
  );
  if (inspect.exitCode !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const network = (parsed as Record<string, { IPAddress?: string }>)[
    DEFAULT_INGRESS_NETWORK
  ];
  if (!network) {
    return null;
  }
  return typeof network.IPAddress === "string" && network.IPAddress.length > 0
    ? network.IPAddress
    : null;
}

async function exportCaddyLocalCaCert(opts: {
  readonly paths: GlobalPaths;
}): Promise<void> {
  const ps = await exec(
    ["docker", "compose", "-f", opts.paths.caddyCompose, "ps", "-q", "caddy"],
    {
      cwd: dirname(opts.paths.caddyCompose),
      stdin: "ignore",
    }
  );
  const id = ps.exitCode === 0 ? ps.stdout.trim() : "";
  if (!id) {
    note("Unable to locate running Caddy container for CA export.", "doctor");
    return;
  }

  await ensureDir(dirname(opts.paths.caddyCaCert));
  await run(
    [
      "docker",
      "cp",
      `${id}:/data/caddy/pki/authorities/local/root.crt`,
      opts.paths.caddyCaCert,
    ],
    { stdin: "inherit" }
  );
}

type GlobalPaths = {
  readonly root: string;
  readonly caddyDir: string;
  readonly caddyCompose: string;
  readonly coreDnsConfig: string;
  readonly caddyCaCert: string;
  readonly loggingCompose: string;
};

function getGlobalPaths(): GlobalPaths {
  const home = getHomeDir();
  if (!home) {
    throw new Error("HOME is not set");
  }
  const root = resolve(home, GLOBAL_HACK_DIR_NAME);
  const caddyDir = resolve(root, GLOBAL_CADDY_DIR_NAME);
  const caddyCompose = resolve(caddyDir, GLOBAL_CADDY_COMPOSE_FILENAME);
  const coreDnsConfig = resolve(caddyDir, GLOBAL_COREDNS_FILENAME);
  const caddyCaCert = resolve(caddyDir, "pki", "caddy-local-authority.crt");
  const loggingCompose = resolve(
    root,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  );
  return {
    root,
    caddyDir,
    caddyCompose,
    coreDnsConfig,
    caddyCaCert,
    loggingCompose,
  };
}

async function writeWithPromptIfDifferent(
  absolutePath: string,
  content: string
): Promise<void> {
  const existing = await readTextFile(absolutePath);
  if (existing === content) {
    return;
  }

  if (existing !== null) {
    const ok = await confirm({
      message: `Overwrite existing file?\n${absolutePath}`,
      initialValue: true,
    });
    if (isCancel(ok)) {
      throw new Error("Canceled");
    }
    if (!ok) {
      return;
    }
  }

  await ensureDir(dirname(absolutePath));
  await writeTextFileIfChanged(absolutePath, content);
}

function emitSlowChecksNote(results: readonly TimedCheckResult[]): void {
  const slow = results
    .filter((r) => r.durationMs >= 500)
    .map((r) => `${r.name} (${r.durationMs}ms)`);
  if (slow.length === 0) {
    return;
  }
  note(slow.join("\n"), "Slow checks");
}

function formatTimedResult(opts: {
  readonly result: CheckResult;
  readonly durationMs: number;
}): string {
  const enableColor = isColorEnabled();

  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const RED = "\x1b[31m";

  const color = (code: string, text: string) =>
    enableColor ? `${code}${text}${RESET}` : text;

  const icon =
    opts.result.status === "ok"
      ? color(GREEN, "✓")
      : opts.result.status === "warn"
        ? color(YELLOW, "!")
        : color(RED, "✗");

  const name = enableColor
    ? `${BOLD}${opts.result.name}${RESET}`
    : opts.result.name;
  const dur =
    opts.durationMs >= 250 ? color(DIM, ` (${opts.durationMs}ms)`) : "";

  return `${icon} ${name}: ${opts.result.message}${dur}`;
}

function renderMacNote(): void {
  if (isMac()) {
    note(
      [
        "macOS tip:",
        `- wildcard DNS: /etc/resolver/${DEFAULT_PROJECT_TLD} + dnsmasq address=/.${DEFAULT_PROJECT_TLD}/${DEFAULT_CADDY_IP}`,
        `- OAuth alias DNS: /etc/resolver/${DEFAULT_OAUTH_ALIAS_ROOT} + dnsmasq address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/${DEFAULT_CADDY_IP}`,
      ].join("\n"),
      "doctor"
    );
  }
}

// Keep macOS guidance at the end so it doesn't push other output off-screen.
// (Called from the command handler.)
async function runCheck(
  s: ReturnType<typeof spinner>,
  name: string,
  fn: () => Promise<CheckResult>,
  opts?: { readonly timeoutMs?: number }
): Promise<TimedCheckResult> {
  const start = Date.now();
  s.start(name);
  try {
    const res = opts?.timeoutMs
      ? await Promise.race([
          fn(),
          new Promise<CheckResult>((resolve) =>
            setTimeout(
              () => resolve({ name, status: "warn", message: "Timed out" }),
              opts.timeoutMs
            )
          ),
        ])
      : await fn();
    const durationMs = Date.now() - start;
    s.stop(formatTimedResult({ result: res, durationMs }));
    return { ...res, durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : "Unknown error";
    const res: CheckResult = { name, status: "error", message };
    s.stop(formatTimedResult({ result: res, durationMs }));
    return { ...res, durationMs };
  }
}

function getHomeDir(): string | null {
  return process.env.HOME ?? null;
}
