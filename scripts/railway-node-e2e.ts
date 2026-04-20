type ProcessResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type RailwayBootstrapPayload = {
  readonly node?: {
    readonly id?: string;
    readonly name?: string;
  };
  readonly endpoint?: string;
  readonly probe?: {
    readonly ok?: boolean;
    readonly status?: string;
    readonly error?: string;
  };
  readonly railway?: {
    readonly network?: string;
    readonly tailscaleAuth?: string;
  };
};

type NodeStatusPayload = {
  readonly nodes?: ReadonlyArray<{
    readonly ok?: boolean;
    readonly status?: string;
    readonly error?: string;
    readonly input?: {
      readonly id?: string;
      readonly name?: string;
    };
  }>;
};

const boolFromEnv = ({
  value,
  defaultValue,
}: {
  readonly value: string | undefined;
  readonly defaultValue: boolean;
}): boolean => {
  if (!value) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
};

const optionalBoolFromEnv = (
  value: string | undefined
): boolean | undefined => {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
};

const parseCsv = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const parsePositiveInt = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const runHack = async ({
  args,
}: {
  readonly args: readonly string[];
}): Promise<ProcessResult> => {
  const proc = Bun.spawn({
    cmd: ["hack", ...args],
    env: {
      ...process.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    stdout: stdoutBytes,
    stderr: stderrBytes,
    exitCode,
  };
};

const extractJsonObject = <T>({
  text,
}: {
  readonly text: string;
}): T | null => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  const candidate = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
};

const railwayProject = (process.env.HACK_RAILWAY_E2E_PROJECT ?? "").trim();
const railwayService = (process.env.HACK_RAILWAY_E2E_SERVICE ?? "").trim();
const railwayEnvironment = (
  process.env.HACK_RAILWAY_E2E_ENVIRONMENT ?? ""
).trim();
const railwayWorkspace = (process.env.HACK_RAILWAY_E2E_WORKSPACE ?? "").trim();
const railwayImage = (process.env.HACK_RAILWAY_E2E_IMAGE ?? "").trim();
const nodeName = (process.env.HACK_RAILWAY_E2E_NODE_NAME ?? "").trim();
const endpointOverride = (process.env.HACK_RAILWAY_E2E_ENDPOINT ?? "").trim();
const labels = parseCsv(process.env.HACK_RAILWAY_E2E_LABELS ?? "railway,e2e");
const tailscaleTags = parseCsv(process.env.HACK_RAILWAY_E2E_TAILSCALE_TAGS);
const tailscaleAuthKey = (
  process.env.HACK_RAILWAY_E2E_TAILSCALE_AUTH_KEY ?? ""
).trim();
const tailscaleHostname = (
  process.env.HACK_RAILWAY_E2E_TAILSCALE_HOSTNAME ?? ""
).trim();
const createService = optionalBoolFromEnv(
  process.env.HACK_RAILWAY_E2E_CREATE_SERVICE
);
const defaultNode = boolFromEnv({
  value: process.env.HACK_RAILWAY_E2E_DEFAULT_NODE,
  defaultValue: false,
});
const privateNetworking = optionalBoolFromEnv(
  process.env.HACK_RAILWAY_E2E_PRIVATE
);
const initRetries = parsePositiveInt(process.env.HACK_RAILWAY_E2E_INIT_RETRIES);
const domainPort = parsePositiveInt(process.env.HACK_RAILWAY_E2E_DOMAIN_PORT);

const bootstrapArgs: string[] = [
  "node",
  "provider",
  "railway",
  "bootstrap",
  "--json",
];

if (railwayProject) {
  bootstrapArgs.push("--railway-project", railwayProject);
}
if (railwayService) {
  bootstrapArgs.push("--railway-service", railwayService);
}
if (railwayEnvironment) {
  bootstrapArgs.push("--railway-environment", railwayEnvironment);
}
if (railwayWorkspace) {
  bootstrapArgs.push("--railway-workspace", railwayWorkspace);
}
if (createService === true) {
  bootstrapArgs.push("--create-service");
}
if (railwayImage) {
  bootstrapArgs.push("--railway-image", railwayImage);
}
if (nodeName) {
  bootstrapArgs.push("--name", nodeName);
}
if (endpointOverride) {
  bootstrapArgs.push("--endpoint", endpointOverride);
}
if (labels.length > 0) {
  bootstrapArgs.push("--labels", labels.join(","));
}
if (defaultNode) {
  bootstrapArgs.push("--default");
}
if (privateNetworking === true) {
  bootstrapArgs.push("--railway-private");
}
if (tailscaleAuthKey) {
  bootstrapArgs.push("--tailscale-auth-key", tailscaleAuthKey);
}
if (tailscaleHostname) {
  bootstrapArgs.push("--tailscale-hostname", tailscaleHostname);
}
if (tailscaleTags.length > 0) {
  bootstrapArgs.push("--tailscale-tags", tailscaleTags.join(","));
}
if (initRetries) {
  bootstrapArgs.push("--init-retries", String(initRetries));
}
if (domainPort) {
  bootstrapArgs.push("--domain-port", String(domainPort));
}

console.log("==> railway bootstrap");
const bootstrap = await runHack({ args: bootstrapArgs });
if (bootstrap.exitCode !== 0) {
  console.error(bootstrap.stdout);
  console.error(bootstrap.stderr);
  throw new Error(`Bootstrap failed with exit code ${bootstrap.exitCode}`);
}

const bootstrapPayload = extractJsonObject<RailwayBootstrapPayload>({
  text: bootstrap.stdout,
});
if (!bootstrapPayload?.node?.id) {
  console.error(bootstrap.stdout);
  throw new Error("Bootstrap succeeded but node id was not returned.");
}

const nodeId = bootstrapPayload.node.id;
console.log(
  `Node registered: ${bootstrapPayload.node.name ?? nodeId} (${nodeId}) endpoint=${bootstrapPayload.endpoint ?? "unknown"}`
);
console.log(
  `Bootstrap network=${bootstrapPayload.railway?.network ?? "unknown"} tailscale_auth=${bootstrapPayload.railway?.tailscaleAuth ?? "unknown"}`
);

console.log("==> node status probe");
const status = await runHack({
  args: ["node", "status", "--node", nodeId, "--json"],
});
if (status.exitCode !== 0) {
  console.error(status.stdout);
  console.error(status.stderr);
  throw new Error(`Node status failed with exit code ${status.exitCode}`);
}
const statusPayload = extractJsonObject<NodeStatusPayload>({
  text: status.stdout,
});
const snapshot =
  statusPayload?.nodes?.find((entry) => entry.input?.id === nodeId) ??
  statusPayload?.nodes?.[0];
if (!snapshot) {
  console.error(status.stdout);
  throw new Error("Node status did not return a snapshot.");
}

console.log(
  `Probe result: ok=${snapshot.ok ?? false} status=${snapshot.status ?? "unknown"} error=${snapshot.error ?? "none"}`
);
if (snapshot.ok !== true) {
  throw new Error("E2E failed: node probe is not healthy.");
}

console.log("Railway node e2e passed.");
