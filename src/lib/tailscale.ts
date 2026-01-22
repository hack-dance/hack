import { exec, findExecutableInPath } from "./shell.ts";

/** Matches trailing dot in DNS names (e.g., "host.ts.net." -> "host.ts.net") */
const TRAILING_DOT_PATTERN = /\.$/;

/**
 * Tailscale status for the current machine.
 */
export interface TailscaleStatus {
  /** Whether Tailscale CLI is installed */
  readonly installed: boolean;
  /** Whether logged in to a Tailnet */
  readonly loggedIn: boolean;
  /** Current Tailscale hostname (e.g., "macbook") */
  readonly hostname: string | null;
  /** Full DNS name (e.g., "macbook.tail1234.ts.net") */
  readonly dnsName: string | null;
  /** Tailnet name */
  readonly tailnetName: string | null;
  /** Current Tailscale IP */
  readonly tailscaleIp: string | null;
  /** Whether Tailscale SSH is enabled on this machine */
  readonly sshEnabled: boolean;
  /** Backend state (e.g., "Running", "Stopped") */
  readonly backendState: string | null;
  /** Error message if status check failed */
  readonly error: string | null;
}

/**
 * Tailscale peer information.
 */
export interface TailscalePeer {
  readonly hostname: string;
  readonly dnsName: string;
  readonly tailscaleIp: string;
  readonly online: boolean;
  readonly os: string | null;
}

/**
 * Raw Tailscale status JSON structure (partial).
 */
interface TailscaleStatusJson {
  readonly BackendState?: string;
  readonly Self?: {
    readonly HostName?: string;
    readonly DNSName?: string;
    readonly TailscaleIPs?: readonly string[];
    readonly Capabilities?: readonly string[];
  };
  readonly CurrentTailnet?: {
    readonly Name?: string;
    readonly MagicDNSSuffix?: string;
  };
  readonly Peer?: Record<
    string,
    {
      readonly HostName?: string;
      readonly DNSName?: string;
      readonly TailscaleIPs?: readonly string[];
      readonly Online?: boolean;
      readonly OS?: string;
    }
  >;
}

/**
 * Check if Tailscale CLI is installed.
 */
export function isTailscaleInstalled(): boolean {
  return findExecutableInPath("tailscale") !== null;
}

/**
 * Get comprehensive Tailscale status.
 *
 * Uses `tailscale status --json` to get machine info.
 * All command arguments are passed as array elements (no shell interpolation).
 */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  if (!isTailscaleInstalled()) {
    return {
      installed: false,
      loggedIn: false,
      hostname: null,
      dnsName: null,
      tailnetName: null,
      tailscaleIp: null,
      sshEnabled: false,
      backendState: null,
      error: "Tailscale CLI not installed",
    };
  }

  const result = await exec(["tailscale", "status", "--json"], {
    stdin: "ignore",
  });

  if (result.exitCode !== 0) {
    // Check if it's just not logged in
    if (result.stderr.includes("not logged in")) {
      return {
        installed: true,
        loggedIn: false,
        hostname: null,
        dnsName: null,
        tailnetName: null,
        tailscaleIp: null,
        sshEnabled: false,
        backendState: "NeedsLogin",
        error: null,
      };
    }

    return {
      installed: true,
      loggedIn: false,
      hostname: null,
      dnsName: null,
      tailnetName: null,
      tailscaleIp: null,
      sshEnabled: false,
      backendState: null,
      error: result.stderr.trim() || "Failed to get Tailscale status",
    };
  }

  let json: TailscaleStatusJson;
  try {
    json = JSON.parse(result.stdout) as TailscaleStatusJson;
  } catch {
    return {
      installed: true,
      loggedIn: false,
      hostname: null,
      dnsName: null,
      tailnetName: null,
      tailscaleIp: null,
      sshEnabled: false,
      backendState: null,
      error: "Failed to parse Tailscale status JSON",
    };
  }

  const backendState = json.BackendState ?? null;
  const loggedIn = backendState === "Running";
  const self = json.Self;
  const hostname = self?.HostName ?? null;
  const dnsName = self?.DNSName?.replace(TRAILING_DOT_PATTERN, "") ?? null;
  const tailscaleIp = self?.TailscaleIPs?.[0] ?? null;
  const tailnetName = json.CurrentTailnet?.Name ?? null;

  // Check if SSH capability is present
  const capabilities = self?.Capabilities ?? [];
  const sshEnabled = capabilities.some(
    (cap) => cap.includes("ssh") || cap.includes("SSH")
  );

  return {
    installed: true,
    loggedIn,
    hostname,
    dnsName,
    tailnetName,
    tailscaleIp,
    sshEnabled,
    backendState,
    error: null,
  };
}

/**
 * Get list of Tailscale peers (other machines on the Tailnet).
 */
export async function getTailscalePeers(): Promise<TailscalePeer[]> {
  const result = await exec(["tailscale", "status", "--json"], {
    stdin: "ignore",
  });

  if (result.exitCode !== 0) {
    return [];
  }

  let json: TailscaleStatusJson;
  try {
    json = JSON.parse(result.stdout) as TailscaleStatusJson;
  } catch {
    return [];
  }

  const peers: TailscalePeer[] = [];
  const peerMap = json.Peer ?? {};

  for (const peer of Object.values(peerMap)) {
    if (peer.HostName && peer.DNSName) {
      peers.push({
        hostname: peer.HostName,
        dnsName: peer.DNSName.replace(TRAILING_DOT_PATTERN, ""),
        tailscaleIp: peer.TailscaleIPs?.[0] ?? "",
        online: peer.Online ?? false,
        os: peer.OS ?? null,
      });
    }
  }

  return peers;
}

/**
 * Generate simple SSH command for Tailscale.
 *
 * @param opts.dnsName - Tailscale DNS name (e.g., "macbook.tail1234.ts.net")
 * @param opts.user - Optional SSH username
 * @returns SSH command string
 */
export function buildTailscaleSshCommand(opts: {
  readonly dnsName: string;
  readonly user?: string;
}): string {
  const target = opts.user ? `${opts.user}@${opts.dnsName}` : opts.dnsName;
  return `ssh ${target}`;
}

/**
 * Generate simple SSH command for direct connection.
 *
 * @param opts.host - Hostname or IP address
 * @param opts.user - Optional SSH username
 * @param opts.port - Optional SSH port (default 22)
 * @returns SSH command string
 */
export function buildDirectSshCommand(opts: {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
}): string {
  const target = opts.user ? `${opts.user}@${opts.host}` : opts.host;
  const portFlag = opts.port && opts.port !== 22 ? `-p ${opts.port} ` : "";
  return `ssh ${portFlag}${target}`;
}

/**
 * Check if Tailscale SSH is working.
 */
export async function checkTailscaleSsh(): Promise<{
  readonly ok: boolean;
  readonly error: string | null;
}> {
  const status = await getTailscaleStatus();

  if (!status.installed) {
    return { ok: false, error: "Tailscale is not installed" };
  }

  if (!status.loggedIn) {
    return { ok: false, error: "Not logged in to Tailscale" };
  }

  if (!status.dnsName) {
    return { ok: false, error: "Could not determine Tailscale DNS name" };
  }

  return { ok: true, error: null };
}

/**
 * Result of Tailscale setup validation.
 */
export interface TailscaleValidation {
  readonly ready: boolean;
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
  readonly status: TailscaleStatus;
}

/**
 * Validate Tailscale is properly configured for SSH access.
 */
export async function validateTailscaleSetup(): Promise<TailscaleValidation> {
  const status = await getTailscaleStatus();
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (!status.installed) {
    issues.push("Tailscale CLI is not installed");
    suggestions.push("Install Tailscale: https://tailscale.com/download");
    return { ready: false, issues, suggestions, status };
  }

  if (!status.loggedIn) {
    issues.push("Not logged in to Tailscale");
    suggestions.push("Run: tailscale login");
    return { ready: false, issues, suggestions, status };
  }

  if (!status.dnsName) {
    issues.push("Could not determine your Tailscale hostname");
    suggestions.push("Check Tailscale status: tailscale status");
  }

  // Note: We don't strictly require Tailscale SSH to be enabled on the machine
  // since they might be connecting TO another machine that has it enabled
  if (!status.sshEnabled) {
    suggestions.push("Consider enabling Tailscale SSH: tailscale set --ssh");
  }

  const ready = issues.length === 0;
  return { ready, issues, suggestions, status };
}
