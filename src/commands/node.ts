import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { confirm, isCancel, text } from "@clack/prompts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts";
import { createGatewayToken } from "../control-plane/extensions/gateway/tokens.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { createGatewayClient } from "../control-plane/sdk/gateway-client.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import {
  cancelNodePairingSession,
  consumeNodePairingSession,
  createNodePairingSession,
  getNodePairingSession,
  listNodePairingSessions,
  type NodePairingStatus,
} from "../lib/node-pairings-registry.ts";
import {
  deleteNodeAuthToken,
  deriveNodeHealth,
  type NodeRecord,
  type NodeStatus,
  readNodeAuthToken,
  readNodesRegistry,
  removeNodeRecord,
  saveNodeAuthToken,
  setDefaultNode,
  upsertNodeRecord,
} from "../lib/nodes-registry.ts";
import { exec } from "../lib/shell.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";
import { isTty } from "../ui/terminal.ts";

const DEFAULT_NODE_CAPABILITIES = ["runtime", "gateway", "supervisor"] as const;
const TRAILING_SLASH_PATTERN = /\/+$/;
const PROJECT_ID_LIKE_PATTERN = /^[a-f0-9]{12}$/i;
const DEFAULT_REMOTE_HACK_PATH = "$HOME/.hack/bin/hack";
const DEFAULT_RAILWAY_IMAGE = "hackdance/hack:latest";
const DEFAULT_NODE_GATEWAY_PORT = 7788;
const DEFAULT_RAILWAY_GATEWAY_PORT = DEFAULT_NODE_GATEWAY_PORT;
const DEFAULT_RAILWAY_BOOTSTRAP_RETRIES = 6;
const DEFAULT_RAILWAY_BOOTSTRAP_DELAY_MS = 5000;
const DEFAULT_RAILWAY_TAILSCALE_SOCKET = "/tmp/tailscaled.sock";
const RAILWAY_SERVICE_NAME_PATTERN = /[^a-z0-9-]+/g;
const TRAILING_DOT_PATTERN = /\.$/;
const NODE_AUTH_LOOKUP_TTL_MS = 60_000;
const NODE_STATUS_HTTP_TIMEOUT_MS = 8000;
const NODE_PREFLIGHT_HTTP_TIMEOUT_MS = 3000;
const TAILSCALE_AUTH_KEY_ENV = "HACK_TAILSCALE_AUTH_KEY";

type NodeAuthLookupCacheEntry = {
  readonly token: string | null;
  readonly error: string | null;
  readonly expiresAtMs: number;
};

type NodeAuthLookupResult =
  | {
      readonly ok: true;
      readonly token: string | null;
    }
  | { readonly ok: false; readonly error: string };

const nodeAuthLookupCache = new Map<string, NodeAuthLookupCacheEntry>();

const optName = defineOption({
  name: "name",
  type: "string",
  long: "--name",
  valueHint: "<name>",
  description: "Node display name",
} as const);

const optEndpoint = defineOption({
  name: "endpoint",
  type: "string",
  long: "--endpoint",
  valueHint: "<url>",
  description: "Reachable node gateway URL",
} as const);

const optLabels = defineOption({
  name: "labels",
  type: "string",
  long: "--labels",
  valueHint: "<a,b,c>",
  description: "Comma-separated node labels",
} as const);

const optBundle = defineOption({
  name: "bundle",
  type: "string",
  long: "--bundle",
  valueHint: "<path|->",
  description: "Enrollment bundle path, or - for stdin",
} as const);

const optSource = defineOption({
  name: "source",
  type: "string",
  long: "--source",
  valueHint: "<user@host>",
  description: "Remote SSH source host (hostname, IP, or Tailscale DNS name)",
} as const);

const optHost = defineOption({
  name: "host",
  type: "string",
  long: "--host",
  valueHint: "<host>",
  description:
    "Remote host used to infer --source and --endpoint (MagicDNS/IP)",
} as const);

const optDefault = defineOption({
  name: "defaultNode",
  type: "boolean",
  long: "--default",
  description: "Set this node as default after add",
} as const);

const optRemoteHack = defineOption({
  name: "remoteHack",
  type: "string",
  long: "--remote-hack",
  valueHint: "<cmd>",
  description:
    "Remote hack command override (default: auto-detect: $HOME/.hack/bin/hack, /opt/homebrew/bin/hack, /usr/local/bin/hack, /usr/bin/hack, then PATH)",
} as const);

const optController = defineOption({
  name: "controller",
  type: "string",
  long: "--controller",
  valueHint: "<user@host>",
  description: "Controller SSH source host that will receive pairing request",
} as const);

const optControllerSshPort = defineOption({
  name: "controllerSshPort",
  type: "number",
  long: "--controller-ssh-port",
  valueHint: "<port>",
  description: "Override SSH port used to connect to controller host",
} as const);

const optPairSession = defineOption({
  name: "session",
  type: "string",
  long: "--session",
  valueHint: "<pair-session-id>",
  description: "Pairing session id",
} as const);

const optPairCode = defineOption({
  name: "code",
  type: "string",
  long: "--code",
  valueHint: "<code>",
  description: "One-time pairing code",
} as const);

const optPairTtlMinutes = defineOption({
  name: "ttlMinutes",
  type: "number",
  long: "--ttl-minutes",
  valueHint: "<minutes>",
  description: "Pairing code TTL in minutes (default: 5)",
} as const);

const optPairStatus = defineOption({
  name: "pairStatus",
  type: "string",
  long: "--status",
  valueHint: "<pending|consumed|cancelled|expired|all>",
  description: "Filter pairing sessions by status",
} as const);

const optNode = defineOption({
  name: "node",
  type: "string",
  long: "--node",
  valueHint: "<id>",
  description: "Target a specific node id",
} as const);

const optWatch = defineOption({
  name: "watch",
  type: "boolean",
  long: "--watch",
  description: "Continuously probe node status",
} as const);

const optProject = defineOption({
  name: "project",
  type: "string",
  long: "--project",
  valueHint: "<name|id>",
  description: "Project name or id on the target node",
} as const);

const optBranch = defineOption({
  name: "branch",
  type: "string",
  long: "--branch",
  valueHint: "<branch>",
  description: "Branch to ensure before devcontainer up",
} as const);

const optSessionId = defineOption({
  name: "id",
  type: "string",
  long: "--id",
  valueHint: "<session-id>",
  description: "Devcontainer session id",
} as const);

const optIde = defineOption({
  name: "ide",
  type: "string",
  long: "--ide",
  valueHint: "<cursor|vscode|claude|codex>",
  description: "IDE target for attach instructions",
} as const);

const optSshHost = defineOption({
  name: "sshHost",
  type: "string",
  long: "--ssh-host",
  valueHint: "<host>",
  description: "Override SSH host used for attach instructions",
} as const);

const optSshPort = defineOption({
  name: "sshPort",
  type: "number",
  long: "--ssh-port",
  valueHint: "<port>",
  description: "Override SSH port for pair/attach operations",
} as const);

const optSshUser = defineOption({
  name: "sshUser",
  type: "string",
  long: "--ssh-user",
  valueHint: "<user>",
  description: "Optional SSH user for attach instructions",
} as const);

const optSshAlias = defineOption({
  name: "sshAlias",
  type: "string",
  long: "--ssh-alias",
  valueHint: "<alias>",
  description: "Optional SSH config alias for Remote-SSH attach",
} as const);

const optRailwayProject = defineOption({
  name: "railwayProject",
  type: "string",
  long: "--railway-project",
  valueHint: "<id|name>",
  description: "Railway project id or name",
} as const);

const optRailwayService = defineOption({
  name: "railwayService",
  type: "string",
  long: "--railway-service",
  valueHint: "<id|name>",
  description: "Railway service id or name",
} as const);

const optRailwayEnvironment = defineOption({
  name: "railwayEnvironment",
  type: "string",
  long: "--railway-environment",
  valueHint: "<id|name>",
  description: "Railway environment id or name (default: production)",
} as const);

const optRailwayWorkspace = defineOption({
  name: "railwayWorkspace",
  type: "string",
  long: "--railway-workspace",
  valueHint: "<id|name>",
  description: "Railway workspace id or name",
} as const);

const optRailwayCreateService = defineOption({
  name: "railwayCreateService",
  type: "boolean",
  long: "--create-service",
  description: "Create the Railway service from node-runtime image if needed",
} as const);

const optRailwayImage = defineOption({
  name: "railwayImage",
  type: "string",
  long: "--railway-image",
  valueHint: "<image-ref>",
  description: `Container image used with --create-service (default: ${DEFAULT_RAILWAY_IMAGE})`,
} as const);

const optRailwayBin = defineOption({
  name: "railwayBin",
  type: "string",
  long: "--railway-bin",
  valueHint: "<cmd>",
  description: "Railway CLI binary (default: railway)",
} as const);

const optRailwayDomainPort = defineOption({
  name: "domainPort",
  type: "number",
  long: "--domain-port",
  valueHint: "<port>",
  description:
    "Optional gateway/domain target port override (default: Railway platform port)",
} as const);

const optRailwayInitRetries = defineOption({
  name: "initRetries",
  type: "number",
  long: "--init-retries",
  valueHint: "<count>",
  description: `Retry count for remote init probe (default: ${DEFAULT_RAILWAY_BOOTSTRAP_RETRIES})`,
} as const);

const optRailwayPrivate = defineOption({
  name: "railwayPrivate",
  type: "boolean",
  long: "--railway-private",
  description:
    "Use private networking bootstrap (skip public domain generation; prefer Tailscale endpoint)",
} as const);

const optTailscaleAuthKey = defineOption({
  name: "tailscaleAuthKey",
  type: "string",
  long: "--tailscale-auth-key",
  valueHint: "<tskey-auth-...>",
  description:
    "Tailscale auth key used on remote node when --railway-private is enabled",
} as const);

const optTailscaleHostname = defineOption({
  name: "tailscaleHostname",
  type: "string",
  long: "--tailscale-hostname",
  valueHint: "<hostname>",
  description:
    "Optional Tailscale hostname override for private endpoint discovery",
} as const);

const optTailscaleTags = defineOption({
  name: "tailscaleTags",
  type: "string",
  long: "--tailscale-tags",
  valueHint: "<tag:one,tag:two>",
  description:
    "Optional advertised Tailscale tags for auth policy (comma-separated)",
} as const);

const nodeSpec = defineCommand({
  name: "node",
  summary: "Manage remote execution nodes",
  group: "Extensions",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const initSpec = defineCommand({
  name: "init",
  summary: "Initialize this host as a node and emit enrollment bundle",
  group: "Extensions",
  options: [optName, optEndpoint, optLabels, optJson],
  positionals: [],
  subcommands: [],
} as const);

const addSpec = defineCommand({
  name: "add",
  summary: "Add a node from an enrollment bundle",
  group: "Extensions",
  options: [optBundle, optDefault, optJson],
  positionals: [],
  subcommands: [],
} as const);

const pairSpec = defineCommand({
  name: "pair",
  summary: "Pair node with one-command or expiring verification-code flow",
  group: "Extensions",
  options: [
    optHost,
    optSource,
    optEndpoint,
    optName,
    optLabels,
    optDefault,
    optSshPort,
    optRemoteHack,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

const pairStartSpec = defineCommand({
  name: "start",
  summary: "Start expiring verification-code pairing session",
  group: "Extensions",
  options: [
    optHost,
    optSource,
    optEndpoint,
    optName,
    optLabels,
    optDefault,
    optPairTtlMinutes,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

const pairRequestSpec = defineCommand({
  name: "request",
  summary: "Publish pairing request to controller host",
  group: "Extensions",
  options: [
    optController,
    optControllerSshPort,
    optSource,
    optEndpoint,
    optName,
    optLabels,
    optDefault,
    optPairTtlMinutes,
    optRemoteHack,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

const pairApproveSpec = defineCommand({
  name: "approve",
  summary: "Approve pairing on node with one-time code and emit bundle",
  group: "Extensions",
  options: [
    optPairSession,
    optPairCode,
    optName,
    optEndpoint,
    optLabels,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

const pairCompleteSpec = defineCommand({
  name: "complete",
  summary: "Complete pairing on controller from approved bundle",
  group: "Extensions",
  options: [optPairSession, optBundle, optDefault, optJson],
  positionals: [],
  subcommands: [],
} as const);

const pairCancelSpec = defineCommand({
  name: "cancel",
  summary: "Cancel an in-flight pairing session",
  group: "Extensions",
  options: [optPairSession, optJson],
  positionals: [],
  subcommands: [],
} as const);

const pairWalkthroughSpec = defineCommand({
  name: "walkthrough",
  summary: "Interactive guided pairing walkthrough",
  group: "Extensions",
  options: [
    optSource,
    optEndpoint,
    optName,
    optLabels,
    optDefault,
    optSshPort,
    optRemoteHack,
    optPairTtlMinutes,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

const pairListSpec = defineCommand({
  name: "list",
  summary: "List controller pairing sessions",
  group: "Extensions",
  options: [optPairStatus, optJson],
  positionals: [],
  subcommands: [],
} as const);

const pairFulfillSpec = defineCommand({
  name: "fulfill",
  summary: "Approve + complete a pending pairing session",
  group: "Extensions",
  options: [
    optPairSession,
    optPairCode,
    optDefault,
    optSshPort,
    optRemoteHack,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

const listSpec = defineCommand({
  name: "list",
  summary: "List registered nodes",
  group: "Extensions",
  options: [optJson],
  positionals: [],
  subcommands: [],
} as const);

const statusSpec = defineCommand({
  name: "status",
  summary: "Probe node health and report live status",
  group: "Extensions",
  options: [optNode, optWatch, optJson],
  positionals: [],
  subcommands: [],
} as const);

const useSpec = defineCommand({
  name: "use",
  summary: "Set default node",
  group: "Extensions",
  options: [optJson],
  positionals: [{ name: "nodeId", required: true }],
  subcommands: [],
} as const);

const removeSpec = defineCommand({
  name: "remove",
  summary: "Remove node registration",
  group: "Extensions",
  options: [optJson],
  positionals: [{ name: "nodeId", required: true }],
  subcommands: [],
} as const);

const devcontainerSpec = defineCommand({
  name: "devcontainer",
  summary: "Manage remote node devcontainers",
  group: "Extensions",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const devcontainerUpSpec = defineCommand({
  name: "up",
  summary: "Start devcontainer on node workspace",
  group: "Extensions",
  options: [optNode, optProject, optBranch, optJson],
  positionals: [],
  subcommands: [],
} as const);

const devcontainerDownSpec = defineCommand({
  name: "down",
  summary: "Stop node devcontainer session",
  group: "Extensions",
  options: [optNode, optSessionId, optJson],
  positionals: [],
  subcommands: [],
} as const);

const devcontainerAttachSpec = defineCommand({
  name: "attach",
  summary: "Print local IDE attach instructions for node devcontainer",
  group: "Extensions",
  options: [
    optNode,
    optSessionId,
    optIde,
    optSshHost,
    optSshPort,
    optSshUser,
    optSshAlias,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

const providerSpec = defineCommand({
  name: "provider",
  summary: "Manage provider-specific node bootstrap workflows",
  group: "Extensions",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const providerRailwaySpec = defineCommand({
  name: "railway",
  summary: "Bootstrap and register nodes hosted on Railway",
  group: "Extensions",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const providerRailwayBootstrapSpec = defineCommand({
  name: "bootstrap",
  summary: "Create/configure Railway service and register it as a node",
  group: "Extensions",
  options: [
    optRailwayProject,
    optRailwayService,
    optRailwayEnvironment,
    optRailwayWorkspace,
    optRailwayCreateService,
    optRailwayImage,
    optRailwayBin,
    optName,
    optEndpoint,
    optLabels,
    optDefault,
    optRailwayDomainPort,
    optRailwayInitRetries,
    optRailwayPrivate,
    optTailscaleAuthKey,
    optTailscaleHostname,
    optTailscaleTags,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

type InitArgs = CommandArgs<
  typeof initSpec.options,
  typeof initSpec.positionals
>;
type AddArgs = CommandArgs<typeof addSpec.options, typeof addSpec.positionals>;
type PairArgs = CommandArgs<
  typeof pairSpec.options,
  typeof pairSpec.positionals
>;
type PairStartArgs = CommandArgs<
  typeof pairStartSpec.options,
  typeof pairStartSpec.positionals
>;
type PairRequestArgs = CommandArgs<
  typeof pairRequestSpec.options,
  typeof pairRequestSpec.positionals
>;
type PairApproveArgs = CommandArgs<
  typeof pairApproveSpec.options,
  typeof pairApproveSpec.positionals
>;
type PairCompleteArgs = CommandArgs<
  typeof pairCompleteSpec.options,
  typeof pairCompleteSpec.positionals
>;
type PairCancelArgs = CommandArgs<
  typeof pairCancelSpec.options,
  typeof pairCancelSpec.positionals
>;
type PairWalkthroughArgs = CommandArgs<
  typeof pairWalkthroughSpec.options,
  typeof pairWalkthroughSpec.positionals
>;
type PairListArgs = CommandArgs<
  typeof pairListSpec.options,
  typeof pairListSpec.positionals
>;
type PairFulfillArgs = CommandArgs<
  typeof pairFulfillSpec.options,
  typeof pairFulfillSpec.positionals
>;
type ListArgs = CommandArgs<
  typeof listSpec.options,
  typeof listSpec.positionals
>;
type StatusArgs = CommandArgs<
  typeof statusSpec.options,
  typeof statusSpec.positionals
>;
type UseArgs = CommandArgs<typeof useSpec.options, typeof useSpec.positionals>;
type RemoveArgs = CommandArgs<
  typeof removeSpec.options,
  typeof removeSpec.positionals
>;
type DevcontainerUpArgs = CommandArgs<
  typeof devcontainerUpSpec.options,
  typeof devcontainerUpSpec.positionals
>;
type DevcontainerDownArgs = CommandArgs<
  typeof devcontainerDownSpec.options,
  typeof devcontainerDownSpec.positionals
>;
type DevcontainerAttachArgs = CommandArgs<
  typeof devcontainerAttachSpec.options,
  typeof devcontainerAttachSpec.positionals
>;
type ProviderRailwayBootstrapArgs = CommandArgs<
  typeof providerRailwayBootstrapSpec.options,
  typeof providerRailwayBootstrapSpec.positionals
>;

type NodeEnrollmentBundle = {
  readonly version: 1;
  readonly node: {
    readonly id: string;
    readonly name: string;
    readonly labels: readonly string[];
    readonly capabilities: readonly string[];
    readonly endpoint: string;
    readonly authRef: string;
    readonly platform: string;
    readonly arch: string;
    readonly version: string;
  };
  readonly token: string;
  readonly pairing?: {
    readonly sessionId: string;
    readonly code: string;
    readonly approvedAt: string;
  };
};

export const nodeCommand = withHandler(
  defineCommand({
    ...nodeSpec,
    subcommands: [
      withHandler(initSpec, handleNodeInit),
      withHandler(
        defineCommand({
          ...pairSpec,
          subcommands: [
            withHandler(pairStartSpec, handleNodePairStart),
            withHandler(pairRequestSpec, handleNodePairRequest),
            withHandler(pairApproveSpec, handleNodePairApprove),
            withHandler(pairCompleteSpec, handleNodePairComplete),
            withHandler(pairCancelSpec, handleNodePairCancel),
            withHandler(pairWalkthroughSpec, handleNodePairWalkthrough),
            withHandler(pairListSpec, handleNodePairList),
            withHandler(pairFulfillSpec, handleNodePairFulfill),
          ],
        } as const),
        handleNodePair
      ),
      withHandler(addSpec, handleNodeAdd),
      withHandler(listSpec, handleNodeList),
      withHandler(statusSpec, handleNodeStatus),
      withHandler(useSpec, handleNodeUse),
      withHandler(removeSpec, handleNodeRemove),
      withHandler(
        defineCommand({
          ...providerSpec,
          subcommands: [
            withHandler(
              defineCommand({
                ...providerRailwaySpec,
                subcommands: [
                  withHandler(
                    providerRailwayBootstrapSpec,
                    handleNodeProviderRailwayBootstrap
                  ),
                ],
              } as const),
              async () => {
                await display.panel({
                  title: "Node provider railway commands",
                  tone: "info",
                  lines: [
                    "hack node provider railway bootstrap --railway-project <id|name> --railway-service <service> [--railway-environment production] [--endpoint <url>] [--default]",
                    "hack node provider railway bootstrap --railway-project <id|name> --create-service [--railway-service <service>] [--name <node-name>] [--railway-image hackdance/hack:latest]",
                    "hack node provider railway bootstrap --railway-project <id|name> --railway-service <service> --railway-private --tailscale-auth-key <tskey-auth-...>",
                    `hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].config.authKey' '<tskey-auth-...>'`,
                  ],
                });
                return 0;
              }
            ),
          ],
        } as const),
        async () => {
          await display.panel({
            title: "Node provider commands",
            tone: "info",
            lines: [
              "hack node provider railway bootstrap --railway-project <id|name> [--railway-service <service>|--create-service] [--railway-private --tailscale-auth-key <key>]",
            ],
          });
          return 0;
        }
      ),
      withHandler(
        defineCommand({
          ...devcontainerSpec,
          subcommands: [
            withHandler(devcontainerUpSpec, handleNodeDevcontainerUp),
            withHandler(devcontainerDownSpec, handleNodeDevcontainerDown),
            withHandler(devcontainerAttachSpec, handleNodeDevcontainerAttach),
          ],
        } as const),
        async () => {
          await display.panel({
            title: "Node devcontainer commands",
            tone: "info",
            lines: [
              "hack node devcontainer up --node <id> --project <name|id> [--branch <branch>]",
              "hack node devcontainer down --node <id> --id <session-id>",
              "hack node devcontainer attach --node <id> --id <session-id> --ide <cursor|vscode|claude|codex> [--ssh-host <host>] [--ssh-port <port>]",
            ],
          });
          return 0;
        }
      ),
    ],
  } as const),
  async () => {
    await display.panel({
      title: "Node commands",
      tone: "info",
      lines: [
        "hack node init --name <name> --endpoint <url>",
        "hack node pair --host <host> [--name <name>] [--labels a,b] [--default]",
        "hack node pair --source <user@host> --endpoint <url> [--name <name>] [--labels a,b] [--default]",
        "hack node pair request --controller <user@host> --source <user@host> [--endpoint <url>]",
        "hack node pair walkthrough [--source <user@host>] [--endpoint <url>] [--default]",
        "hack node pair list [--status pending|consumed|cancelled|expired|all]",
        "hack node pair fulfill --session <id> --code <code> [--default]",
        "hack node add --bundle <file|->",
        "hack node list",
        "hack node status [--node <id>] [--watch]",
        "hack node use <id>",
        "hack node remove <id>",
        "hack node provider railway bootstrap --railway-project <id|name> [--railway-service <service>|--create-service] [--railway-environment production] [--railway-private --tailscale-auth-key <key>]",
        "hack node devcontainer up --node <id> --project <name|id> [--branch <branch>]",
      ],
    });
    return 0;
  }
);

async function handleNodeInit({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: InitArgs;
}): Promise<number> {
  const name = (args.options.name ?? hostname()).trim();
  if (!name) {
    logger.error({ message: "Missing node name. Pass --name." });
    return 1;
  }
  const gateway = await resolveGatewayConfig();
  if (!gateway.config.enabled) {
    logger.error({
      message:
        "Gateway is not enabled on this host. Run `hack gateway setup` first.",
    });
    return 1;
  }

  const endpointRaw =
    args.options.endpoint?.trim() ||
    buildDefaultEndpoint({
      bind: gateway.config.bind,
      port: gateway.config.port,
    });
  const endpoint = endpointRaw.replace(TRAILING_SLASH_PATTERN, "");
  if (!isHttpUrl(endpoint)) {
    logger.error({ message: "Invalid --endpoint. Expected http(s) URL." });
    return 1;
  }

  const daemonPaths = resolveDaemonPaths({});
  const authRef = `node.${randomUUID()}`;
  const issued = await createGatewayToken({
    rootDir: daemonPaths.root,
    label: `node-init:${name}`,
    scope: "write",
  });

  const bundle: NodeEnrollmentBundle = {
    version: 1,
    node: {
      id: randomUUID(),
      name,
      labels: parseCsv(args.options.labels),
      capabilities: [...DEFAULT_NODE_CAPABILITIES],
      endpoint,
      authRef,
      platform: process.platform,
      arch: process.arch,
      version: Bun.version,
    },
    token: issued.token,
  };

  if (args.options.json) {
    process.stdout.write(`${JSON.stringify({ bundle }, null, 2)}\n`);
    return 0;
  }

  await display.panel({
    title: "Node enrollment bundle",
    tone: "warn",
    lines: [
      `name: ${name}`,
      `endpoint: ${endpoint}`,
      `node_id: ${bundle.node.id}`,
      "The output below includes a write token. Treat it as sensitive.",
      "Run on controller: hack node add --bundle <path>",
    ],
  });
  process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  return 0;
}

async function handleNodeAdd({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: AddArgs;
}): Promise<number> {
  const bundlePath = (args.options.bundle ?? "").trim();
  if (!bundlePath) {
    logger.error({ message: "Missing --bundle <path|->." });
    return 1;
  }
  const raw = await readBundleInput({ value: bundlePath });
  if (!raw.ok) {
    logger.error({ message: raw.error });
    return 1;
  }
  const parsed = parseEnrollmentBundle({ text: raw.text });
  if (!parsed.ok) {
    logger.error({ message: parsed.error });
    return 1;
  }
  const registered = await registerBundleOnController({
    bundle: parsed.bundle,
    makeDefault: args.options.defaultNode === true,
  });
  if (!registered.ok) {
    logger.error({ message: registered.error });
    return 1;
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          node: registered.nodeForOutput,
          created: registered.created,
          probe: {
            ok: registered.probe.ok,
            status: registered.probe.status,
            error: registered.probe.error,
          },
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.kv({
    title: registered.created ? "Node added" : "Node updated",
    entries: [
      ["id", registered.nodeForOutput.id],
      ["name", registered.nodeForOutput.name],
      ["endpoint", registered.nodeForOutput.endpoint],
      ["status", registered.probe.status],
      ["default", args.options.defaultNode ? "yes" : "no"],
    ],
  });

  if (!registered.probe.ok && registered.probe.error) {
    logger.warn({
      message: `Node added but probe failed: ${registered.probe.error}`,
    });
  }
  return 0;
}

async function handleNodePair({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairArgs;
}): Promise<number> {
  const target = await resolvePairTarget({
    source: args.options.source,
    host: args.options.host,
    endpoint: args.options.endpoint,
  });
  if (!target.ok) {
    logger.error({ message: target.error });
    return 1;
  }
  const source = target.source;
  const endpoint = target.endpoint;
  const remoteHack = normalizeRemoteHackOverride({
    value: args.options.remoteHack,
  });

  const pairingName = derivePairingName({
    explicitName: args.options.name,
    source,
  });
  const labels = parseCsv(args.options.labels);
  const remoteInit = await runRemoteNodeInit({
    source,
    endpoint,
    name: pairingName,
    labels,
    sshPort: args.options.sshPort,
    remoteHack,
  });
  if (!remoteInit.ok) {
    logger.error({ message: remoteInit.error });
    return 1;
  }

  const parsed = parseEnrollmentBundleFromRemoteOutput({
    text: remoteInit.stdout,
  });
  if (!parsed.ok) {
    logger.error({
      message: `Remote node did not return a valid enrollment bundle: ${parsed.error}`,
    });
    return 1;
  }
  const registered = await registerBundleOnController({
    bundle: parsed.bundle,
    makeDefault: args.options.defaultNode === true,
  });
  if (!registered.ok) {
    logger.error({ message: registered.error });
    return 1;
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          source,
          endpointVerified: true,
          node: registered.nodeForOutput,
          created: registered.created,
          probe: {
            ok: registered.probe.ok,
            status: registered.probe.status,
            error: registered.probe.error,
          },
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.kv({
    title: registered.created ? "Node paired" : "Node re-paired",
    entries: [
      ["source", source],
      ["id", registered.nodeForOutput.id],
      ["name", registered.nodeForOutput.name],
      ["endpoint", registered.nodeForOutput.endpoint],
      ["status", registered.probe.status],
      ["default", args.options.defaultNode ? "yes" : "no"],
    ],
  });

  if (!registered.probe.ok && registered.probe.error) {
    logger.warn({
      message: `Node paired but probe failed: ${registered.probe.error}`,
    });
  }
  return 0;
}

async function handleNodePairStart({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairStartArgs;
}): Promise<number> {
  const target = await resolvePairTarget({
    source: args.options.source,
    host: args.options.host,
    endpoint: args.options.endpoint,
  });
  if (!target.ok) {
    logger.error({ message: target.error });
    return 1;
  }
  const source = target.source;
  const endpoint = target.endpoint;
  const name = derivePairingName({
    explicitName: args.options.name,
    source,
  });
  const labels = parseCsv(args.options.labels);
  const ttlMinutes = Math.max(1, Math.trunc(args.options.ttlMinutes ?? 5));
  const created = await createNodePairingSession({
    source,
    endpoint,
    ttlMs: ttlMinutes * 60 * 1000,
  });
  const commandSet = buildPairingCommandSet({
    source,
    endpoint,
    name,
    labels,
    defaultNode: args.options.defaultNode === true,
    sessionId: created.session.id,
    code: created.code,
  });

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          session: created.session,
          code: created.code,
          source,
          endpoint,
          commands: commandSet,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.panel({
    title: "Pairing session started",
    tone: "warn",
    lines: [
      `session_id: ${created.session.id}`,
      `code: ${created.code}`,
      `expires_at: ${created.session.expiresAt}`,
      "Run on remote node (or via SSH):",
      `  ${commandSet.approveRemote}`,
      "Then complete on controller:",
      `  ${commandSet.completeController}`,
      "One-liner (controller executes SSH + complete):",
      `  ${commandSet.endToEnd}`,
    ],
  });
  return 0;
}

async function handleNodePairRequest({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairRequestArgs;
}): Promise<number> {
  const controller = (args.options.controller ?? "").trim();
  if (!controller) {
    logger.error({ message: "Missing --controller <user@host>." });
    return 1;
  }
  const source = (args.options.source ?? "").trim();
  if (!source) {
    logger.error({ message: "Missing --source <user@host>." });
    return 1;
  }
  const remoteHack = normalizeRemoteHackOverride({
    value: args.options.remoteHack,
  });

  let endpoint = (args.options.endpoint ?? "").trim();
  if (!endpoint) {
    const gateway = await resolveGatewayConfig();
    if (!gateway.config.enabled) {
      logger.error({
        message:
          "Missing --endpoint and local gateway is disabled. Run `hack gateway setup` or pass --endpoint.",
      });
      return 1;
    }
    endpoint = buildDefaultEndpoint({
      bind: gateway.config.bind,
      port: gateway.config.port,
    });
  }
  endpoint = endpoint.replace(TRAILING_SLASH_PATTERN, "");
  if (!isHttpUrl(endpoint)) {
    logger.error({ message: "Missing or invalid --endpoint <url>." });
    return 1;
  }

  const name = derivePairingName({
    explicitName: args.options.name,
    source,
  });
  const labels = parseCsv(args.options.labels);
  const ttlMinutes = Math.max(1, Math.trunc(args.options.ttlMinutes ?? 5));
  const request = await runControllerPairStart({
    controller,
    controllerSshPort: args.options.controllerSshPort,
    remoteHack,
    source,
    endpoint,
    name,
    labels,
    defaultNode: args.options.defaultNode === true,
    ttlMinutes,
  });
  if (!request.ok) {
    logger.error({ message: request.error });
    return 1;
  }

  const parsed = parsePairStartResponseOutput({ text: request.stdout });
  if (!parsed.ok) {
    logger.error({
      message: `Controller did not return valid pairing request payload: ${parsed.error}`,
    });
    return 1;
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          controller,
          source,
          endpoint,
          request: parsed.payload,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.panel({
    title: "Pairing request published",
    tone: "success",
    lines: [
      `controller: ${controller}`,
      `session_id: ${parsed.payload.session.id}`,
      `code: ${parsed.payload.code}`,
      `expires_at: ${parsed.payload.session.expiresAt}`,
      "Open controller Settings → Topology → Pairing requests to approve.",
    ],
  });
  return 0;
}

async function handleNodePairApprove({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairApproveArgs;
}): Promise<number> {
  const sessionId = (args.options.session ?? "").trim();
  if (!sessionId) {
    logger.error({ message: "Missing --session <pair-session-id>." });
    return 1;
  }
  const code = (args.options.code ?? "").trim();
  if (!code) {
    logger.error({ message: "Missing --code <code>." });
    return 1;
  }
  const name = (args.options.name ?? hostname()).trim();
  if (!name) {
    logger.error({ message: "Missing node name. Pass --name." });
    return 1;
  }
  const gateway = await resolveGatewayConfig();
  if (!gateway.config.enabled) {
    logger.error({
      message:
        "Gateway is not enabled on this host. Run `hack gateway setup` first.",
    });
    return 1;
  }
  const endpointRaw =
    args.options.endpoint?.trim() ||
    buildDefaultEndpoint({
      bind: gateway.config.bind,
      port: gateway.config.port,
    });
  const endpoint = endpointRaw.replace(TRAILING_SLASH_PATTERN, "");
  if (!isHttpUrl(endpoint)) {
    logger.error({ message: "Invalid --endpoint. Expected http(s) URL." });
    return 1;
  }

  const daemonPaths = resolveDaemonPaths({});
  const authRef = `node.${randomUUID()}`;
  const issued = await createGatewayToken({
    rootDir: daemonPaths.root,
    label: `node-pair:${name}`,
    scope: "write",
  });
  const bundle: NodeEnrollmentBundle = {
    version: 1,
    node: {
      id: randomUUID(),
      name,
      labels: parseCsv(args.options.labels),
      capabilities: [...DEFAULT_NODE_CAPABILITIES],
      endpoint,
      authRef,
      platform: process.platform,
      arch: process.arch,
      version: Bun.version,
    },
    token: issued.token,
    pairing: {
      sessionId,
      code,
      approvedAt: new Date().toISOString(),
    },
  };
  if (args.options.json) {
    process.stdout.write(`${JSON.stringify({ bundle }, null, 2)}\n`);
    return 0;
  }
  await display.panel({
    title: "Pairing approval bundle",
    tone: "warn",
    lines: [
      `session_id: ${sessionId}`,
      "Output includes a write token + one-time code attestation.",
      "Return this bundle to controller: hack node pair complete --session <id> --bundle <path|->",
    ],
  });
  process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  return 0;
}

async function handleNodePairComplete({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairCompleteArgs;
}): Promise<number> {
  const sessionId = (args.options.session ?? "").trim();
  if (!sessionId) {
    logger.error({ message: "Missing --session <pair-session-id>." });
    return 1;
  }
  const bundlePath = (args.options.bundle ?? "").trim();
  if (!bundlePath) {
    logger.error({ message: "Missing --bundle <path|->." });
    return 1;
  }
  const raw = await readBundleInput({ value: bundlePath });
  if (!raw.ok) {
    logger.error({ message: raw.error });
    return 1;
  }
  const parsed = parseEnrollmentBundleFromRemoteOutput({ text: raw.text });
  if (!parsed.ok) {
    logger.error({ message: parsed.error });
    return 1;
  }
  const completed = await completePairingWithBundle({
    sessionId,
    bundle: parsed.bundle,
    makeDefault: args.options.defaultNode === true,
  });
  if (!completed.ok) {
    logger.error({ message: completed.error });
    return 1;
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          node: completed.nodeForOutput,
          created: completed.created,
          pairing: {
            sessionId,
            consumedAt: completed.consumedAt ?? null,
          },
          probe: {
            ok: completed.probe.ok,
            status: completed.probe.status,
            error: completed.probe.error,
          },
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.kv({
    title: completed.created
      ? "Node paired (verified)"
      : "Node updated (verified)",
    entries: [
      ["session_id", sessionId],
      ["id", completed.nodeForOutput.id],
      ["name", completed.nodeForOutput.name],
      ["endpoint", completed.nodeForOutput.endpoint],
      ["status", completed.probe.status],
      ["default", args.options.defaultNode ? "yes" : "no"],
    ],
  });
  return 0;
}

async function handleNodePairCancel({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairCancelArgs;
}): Promise<number> {
  const sessionId = (args.options.session ?? "").trim();
  if (!sessionId) {
    logger.error({ message: "Missing --session <pair-session-id>." });
    return 1;
  }
  const cancelled = await cancelNodePairingSession({ sessionId });
  if (!cancelled.cancelled) {
    logger.error({ message: `Pairing session not cancelled: ${sessionId}` });
    return 1;
  }
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ cancelled: true, sessionId }, null, 2)}\n`
    );
    return 0;
  }
  logger.success({ message: `Cancelled pairing session ${sessionId}` });
  return 0;
}

async function handleNodePairList({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairListArgs;
}): Promise<number> {
  const status = parsePairStatusFilter({
    value: args.options.pairStatus,
  });
  if (!status.ok) {
    logger.error({ message: status.error });
    return 1;
  }

  const sessions = await listNodePairingSessions({
    status: status.value,
  });
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ sessions, status: status.value }, null, 2)}\n`
    );
    return 0;
  }

  if (!sessions.length) {
    logger.info({
      message: "No pairing sessions found for selected status filter.",
    });
    return 0;
  }

  await display.table({
    columns: ["session_id", "status", "source", "endpoint", "expires_at"],
    rows: sessions.map((session) => [
      session.id,
      session.status,
      session.source,
      session.endpoint,
      session.expiresAt,
    ]),
  });
  return 0;
}

async function handleNodePairFulfill({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairFulfillArgs;
}): Promise<number> {
  const sessionId = (args.options.session ?? "").trim();
  if (!sessionId) {
    logger.error({ message: "Missing --session <pair-session-id>." });
    return 1;
  }
  const code = (args.options.code ?? "").trim();
  if (!code) {
    logger.error({ message: "Missing --code <code>." });
    return 1;
  }
  const remoteHack = normalizeRemoteHackOverride({
    value: args.options.remoteHack,
  });

  const session = await getNodePairingSession({ sessionId });
  if (!session) {
    logger.error({ message: `Unknown pairing session: ${sessionId}` });
    return 1;
  }
  if (session.status !== "pending") {
    logger.error({
      message: `Pairing session is not pending (status=${session.status}).`,
    });
    return 1;
  }

  const name = derivePairingName({
    explicitName: undefined,
    source: session.source,
  });
  const labels: string[] = [];
  const commandSet = buildPairingCommandSet({
    source: session.source,
    endpoint: session.endpoint,
    name,
    labels,
    defaultNode: args.options.defaultNode === true,
    sessionId,
    code,
  });

  const approved = await runRemotePairApprove({
    source: session.source,
    endpoint: session.endpoint,
    name,
    labels,
    sessionId,
    code,
    sshPort: args.options.sshPort,
    remoteHack,
  });
  if (!approved.ok) {
    logger.error({ message: approved.error });
    logger.info({ message: `Retry manually: ${commandSet.endToEnd}` });
    return 1;
  }

  const parsed = parseEnrollmentBundleFromRemoteOutput({
    text: approved.stdout,
  });
  if (!parsed.ok) {
    logger.error({
      message: `Failed to parse remote approval bundle: ${parsed.error}`,
    });
    return 1;
  }

  const completed = await completePairingWithBundle({
    sessionId,
    bundle: parsed.bundle,
    makeDefault: args.options.defaultNode === true,
  });
  if (!completed.ok) {
    logger.error({ message: completed.error });
    return 1;
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          node: completed.nodeForOutput,
          created: completed.created,
          pairing: {
            sessionId,
            consumedAt: completed.consumedAt ?? null,
          },
          probe: {
            ok: completed.probe.ok,
            status: completed.probe.status,
            error: completed.probe.error,
          },
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.kv({
    title: completed.created
      ? "Node paired (fulfilled)"
      : "Node updated (fulfilled)",
    entries: [
      ["session_id", sessionId],
      ["id", completed.nodeForOutput.id],
      ["name", completed.nodeForOutput.name],
      ["endpoint", completed.nodeForOutput.endpoint],
      ["status", completed.probe.status],
      ["default", args.options.defaultNode ? "yes" : "no"],
    ],
  });
  return 0;
}

async function handleNodePairWalkthrough({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PairWalkthroughArgs;
}): Promise<number> {
  const input = await resolvePairWalkthroughInput({
    args,
  });
  if (!input.ok) {
    if (input.cancelled) {
      logger.info({ message: "Pair walkthrough cancelled." });
      return 0;
    }
    logger.error({ message: input.error });
    return 1;
  }

  const preflight = await preflightNodeEndpoint({ endpoint: input.endpoint });
  if (!preflight.ok) {
    logger.error({ message: `Endpoint preflight failed: ${preflight.error}` });
    return 1;
  }

  const created = await createNodePairingSession({
    source: input.source,
    endpoint: input.endpoint,
    ttlMs: input.ttlMinutes * 60 * 1000,
  });
  const commandSet = buildPairingCommandSet({
    source: input.source,
    endpoint: input.endpoint,
    name: input.name,
    labels: input.labels,
    defaultNode: input.defaultNode,
    sessionId: created.session.id,
    code: created.code,
  });

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          session: created.session,
          code: created.code,
          input: {
            source: input.source,
            endpoint: input.endpoint,
            name: input.name,
            labels: input.labels,
            defaultNode: input.defaultNode,
          },
          commands: commandSet,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.panel({
    title: "Pair walkthrough",
    tone: "info",
    lines: [
      `session_id: ${created.session.id}`,
      `code: ${created.code}`,
      `expires_at: ${created.session.expiresAt}`,
      `source: ${input.source}`,
      `endpoint: ${input.endpoint}`,
      "Run automatically now, or use these commands manually:",
      `  approve (remote): ${commandSet.approveRemote}`,
      `  complete (controller): ${commandSet.completeController}`,
      `  end-to-end one-liner: ${commandSet.endToEnd}`,
    ],
  });

  const executeNow = await confirm({
    message: "Execute remote approval and complete pairing now?",
    initialValue: true,
  });
  if (isCancel(executeNow)) {
    await cancelNodePairingSession({ sessionId: created.session.id });
    logger.info({
      message:
        "Pairing session cancelled. Re-run `hack node pair walkthrough` when ready.",
    });
    return 0;
  }
  if (!executeNow) {
    logger.info({
      message:
        "Session left pending. Complete manually with the commands above before expiry.",
    });
    return 0;
  }

  const approved = await runRemotePairApprove({
    source: input.source,
    endpoint: input.endpoint,
    name: input.name,
    labels: input.labels,
    sessionId: created.session.id,
    code: created.code,
    sshPort: input.sshPort,
    remoteHack: input.remoteHack,
  });
  if (!approved.ok) {
    logger.error({ message: approved.error });
    logger.info({
      message: `Retry manually: ${commandSet.endToEnd}`,
    });
    return 1;
  }

  const parsed = parseEnrollmentBundleFromRemoteOutput({
    text: approved.stdout,
  });
  if (!parsed.ok) {
    logger.error({
      message: `Failed to parse remote approval bundle: ${parsed.error}`,
    });
    return 1;
  }

  const completed = await completePairingWithBundle({
    sessionId: created.session.id,
    bundle: parsed.bundle,
    makeDefault: input.defaultNode,
  });
  if (!completed.ok) {
    logger.error({ message: completed.error });
    return 1;
  }

  await display.kv({
    title: completed.created
      ? "Walkthrough pairing complete"
      : "Walkthrough pairing updated",
    entries: [
      ["session_id", created.session.id],
      ["node_id", completed.nodeForOutput.id],
      ["node_name", completed.nodeForOutput.name],
      ["endpoint", completed.nodeForOutput.endpoint],
      ["status", completed.probe.status],
      ["default", input.defaultNode ? "yes" : "no"],
    ],
  });
  return 0;
}

type PairWalkthroughResolvedInput = {
  readonly ok: true;
  readonly source: string;
  readonly endpoint: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly defaultNode: boolean;
  readonly ttlMinutes: number;
  readonly sshPort: number | undefined;
  readonly remoteHack: string | undefined;
};

type PairWalkthroughError = {
  readonly ok: false;
  readonly cancelled: boolean;
  readonly error: string;
};

type PairWalkthroughResult =
  | PairWalkthroughResolvedInput
  | PairWalkthroughError;

type PairWalkthroughValue = {
  readonly ok: true;
  readonly value: string;
};

type PairWalkthroughValueResult = PairWalkthroughValue | PairWalkthroughError;

/**
 * Resolves pair walkthrough input from flags or interactive prompts.
 */
async function resolvePairWalkthroughInput(input: {
  readonly args: PairWalkthroughArgs;
}): Promise<PairWalkthroughResult> {
  const interactive = isTty();
  const sourceResult = await resolveRequiredWalkthroughValue({
    currentValue: input.args.options.source,
    interactive,
    missingError: "Missing --source <user@host> in non-interactive mode.",
    message: "Remote SSH source (user@host):",
    placeholder: "ubuntu@helsinki.tail8fedfd.ts.net",
    validate: (value) =>
      value.trim().length ? undefined : "Source is required",
  });
  if (!sourceResult.ok) {
    return sourceResult;
  }
  const source = sourceResult.value;

  const endpointResult = await resolveRequiredWalkthroughValue({
    currentValue: input.args.options.endpoint,
    interactive,
    missingError: "Missing --endpoint <url> in non-interactive mode.",
    message: "Reachable gateway endpoint URL:",
    placeholder: "http://127.0.0.1:7788",
    validate: (value) =>
      isHttpUrl(value.trim()) ? undefined : "Valid http(s) URL required",
  });
  if (!endpointResult.ok) {
    return endpointResult;
  }
  const endpoint = endpointResult.value;

  const name = await resolveWalkthroughName({
    explicitName: input.args.options.name,
    source,
    interactive,
  });
  if (!name.ok) {
    return name;
  }

  const labels = await resolveWalkthroughLabels({
    labels: input.args.options.labels,
    interactive,
  });
  if (!labels.ok) {
    return labels;
  }

  const defaultNode = await resolveWalkthroughDefaultNode({
    explicitDefault: input.args.options.defaultNode === true,
    interactive,
  });
  if (!defaultNode.ok) {
    return defaultNode;
  }

  const ttlMinutes = await resolveWalkthroughTtlMinutes({
    ttlMinutes: input.args.options.ttlMinutes,
    interactive,
  });
  if (!ttlMinutes.ok) {
    return ttlMinutes;
  }

  const remoteHack = normalizeRemoteHackOverride({
    value: input.args.options.remoteHack,
  });

  return {
    ok: true,
    source,
    endpoint,
    name: name.value,
    labels: labels.value,
    defaultNode: defaultNode.value,
    ttlMinutes: ttlMinutes.value,
    sshPort: input.args.options.sshPort,
    remoteHack,
  };
}

/**
 * Resolves a required string value from an explicit flag or prompt.
 */
async function resolveRequiredWalkthroughValue(input: {
  readonly currentValue: string | undefined;
  readonly interactive: boolean;
  readonly missingError: string;
  readonly message: string;
  readonly placeholder?: string;
  readonly validate?: (value: string) => string | undefined;
}): Promise<PairWalkthroughValueResult> {
  const currentValue = (input.currentValue ?? "").trim();
  if (currentValue.length) {
    return { ok: true, value: currentValue };
  }
  if (!input.interactive) {
    return buildPairWalkthroughError({
      cancelled: false,
      error: input.missingError,
    });
  }

  const answer = await text({
    message: input.message,
    placeholder: input.placeholder,
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed.length) {
        return "Value is required";
      }
      return input.validate?.(trimmed);
    },
  });
  if (isCancel(answer)) {
    return buildCancelledPairWalkthroughError();
  }
  return { ok: true, value: answer.trim() };
}

/**
 * Resolves the display name, defaulting to source host when not provided.
 */
async function resolveWalkthroughName(input: {
  readonly explicitName: string | undefined;
  readonly source: string;
  readonly interactive: boolean;
}): Promise<PairWalkthroughValueResult> {
  const nameDefault = derivePairingName({
    explicitName: input.explicitName,
    source: input.source,
  });
  if (input.explicitName || !input.interactive) {
    return { ok: true, value: nameDefault };
  }

  const answer = await text({
    message: "Node display name:",
    initialValue: nameDefault,
    validate: (value) =>
      (value ?? "").trim().length ? undefined : "Name is required",
  });
  if (isCancel(answer)) {
    return buildCancelledPairWalkthroughError();
  }
  return { ok: true, value: answer.trim() };
}

/**
 * Resolves optional labels from CLI or prompt.
 */
async function resolveWalkthroughLabels(input: {
  readonly labels: string | undefined;
  readonly interactive: boolean;
}): Promise<
  { readonly ok: true; readonly value: string[] } | PairWalkthroughError
> {
  if (input.labels) {
    return { ok: true, value: parseCsv(input.labels) };
  }
  if (!input.interactive) {
    return { ok: true, value: [] };
  }

  const answer = await text({
    message: "Node labels (optional comma-separated):",
    placeholder: "aws,dev,laptop",
  });
  if (isCancel(answer)) {
    return buildCancelledPairWalkthroughError();
  }
  return { ok: true, value: parseCsv(answer) };
}

/**
 * Resolves default-node behavior, prompting in interactive mode when unset.
 */
async function resolveWalkthroughDefaultNode(input: {
  readonly explicitDefault: boolean;
  readonly interactive: boolean;
}): Promise<
  { readonly ok: true; readonly value: boolean } | PairWalkthroughError
> {
  if (input.explicitDefault || !input.interactive) {
    return { ok: true, value: input.explicitDefault };
  }

  const answer = await confirm({
    message: "Set this as default node on controller?",
    initialValue: true,
  });
  if (isCancel(answer)) {
    return buildCancelledPairWalkthroughError();
  }
  return { ok: true, value: answer === true };
}

/**
 * Resolves TTL minutes, enforcing an integer floor of 1.
 */
async function resolveWalkthroughTtlMinutes(input: {
  readonly ttlMinutes: number | undefined;
  readonly interactive: boolean;
}): Promise<
  { readonly ok: true; readonly value: number } | PairWalkthroughError
> {
  if (input.ttlMinutes !== undefined) {
    return { ok: true, value: sanitizeTtlMinutes(input.ttlMinutes) };
  }
  if (!input.interactive) {
    return { ok: true, value: 5 };
  }

  const answer = await text({
    message: "Pairing code TTL (minutes):",
    initialValue: "5",
    validate: (value) => {
      const parsed = Number.parseInt((value ?? "").trim(), 10);
      return Number.isFinite(parsed) && parsed >= 1
        ? undefined
        : "Enter an integer >= 1";
    },
  });
  if (isCancel(answer)) {
    return buildCancelledPairWalkthroughError();
  }
  return {
    ok: true,
    value: sanitizeTtlMinutes(Number.parseInt(answer.trim(), 10)),
  };
}

function sanitizeTtlMinutes(ttlMinutes: number): number {
  return Math.max(1, Math.trunc(ttlMinutes));
}

function buildCancelledPairWalkthroughError(): PairWalkthroughError {
  return buildPairWalkthroughError({ cancelled: true, error: "Cancelled." });
}

function buildPairWalkthroughError(input: {
  readonly cancelled: boolean;
  readonly error: string;
}): PairWalkthroughError {
  return { ok: false, cancelled: input.cancelled, error: input.error };
}

async function handleNodeList({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ListArgs;
}): Promise<number> {
  const registry = await readNodesRegistry();
  const config = await readControlPlaneConfig({});
  const staleAfterMs = config.config.cluster.staleAfterMs;
  const offlineAfterMs = config.config.cluster.offlineAfterMs;

  const rows = registry.nodes.map((node) => {
    const derived = deriveNodeHealth({
      lastSeenAt: node.lastSeenAt,
      staleAfterMs,
      offlineAfterMs,
    });
    return {
      ...node,
      status: node.status ?? derived,
      isDefault: registry.defaultNodeId === node.id,
    };
  });

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          defaultNodeId: registry.defaultNodeId,
          nodes: rows,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (rows.length === 0) {
    await display.panel({
      title: "Nodes",
      tone: "info",
      lines: [
        "No nodes registered.",
        "Create bundle on node: hack node init --name <name> --endpoint <url>",
        "Register on controller: hack node add --bundle <path>",
      ],
    });
    return 0;
  }

  await display.table({
    columns: ["Id", "Name", "Status", "Endpoint", "Default", "Last Seen"],
    rows: rows.map((node) => [
      node.id,
      node.name,
      node.status ?? "unknown",
      node.endpoint,
      node.isDefault ? "yes" : "",
      node.lastSeenAt ?? "",
    ]),
  });
  return 0;
}

async function handleNodeStatus({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: StatusArgs;
}): Promise<number> {
  const watch = args.options.watch === true;
  const targetNodeId = (args.options.node ?? "").trim() || null;

  while (true) {
    const registry = await readNodesRegistry();
    const targets = resolveStatusTargets({
      nodes: registry.nodes,
      targetNodeId,
    });
    if (!targets.ok) {
      logger.error({
        message: targets.error,
      });
      return 1;
    }

    const snapshots = await Promise.all(
      targets.nodes.map((node) => probeNode({ node }))
    );
    if (args.options.json) {
      writeStatusSnapshotsJson({ snapshots });
    } else {
      if (watch) {
        process.stdout.write("\x1Bc");
      }
      await renderStatusSnapshotsTable({ snapshots });
      warnForStatusSnapshotErrors({ snapshots });
    }

    if (!watch) {
      return statusSnapshotsExitCode({ snapshots });
    }
    await Bun.sleep(2000);
  }
}

type NodeStatusSnapshot = Awaited<ReturnType<typeof probeNode>>;

function resolveStatusTargets(input: {
  readonly nodes: readonly NodeRecord[];
  readonly targetNodeId: string | null;
}):
  | { readonly ok: true; readonly nodes: readonly NodeRecord[] }
  | { readonly ok: false; readonly error: string } {
  const selected = input.targetNodeId
    ? input.nodes.filter((node) => node.id === input.targetNodeId)
    : input.nodes;
  if (selected.length === 0) {
    return {
      ok: false,
      error: input.targetNodeId
        ? `Unknown node id: ${input.targetNodeId}`
        : "No nodes registered.",
    };
  }
  return { ok: true, nodes: selected };
}

function writeStatusSnapshotsJson(input: {
  readonly snapshots: readonly NodeStatusSnapshot[];
}): void {
  process.stdout.write(
    `${JSON.stringify({ nodes: input.snapshots }, null, 2)}\n`
  );
}

async function renderStatusSnapshotsTable(input: {
  readonly snapshots: readonly NodeStatusSnapshot[];
}): Promise<void> {
  await display.table({
    columns: ["Id", "Name", "Status", "Version", "Platform", "Endpoint"],
    rows: input.snapshots.map((entry) => [
      entry.node?.id ?? entry.input.id,
      entry.node?.name ?? entry.input.name,
      entry.status,
      entry.node?.version ?? "",
      [entry.node?.platform ?? "", entry.node?.arch ?? ""]
        .filter(Boolean)
        .join("/"),
      entry.input.endpoint,
    ]),
  });
}

function warnForStatusSnapshotErrors(input: {
  readonly snapshots: readonly NodeStatusSnapshot[];
}): void {
  for (const entry of input.snapshots) {
    if (!(entry.ok || !entry.error)) {
      logger.warn({
        message: `${entry.input.id}: ${entry.error}`,
      });
    }
  }
}

function statusSnapshotsExitCode(input: {
  readonly snapshots: readonly NodeStatusSnapshot[];
}): number {
  return input.snapshots.some((entry) => !entry.ok) ? 1 : 0;
}

async function handleNodeUse({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: UseArgs;
}): Promise<number> {
  const nodeId = (args.positionals.nodeId ?? "").trim();
  if (!nodeId) {
    logger.error({ message: "Usage: hack node use <id>" });
    return 1;
  }
  try {
    const registry = await setDefaultNode({ id: nodeId });
    if (args.options.json) {
      process.stdout.write(
        `${JSON.stringify({ defaultNodeId: registry.defaultNodeId }, null, 2)}\n`
      );
      return 0;
    }
    logger.success({ message: `Default node set to ${nodeId}` });
    return 0;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "failed to set node";
    logger.error({ message });
    return 1;
  }
}

async function handleNodeRemove({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RemoveArgs;
}): Promise<number> {
  const nodeId = (args.positionals.nodeId ?? "").trim();
  if (!nodeId) {
    logger.error({ message: "Usage: hack node remove <id>" });
    return 1;
  }
  const removed = await removeNodeRecord({ id: nodeId });
  if (!removed.removed) {
    logger.error({ message: `Unknown node id: ${nodeId}` });
    return 1;
  }
  if (removed.node) {
    await deleteNodeAuthToken({ authRef: removed.node.authRef }).catch(
      () => undefined
    );
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ removed: removed.removed, nodeId }, null, 2)}\n`
    );
    return 0;
  }
  logger.success({ message: `Removed node ${nodeId}` });
  return 0;
}

async function handleNodeProviderRailwayBootstrap({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ProviderRailwayBootstrapArgs;
}): Promise<number> {
  const railwayProject = (args.options.railwayProject ?? "").trim();
  if (!railwayProject) {
    logger.error({
      message: "Missing --railway-project <id|name>.",
    });
    return 1;
  }
  const railwayBin = (args.options.railwayBin ?? "railway").trim();
  if (!railwayBin) {
    logger.error({ message: "Invalid --railway-bin value." });
    return 1;
  }
  const railwayEnvironment =
    (args.options.railwayEnvironment ?? "production").trim() || "production";
  const railwayWorkspace = (args.options.railwayWorkspace ?? "").trim();
  const createService = args.options.railwayCreateService === true;
  const image = (args.options.railwayImage ?? DEFAULT_RAILWAY_IMAGE).trim();
  if (createService && !image) {
    logger.error({
      message: "Missing --railway-image when --create-service is enabled.",
    });
    return 1;
  }
  const labels = parseCsv(args.options.labels);
  const fallbackName = (args.options.name ?? "").trim();
  const requestedService = (args.options.railwayService ?? "").trim();
  const name = fallbackName || requestedService || hostname();
  if (!name) {
    logger.error({ message: "Missing node name. Pass --name." });
    return 1;
  }
  let service = "";
  if (requestedService) {
    service = requestedService;
  } else if (createService) {
    service = deriveRailwayServiceName({ value: name });
  }
  if (!service) {
    logger.error({
      message:
        "Missing --railway-service <id|name>. Pass it explicitly or use --create-service.",
    });
    return 1;
  }

  const domainPort =
    typeof args.options.domainPort === "number"
      ? normalizePositiveInteger({
          value: args.options.domainPort,
          fallback: DEFAULT_RAILWAY_GATEWAY_PORT,
        })
      : null;
  const initRetries = normalizePositiveInteger({
    value: args.options.initRetries,
    fallback: DEFAULT_RAILWAY_BOOTSTRAP_RETRIES,
  });
  const tailscaleAuthKeyOption = (args.options.tailscaleAuthKey ?? "").trim();
  const privateNetworking =
    args.options.railwayPrivate === true || tailscaleAuthKeyOption.length > 0;
  const resolvedAuthKey = privateNetworking
    ? await resolveRailwayPrivateTailscaleAuthKey()
    : { authKey: "", source: null as "config" | "env" | null };
  const tailscaleAuthKey = (
    tailscaleAuthKeyOption || resolvedAuthKey.authKey
  ).trim();
  let tailscaleAuthSource: "provided" | "config" | "env" | null = null;
  if (tailscaleAuthKeyOption.length > 0) {
    tailscaleAuthSource = "provided";
  } else if (tailscaleAuthKey.length > 0) {
    tailscaleAuthSource = resolvedAuthKey.source;
  }
  const tailscaleHostname = (args.options.tailscaleHostname ?? "").trim();
  const tailscaleTags = privateNetworking
    ? ensurePrivateTailscaleTags({ tags: parseCsv(args.options.tailscaleTags) })
    : normalizeTailscaleTags({ tags: parseCsv(args.options.tailscaleTags) });
  if (privateNetworking && tailscaleAuthKey.length === 0) {
    logger.error({
      message: `Private mode requires a Tailscale auth key. Pass --tailscale-auth-key, set ${TAILSCALE_AUTH_KEY_ENV}, or set controlPlane.extensions["dance.hack.tailscale"].config.authKey.`,
    });
    return 1;
  }
  const staticGatewayToken = createRailwayStaticGatewayToken();
  let endpoint = (args.options.endpoint ?? "").trim();
  if (endpoint && !isHttpUrl(endpoint)) {
    logger.error({
      message: "Invalid --endpoint. Expected http(s) URL.",
    });
    return 1;
  }

  const contextDir = await mkdtemp(join(tmpdir(), "hack-railway-node-"));
  try {
    const link = await runRailwayCommand({
      railwayBin,
      cwd: contextDir,
      args: buildRailwayLinkArgs({
        project: railwayProject,
        environment: railwayEnvironment,
        workspace: railwayWorkspace || undefined,
      }),
    });
    if (!link.ok) {
      logger.error({ message: link.error });
      return 1;
    }

    const linkedProject = await resolveRailwayLinkedProjectId({
      railwayBin,
      cwd: contextDir,
    });
    const railwayProjectForSsh = linkedProject.ok
      ? linkedProject.projectId
      : railwayProject;
    if (!(linkedProject.ok || args.options.json)) {
      logger.warn({
        message: `Could not resolve linked Railway project id; falling back to provided project value for SSH operations: ${linkedProject.error}`,
      });
    }

    if (createService) {
      const addResult = await runRailwayCommand({
        railwayBin,
        cwd: contextDir,
        args: buildRailwayCreateServiceArgs({
          service,
          image,
        }),
      });
      if (!addResult.ok) {
        logger.error({
          message: formatRailwayCreateServiceError({
            error: addResult.error,
            image,
          }),
        });
        return 1;
      }
    }

    if (!(endpoint || privateNetworking)) {
      const domainResult = await runRailwayCommand({
        railwayBin,
        cwd: contextDir,
        args: buildRailwayDomainArgs({
          service,
          port: domainPort ?? undefined,
        }),
      });
      if (!domainResult.ok) {
        logger.error({
          message: `${domainResult.error} Pass --endpoint to skip domain generation.`,
        });
        return 1;
      }
      const parsedDomain = parseRailwayDomainEndpoint({
        output: domainResult.stdout,
      });
      if (!parsedDomain.ok) {
        logger.error({
          message: `${parsedDomain.error} Pass --endpoint to continue without auto-domain detection.`,
        });
        return 1;
      }
      endpoint = parsedDomain.endpoint;
    }

    const variableSet = await runRailwayCommand({
      railwayBin,
      cwd: contextDir,
      args: buildRailwayVariableSetArgs({
        service,
        environment: railwayEnvironment,
        pairs: buildRailwayVariablePairs({
          name,
          endpoint: endpoint || null,
          labels,
          gatewayPort: domainPort,
          staticGatewayToken,
          privateNetworking,
          tailscaleAuthKey:
            tailscaleAuthKey.length > 0 ? tailscaleAuthKey : null,
          tailscaleHostname:
            tailscaleHostname.length > 0 ? tailscaleHostname : null,
          tailscaleTags,
        }),
      }),
    });
    if (!variableSet.ok) {
      logger.error({ message: variableSet.error });
      return 1;
    }
    const variableDeletes = buildRailwayVariableDeletes({
      gatewayPort: domainPort,
      privateNetworking,
      tailscaleTags,
    });
    for (const key of variableDeletes) {
      const variableDelete = await runRailwayCommand({
        railwayBin,
        cwd: contextDir,
        args: buildRailwayVariableDeleteArgs({
          service,
          environment: railwayEnvironment,
          key,
        }),
      });
      if (!variableDelete.ok) {
        logger.warn({
          message: `Failed to clear ${key} override (continuing): ${variableDelete.error}`,
        });
      }
    }
    const redeploy = await runRailwayCommand({
      railwayBin,
      cwd: contextDir,
      args: buildRailwayServiceRedeployArgs({ service }),
    });
    if (!redeploy.ok) {
      logger.warn({
        message: `Railway redeploy command failed (continuing): ${redeploy.error}`,
      });
    }
    if (!endpoint && privateNetworking) {
      const tailscaleEndpoint = await resolveRailwayTailscaleEndpoint({
        railwayBin,
        cwd: contextDir,
        project: railwayProjectForSsh,
        service,
        environment: railwayEnvironment,
        retries: initRetries,
        jsonMode: args.options.json === true,
      });
      if (!tailscaleEndpoint.ok) {
        logger.error({ message: tailscaleEndpoint.error });
        return 1;
      }
      endpoint = tailscaleEndpoint.endpoint;
    }

    const initialized = await initRailwayNodeBundle({
      railwayBin,
      cwd: contextDir,
      project: railwayProjectForSsh,
      service,
      environment: railwayEnvironment,
      name,
      endpoint,
      labels,
      retries: initRetries,
      jsonMode: args.options.json === true,
    });
    if (!initialized.ok) {
      logger.error({ message: initialized.error });
      return 1;
    }

    const registered = await registerBundleOnController({
      bundle: withRailwayStaticGatewayToken({
        bundle: initialized.bundle,
        token: staticGatewayToken,
      }),
      makeDefault: args.options.defaultNode === true,
    });
    if (!registered.ok) {
      logger.error({ message: registered.error });
      return 1;
    }
    const stabilizedProbe = await stabilizeNodeProbe({
      snapshot: registered.probe,
      node: registered.nodeForOutput,
      retries: 4,
      delayMs: 1500,
      jsonMode: args.options.json === true,
    });
    const nodeForOutput = stabilizedProbe.node ?? registered.nodeForOutput;

    if (args.options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            provider: "railway",
            railway: {
              project: railwayProject,
              ...(railwayProjectForSsh !== railwayProject
                ? { projectId: railwayProjectForSsh }
                : {}),
              service,
              environment: railwayEnvironment,
              network: privateNetworking ? "tailscale-private" : "public",
              ...(privateNetworking && tailscaleAuthSource
                ? { tailscaleAuth: tailscaleAuthSource }
                : {}),
              ...(railwayWorkspace ? { workspace: railwayWorkspace } : {}),
              createService,
              ...(typeof domainPort === "number" ? { domainPort } : {}),
              initAttempts: initialized.attempts,
            },
            node: nodeForOutput,
            endpoint,
            created: registered.created,
            probe: {
              ok: stabilizedProbe.ok,
              status: stabilizedProbe.status,
              error: stabilizedProbe.error,
            },
          },
          null,
          2
        )}\n`
      );
      return 0;
    }

    await display.kv({
      title: registered.created
        ? "Railway node registered"
        : "Railway node updated",
      entries: [
        ["provider", "railway"],
        ["project", railwayProject],
        ...(railwayProjectForSsh !== railwayProject
          ? [["project_id", railwayProjectForSsh] as const]
          : []),
        ["service", service],
        ["environment", railwayEnvironment],
        ["network", privateNetworking ? "tailscale-private" : "public"],
        ...(privateNetworking && tailscaleAuthSource
          ? [["tailscale_auth", tailscaleAuthSource] as const]
          : []),
        ["endpoint", endpoint],
        ["node_id", nodeForOutput.id],
        ["node_name", nodeForOutput.name],
        ["status", stabilizedProbe.status],
        ["default", args.options.defaultNode ? "yes" : "no"],
      ],
    });
    if (!stabilizedProbe.ok && stabilizedProbe.error) {
      logger.warn({
        message: `Node registered but probe failed: ${stabilizedProbe.error}`,
      });
    }
    return 0;
  } finally {
    await rm(contextDir, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

async function handleNodeDevcontainerUp({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DevcontainerUpArgs;
}): Promise<number> {
  const selector = (args.options.project ?? "").trim();
  if (!selector) {
    logger.error({
      message: "Missing --project <name|id>.",
    });
    return 1;
  }
  const branch = args.options.branch?.trim();

  const nodeClient = await resolveNodeGatewayClient({
    nodeId: args.options.node?.trim(),
  });
  if (!nodeClient.ok) {
    logger.error({ message: nodeClient.error });
    return 1;
  }

  const workspaceSelector = resolveWorkspaceSelector({ selector, branch });
  const up = await nodeClient.client.devcontainerUp(workspaceSelector);
  if (!up.ok) {
    logger.error({
      message: `Devcontainer up failed (${up.status}): ${up.error.message}`,
    });
    return 1;
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ node: nodeClient.node, session: up.data.session }, null, 2)}\n`
    );
    return 0;
  }

  await display.kv({
    title: "Devcontainer started",
    entries: [
      ["node", `${nodeClient.node.name} (${nodeClient.node.id})`],
      ["session_id", up.data.session.id],
      ["project", up.data.session.workspace.projectName],
      ["branch", up.data.session.workspace.branch ?? ""],
      ["status", up.data.session.status],
      ["container_id", up.data.session.containerId ?? ""],
    ],
  });
  return up.data.session.status === "running" ? 0 : 1;
}

async function handleNodeDevcontainerDown({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DevcontainerDownArgs;
}): Promise<number> {
  const sessionId = (args.options.id ?? "").trim();
  if (!sessionId) {
    logger.error({ message: "Missing --id <session-id>." });
    return 1;
  }

  const nodeClient = await resolveNodeGatewayClient({
    nodeId: args.options.node?.trim(),
  });
  if (!nodeClient.ok) {
    logger.error({ message: nodeClient.error });
    return 1;
  }

  const down = await nodeClient.client.devcontainerDown({ id: sessionId });
  if (!down.ok) {
    logger.error({
      message: `Devcontainer down failed (${down.status}): ${down.error.message}`,
    });
    return 1;
  }

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ node: nodeClient.node, session: down.data.session }, null, 2)}\n`
    );
    return 0;
  }

  await display.kv({
    title: "Devcontainer stopped",
    entries: [
      ["node", `${nodeClient.node.name} (${nodeClient.node.id})`],
      ["session_id", down.data.session.id],
      ["status", down.data.session.status],
      ["container_id", down.data.session.containerId ?? ""],
    ],
  });
  return down.data.session.status === "stopped" ? 0 : 1;
}

async function handleNodeDevcontainerAttach({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DevcontainerAttachArgs;
}): Promise<number> {
  const sessionId = (args.options.id ?? "").trim();
  if (!sessionId) {
    logger.error({ message: "Missing --id <session-id>." });
    return 1;
  }
  const ide = ((args.options.ide ?? "vscode").trim().toLowerCase() ||
    "vscode") as "cursor" | "vscode" | "claude" | "codex";
  if (
    !(
      ide === "cursor" ||
      ide === "vscode" ||
      ide === "claude" ||
      ide === "codex"
    )
  ) {
    logger.error({
      message: "Invalid --ide. Expected cursor|vscode|claude|codex.",
    });
    return 1;
  }

  const nodeClient = await resolveNodeGatewayClient({
    nodeId: args.options.node?.trim(),
  });
  if (!nodeClient.ok) {
    logger.error({ message: nodeClient.error });
    return 1;
  }

  const session = await nodeClient.client.getDevcontainer({ id: sessionId });
  if (!session.ok) {
    logger.error({
      message: `Devcontainer session lookup failed (${session.status}): ${session.error.message}`,
    });
    return 1;
  }

  const endpointInfo = resolveNodeEndpoint({
    endpoint: nodeClient.node.endpoint,
  });
  const sshHost =
    args.options.sshHost?.trim() || endpointInfo.host || nodeClient.node.name;
  const sshPort = Math.max(1, Math.trunc(args.options.sshPort ?? 22));
  const sshUser = args.options.sshUser?.trim() || undefined;
  const sshAlias =
    args.options.sshAlias?.trim() ||
    `hack-node-${nodeClient.node.id.slice(0, 8)}`;
  const attach = buildAttachInstructions({
    ide,
    sshHost,
    sshPort,
    sshAlias,
    ...(sshUser ? { sshUser } : {}),
    workspaceFolder: session.data.session.workspace.projectRoot,
    containerId: session.data.session.containerId,
    endpointPort: endpointInfo.port,
  });

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          node: nodeClient.node,
          ide,
          session: session.data.session,
          attach,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.panel({
    title: `Attach (${ide})`,
    tone: "info",
    lines: attach.lines,
  });
  return 0;
}

/**
 * Builds a sanitized Railway service slug from user/node input.
 */
function deriveRailwayServiceName(input: { readonly value: string }): string {
  const normalized = input.value
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(RAILWAY_SERVICE_NAME_PATTERN, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  if (normalized.length > 0) {
    return normalized.slice(0, 63);
  }
  return `hack-node-${randomUUID().slice(0, 8)}`;
}

/**
 * Normalizes optional numeric CLI input into a positive integer fallback.
 */
function normalizePositiveInteger(input: {
  readonly value: number | undefined;
  readonly fallback: number;
}): number {
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return input.fallback;
  }
  return Math.max(1, Math.trunc(input.value));
}

function buildRailwayLinkArgs(input: {
  readonly project: string;
  readonly environment: string;
  readonly workspace?: string;
}): string[] {
  return [
    "link",
    "--project",
    input.project,
    "--environment",
    input.environment,
    ...(input.workspace ? ["--workspace", input.workspace] : []),
    "--json",
  ];
}

function buildRailwayCreateServiceArgs(input: {
  readonly service: string;
  readonly image: string;
}): string[] {
  return ["add", "--service", input.service, "--image", input.image, "--json"];
}

function formatRailwayCreateServiceError(input: {
  readonly error: string;
  readonly image: string;
}): string {
  const normalized = input.error.toLowerCase();
  if (
    normalized.includes("unable to connect to the registry") ||
    normalized.includes("credentials") ||
    normalized.includes("unauthorized")
  ) {
    return `${input.error} Railway could not pull image "${input.image}". Use --railway-image with a reachable/public image, or configure registry credentials in Railway service settings.`;
  }
  return input.error;
}

function buildRailwayDomainArgs(input: {
  readonly service: string;
  readonly port?: number;
}): string[] {
  return [
    "domain",
    "--service",
    input.service,
    ...(typeof input.port === "number" ? ["--port", String(input.port)] : []),
    "--json",
  ];
}

function normalizeTailscaleTags(input: {
  readonly tags: readonly string[];
}): string[] {
  const unique = new Set<string>();
  const normalized: string[] = [];
  for (const raw of input.tags) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    const value = trimmed.startsWith("tag:") ? trimmed : `tag:${trimmed}`;
    if (unique.has(value)) {
      continue;
    }
    unique.add(value);
    normalized.push(value);
  }
  return normalized;
}

function ensurePrivateTailscaleTags(input: {
  readonly tags: readonly string[];
}): string[] {
  return normalizeTailscaleTags({ tags: input.tags });
}

/**
 * Reads the private Railway bootstrap auth key from global config or env.
 *
 * Precedence:
 * 1) controlPlane.extensions["dance.hack.tailscale"].config.authKey
 * 2) controlPlane.extensions["dance.hack.railway"].config.tailscaleAuthKey (compat)
 * 3) HACK_TAILSCALE_AUTH_KEY
 */
async function resolveRailwayPrivateTailscaleAuthKey(): Promise<{
  readonly authKey: string;
  readonly source: "config" | "env" | null;
}> {
  const config = await readControlPlaneConfig({});
  const extensions = config.config.extensions;
  if (isRecord(extensions)) {
    const tailscaleExtension = extensions["dance.hack.tailscale"];
    if (isRecord(tailscaleExtension)) {
      const extensionConfig = isRecord(tailscaleExtension.config)
        ? tailscaleExtension.config
        : {};
      const fromTailscaleConfig = getOptionalString(extensionConfig.authKey);
      if (fromTailscaleConfig) {
        return {
          authKey: fromTailscaleConfig,
          source: "config",
        };
      }
    }
    const railwayExtension = extensions["dance.hack.railway"];
    if (isRecord(railwayExtension)) {
      const extensionConfig = isRecord(railwayExtension.config)
        ? railwayExtension.config
        : {};
      const fromConfig = getOptionalString(extensionConfig.tailscaleAuthKey);
      if (fromConfig) {
        return {
          authKey: fromConfig,
          source: "config",
        };
      }
    }
  }
  const fromEnv = (process.env[TAILSCALE_AUTH_KEY_ENV] ?? "").trim();
  if (fromEnv) {
    return {
      authKey: fromEnv,
      source: "env",
    };
  }
  return {
    authKey: "",
    source: null,
  };
}

function buildRailwayVariablePairs(input: {
  readonly name: string;
  readonly endpoint: string | null;
  readonly labels: readonly string[];
  readonly gatewayPort: number | null;
  readonly staticGatewayToken: string;
  readonly privateNetworking: boolean;
  readonly tailscaleAuthKey: string | null;
  readonly tailscaleHostname: string | null;
  readonly tailscaleTags: readonly string[];
}): string[] {
  const pairs: string[] = [
    `HACK_NODE_NAME=${input.name}`,
    "HACK_NODE_GATEWAY_BIND=0.0.0.0",
    "HACK_NODE_GATEWAY_ALLOW_WRITES=1",
    "HACK_DAEMON_DISABLE_DOCKER_EVENTS=1",
    `HACK_GATEWAY_STATIC_TOKEN=${input.staticGatewayToken}`,
    "HACK_GATEWAY_STATIC_TOKEN_SCOPE=write",
    ...(typeof input.gatewayPort === "number"
      ? [`HACK_NODE_GATEWAY_PORT=${input.gatewayPort}`]
      : []),
    ...(input.labels.length > 0
      ? [`HACK_NODE_LABELS=${input.labels.join(",")}`]
      : []),
  ];
  if (input.endpoint) {
    pairs.push(`HACK_NODE_ENDPOINT=${input.endpoint}`);
  }
  if (input.privateNetworking) {
    pairs.push("HACK_TAILSCALE_ENABLE=1");
    pairs.push("HACK_TAILSCALE_SERVE=1");
    if (input.tailscaleAuthKey) {
      pairs.push(`TS_AUTHKEY=${input.tailscaleAuthKey}`);
    }
    if (input.tailscaleHostname) {
      pairs.push(`HACK_TAILSCALE_HOSTNAME=${input.tailscaleHostname}`);
    }
    if (input.tailscaleTags.length > 0) {
      pairs.push(
        `HACK_TAILSCALE_ADVERTISE_TAGS=${input.tailscaleTags.join(",")}`
      );
    }
  }
  return pairs;
}

function buildRailwayVariableDeletes(input: {
  readonly gatewayPort: number | null;
  readonly privateNetworking: boolean;
  readonly tailscaleTags: readonly string[];
}): string[] {
  const deletes: string[] = [];
  if (input.gatewayPort === null) {
    deletes.push("HACK_NODE_GATEWAY_PORT");
  }
  if (!(input.privateNetworking && input.tailscaleTags.length > 0)) {
    deletes.push("HACK_TAILSCALE_ADVERTISE_TAGS");
  }
  if (!input.privateNetworking) {
    deletes.push(
      "HACK_TAILSCALE_ENABLE",
      "HACK_TAILSCALE_SERVE",
      "TS_AUTHKEY",
      "HACK_TAILSCALE_HOSTNAME"
    );
  }
  const unique = new Set<string>();
  const normalized: string[] = [];
  for (const key of deletes) {
    if (unique.has(key)) {
      continue;
    }
    unique.add(key);
    normalized.push(key);
  }
  return normalized;
}

function createRailwayStaticGatewayToken(): string {
  return randomBytes(32).toString("base64url");
}

async function resolveRailwayTailscaleEndpoint(input: {
  readonly railwayBin: string;
  readonly cwd: string;
  readonly project: string;
  readonly service: string;
  readonly environment: string;
  readonly retries: number;
  readonly jsonMode: boolean;
}): Promise<
  | {
      readonly ok: true;
      readonly endpoint: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= input.retries; attempt += 1) {
    const status = await runRailwayCommand({
      railwayBin: input.railwayBin,
      cwd: input.cwd,
      args: buildRailwaySshTailscaleStatusArgs({
        project: input.project,
        service: input.service,
        environment: input.environment,
      }),
    });
    if (status.ok) {
      const parsed = parseRailwayTailscaleEndpoint({ output: status.stdout });
      if (parsed.ok) {
        return parsed;
      }
      lastError = parsed.error;
    } else {
      lastError = status.error;
    }
    if (attempt < input.retries) {
      if (!input.jsonMode) {
        logger.info({
          message:
            "Waiting for Tailscale endpoint to become available on Railway service.",
          fields: {
            attempt,
            retries: input.retries,
          },
        });
      }
      await Bun.sleep(DEFAULT_RAILWAY_BOOTSTRAP_DELAY_MS);
    }
  }
  return {
    ok: false,
    error:
      lastError ??
      "Failed to resolve private Tailscale endpoint from Railway service.",
  };
}

function buildRailwaySshTailscaleStatusArgs(input: {
  readonly project: string;
  readonly service: string;
  readonly environment: string;
}): string[] {
  return [
    "ssh",
    "--project",
    input.project,
    "--service",
    input.service,
    "--environment",
    input.environment,
    "--",
    "tailscale",
    "--socket",
    DEFAULT_RAILWAY_TAILSCALE_SOCKET,
    "status",
    "--json",
  ];
}

function parseRailwayTailscaleEndpoint(input: { readonly output: string }):
  | {
      readonly ok: true;
      readonly endpoint: string;
    }
  | { readonly ok: false; readonly error: string } {
  const parsed = parseRailwayJsonOutput({ output: input.output });
  if (!parsed.ok) {
    return parsed;
  }
  if (!isRecord(parsed.value)) {
    return {
      ok: false,
      error: "Tailscale status payload did not return an object.",
    };
  }
  const self = isRecord(parsed.value.Self) ? parsed.value.Self : null;
  if (!self) {
    return {
      ok: false,
      error: "Tailscale status payload did not include Self metadata.",
    };
  }
  const dnsNameRaw = getOptionalString(self.DNSName);
  const dnsName = dnsNameRaw?.replace(TRAILING_DOT_PATTERN, "").trim() ?? "";
  if (!dnsName) {
    return {
      ok: false,
      error:
        "Tailscale status payload did not include a usable Self.DNSName value.",
    };
  }
  return {
    ok: true,
    endpoint: `https://${dnsName}`,
  };
}

function withRailwayStaticGatewayToken(input: {
  readonly bundle: NodeEnrollmentBundle;
  readonly token: string;
}): NodeEnrollmentBundle {
  return {
    ...input.bundle,
    token: input.token,
  };
}

function buildRailwayVariableSetArgs(input: {
  readonly service: string;
  readonly environment: string;
  readonly pairs: readonly string[];
}): string[] {
  return [
    "variable",
    "set",
    "--service",
    input.service,
    "--environment",
    input.environment,
    ...input.pairs,
  ];
}

function buildRailwayVariableDeleteArgs(input: {
  readonly service: string;
  readonly environment: string;
  readonly key: string;
}): string[] {
  return [
    "variable",
    "delete",
    "--service",
    input.service,
    "--environment",
    input.environment,
    input.key,
  ];
}

function buildRailwayServiceRedeployArgs(input: {
  readonly service: string;
}): string[] {
  return ["service", "redeploy", "--service", input.service, "--yes"];
}

function buildRailwaySshNodeInitArgs(input: {
  readonly project: string;
  readonly service: string;
  readonly environment: string;
  readonly name: string;
  readonly endpoint: string;
  readonly labels: readonly string[];
}): string[] {
  return [
    "ssh",
    "--project",
    input.project,
    "--service",
    input.service,
    "--environment",
    input.environment,
    "--",
    "hack",
    "node",
    "init",
    "--name",
    input.name,
    "--endpoint",
    input.endpoint,
    ...(input.labels.length > 0 ? ["--labels", input.labels.join(",")] : []),
    "--json",
  ];
}

async function resolveRailwayLinkedProjectId(input: {
  readonly railwayBin: string;
  readonly cwd: string;
}): Promise<
  | {
      readonly ok: true;
      readonly projectId: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const status = await runRailwayCommand({
    railwayBin: input.railwayBin,
    cwd: input.cwd,
    args: ["status", "--json"],
  });
  if (!status.ok) {
    return { ok: false, error: status.error };
  }
  const parsed = parseRailwayJsonOutput({ output: status.stdout });
  if (!(parsed.ok && isRecord(parsed.value))) {
    return {
      ok: false,
      error: parsed.ok
        ? "Railway status payload did not include a project object."
        : parsed.error,
    };
  }
  const projectId = getOptionalString(parsed.value.id)?.trim() ?? "";
  if (!projectId) {
    return {
      ok: false,
      error: "Railway status payload did not include project id.",
    };
  }
  return {
    ok: true,
    projectId,
  };
}

type RailwayCommandFailure = {
  readonly ok: false;
  readonly error: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type RailwayCommandSuccess = {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
};

type RailwayCommandResult = RailwayCommandSuccess | RailwayCommandFailure;

async function runRailwayCommand(input: {
  readonly railwayBin: string;
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<RailwayCommandResult> {
  const cmd = [input.railwayBin, ...input.args];
  const result = await exec(cmd, {
    cwd: input.cwd,
    stdin: "ignore",
  });
  if (result.exitCode === 0) {
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout || `exit ${result.exitCode}`;
  const displayCmd = formatRailwayCommandForLogs({ cmd });
  return {
    ok: false,
    error: `Railway command failed (${displayCmd}): ${detail}`,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function formatRailwayCommandForLogs(input: {
  readonly cmd: readonly string[];
}): string {
  return input.cmd
    .map((token) => redactRailwaySecretToken({ token }))
    .join(" ");
}

function redactRailwaySecretToken(input: { readonly token: string }): string {
  const separators = ["="] as const;
  const secretPrefixes = [
    "TS_AUTHKEY",
    "HACK_GATEWAY_STATIC_TOKEN",
    "HACK_GATEWAY_TOKEN",
  ] as const;
  for (const separator of separators) {
    const index = input.token.indexOf(separator);
    if (index <= 0) {
      continue;
    }
    const key = input.token.slice(0, index);
    if (secretPrefixes.includes(key as (typeof secretPrefixes)[number])) {
      return `${key}${separator}***`;
    }
  }
  return input.token;
}

/**
 * Attempts to extract a JSON payload from mixed CLI output (prompts + JSON).
 */
function parseRailwayJsonOutput(input: {
  readonly output: string;
}):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string } {
  const trimmed = input.output.trim();
  if (!trimmed) {
    return { ok: false, error: "Railway command returned empty output." };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const firstObject = trimmed.indexOf("{");
    const firstArray = trimmed.indexOf("[");
    const objectStart =
      firstObject >= 0 ? firstObject : Number.POSITIVE_INFINITY;
    const arrayStart = firstArray >= 0 ? firstArray : Number.POSITIVE_INFINITY;
    const start = Math.min(objectStart, arrayStart);
    if (!Number.isFinite(start)) {
      return { ok: false, error: "Railway output did not include JSON." };
    }
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end <= start) {
      return { ok: false, error: "Railway output JSON framing is invalid." };
    }
    const candidate = trimmed.slice(start, end + 1);
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      return { ok: false, error: "Failed to parse Railway JSON payload." };
    }
  }
}

function parseRailwayDomainEndpoint(input: {
  readonly output: string;
}):
  | { readonly ok: true; readonly endpoint: string }
  | { readonly ok: false; readonly error: string } {
  const parsed = parseRailwayJsonOutput({ output: input.output });
  if (!parsed.ok) {
    return parsed;
  }
  const domain = findRailwayDomainValue({ value: parsed.value });
  if (!domain) {
    return {
      ok: false,
      error:
        "Railway domain response did not include a domain value. Pass --endpoint explicitly.",
    };
  }
  const endpoint =
    domain.startsWith("http://") || domain.startsWith("https://")
      ? domain
      : `https://${domain}`;
  if (!isHttpUrl(endpoint)) {
    return { ok: false, error: `Generated endpoint is invalid: ${endpoint}` };
  }
  return {
    ok: true,
    endpoint: endpoint.replace(TRAILING_SLASH_PATTERN, ""),
  };
}

function findRailwayDomainValue(input: {
  readonly value: unknown;
}): string | null {
  if (typeof input.value === "string") {
    const value = input.value.trim();
    return value.length > 0 ? value : null;
  }
  if (Array.isArray(input.value)) {
    for (const entry of input.value) {
      const candidate = findRailwayDomainValue({ value: entry });
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }
  if (!isRecord(input.value)) {
    return null;
  }
  const direct =
    getOptionalString(input.value.domain) ??
    getOptionalString(input.value.url) ??
    getOptionalString(input.value.hostname) ??
    getOptionalString(input.value.host);
  if (direct) {
    return direct;
  }
  if (Array.isArray(input.value.serviceDomains)) {
    const serviceDomain = findRailwayDomainValue({
      value: input.value.serviceDomains,
    });
    if (serviceDomain) {
      return serviceDomain;
    }
  }
  if (Array.isArray(input.value.customDomains)) {
    const customDomain = findRailwayDomainValue({
      value: input.value.customDomains,
    });
    if (customDomain) {
      return customDomain;
    }
  }
  for (const nested of Object.values(input.value)) {
    const candidate = findRailwayDomainValue({ value: nested });
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

async function initRailwayNodeBundle(input: {
  readonly railwayBin: string;
  readonly cwd: string;
  readonly project: string;
  readonly service: string;
  readonly environment: string;
  readonly name: string;
  readonly endpoint: string;
  readonly labels: readonly string[];
  readonly retries: number;
  readonly jsonMode: boolean;
}): Promise<
  | {
      readonly ok: true;
      readonly bundle: NodeEnrollmentBundle;
      readonly attempts: number;
    }
  | { readonly ok: false; readonly error: string }
> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= input.retries; attempt += 1) {
    await wakeRailwayNodeEndpoint({ endpoint: input.endpoint });
    const initResult = await runRailwayCommand({
      railwayBin: input.railwayBin,
      cwd: input.cwd,
      args: buildRailwaySshNodeInitArgs({
        project: input.project,
        service: input.service,
        environment: input.environment,
        name: input.name,
        endpoint: input.endpoint,
        labels: input.labels,
      }),
    });
    if (initResult.ok) {
      const parsedBundle = parseEnrollmentBundleFromRemoteOutput({
        text: initResult.stdout,
      });
      if (parsedBundle.ok) {
        return {
          ok: true,
          bundle: parsedBundle.bundle,
          attempts: attempt,
        };
      }
      lastError = `Railway SSH succeeded but bundle parse failed: ${parsedBundle.error}`;
    } else {
      lastError = initResult.error;
    }
    if (attempt < input.retries) {
      if (!input.jsonMode) {
        logger.info({
          message:
            "Railway node init not ready yet; waiting before retrying SSH bootstrap.",
          fields: {
            attempt,
            retries: input.retries,
          },
        });
      }
      await Bun.sleep(DEFAULT_RAILWAY_BOOTSTRAP_DELAY_MS);
    }
  }
  return {
    ok: false,
    error:
      lastError ??
      "Railway node init failed without a detailed error. Verify deployment health and retry.",
  };
}

async function stabilizeNodeProbe(input: {
  readonly snapshot: NodeStatusSnapshot;
  readonly node: NodeRecord;
  readonly retries: number;
  readonly delayMs: number;
  readonly jsonMode: boolean;
}): Promise<NodeStatusSnapshot> {
  let snapshot = input.snapshot;
  for (let attempt = 1; attempt <= input.retries; attempt += 1) {
    if (!(isTransientNodeProbeError(snapshot.error) && !snapshot.ok)) {
      return snapshot;
    }
    if (!input.jsonMode) {
      logger.info({
        message: "Node endpoint still warming; retrying status probe.",
        fields: {
          attempt,
          retries: input.retries,
        },
      });
    }
    await Bun.sleep(input.delayMs);
    snapshot = await probeNode({
      node: snapshot.node ?? input.node,
    });
  }
  return snapshot;
}

function isTransientNodeProbeError(error: string | undefined): boolean {
  const value = (error ?? "").trim().toLowerCase();
  return (
    value.includes("http 502") ||
    value.includes("http 503") ||
    value.includes("http 504")
  );
}

/**
 * Serverless Railway services can sleep when idle, so touch the node endpoint
 * before SSH attempts to trigger a cold start.
 */
async function wakeRailwayNodeEndpoint(input: {
  readonly endpoint: string;
}): Promise<void> {
  const endpoint = input.endpoint.replace(TRAILING_SLASH_PATTERN, "");
  const wakeUrl = `${endpoint}/v1/node/status`;
  try {
    await fetchWithTimeout({
      url: wakeUrl,
      timeoutMs: NODE_PREFLIGHT_HTTP_TIMEOUT_MS,
      init: {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      },
    });
  } catch {
    // Best-effort wake ping; retries continue through SSH path diagnostics.
  }
}

async function resolveNodeGatewayClient(input: {
  readonly nodeId?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly node: NodeRecord;
      readonly client: ReturnType<typeof createGatewayClient>;
    }
  | { readonly ok: false; readonly error: string }
> {
  const registry = await readNodesRegistry();
  const selectedId = input.nodeId?.trim() || registry.defaultNodeId;
  if (!selectedId) {
    return {
      ok: false,
      error:
        "Missing node target. Pass --node <id> or set default with `hack node use <id>`.",
    };
  }
  const node = registry.nodes.find((entry) => entry.id === selectedId);
  if (!node) {
    return { ok: false, error: `Unknown node id: ${selectedId}` };
  }
  const token = await readNodeAuthToken({ authRef: node.authRef });
  if (!token) {
    return {
      ok: false,
      error: `Missing auth token for node ${node.id}. Re-add bundle with \`hack node add --bundle ...\`.`,
    };
  }
  return {
    ok: true,
    node,
    client: createGatewayClient({
      baseUrl: node.endpoint,
      token,
      timeoutMs: 10_000,
    }),
  };
}

function resolveWorkspaceSelector(input: {
  readonly selector: string;
  readonly branch?: string;
}): {
  readonly project?: string;
  readonly projectId?: string;
  readonly branch?: string;
} {
  const selector = input.selector.trim();
  const base = PROJECT_ID_LIKE_PATTERN.test(selector)
    ? { projectId: selector }
    : { project: selector };
  return {
    ...base,
    ...(input.branch ? { branch: input.branch } : {}),
  };
}

function resolveNodeEndpoint(input: { readonly endpoint: string }): {
  readonly host: string;
  readonly port: number | null;
} {
  try {
    const url = new URL(input.endpoint);
    const port = Number.parseInt(url.port, 10);
    return {
      host: url.hostname,
      port: Number.isFinite(port) ? port : null,
    };
  } catch {
    return { host: input.endpoint, port: null };
  }
}

function buildAttachInstructions(input: {
  readonly ide: "cursor" | "vscode" | "claude" | "codex";
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshAlias: string;
  readonly sshUser?: string;
  readonly workspaceFolder: string;
  readonly containerId: string | null;
  readonly endpointPort: number | null;
}): {
  readonly lines: string[];
  readonly commands: readonly string[];
  readonly ssh: {
    readonly host: string;
    readonly port: number;
    readonly user?: string;
    readonly alias: string;
    readonly target: string;
  };
} {
  const sshTarget = input.sshUser
    ? `${input.sshUser}@${input.sshHost}`
    : input.sshHost;
  const sshCmd =
    input.sshPort === 22
      ? `ssh ${sshTarget}`
      : `ssh -p ${input.sshPort} ${sshTarget}`;

  const sharedLines = [
    `SSH host: ${input.sshHost}`,
    `SSH port: ${input.sshPort}`,
    ...(input.sshUser ? [`SSH user: ${input.sshUser}`] : []),
    `SSH alias (optional): ${input.sshAlias}`,
    ...(input.endpointPort
      ? [
          `Gateway endpoint port is ${input.endpointPort} (SSH is configured separately).`,
        ]
      : []),
  ];
  const sshConfigLines = [
    `Host ${input.sshAlias}`,
    `  HostName ${input.sshHost}`,
    `  Port ${input.sshPort}`,
    ...(input.sshUser ? [`  User ${input.sshUser}`] : []),
  ];

  if (input.ide === "vscode" || input.ide === "cursor") {
    const binary = input.ide === "cursor" ? "cursor" : "code";
    const remoteTarget = input.sshAlias;
    const openCommand = `${binary} --remote "ssh-remote+${remoteTarget}" "${input.workspaceFolder}"`;
    return {
      lines: [
        ...sharedLines,
        "1) Add SSH config entry (optional):",
        ...sshConfigLines,
        `2) Verify SSH access: ${sshCmd}`,
        `3) Open workspace in ${input.ide}: ${openCommand}`,
        ...(input.containerId
          ? [
              `4) Container is running (id: ${input.containerId}). In Remote-SSH, run "Dev Containers: Attach to Running Container".`,
            ]
          : [
              "4) Container id unavailable; open workspace first, then run Dev Containers attach command from IDE.",
            ]),
      ],
      commands: [sshCmd, openCommand],
      ssh: {
        host: input.sshHost,
        port: input.sshPort,
        ...(input.sshUser ? { user: input.sshUser } : {}),
        alias: input.sshAlias,
        target: sshTarget,
      },
    };
  }

  const toolCommand = input.ide;
  const commands = [sshCmd, `cd ${input.workspaceFolder}`];
  if (input.containerId) {
    commands.push(`docker exec -it ${input.containerId} /bin/sh`);
  }
  commands.push(toolCommand);
  return {
    lines: [
      ...sharedLines,
      `1) SSH to node: ${sshCmd}`,
      `2) Open workspace: cd ${input.workspaceFolder}`,
      ...(input.containerId
        ? [
            `3) Optional container attach: docker exec -it ${input.containerId} /bin/sh`,
          ]
        : ["3) Container id unavailable; run from workspace shell"]),
      `4) Start ${input.ide}: ${toolCommand}`,
    ],
    commands,
    ssh: {
      host: input.sshHost,
      port: input.sshPort,
      ...(input.sshUser ? { user: input.sshUser } : {}),
      alias: input.sshAlias,
      target: sshTarget,
    },
  };
}

export const __testOnlyNodeAttach = {
  buildAttachInstructions,
  resolveNodeEndpoint,
};

export const __testOnlyNodePair = {
  derivePairingName,
  extractSshHost,
  buildAutoEndpointCandidates,
  normalizeHostHint,
  normalizeRemoteHackOverride,
  parseEnrollmentBundleFromRemoteOutput,
  renderShellCommand,
  renderRemoteHackCommand,
};

export const __testOnlyNodeRailway = {
  buildRailwayLinkArgs,
  buildRailwayCreateServiceArgs,
  buildRailwayDomainArgs,
  buildRailwayVariableDeletes,
  buildRailwaySshTailscaleStatusArgs,
  buildRailwayVariablePairs,
  buildRailwayVariableSetArgs,
  buildRailwaySshNodeInitArgs,
  ensurePrivateTailscaleTags,
  normalizeTailscaleTags,
  redactRailwaySecretToken,
  parseRailwayJsonOutput,
  parseRailwayDomainEndpoint,
  parseRailwayTailscaleEndpoint,
  deriveRailwayServiceName,
};

export const __testOnlyNodeStatus = {
  resolveNodeAuthLookup,
  clearNodeAuthLookupCache,
};

/**
 * Resolve node auth token once and reuse a short-lived cache entry to avoid
 * repeated keychain prompts during polling.
 */
async function resolveNodeAuthLookup(input: {
  readonly authRef: string;
  readonly nowMs?: number;
  readonly ttlMs?: number;
  readonly cache?: Map<string, NodeAuthLookupCacheEntry>;
  readonly readToken?: (input: {
    readonly authRef: string;
  }) => Promise<string | null>;
}): Promise<NodeAuthLookupResult> {
  const authRef = input.authRef.trim();
  if (!authRef) {
    return {
      ok: false,
      error: "Missing auth token reference.",
    };
  }
  const cache = input.cache ?? nodeAuthLookupCache;
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? NODE_AUTH_LOOKUP_TTL_MS;
  const cached = cache.get(authRef);
  if (cached && cached.expiresAtMs > nowMs) {
    if (cached.error) {
      return { ok: false, error: cached.error };
    }
    return { ok: true, token: cached.token };
  }

  const readToken =
    input.readToken ??
    (async ({ authRef: sourceAuthRef }: { readonly authRef: string }) =>
      await readNodeAuthToken({ authRef: sourceAuthRef }));
  try {
    const token = await readToken({ authRef });
    cache.set(authRef, {
      token,
      error: null,
      expiresAtMs: nowMs + ttlMs,
    });
    return { ok: true, token };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.trim() || "request failed";
    const formatted = `Unable to read auth token for ${authRef}: ${normalized}`;
    cache.set(authRef, {
      token: null,
      error: formatted,
      expiresAtMs: nowMs + ttlMs,
    });
    return { ok: false, error: formatted };
  }
}

function clearNodeAuthLookupCache(input: {
  readonly authRef: string;
  readonly cache?: Map<string, NodeAuthLookupCacheEntry>;
}): void {
  const authRef = input.authRef.trim();
  if (!authRef) {
    return;
  }
  const cache = input.cache ?? nodeAuthLookupCache;
  cache.delete(authRef);
}

async function probeNode(input: { readonly node: NodeRecord }): Promise<{
  readonly ok: boolean;
  readonly input: NodeRecord;
  readonly status: NodeStatus;
  readonly node?: NodeRecord;
  readonly payload?: Record<string, unknown>;
  readonly error?: string;
}> {
  const config = await readControlPlaneConfig({});
  const staleAfterMs = config.config.cluster.staleAfterMs;
  const offlineAfterMs = config.config.cluster.offlineAfterMs;
  const tokenLookup = await resolveNodeAuthLookup({
    authRef: input.node.authRef,
  });
  if (!tokenLookup.ok) {
    const status = deriveNodeHealth({
      lastSeenAt: input.node.lastSeenAt,
      staleAfterMs,
      offlineAfterMs,
    });
    await upsertNodeRecord({
      id: input.node.id,
      name: input.node.name,
      labels: input.node.labels,
      capabilities: input.node.capabilities,
      endpoint: input.node.endpoint,
      authRef: input.node.authRef,
      lastSeenAt: input.node.lastSeenAt,
      status,
      version: input.node.version,
      platform: input.node.platform,
      arch: input.node.arch,
    });
    return {
      ok: false,
      input: input.node,
      status,
      error: tokenLookup.error,
    };
  }
  const token = tokenLookup.token;
  if (!token) {
    const status = deriveNodeHealth({
      lastSeenAt: input.node.lastSeenAt,
      staleAfterMs,
      offlineAfterMs,
    });
    await upsertNodeRecord({
      id: input.node.id,
      name: input.node.name,
      labels: input.node.labels,
      capabilities: input.node.capabilities,
      endpoint: input.node.endpoint,
      authRef: input.node.authRef,
      lastSeenAt: input.node.lastSeenAt,
      status,
      version: input.node.version,
      platform: input.node.platform,
      arch: input.node.arch,
    });
    return {
      ok: false,
      input: input.node,
      status,
      error: `Missing auth token for ${input.node.authRef}`,
    };
  }

  try {
    const res = await fetchWithTimeout({
      url: `${input.node.endpoint}/v1/node/status`,
      timeoutMs: NODE_STATUS_HTTP_TIMEOUT_MS,
      init: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        clearNodeAuthLookupCache({ authRef: input.node.authRef });
      }
      const status = deriveNodeHealth({
        lastSeenAt: input.node.lastSeenAt,
        staleAfterMs,
        offlineAfterMs,
      });
      await upsertNodeRecord({
        id: input.node.id,
        name: input.node.name,
        labels: input.node.labels,
        capabilities: input.node.capabilities,
        endpoint: input.node.endpoint,
        authRef: input.node.authRef,
        lastSeenAt: input.node.lastSeenAt,
        status,
        version: input.node.version,
        platform: input.node.platform,
        arch: input.node.arch,
      });
      return {
        ok: false,
        input: input.node,
        status,
        error: `HTTP ${res.status}`,
      };
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const nodeObj = isRecord(payload.node) ? payload.node : {};
    const version = getOptionalString(nodeObj.version);
    const platform = getOptionalString(nodeObj.platform);
    const arch = getOptionalString(nodeObj.arch);

    const upserted = await upsertNodeRecord({
      id: input.node.id,
      name: input.node.name,
      labels: input.node.labels,
      capabilities: input.node.capabilities,
      endpoint: input.node.endpoint,
      authRef: input.node.authRef,
      lastSeenAt: new Date().toISOString(),
      status: "healthy",
      ...(version ? { version } : {}),
      ...(platform ? { platform } : {}),
      ...(arch ? { arch } : {}),
    });
    return {
      ok: true,
      input: input.node,
      status: "healthy",
      node: upserted.node,
      payload,
    };
  } catch (error: unknown) {
    const status = deriveNodeHealth({
      lastSeenAt: input.node.lastSeenAt,
      staleAfterMs,
      offlineAfterMs,
    });
    await upsertNodeRecord({
      id: input.node.id,
      name: input.node.name,
      labels: input.node.labels,
      capabilities: input.node.capabilities,
      endpoint: input.node.endpoint,
      authRef: input.node.authRef,
      lastSeenAt: input.node.lastSeenAt,
      status,
      version: input.node.version,
      platform: input.node.platform,
      arch: input.node.arch,
    });
    const message = describeRequestError({
      error,
      timeoutMs: NODE_STATUS_HTTP_TIMEOUT_MS,
    });
    return {
      ok: false,
      input: input.node,
      status,
      error: message,
    };
  }
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseCsv(input: string | undefined): string[] {
  const raw = (input ?? "").trim();
  if (!raw) {
    return [];
  }
  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parsePairStatusFilter(input: {
  readonly value: string | undefined;
}):
  | { readonly ok: true; readonly value: NodePairingStatus | "all" }
  | { readonly ok: false; readonly error: string } {
  const raw = (input.value ?? "pending").trim().toLowerCase();
  if (
    raw === "pending" ||
    raw === "consumed" ||
    raw === "cancelled" ||
    raw === "expired" ||
    raw === "all"
  ) {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error:
      "Invalid --status value. Expected pending|consumed|cancelled|expired|all.",
  };
}

function buildDefaultEndpoint(input: {
  readonly bind: string;
  readonly port: number;
}): string {
  const bind = input.bind.trim();
  const host =
    bind === "0.0.0.0" || bind === "::" || bind.length === 0
      ? "127.0.0.1"
      : bind;
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `http://${formatted}:${input.port}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function preflightNodeEndpoint(input: {
  readonly endpoint: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const endpoint = input.endpoint.replace(TRAILING_SLASH_PATTERN, "");
  const url = `${endpoint}/v1/node/status`;
  try {
    const response = await fetchWithTimeout({
      url,
      timeoutMs: NODE_PREFLIGHT_HTTP_TIMEOUT_MS,
      init: {
        method: "GET",
        headers: { accept: "application/json" },
      },
    });
    if (
      response.status === 200 ||
      response.status === 401 ||
      response.status === 403
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `Unexpected HTTP ${response.status} from ${url}.`,
    };
  } catch (error: unknown) {
    const message = describeRequestError({
      error,
      timeoutMs: NODE_PREFLIGHT_HTTP_TIMEOUT_MS,
    });
    return { ok: false, error: `${url} unreachable: ${message}` };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function describeRequestError(input: {
  readonly error: unknown;
  readonly timeoutMs: number;
}): string {
  if (isAbortError(input.error)) {
    return `request timed out after ${input.timeoutMs}ms`;
  }
  if (input.error instanceof Error) {
    return input.error.message;
  }
  return "request failed";
}

/**
 * Enforce finite HTTP probes so one unhealthy endpoint cannot stall the
 * controller health/status loop.
 */
async function fetchWithTimeout(input: {
  readonly url: string;
  readonly timeoutMs: number;
  readonly init?: RequestInit;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs);
  try {
    return await fetch(input.url, {
      ...input.init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

type PairTargetResolution =
  | { readonly ok: true; readonly source: string; readonly endpoint: string }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve pairing source + endpoint from explicit flags or a single host hint.
 * This keeps the common tailnet flow to one input (`--host`) while preserving
 * explicit overrides for advanced setups.
 */
async function resolvePairTarget(input: {
  readonly source: string | undefined;
  readonly host: string | undefined;
  readonly endpoint: string | undefined;
}): Promise<PairTargetResolution> {
  const normalizedHost = normalizeHostHint(input.host);
  const sourceRaw = (input.source ?? "").trim();
  const source =
    sourceRaw ||
    (normalizedHost
      ? `${resolveCurrentUsername()}@${normalizedHost}`
      : sourceRaw);
  if (!source) {
    return {
      ok: false,
      error: "Missing --source <user@host> (or pass --host <host>).",
    };
  }

  const sourceHost = extractSshHost(source);
  const host = normalizedHost || sourceHost;
  const endpointRaw = (input.endpoint ?? "")
    .trim()
    .replace(TRAILING_SLASH_PATTERN, "");

  if (endpointRaw) {
    if (!isHttpUrl(endpointRaw)) {
      return { ok: false, error: "Missing or invalid --endpoint <url>." };
    }
    const preflight = await preflightNodeEndpoint({ endpoint: endpointRaw });
    if (!preflight.ok) {
      return {
        ok: false,
        error: `Endpoint preflight failed: ${preflight.error}`,
      };
    }
    return { ok: true, source, endpoint: endpointRaw };
  }

  if (!host) {
    return {
      ok: false,
      error: "Missing --endpoint <url> (or pass --host <host>).",
    };
  }

  const candidates = buildAutoEndpointCandidates({ host });
  const errors: string[] = [];
  for (const endpoint of candidates) {
    const preflight = await preflightNodeEndpoint({ endpoint });
    if (preflight.ok) {
      return { ok: true, source, endpoint };
    }
    errors.push(`${endpoint}: ${preflight.error}`);
  }

  return {
    ok: false,
    error: [
      `Could not auto-detect --endpoint for host "${host}".`,
      `Tried: ${candidates.join(", ")}`,
      `Details: ${errors.join(" | ")}`,
      "Pass --endpoint <url> to continue.",
    ].join("\n"),
  };
}

function resolveCurrentUsername(): string {
  return (
    (process.env.USER ?? "").trim() ||
    (process.env.LOGNAME ?? "").trim() ||
    "root"
  );
}

function normalizeHostHint(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.includes("://")) {
    try {
      return new URL(raw).hostname;
    } catch {
      return raw;
    }
  }
  return extractSshHost(raw);
}

function extractSshHost(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "";
  }
  const value = trimmed.includes("@")
    ? trimmed.slice(trimmed.indexOf("@") + 1)
    : trimmed;
  if (!value) {
    return "";
  }
  if (value.startsWith("[") && value.includes("]")) {
    const closing = value.indexOf("]");
    if (closing > 1) {
      return value.slice(1, closing);
    }
  }
  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon > 0 && firstColon === lastColon) {
    return value.slice(0, lastColon);
  }
  return value;
}

function buildAutoEndpointCandidates(input: {
  readonly host: string;
}): readonly string[] {
  const host = input.host.trim().replace(TRAILING_DOT_PATTERN, "");
  if (!host) {
    return [];
  }
  const formattedHost =
    host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))
      ? `[${host}]`
      : host;
  const https = `https://${formattedHost}`;
  const httpDefault = `http://${formattedHost}:${DEFAULT_NODE_GATEWAY_PORT}`;
  const tsNet = host.endsWith(".ts.net");
  return tsNet ? [https, httpDefault] : [httpDefault, https];
}

function derivePairingName(input: {
  readonly explicitName: string | undefined;
  readonly source: string;
}): string {
  const explicit = (input.explicitName ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const source = input.source.trim();
  if (!source) {
    return hostname();
  }
  const hostPart = extractSshHost(source);
  return hostPart || source;
}

/**
 * Normalize optional --remote-hack override.
 */
function normalizeRemoteHackOverride(input: {
  readonly value: string | undefined;
}): string | undefined {
  const trimmed = (input.value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the remote shell command used over SSH to invoke hack.
 *
 * When no explicit override is supplied, this resolves the binary dynamically
 * on the remote host and prefers the standard install location first.
 */
function renderRemoteHackCommand(input: {
  readonly remoteHack: string | undefined;
  readonly args: readonly string[];
}): string {
  if (input.remoteHack) {
    return renderShellCommand({
      args: [input.remoteHack, ...input.args],
    });
  }
  const commandTail = input.args.map(shellQuote).join(" ");
  const lines = [
    `if [ -x "${DEFAULT_REMOTE_HACK_PATH}" ]; then __hack_bin="${DEFAULT_REMOTE_HACK_PATH}";`,
    'elif [ -x "/opt/homebrew/bin/hack" ]; then __hack_bin="/opt/homebrew/bin/hack";',
    'elif [ -x "/usr/local/bin/hack" ]; then __hack_bin="/usr/local/bin/hack";',
    'elif [ -x "/usr/bin/hack" ]; then __hack_bin="/usr/bin/hack";',
    'elif command -v hack >/dev/null 2>&1; then __hack_bin="$(command -v hack)";',
    `else echo "hack not found. Install to ${DEFAULT_REMOTE_HACK_PATH} or add hack to PATH." >&2; exit 127;`,
    "fi;",
    `exec "$__hack_bin" ${commandTail}`,
  ];
  return lines.join(" ");
}

async function runRemoteNodeInit(input: {
  readonly source: string;
  readonly endpoint: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly sshPort: number | undefined;
  readonly remoteHack: string | undefined;
}): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: string }
> {
  const remoteArgs = [
    "node",
    "init",
    "--name",
    input.name,
    "--endpoint",
    input.endpoint,
    ...(input.labels.length > 0 ? ["--labels", input.labels.join(",")] : []),
    "--json",
  ];
  const sshArgs = [
    "ssh",
    ...(typeof input.sshPort === "number"
      ? ["-p", String(Math.max(1, Math.trunc(input.sshPort)))]
      : []),
    input.source,
    renderRemoteHackCommand({
      remoteHack: input.remoteHack,
      args: remoteArgs,
    }),
  ];
  const result = await exec(sshArgs, { stdin: "ignore" });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      error:
        stderr.length > 0
          ? `SSH pairing command failed: ${stderr}`
          : "SSH pairing command failed.",
    };
  }
  return { ok: true, stdout: result.stdout };
}

async function runControllerPairStart(input: {
  readonly controller: string;
  readonly controllerSshPort: number | undefined;
  readonly remoteHack: string | undefined;
  readonly source: string;
  readonly endpoint: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly defaultNode: boolean;
  readonly ttlMinutes: number;
}): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: string }
> {
  const remoteArgs = [
    "node",
    "pair",
    "start",
    "--source",
    input.source,
    "--endpoint",
    input.endpoint,
    "--name",
    input.name,
    ...(input.labels.length > 0 ? ["--labels", input.labels.join(",")] : []),
    ...(input.defaultNode ? ["--default"] : []),
    "--ttl-minutes",
    String(Math.max(1, Math.trunc(input.ttlMinutes))),
    "--json",
  ];
  const sshArgs = [
    "ssh",
    ...(typeof input.controllerSshPort === "number"
      ? ["-p", String(Math.max(1, Math.trunc(input.controllerSshPort)))]
      : []),
    input.controller,
    renderRemoteHackCommand({
      remoteHack: input.remoteHack,
      args: remoteArgs,
    }),
  ];
  const result = await exec(sshArgs, { stdin: "ignore" });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      error:
        stderr.length > 0
          ? `SSH pairing request failed: ${stderr}`
          : "SSH pairing request failed.",
    };
  }
  return { ok: true, stdout: result.stdout };
}

function buildPairingCommandSet(input: {
  readonly source: string;
  readonly endpoint: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly defaultNode: boolean;
  readonly sessionId: string;
  readonly code: string;
  readonly sshPort?: number;
}): {
  readonly approveRemote: string;
  readonly completeController: string;
  readonly endToEnd: string;
} {
  const approveArgs = [
    "node",
    "pair",
    "approve",
    "--session",
    input.sessionId,
    "--code",
    input.code,
    "--endpoint",
    input.endpoint,
    "--name",
    input.name,
    ...(input.labels.length > 0 ? ["--labels", input.labels.join(",")] : []),
    "--json",
  ];
  const completeArgs = [
    "hack",
    "node",
    "pair",
    "complete",
    "--session",
    input.sessionId,
    "--bundle",
    "-",
    ...(input.defaultNode ? ["--default"] : []),
  ];
  const approveRemote = renderRemoteHackCommand({
    remoteHack: undefined,
    args: approveArgs,
  });
  const completeController = renderShellCommand({ args: completeArgs });
  const sshPrefix =
    typeof input.sshPort === "number"
      ? `ssh -p ${Math.max(1, Math.trunc(input.sshPort))}`
      : "ssh";
  const endToEnd = `${sshPrefix} ${input.source} ${approveRemote} | ${completeController}`;
  return {
    approveRemote,
    completeController,
    endToEnd,
  };
}

async function runRemotePairApprove(input: {
  readonly source: string;
  readonly endpoint: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly sessionId: string;
  readonly code: string;
  readonly sshPort: number | undefined;
  readonly remoteHack: string | undefined;
}): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: string }
> {
  const remoteArgs = [
    "node",
    "pair",
    "approve",
    "--session",
    input.sessionId,
    "--code",
    input.code,
    "--endpoint",
    input.endpoint,
    "--name",
    input.name,
    ...(input.labels.length > 0 ? ["--labels", input.labels.join(",")] : []),
    "--json",
  ];
  const sshArgs = [
    "ssh",
    ...(typeof input.sshPort === "number"
      ? ["-p", String(Math.max(1, Math.trunc(input.sshPort)))]
      : []),
    input.source,
    renderRemoteHackCommand({
      remoteHack: input.remoteHack,
      args: remoteArgs,
    }),
  ];
  const result = await exec(sshArgs, { stdin: "ignore" });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      error:
        stderr.length > 0
          ? `SSH pairing approval failed: ${stderr}`
          : "SSH pairing approval failed.",
    };
  }
  return { ok: true, stdout: result.stdout };
}

async function registerBundleOnController(input: {
  readonly bundle: NodeEnrollmentBundle;
  readonly makeDefault: boolean;
}): Promise<
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly nodeForOutput: NodeRecord;
      readonly probe: NodeStatusSnapshot;
    }
  | { readonly ok: false; readonly error: string }
> {
  try {
    await saveNodeAuthToken({
      authRef: input.bundle.node.authRef,
      token: input.bundle.token,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "failed to save node token";
    return { ok: false, error: `Failed to store auth token: ${message}` };
  }

  const upserted = await upsertNodeRecord({
    id: input.bundle.node.id,
    name: input.bundle.node.name,
    labels: input.bundle.node.labels,
    capabilities: input.bundle.node.capabilities,
    endpoint: input.bundle.node.endpoint,
    authRef: input.bundle.node.authRef,
    platform: input.bundle.node.platform,
    arch: input.bundle.node.arch,
    version: input.bundle.node.version,
    status: "unknown",
  });
  if (input.makeDefault) {
    await setDefaultNode({ id: upserted.node.id });
  }
  const probe = await probeNode({ node: upserted.node });
  return {
    ok: true,
    created: upserted.created,
    nodeForOutput: probe.node ?? upserted.node,
    probe,
  };
}

async function completePairingWithBundle(input: {
  readonly sessionId: string;
  readonly bundle: NodeEnrollmentBundle;
  readonly makeDefault: boolean;
}): Promise<
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly nodeForOutput: NodeRecord;
      readonly probe: NodeStatusSnapshot;
      readonly consumedAt?: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  if (!input.bundle.pairing) {
    return {
      ok: false,
      error:
        "Bundle is missing pairing attestation. Use `hack node pair approve` on remote node.",
    };
  }
  if (input.bundle.pairing.sessionId !== input.sessionId) {
    return {
      ok: false,
      error: `Pairing session mismatch: expected ${input.sessionId}, got ${input.bundle.pairing.sessionId}.`,
    };
  }
  const consumed = await consumeNodePairingSession({
    sessionId: input.sessionId,
    code: input.bundle.pairing.code,
  });
  if (!consumed.ok) {
    return { ok: false, error: consumed.error };
  }

  const registered = await registerBundleOnController({
    bundle: input.bundle,
    makeDefault: input.makeDefault,
  });
  if (!registered.ok) {
    return registered;
  }
  return {
    ok: true,
    created: registered.created,
    nodeForOutput: registered.nodeForOutput,
    probe: registered.probe,
    consumedAt: consumed.session.consumedAt,
  };
}

function renderShellCommand(input: {
  readonly args: readonly string[];
}): string {
  return input.args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readBundleInput(input: {
  readonly value: string;
}): Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string }
> {
  if (input.value === "-") {
    const text = await new Response(Bun.stdin.stream()).text();
    if (!text.trim()) {
      return { ok: false, error: "No bundle data received on stdin." };
    }
    return { ok: true, text };
  }
  try {
    const text = await readFile(input.value, "utf8");
    return { ok: true, text };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "read failed";
    return { ok: false, error: `Failed to read bundle: ${message}` };
  }
}

function parseEnrollmentBundle(input: {
  readonly text: string;
}):
  | { readonly ok: true; readonly bundle: NodeEnrollmentBundle }
  | { readonly ok: false; readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { ok: false, error: "Bundle is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Bundle must be a JSON object." };
  }
  const envelope = isRecord(parsed.bundle) ? parsed.bundle : parsed;
  if (!isRecord(envelope)) {
    return { ok: false, error: "Bundle payload missing." };
  }
  const version = envelope.version;
  if (version !== 1) {
    return { ok: false, error: "Unsupported bundle version." };
  }
  const nodeRaw = envelope.node;
  const token = getOptionalString(envelope.token);
  if (!(isRecord(nodeRaw) && token)) {
    return { ok: false, error: "Bundle requires { node, token }." };
  }
  const id = getOptionalString(nodeRaw.id);
  const name = getOptionalString(nodeRaw.name);
  const endpoint = getOptionalString(nodeRaw.endpoint);
  const authRef = getOptionalString(nodeRaw.authRef);
  if (!(id && name && endpoint && authRef)) {
    return {
      ok: false,
      error: "Bundle node requires id, name, endpoint, and authRef.",
    };
  }
  const labels = Array.isArray(nodeRaw.labels)
    ? nodeRaw.labels.filter((entry) => typeof entry === "string")
    : [];
  const capabilities = Array.isArray(nodeRaw.capabilities)
    ? nodeRaw.capabilities.filter((entry) => typeof entry === "string")
    : [...DEFAULT_NODE_CAPABILITIES];
  const pairingRaw = isRecord(envelope.pairing) ? envelope.pairing : null;
  const pairingSessionId = pairingRaw
    ? getOptionalString(pairingRaw.sessionId)
    : undefined;
  const pairingCode = pairingRaw
    ? getOptionalString(pairingRaw.code)
    : undefined;
  const pairingApprovedAt = pairingRaw
    ? getOptionalString(pairingRaw.approvedAt)
    : undefined;
  const bundle: NodeEnrollmentBundle = {
    version: 1,
    node: {
      id,
      name,
      endpoint,
      authRef,
      labels,
      capabilities,
      platform: getOptionalString(nodeRaw.platform) ?? "unknown",
      arch: getOptionalString(nodeRaw.arch) ?? "unknown",
      version: getOptionalString(nodeRaw.version) ?? "unknown",
    },
    token,
    ...(pairingSessionId && pairingCode && pairingApprovedAt
      ? {
          pairing: {
            sessionId: pairingSessionId,
            code: pairingCode,
            approvedAt: pairingApprovedAt,
          },
        }
      : {}),
  };
  return { ok: true, bundle };
}

function parseEnrollmentBundleFromRemoteOutput(input: {
  readonly text: string;
}):
  | { readonly ok: true; readonly bundle: NodeEnrollmentBundle }
  | { readonly ok: false; readonly error: string } {
  const direct = parseEnrollmentBundle({ text: input.text });
  if (direct.ok) {
    return direct;
  }
  const firstBrace = input.text.indexOf("{");
  const lastBrace = input.text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return direct;
  }
  const candidate = input.text.slice(firstBrace, lastBrace + 1);
  const extracted = parseEnrollmentBundle({ text: candidate });
  if (extracted.ok) {
    return extracted;
  }
  return direct;
}

function parsePairStartResponse(input: { readonly text: string }):
  | {
      readonly ok: true;
      readonly payload: {
        readonly session: {
          readonly id: string;
          readonly expiresAt: string;
        };
        readonly code: string;
      };
    }
  | { readonly ok: false; readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { ok: false, error: "Response is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Response must be a JSON object." };
  }
  const code = getOptionalString(parsed.code);
  const sessionRaw = isRecord(parsed.session) ? parsed.session : null;
  const sessionId = sessionRaw ? getOptionalString(sessionRaw.id) : undefined;
  const expiresAt = sessionRaw
    ? getOptionalString(sessionRaw.expiresAt)
    : undefined;
  if (!(code && sessionId && expiresAt)) {
    return {
      ok: false,
      error: "Response missing session.id, session.expiresAt, or code.",
    };
  }
  return {
    ok: true,
    payload: {
      session: {
        id: sessionId,
        expiresAt,
      },
      code,
    },
  };
}

function parsePairStartResponseOutput(input: { readonly text: string }):
  | {
      readonly ok: true;
      readonly payload: {
        readonly session: {
          readonly id: string;
          readonly expiresAt: string;
        };
        readonly code: string;
      };
    }
  | { readonly ok: false; readonly error: string } {
  const direct = parsePairStartResponse({ text: input.text });
  if (direct.ok) {
    return direct;
  }
  const firstBrace = input.text.indexOf("{");
  const lastBrace = input.text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return direct;
  }
  const candidate = input.text.slice(firstBrace, lastBrace + 1);
  const extracted = parsePairStartResponse({ text: candidate });
  if (extracted.ok) {
    return extracted;
  }
  return direct;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
