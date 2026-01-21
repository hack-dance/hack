import { appendFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import pkg from "../../package.json";
import { GLOBAL_HACK_DIR_NAME } from "../constants.ts";
import { ensureDir, pathExists } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { findProjectContext } from "../lib/project.ts";
import {
  readProjectsRegistry,
  resolveRegisteredProjectByName,
} from "../lib/projects-registry.ts";
import { readLinesFromStream } from "../ui/lines.ts";

type PackageJsonType = {
  readonly name: string;
  readonly version: string;
} & Record<string, unknown>;

const packageJson = pkg as unknown as PackageJsonType;

type ProjectSelection = {
  readonly projectName?: string;
  readonly repoRoot?: string;
  readonly path?: string;
};

type HackCommandResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ToolResultPayload = HackCommandResult & {
  readonly ok: boolean;
  readonly data?: unknown;
};

const DEFAULT_CMD_TIMEOUT_MS = 120_000;
const DEFAULT_LOG_TAIL_EVENTS = 200;
const DEFAULT_LOG_TAIL_MS = 5000;

const toolOutputSchema = {
  ok: z.boolean(),
  command: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  data: z.unknown().optional(),
} as const;

/**
 * Start the hack MCP server on stdio for local tool clients.
 */
export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    {
      name: packageJson.name,
      version: packageJson.version,
    },
    {
      capabilities: { tools: {} },
    }
  );

  registerTools({ server });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function registerTools(opts: { readonly server: McpServer }): void {
  const projectSelectorInput = {
    projectName: z
      .string()
      .describe("Registered project name (from ~/.hack/projects.json)")
      .optional(),
    repoRoot: z
      .string()
      .describe("Repo root path (absolute or relative)")
      .optional(),
    path: z
      .string()
      .describe("Path inside a repo (absolute or relative)")
      .optional(),
  };

  const branchInput = {
    branch: z.string().describe("Branch/worktree name").optional(),
  };

  const profileInput = {
    profiles: z.array(z.string()).describe("Compose profile names").optional(),
  };

  opts.server.registerTool(
    "hack.projects.list",
    {
      title: "List hack projects",
      description: "List registered hack projects and runtime status.",
      inputSchema: {
        filter: z.string().describe("Filter by project name").optional(),
        includeGlobal: z
          .boolean()
          .describe("Include global infra projects")
          .optional(),
        includeUnregistered: z
          .boolean()
          .describe("Include unregistered compose projects")
          .optional(),
      },
      outputSchema: toolOutputSchema,
    },
    async ({
      filter,
      includeGlobal,
      includeUnregistered,
    }): Promise<CallToolResult> => {
      const args = [
        "projects",
        "--json",
        ...(filter ? ["--project", filter] : []),
        ...(includeGlobal ? ["--include-global"] : []),
        ...(includeUnregistered ? ["--all"] : []),
      ];

      const result = await runHackCommand({
        tool: "hack.projects.list",
        args,
      });

      return buildToolResult({
        result,
        data: parseJson(result.stdout),
      });
    }
  );

  opts.server.registerTool(
    "hack.project.status",
    {
      title: "Project status",
      description: "Get docker compose status for a project.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        ...profileInput,
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "ps",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--json",
      ];

      const result = await runHackCommand({
        tool: "hack.project.status",
        args,
      });

      return buildToolResult({
        result,
        data: parseJson(result.stdout),
      });
    }
  );

  opts.server.registerTool(
    "hack.project.up",
    {
      title: "Start project",
      description: "Start project services in detached mode.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        ...profileInput,
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "up",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--detach",
      ];

      const result = await runHackCommand({
        tool: "hack.project.up",
        args,
      });

      return buildToolResult({ result });
    }
  );

  opts.server.registerTool(
    "hack.project.down",
    {
      title: "Stop project",
      description: "Stop project services.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        ...profileInput,
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "down",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
      ];

      const result = await runHackCommand({
        tool: "hack.project.down",
        args,
      });

      return buildToolResult({ result });
    }
  );

  opts.server.registerTool(
    "hack.project.restart",
    {
      title: "Restart project",
      description: "Restart project services.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        ...profileInput,
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "restart",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
      ];

      const result = await runHackCommand({
        tool: "hack.project.restart",
        args,
      });

      return buildToolResult({ result });
    }
  );

  opts.server.registerTool(
    "hack.project.run",
    {
      title: "Run command in service container",
      description: "Run a one-off command inside a service container.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        ...profileInput,
        service: z.string().describe("Compose service name"),
        cmd: z.array(z.string()).describe("Command arguments").optional(),
        workdir: z
          .string()
          .describe("Working directory inside container")
          .optional(),
        timeoutMs: z.number().describe("Command timeout in ms").optional(),
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "run",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        ...(input.workdir ? ["--workdir", input.workdir] : []),
        input.service,
        ...(input.cmd ?? []),
      ];

      const result = await runHackCommand({
        tool: "hack.project.run",
        args,
        timeoutMs: input.timeoutMs,
      });

      return buildToolResult({ result });
    }
  );

  opts.server.registerTool(
    "hack.project.logs.snapshot",
    {
      title: "Snapshot logs",
      description: "Fetch a log snapshot and return structured log events.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        ...profileInput,
        service: z.string().describe("Single service name").optional(),
        services: z
          .array(z.string())
          .describe("Multiple service names")
          .optional(),
        query: z.string().describe("Raw LogQL selector/query").optional(),
        loki: z.boolean().describe("Force Loki backend").optional(),
        compose: z
          .boolean()
          .describe("Force docker compose backend")
          .optional(),
        tail: z.number().describe("Tail last N log lines").optional(),
        since: z
          .string()
          .describe("Start time (RFC3339 or duration)")
          .optional(),
        until: z.string().describe("End time (RFC3339 or duration)").optional(),
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "logs",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--json",
        "--no-follow",
        ...(input.loki ? ["--loki"] : []),
        ...(input.compose ? ["--compose"] : []),
        ...(input.tail ? ["--tail", String(input.tail)] : []),
        ...(input.query ? ["--query", input.query] : []),
        ...(input.services
          ? buildServicesArgs({ services: input.services })
          : []),
        ...(input.since ? ["--since", input.since] : []),
        ...(input.until ? ["--until", input.until] : []),
        ...(input.service ? [input.service] : []),
      ];

      const result = await runHackCommand({
        tool: "hack.project.logs.snapshot",
        args,
      });

      return buildToolResult({
        result,
        data: {
          events: parseJsonLines(result.stdout),
          count: countJsonLines(result.stdout),
        },
      });
    }
  );

  opts.server.registerTool(
    "hack.project.logs.tail",
    {
      title: "Tail logs",
      description: "Stream logs briefly and return the collected events.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        ...profileInput,
        service: z.string().describe("Single service name").optional(),
        services: z
          .array(z.string())
          .describe("Multiple service names")
          .optional(),
        query: z.string().describe("Raw LogQL selector/query").optional(),
        loki: z.boolean().describe("Force Loki backend").optional(),
        compose: z
          .boolean()
          .describe("Force docker compose backend")
          .optional(),
        tail: z.number().describe("Tail last N log lines").optional(),
        since: z
          .string()
          .describe("Start time (RFC3339 or duration)")
          .optional(),
        until: z.string().describe("End time (RFC3339 or duration)").optional(),
        maxEvents: z.number().describe("Max events to collect").optional(),
        maxMs: z.number().describe("Max duration in ms").optional(),
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "logs",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--json",
        ...(input.loki ? ["--loki"] : []),
        ...(input.compose ? ["--compose"] : []),
        ...(input.tail ? ["--tail", String(input.tail)] : []),
        ...(input.query ? ["--query", input.query] : []),
        ...(input.services
          ? buildServicesArgs({ services: input.services })
          : []),
        ...(input.since ? ["--since", input.since] : []),
        ...(input.until ? ["--until", input.until] : []),
        ...(input.service ? [input.service] : []),
      ];

      const result = await runHackLogTail({
        tool: "hack.project.logs.tail",
        args,
        maxEvents: input.maxEvents,
        maxMs: input.maxMs,
      });

      return buildToolResult({
        result: {
          command: result.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        data: {
          events: result.events,
          count: result.events.length,
          stop_reason: result.stopReason,
          duration_ms: result.durationMs,
        },
      });
    }
  );

  opts.server.registerTool(
    "hack.project.open",
    {
      title: "Resolve project URL",
      description: "Return a URL for the project without launching a browser.",
      inputSchema: {
        ...projectSelectorInput,
        ...branchInput,
        target: z.string().describe("Target host/subdomain or URL").optional(),
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: process.cwd(),
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "open",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        "--json",
        ...(input.target ? [input.target] : []),
      ];

      const result = await runHackCommand({
        tool: "hack.project.open",
        args,
      });

      return buildToolResult({
        result,
        data: parseJson(result.stdout),
      });
    }
  );

  opts.server.registerTool(
    "hack.project.init",
    {
      title: "Initialize project",
      description: "Initialize a repo using non-interactive defaults.",
      inputSchema: {
        ...projectSelectorInput,
        name: z.string().describe("Project slug").optional(),
        devHost: z.string().describe("DEV_HOST override").optional(),
        oauth: z.boolean().describe("Enable OAuth alias host").optional(),
        oauthTld: z.string().describe("OAuth alias TLD").optional(),
        manual: z
          .boolean()
          .describe("Skip discovery and generate a minimal compose")
          .optional(),
        noDiscovery: z
          .boolean()
          .describe("Skip discovery even if available")
          .optional(),
      },
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const selection = toProjectSelection(input);
      if (!(selection.path || selection.repoRoot)) {
        return buildToolError({
          message: "Provide repoRoot or path for initialization.",
        });
      }

      const resolved = await resolveProjectArgs({
        selection,
        cwd: process.cwd(),
        allowUnregistered: true,
      });
      if (!resolved.ok) return buildToolError({ message: resolved.message });

      const args = [
        "init",
        ...resolved.args,
        "--auto",
        ...(input.name ? ["--name", input.name] : []),
        ...(input.devHost ? ["--dev-host", input.devHost] : []),
        ...(input.oauth ? ["--oauth"] : []),
        ...(input.oauthTld ? ["--oauth-tld", input.oauthTld] : []),
        ...(input.manual ? ["--manual"] : []),
        ...(input.noDiscovery ? ["--no-discovery"] : []),
      ];

      const result = await runHackCommand({
        tool: "hack.project.init",
        args,
        timeoutMs: 180_000,
      });

      return buildToolResult({ result });
    }
  );
}

function buildToolResult(opts: {
  readonly result: HackCommandResult;
  readonly data?: unknown;
}): CallToolResult {
  const ok = opts.result.exitCode === 0;
  const payload: ToolResultPayload = {
    ok,
    command: opts.result.command,
    exitCode: opts.result.exitCode,
    stdout: opts.result.stdout,
    stderr: opts.result.stderr,
    ...(opts.data !== undefined ? { data: opts.data } : {}),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(ok ? {} : { isError: true }),
  };
}

function buildToolError(opts: {
  readonly message: string;
  readonly command?: string;
}): CallToolResult {
  const payload: ToolResultPayload = {
    ok: false,
    command: opts.command ?? "",
    exitCode: 1,
    stdout: "",
    stderr: opts.message,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function buildBranchArgs(opts: { readonly branch?: string }): string[] {
  const branch = (opts.branch ?? "").trim();
  return branch.length > 0 ? ["--branch", branch] : [];
}

function buildProfileArgs(opts: {
  readonly profiles?: readonly string[];
}): string[] {
  const profiles = (opts.profiles ?? []).map((p) => p.trim()).filter(Boolean);
  if (profiles.length === 0) return [];
  return ["--profile", profiles.join(",")];
}

function buildServicesArgs(opts: {
  readonly services: readonly string[];
}): string[] {
  const services = opts.services.map((s) => s.trim()).filter(Boolean);
  if (services.length === 0) return [];
  return ["--services", services.join(",")];
}

function toProjectSelection(input: ProjectSelection): ProjectSelection {
  return {
    projectName: input.projectName,
    repoRoot: input.repoRoot,
    path: input.path,
  };
}

async function resolveProjectArgs(opts: {
  readonly selection: ProjectSelection;
  readonly cwd: string;
  readonly allowUnregistered?: boolean;
}): Promise<
  | { readonly ok: true; readonly args: string[] }
  | { readonly ok: false; readonly message: string }
> {
  const selection = opts.selection;
  const picked = [
    selection.projectName,
    selection.repoRoot,
    selection.path,
  ].filter(Boolean);
  if (picked.length > 1) {
    return {
      ok: false,
      message: "Use only one of projectName, repoRoot, or path.",
    };
  }

  if (selection.projectName) {
    const project = await resolveRegisteredProjectByName({
      name: selection.projectName,
    });
    if (!project) {
      return {
        ok: false,
        message: `Unknown project "${selection.projectName}". Run 'hack init' or 'hack projects' first.`,
      };
    }
    return { ok: true, args: ["--project", selection.projectName] };
  }

  const pathLike = selection.repoRoot ?? selection.path;
  if (pathLike) {
    const absPath = resolve(opts.cwd, pathLike);
    if (!(await pathExists(absPath))) {
      return { ok: false, message: `Path not found: ${absPath}` };
    }
    if (!opts.allowUnregistered) {
      const allowed = await isPathAllowed({ absPath });
      if (!allowed) {
        return {
          ok: false,
          message: "Path is outside registered hack projects.",
        };
      }
    }
    return { ok: true, args: ["--path", absPath] };
  }

  const context = await findProjectContext(opts.cwd);
  if (context) return { ok: true, args: [] };

  if (!opts.allowUnregistered) {
    const allowed = await isPathAllowed({ absPath: opts.cwd });
    if (!allowed) {
      return {
        ok: false,
        message: "No project context found. Provide projectName or path.",
      };
    }
  }

  return { ok: true, args: ["--path", opts.cwd] };
}

async function isPathAllowed(opts: {
  readonly absPath: string;
}): Promise<boolean> {
  const roots = await readAllowedRoots();
  if (roots.length === 0) return false;
  return roots.some((root) =>
    isPathWithin({ parent: root, child: opts.absPath })
  );
}

async function readAllowedRoots(): Promise<string[]> {
  const registry = await readProjectsRegistry();
  const roots = new Set<string>();
  for (const project of registry.projects) {
    roots.add(resolve(project.repoRoot));
    roots.add(resolve(project.projectDir));
  }
  return [...roots];
}

function isPathWithin(opts: {
  readonly parent: string;
  readonly child: string;
}): boolean {
  const rel = relative(opts.parent, opts.child);
  if (rel === "") return true;
  return !(rel.startsWith("..") || isAbsolute(rel));
}

async function runHackCommand(opts: {
  readonly tool: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}): Promise<HackCommandResult> {
  const invocation = await resolveHackInvocation();
  const cmd = [invocation.bin, ...invocation.args, ...opts.args];
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr] = await Promise.all([
    streamToText(proc.stdout),
    streamToText(proc.stderr),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const command = formatCommand(cmd);
  await appendAuditLog({
    tool: opts.tool,
    command,
    exitCode,
  });

  return {
    command,
    exitCode,
    stdout,
    stderr,
  };
}

async function runHackLogTail(opts: {
  readonly tool: string;
  readonly args: readonly string[];
  readonly maxEvents?: number;
  readonly maxMs?: number;
}): Promise<{
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: readonly Record<string, unknown>[];
  readonly stopReason: string;
  readonly durationMs: number;
}> {
  const invocation = await resolveHackInvocation();
  const cmd = [invocation.bin, ...invocation.args, ...opts.args];
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const maxEvents = opts.maxEvents ?? DEFAULT_LOG_TAIL_EVENTS;
  const maxMs = opts.maxMs ?? DEFAULT_LOG_TAIL_MS;
  const start = Date.now();

  const events: Record<string, unknown>[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  let stopReason = "eof";

  const stop = (reason: string) => {
    if (stopReason !== "eof") return;
    stopReason = reason;
    proc.kill();
  };

  const stdoutTask = (async () => {
    for await (const line of readLinesFromStream(proc.stdout)) {
      stdoutLines.push(line);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = parseJsonLine(trimmed);
      if (parsed) events.push(parsed);
      if (events.length >= maxEvents) {
        stop("max_events");
        break;
      }
    }
  })();

  const stderrTask = (async () => {
    for await (const line of readLinesFromStream(proc.stderr)) {
      stderrLines.push(line);
    }
  })();

  const timer = setTimeout(() => stop("timeout"), maxMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  await Promise.all([stdoutTask, stderrTask]);

  const command = formatCommand(cmd);
  await appendAuditLog({ tool: opts.tool, command, exitCode });

  return {
    command,
    exitCode,
    stdout: joinLines(stdoutLines),
    stderr: joinLines(stderrLines),
    events,
    stopReason,
    durationMs: Date.now() - start,
  };
}

function formatCommand(parts: readonly string[]): string {
  return parts
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseJsonLine(line.trim());
    if (parsed) events.push(parsed);
  }
  return events;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  if (line.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function countJsonLines(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (parseJsonLine(line.trim())) count += 1;
  }
  return count;
}

function joinLines(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

async function streamToText(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

async function appendAuditLog(opts: {
  readonly tool: string;
  readonly command: string;
  readonly exitCode: number;
}): Promise<void> {
  const home = (process.env.HOME ?? "").trim();
  if (home.length === 0) return;
  const logPath = resolve(home, GLOBAL_HACK_DIR_NAME, "mcp-audit.log");
  try {
    await ensureDir(dirname(logPath));
    const payload = {
      ts: new Date().toISOString(),
      tool: opts.tool,
      command: opts.command,
      exit_code: opts.exitCode,
    };
    await appendFile(logPath, `${JSON.stringify(payload)}\n`);
  } catch {
    return;
  }
}
