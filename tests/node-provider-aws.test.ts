import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  readNodeAuthToken,
  readNodesRegistry,
} from "../src/lib/nodes-registry.ts";

type CliRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type MockInstanceState = {
  readonly instanceId: string;
  readonly state: string;
};

type MockCommandInvocation = {
  readonly status: string;
  readonly stdout: string;
  readonly stderr: string;
};

type AwsMockState = {
  ec2DescribeQueue: MockInstanceState[];
  ssmInstanceInfoQueue: Array<readonly string[]>;
  commandInvocations: Record<string, MockCommandInvocation>;
  commandIds: string[];
  sentSsmCommands: string[];
  startedInstances: string[];
  describeInstanceFilters: unknown[];
  fromIniProfiles: string[];
};

const awsMockState: AwsMockState = {
  ec2DescribeQueue: [],
  ssmInstanceInfoQueue: [],
  commandInvocations: {},
  commandIds: [],
  sentSsmCommands: [],
  startedInstances: [],
  describeInstanceFilters: [],
  fromIniProfiles: [],
};

mock.module("@aws-sdk/credential-providers", () => ({
  fromIni: (input: { readonly profile?: string }) => {
    if (input.profile) {
      awsMockState.fromIniProfiles.push(input.profile);
    }
    return { __mockProfile: input.profile ?? "" };
  },
}));

mock.module("@aws-sdk/client-ec2", () => {
  class DescribeInstancesCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class StartInstancesCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class EC2Client {
    async send(command: { readonly input: Record<string, unknown> }) {
      if (command instanceof DescribeInstancesCommand) {
        awsMockState.describeInstanceFilters.push(command.input);
        const next =
          awsMockState.ec2DescribeQueue.shift() ??
          awsMockState.ec2DescribeQueue.at(-1);
        if (!next) {
          return { Reservations: [] };
        }
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: next.instanceId,
                  State: { Name: next.state },
                },
              ],
            },
          ],
        };
      }
      if (command instanceof StartInstancesCommand) {
        const ids = Array.isArray(command.input.InstanceIds)
          ? command.input.InstanceIds.filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        awsMockState.startedInstances.push(...ids);
        return {};
      }
      throw new Error("Unexpected EC2 command");
    }
  }

  return {
    EC2Client,
    DescribeInstancesCommand,
    StartInstancesCommand,
  };
});

mock.module("@aws-sdk/client-ssm", () => {
  class DescribeInstanceInformationCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class SendCommandCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class GetCommandInvocationCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class SSMClient {
    async send(command: { readonly input: Record<string, unknown> }) {
      if (command instanceof DescribeInstanceInformationCommand) {
        const onlineIds =
          awsMockState.ssmInstanceInfoQueue.shift() ??
          awsMockState.ssmInstanceInfoQueue.at(-1) ??
          [];
        return {
          InstanceInformationList: onlineIds.map((instanceId) => ({
            InstanceId: instanceId,
            PingStatus: "Online",
          })),
        };
      }
      if (command instanceof SendCommandCommand) {
        const commandId = awsMockState.commandIds.shift();
        if (!commandId) {
          throw new Error("Missing mock command id");
        }
        const parameters = command.input.Parameters as
          | {
              readonly commands?: readonly unknown[];
            }
          | undefined;
        const commands = Array.isArray(parameters?.commands)
          ? parameters.commands.filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        awsMockState.sentSsmCommands.push(commands.join("\n"));
        return {
          Command: {
            CommandId: commandId,
          },
        };
      }
      if (command instanceof GetCommandInvocationCommand) {
        const commandId =
          typeof command.input.CommandId === "string"
            ? command.input.CommandId
            : "";
        const invocation = awsMockState.commandInvocations[commandId];
        if (!invocation) {
          throw new Error(`Missing mock invocation for ${commandId}`);
        }
        return {
          Status: invocation.status,
          StandardOutputContent: invocation.stdout,
          StandardErrorContent: invocation.stderr,
        };
      }
      throw new Error("Unexpected SSM command");
    }
  }

  return {
    DescribeInstanceInformationCommand,
    GetCommandInvocationCommand,
    SendCommandCommand,
    SSMClient,
  };
});

let tempDir: string | null = null;
let server: Bun.Server<unknown> | null = null;

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
const originalLogger = process.env.HACK_LOGGER;
const originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;

const { runCli } = await import("../src/cli/run.ts");

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-node-provider-aws-"));
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = resolve(tempDir, "hack.config.json");
  process.env.HACK_SECRETS_FILE_KEY = "test-node-provider-aws-key";
  process.env.HACK_LOGGER = "console";
  process.env.HACK_SETUP_SYNC_MODE = "off";

  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH,
    `${JSON.stringify(
      {
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            allowEnvAuthRefs: true,
            encryptedFile: {
              path: resolve(tempDir, "secrets.enc.json"),
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  awsMockState.ec2DescribeQueue = [];
  awsMockState.ssmInstanceInfoQueue = [];
  awsMockState.commandInvocations = {};
  awsMockState.commandIds = [];
  awsMockState.sentSsmCommands = [];
  awsMockState.startedInstances = [];
  awsMockState.describeInstanceFilters = [];
  awsMockState.fromIniProfiles = [];

  server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        node: {
          status: "online",
        },
      });
    },
  });
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  globalThis.fetch = originalFetch;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
  if (originalSecretsKey === undefined) {
    process.env.HACK_SECRETS_FILE_KEY = undefined;
  } else {
    process.env.HACK_SECRETS_FILE_KEY = originalSecretsKey;
  }
  if (originalLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = originalLogger;
  }
  if (originalSetupSyncMode === undefined) {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  }
});

afterAll(() => {
  mock.restore();
});

test("node provider aws bootstrap registers a running instance via SSM bootstrap and preserves source metadata", async () => {
  const endpoint = resolveLocalEndpoint();
  awsMockState.ec2DescribeQueue = [
    { instanceId: "i-running", state: "running" },
  ];
  awsMockState.ssmInstanceInfoQueue = [["i-running"]];
  awsMockState.commandIds = ["cmd-bootstrap", "cmd-node-init"];
  awsMockState.commandInvocations = {
    "cmd-bootstrap": {
      status: "Success",
      stdout: "bootstrap ok",
      stderr: "",
    },
    "cmd-node-init": {
      status: "Success",
      stdout: JSON.stringify({
        bundle: {
          version: 1,
          node: {
            id: "node-aws-running",
            name: "aws-runner",
            endpoint,
            authRef: "env:HACK_NODE_AWS_TOKEN",
            labels: ["aws", "linux"],
            capabilities: ["jobs"],
            platform: "linux",
            arch: "arm64",
            version: "1.0.0",
          },
          token: "node-token-running",
        },
      }),
      stderr: "",
    },
  };

  const result = await runCliWithCapturedIo({
    argv: [
      "node",
      "provider",
      "aws",
      "bootstrap",
      "--instance-id",
      "i-running",
      "--region",
      "us-east-1",
      "--profile",
      "qa",
      "--source",
      "ec2-user@runner.internal",
      "--endpoint",
      endpoint,
      "--name",
      "aws-runner",
      "--labels",
      "aws,linux",
      "--bootstrap-command",
      "sudo systemctl start hack-node",
      "--default",
      "--json",
    ],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly provider: string;
    readonly created: boolean;
    readonly endpoint: string;
    readonly node: {
      readonly id: string;
      readonly source?: string;
      readonly endpoint: string;
      readonly status: string;
    };
  };
  expect(payload.provider).toBe("aws");
  expect(payload.created).toBe(true);
  expect(payload.endpoint).toBe(endpoint);
  expect(payload.node.id).toBe("node-aws-running");
  expect(payload.node.source).toBe("ec2-user@runner.internal");
  expect(payload.node.status).toBe("healthy");
  expect(awsMockState.startedInstances).toEqual([]);
  expect(awsMockState.fromIniProfiles).toEqual(["qa"]);
  expect(awsMockState.sentSsmCommands[0]).toContain(
    "sudo systemctl start hack-node"
  );
  expect(awsMockState.sentSsmCommands[1]).toContain("node");
  expect(awsMockState.sentSsmCommands[1]).toContain("init");

  const registry = await readNodesRegistry();
  const node = registry.nodes.find((entry) => entry.id === "node-aws-running");
  expect(node?.source).toBe("ec2-user@runner.internal");
  expect(node?.endpoint).toBe(endpoint);
  const token = await readNodeAuthToken({ authRef: "env:HACK_NODE_AWS_TOKEN" });
  expect(token).toBe("node-token-running");
});

test("node provider aws bootstrap starts stopped instances and supports tag lookup", async () => {
  const endpoint = resolveLocalEndpoint();
  awsMockState.ec2DescribeQueue = [
    { instanceId: "i-stopped", state: "stopped" },
    { instanceId: "i-stopped", state: "pending" },
    { instanceId: "i-stopped", state: "running" },
  ];
  awsMockState.ssmInstanceInfoQueue = [[], ["i-stopped"]];
  awsMockState.commandIds = ["cmd-node-init"];
  awsMockState.commandInvocations = {
    "cmd-node-init": {
      status: "Success",
      stdout: JSON.stringify({
        bundle: {
          version: 1,
          node: {
            id: "node-aws-stopped",
            name: "aws-stopped-runner",
            endpoint,
            authRef: "env:HACK_NODE_AWS_STOPPED_TOKEN",
            labels: ["aws"],
            capabilities: ["jobs"],
            platform: "linux",
            arch: "amd64",
            version: "1.0.0",
          },
          token: "node-token-stopped",
        },
      }),
      stderr: "",
    },
  };

  const result = await runCliWithCapturedIo({
    argv: [
      "node",
      "provider",
      "aws",
      "bootstrap",
      "--instance-tag-value",
      "event-agent-qa-runner",
      "--region",
      "us-east-1",
      "--source",
      "ec2-user@runner.internal",
      "--endpoint",
      endpoint,
      "--name",
      "aws-stopped-runner",
      "--json",
    ],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly provider: string;
    readonly created: boolean;
    readonly node: {
      readonly id: string;
    };
  };
  expect(payload.provider).toBe("aws");
  expect(payload.created).toBe(true);
  expect(payload.node.id).toBe("node-aws-stopped");
  expect(awsMockState.startedInstances).toEqual(["i-stopped"]);
  expect(awsMockState.describeInstanceFilters[0]).toMatchObject({
    Filters: expect.arrayContaining([
      expect.objectContaining({
        Name: "tag:Name",
        Values: ["event-agent-qa-runner"],
      }),
    ]),
  });
});

test("node provider aws inspect reports resolved instance and ssm readiness from saved defaults", async () => {
  const configPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Missing global config path");
  }
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            allowEnvAuthRefs: true,
            encryptedFile: {
              path: resolve(tempDir ?? "", "secrets.enc.json"),
            },
          },
          extensions: {
            "dance.hack.aws": {
              enabled: true,
              config: {
                instanceTagValue: "event-agent-qa-runner",
                region: "us-east-1",
                profile: "qa",
                source: "ec2-user@runner.internal",
                endpoint: "https://runner.hack",
              },
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  awsMockState.ec2DescribeQueue = [
    { instanceId: "i-inspect", state: "running" },
  ];
  awsMockState.ssmInstanceInfoQueue = [["i-inspect"]];

  const result = await runCliWithCapturedIo({
    argv: ["node", "provider", "aws", "inspect", "--json"],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly provider: string;
    readonly selectorSummary: string;
    readonly canBootstrap: boolean;
    readonly config: {
      readonly region?: string;
      readonly profile?: string;
      readonly endpoint?: string;
      readonly endpointValid: boolean;
    };
    readonly target?: {
      readonly resolved: boolean;
      readonly instanceId?: string;
      readonly state?: string;
      readonly ssmOnline?: boolean;
    };
  };
  expect(payload.provider).toBe("aws");
  expect(payload.selectorSummary).toBe("tag:Name=event-agent-qa-runner");
  expect(payload.canBootstrap).toBe(true);
  expect(payload.config.region).toBe("us-east-1");
  expect(payload.config.profile).toBe("qa");
  expect(payload.config.endpoint).toBe("https://runner.hack");
  expect(payload.config.endpointValid).toBe(true);
  expect(payload.target?.resolved).toBe(true);
  expect(payload.target?.instanceId).toBe("i-inspect");
  expect(payload.target?.state).toBe("running");
  expect(payload.target?.ssmOnline).toBe(true);
});

test("node provider aws inspect reports missing bootstrap requirements without contacting aws", async () => {
  const result = await runCliWithCapturedIo({
    argv: ["node", "provider", "aws", "inspect", "--json"],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly canBootstrap: boolean;
    readonly issues: readonly string[];
    readonly target?: {
      readonly resolved: boolean;
    };
  };
  expect(payload.canBootstrap).toBe(false);
  expect(payload.issues).toEqual(
    expect.arrayContaining([
      "Configure exactly one selector: instance id or instance tag value.",
      "Missing region.",
      "Missing SSH source.",
      "Missing gateway endpoint.",
    ])
  );
  expect(payload.target).toBeUndefined();
  expect(awsMockState.describeInstanceFilters).toEqual([]);
});

function resolveLocalEndpoint(): string {
  if (!server) {
    throw new Error("Missing local test server");
  }
  return `http://127.0.0.1:${server.port}`;
}

async function runCliWithCapturedIo(input: {
  readonly argv: readonly string[];
}): Promise<CliRunResult> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await runCli(input.argv);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
