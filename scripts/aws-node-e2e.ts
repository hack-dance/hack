type ProcessResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type AwsBootstrapPayload = {
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
  readonly aws?: {
    readonly region?: string;
    readonly instanceId?: string;
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

const parseCsv = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const requireEnv = ({ key }: { readonly key: string }): string => {
  const value = (process.env[key] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
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
    proc.stdout.text(),
    proc.stderr.text(),
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

const instanceId = (process.env.HACK_AWS_E2E_INSTANCE_ID ?? "").trim();
const instanceTagKey = (
  process.env.HACK_AWS_E2E_INSTANCE_TAG_KEY ?? "Name"
).trim();
const instanceTagValue = (
  process.env.HACK_AWS_E2E_INSTANCE_TAG_VALUE ?? ""
).trim();
const region = requireEnv({ key: "HACK_AWS_E2E_REGION" });
const profile = (process.env.HACK_AWS_E2E_PROFILE ?? "").trim();
const source = requireEnv({ key: "HACK_AWS_E2E_SOURCE" });
const endpoint = requireEnv({ key: "HACK_AWS_E2E_ENDPOINT" });
const bootstrapCommand = (
  process.env.HACK_AWS_E2E_BOOTSTRAP_COMMAND ?? ""
).trim();
const nodeName = (process.env.HACK_AWS_E2E_NODE_NAME ?? "").trim();
const labels = parseCsv(process.env.HACK_AWS_E2E_LABELS ?? "aws,e2e");
const defaultNode = boolFromEnv({
  value: process.env.HACK_AWS_E2E_DEFAULT_NODE,
  defaultValue: false,
});
const project = (process.env.HACK_AWS_E2E_PROJECT ?? "").trim();
const branch = (process.env.HACK_AWS_E2E_BRANCH ?? "").trim();
const runCommand = (process.env.HACK_AWS_E2E_RUN_COMMAND ?? "pwd").trim();
const runDevcontainer = boolFromEnv({
  value: process.env.HACK_AWS_E2E_DEVCONTAINER,
  defaultValue: false,
});

if ((instanceId ? 1 : 0) + (instanceTagValue ? 1 : 0) !== 1) {
  throw new Error(
    "Set exactly one of HACK_AWS_E2E_INSTANCE_ID or HACK_AWS_E2E_INSTANCE_TAG_VALUE."
  );
}

const bootstrapArgs: string[] = [
  "node",
  "provider",
  "aws",
  "bootstrap",
  "--json",
  "--region",
  region,
  "--source",
  source,
  "--endpoint",
  endpoint,
];

if (instanceId) {
  bootstrapArgs.push("--instance-id", instanceId);
}
if (instanceTagValue) {
  bootstrapArgs.push("--instance-tag-key", instanceTagKey);
  bootstrapArgs.push("--instance-tag-value", instanceTagValue);
}
if (profile) {
  bootstrapArgs.push("--profile", profile);
}
if (bootstrapCommand) {
  bootstrapArgs.push("--bootstrap-command", bootstrapCommand);
}
if (nodeName) {
  bootstrapArgs.push("--name", nodeName);
}
if (labels.length > 0) {
  bootstrapArgs.push("--labels", labels.join(","));
}
if (defaultNode) {
  bootstrapArgs.push("--default");
}

console.log("==> aws bootstrap");
const bootstrap = await runHack({ args: bootstrapArgs });
if (bootstrap.exitCode !== 0) {
  console.error(bootstrap.stdout);
  console.error(bootstrap.stderr);
  throw new Error(`Bootstrap failed with exit code ${bootstrap.exitCode}`);
}

const bootstrapPayload = extractJsonObject<AwsBootstrapPayload>({
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
  `Bootstrap aws_region=${bootstrapPayload.aws?.region ?? "unknown"} instance_id=${bootstrapPayload.aws?.instanceId ?? "unknown"}`
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

if (project) {
  console.log("==> dispatch run");
  const dispatchArgs = [
    "dispatch",
    "run",
    "--project",
    project,
    "--node",
    nodeId,
    "--runner",
    "generic",
    ...(branch ? ["--branch", branch] : []),
    "--",
    "sh",
    "-lc",
    runCommand,
  ];
  const dispatch = await runHack({ args: dispatchArgs });
  if (dispatch.exitCode !== 0) {
    console.error(dispatch.stdout);
    console.error(dispatch.stderr);
    throw new Error(`Dispatch run failed with exit code ${dispatch.exitCode}`);
  }
  console.log("Dispatch run passed.");
}

if (project && runDevcontainer) {
  console.log("==> devcontainer up");
  const devcontainerArgs = [
    "node",
    "devcontainer",
    "up",
    "--node",
    nodeId,
    "--project",
    project,
    ...(branch ? ["--branch", branch] : []),
    "--json",
  ];
  const devcontainer = await runHack({ args: devcontainerArgs });
  if (devcontainer.exitCode !== 0) {
    console.error(devcontainer.stdout);
    console.error(devcontainer.stderr);
    throw new Error(
      `Devcontainer up failed with exit code ${devcontainer.exitCode}`
    );
  }
  console.log("Devcontainer up passed.");
}

console.log("AWS node e2e passed.");
