import { createHash } from "node:crypto";
import { basename } from "node:path";

import { pathExists } from "./fs.ts";
import { type ExecResult, exec, findExecutableInPath } from "./shell.ts";

const DEFAULT_MUTAGEN_EXCLUDES = [
  ".git",
  ".hack/.internal",
  ".DS_Store",
] as const;
const MUTAGEN_SESSION_HASH_LENGTH = 8;
const MUTAGEN_SESSION_MAX_LENGTH = 72;
const SSH_BRACKET_HOST_PATTERN = /^\[(.+)\](?::(\d+))?$/;
const SSH_NUMERIC_PORT_PATTERN = /^\d+$/;

export type MutagenSyncFailureCode =
  | "missing_binary"
  | "missing_source"
  | "missing_local_path"
  | "invalid_remote_path"
  | "create_failed"
  | "flush_failed";

export type ParsedSshSource = {
  readonly user?: string;
  readonly host: string;
  readonly port?: number;
};

export type MutagenSyncSuccess = {
  readonly ok: true;
  readonly sessionName: string;
  readonly created: boolean;
  readonly localPath: string;
  readonly remotePath: string;
  readonly remoteUri: string;
  readonly excludes: readonly string[];
};

export type MutagenSyncFailure = {
  readonly ok: false;
  readonly code: MutagenSyncFailureCode;
  readonly error: string;
};

export type MutagenSyncResult = MutagenSyncSuccess | MutagenSyncFailure;

type MutagenExec = (input: {
  readonly cmd: readonly string[];
}) => Promise<ExecResult>;
type MutagenBinaryResolver = (input: {
  readonly name: string;
}) => string | null;

/**
 * Ensure a one-way Mutagen sync session exists and flush local edits to remote workspace.
 */
export async function ensureMutagenLocalToRemoteSync(input: {
  readonly projectName?: string;
  readonly nodeId: string;
  readonly branch?: string;
  readonly nodeSource: string;
  readonly localProjectRoot: string;
  readonly remoteProjectRoot: string;
  readonly exclude?: readonly string[];
  readonly resolveBinary?: MutagenBinaryResolver;
  readonly execCommand?: MutagenExec;
}): Promise<MutagenSyncResult> {
  const localProjectRoot = input.localProjectRoot.trim();
  if (!(localProjectRoot && (await pathExists(localProjectRoot)))) {
    return {
      ok: false,
      code: "missing_local_path",
      error: `Local project root is missing or not accessible: ${input.localProjectRoot}`,
    };
  }

  const remoteProjectRoot = normalizeRemotePath({
    value: input.remoteProjectRoot,
  });
  if (!remoteProjectRoot) {
    return {
      ok: false,
      code: "invalid_remote_path",
      error: `Remote project root must be an absolute path: ${input.remoteProjectRoot}`,
    };
  }

  const source = parseSshSource({ source: input.nodeSource });
  if (!source) {
    return {
      ok: false,
      code: "missing_source",
      error:
        "Node SSH source is missing or invalid. Re-pair with `hack node pair --source <user@host> ...`.",
    };
  }

  const resolveBinary = input.resolveBinary ?? defaultMutagenBinaryResolver;
  const mutagenBin = normalizeBinaryPath({
    value: resolveBinary({ name: "mutagen" }),
  });
  if (!mutagenBin) {
    return {
      ok: false,
      code: "missing_binary",
      error:
        "Mutagen binary was not found on this machine. Install Mutagen or switch execution mode.",
    };
  }

  const remoteUri = buildMutagenSshUri({
    source,
    remotePath: remoteProjectRoot,
  });
  const sessionName = buildMutagenSessionName({
    projectName: input.projectName ?? basename(localProjectRoot),
    nodeId: input.nodeId,
    branch: input.branch,
    localProjectRoot,
    remoteProjectRoot,
  });
  const excludes = normalizeExcludePatterns({
    configured: input.exclude ?? [],
  });

  const createArgs = [
    mutagenBin,
    "sync",
    "create",
    "--name",
    sessionName,
    "--sync-mode",
    "one-way-safe",
    ...renderMutagenIgnoreArgs({ excludes }),
    localProjectRoot,
    remoteUri,
  ] as const;
  const runMutagen = input.execCommand ?? defaultMutagenExec;
  const create = await runMutagen({ cmd: createArgs });
  const alreadyExists = isMutagenSessionAlreadyExists({ result: create });
  if (create.exitCode !== 0 && !alreadyExists) {
    return {
      ok: false,
      code: "create_failed",
      error: formatMutagenFailure({
        action: "Mutagen sync create failed",
        result: create,
      }),
    };
  }

  const flushArgs = [mutagenBin, "sync", "flush", sessionName] as const;
  const flush = await runMutagen({ cmd: flushArgs });
  if (flush.exitCode !== 0) {
    return {
      ok: false,
      code: "flush_failed",
      error: formatMutagenFailure({
        action: "Mutagen sync flush failed",
        result: flush,
      }),
    };
  }

  return {
    ok: true,
    sessionName,
    created: create.exitCode === 0,
    localPath: localProjectRoot,
    remotePath: remoteProjectRoot,
    remoteUri,
    excludes,
  };
}

/**
 * Parse `<user@host[:port]>` into normalized SSH source fields.
 */
export function parseSshSource(input: {
  readonly source: string;
}): ParsedSshSource | null {
  const raw = input.source.trim();
  if (!raw) {
    return null;
  }

  const atIndex = raw.lastIndexOf("@");
  const user =
    atIndex > 0
      ? normalizeSshUser({
          value: raw.slice(0, atIndex),
        })
      : undefined;
  const hostPort = (atIndex >= 0 ? raw.slice(atIndex + 1) : raw).trim();
  if (!hostPort) {
    return null;
  }

  const parsedHostPort = parseSshHostPort({ value: hostPort });
  if (!parsedHostPort) {
    return null;
  }
  return {
    ...(user ? { user } : {}),
    host: parsedHostPort.host,
    ...(parsedHostPort.port !== undefined ? { port: parsedHostPort.port } : {}),
  };
}

/**
 * Build a stable Mutagen session name for a project/node/branch tuple.
 */
export function buildMutagenSessionName(input: {
  readonly projectName: string;
  readonly nodeId: string;
  readonly branch?: string;
  readonly localProjectRoot: string;
  readonly remoteProjectRoot: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.localProjectRoot.trim()}|${input.remoteProjectRoot.trim()}|${input.branch ?? ""}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, MUTAGEN_SESSION_HASH_LENGTH);

  const stem = [
    "hack",
    sanitizeSessionToken({ value: input.projectName }),
    sanitizeSessionToken({ value: input.nodeId }),
    sanitizeSessionToken({ value: input.branch ?? "default" }),
  ]
    .filter((entry) => entry.length > 0)
    .join("-");

  const allowedStemLength = Math.max(
    1,
    MUTAGEN_SESSION_MAX_LENGTH - MUTAGEN_SESSION_HASH_LENGTH - 1
  );
  const clippedStem =
    stem.slice(0, allowedStemLength).replace(/-+$/g, "") || "hack";
  return `${clippedStem}-${digest}`;
}

/**
 * Build an SSH URI that Mutagen accepts for remote endpoint addressing.
 */
export function buildMutagenSshUri(input: {
  readonly source: ParsedSshSource;
  readonly remotePath: string;
}): string {
  const host = input.source.host.includes(":")
    ? `[${input.source.host}]`
    : input.source.host;
  const user = input.source.user
    ? `${encodeURIComponent(input.source.user)}@`
    : "";
  const port = input.source.port ? `:${input.source.port}` : "";
  return `ssh://${user}${host}${port}${encodeURI(input.remotePath)}`;
}

function normalizeRemotePath(input: { readonly value: string }): string | null {
  const trimmed = input.value.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  return trimmed;
}

function defaultMutagenBinaryResolver(input: {
  readonly name: string;
}): string | null {
  return findExecutableInPath(input.name);
}

async function defaultMutagenExec(input: {
  readonly cmd: readonly string[];
}): Promise<ExecResult> {
  return await exec(input.cmd, { stdin: "ignore" });
}

function normalizeBinaryPath(input: {
  readonly value: string | null;
}): string | null {
  const trimmed = input.value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeExcludePatterns(input: {
  readonly configured: readonly string[];
}): string[] {
  const seen = new Set<string>();
  const excludes: string[] = [];
  const merged = [...DEFAULT_MUTAGEN_EXCLUDES, ...input.configured];
  for (const raw of merged) {
    const value = raw.trim();
    if (!(value && !seen.has(value))) {
      continue;
    }
    seen.add(value);
    excludes.push(value);
  }
  return excludes;
}

function renderMutagenIgnoreArgs(input: {
  readonly excludes: readonly string[];
}): string[] {
  const args: string[] = [];
  for (const pattern of input.excludes) {
    args.push("--ignore", pattern);
  }
  return args;
}

function normalizeSshUser(input: {
  readonly value: string;
}): string | undefined {
  const trimmed = input.value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSshHostPort(input: {
  readonly value: string;
}): { readonly host: string; readonly port?: number } | null {
  const raw = input.value.trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith("[")) {
    const matched = raw.match(SSH_BRACKET_HOST_PATTERN);
    if (!matched) {
      return null;
    }
    const host = matched[1]?.trim();
    if (!host) {
      return null;
    }
    const port = parseOptionalPort({ raw: matched[2] });
    if (matched[2] && port === undefined) {
      return null;
    }
    return {
      host,
      ...(port !== undefined ? { port } : {}),
    };
  }

  const colonMatches = raw.match(/:/g)?.length ?? 0;
  if (colonMatches === 1) {
    const splitIndex = raw.lastIndexOf(":");
    const host = raw.slice(0, splitIndex).trim();
    const rawPort = raw.slice(splitIndex + 1).trim();
    const port = parseOptionalPort({ raw: rawPort });
    if (host && port !== undefined) {
      return { host, port };
    }
  }

  return { host: raw };
}

function parseOptionalPort(input: {
  readonly raw: string | undefined;
}): number | undefined {
  const raw = input.raw?.trim() ?? "";
  if (!raw) {
    return undefined;
  }
  if (!SSH_NUMERIC_PORT_PATTERN.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed >= 1 && parsed <= 65_535 ? parsed : undefined;
}

function sanitizeSessionToken(input: { readonly value: string }): string {
  return input.value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isMutagenSessionAlreadyExists(input: {
  readonly result: ExecResult;
}): boolean {
  const combined =
    `${input.result.stderr}\n${input.result.stdout}`.toLowerCase();
  return (
    combined.includes("already exists") ||
    combined.includes("duplicate session name")
  );
}

function formatMutagenFailure(input: {
  readonly action: string;
  readonly result: ExecResult;
}): string {
  const detail = input.result.stderr.trim() || input.result.stdout.trim();
  if (detail.length > 0) {
    return `${input.action}: ${detail}`;
  }
  return `${input.action} (exit ${input.result.exitCode}).`;
}

export const __testOnlyMutagenSync = {
  buildMutagenSessionName,
  buildMutagenSshUri,
  parseSshSource,
};
