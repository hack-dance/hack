#!/usr/bin/env bun

import { extname, resolve } from "node:path";

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type FindingKind =
  | "ssh-private-ip"
  | "tailscale-domain"
  | "macos-home-path"
  | "linux-home-path";

type PrivacyFinding = {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly kind: FindingKind;
  readonly snippet: string;
};

const repoRoot = resolve(import.meta.dir, "..");

const ignoredFileNames = new Set([
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const ignoredExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mov",
  ".mp4",
  ".wav",
  ".mp3",
  ".icns",
  ".xcworkspace",
  ".xcodeproj",
  ".sqlite",
  ".db",
  ".bin",
]);

const allowedUsernames = new Set([
  "user",
  "username",
  "remote-user",
  "local-user",
  "node-user",
  "controller-user",
  "test-user",
  "test",
  "testuser",
  "example",
  "dev",
  "demo",
  "developer",
  "you",
  "root",
  "admin",
  "runner",
]);

const sshPrivateIpPattern =
  /\b(?<user>[A-Za-z0-9._-]+)@(?<ip>(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:192\.168\.\d{1,3}\.\d{1,3})|(?:172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})|(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}))\b/g;

const tailscaleDomainPattern = /\b[a-z0-9-]+\.tail[a-z0-9]{5,}\.ts\.net\b/gi;
const macosHomePathPattern = /\/Users\/(?<user>[A-Za-z0-9._-]+)/g;
const linuxHomePathPattern = /\/home\/(?<user>[A-Za-z0-9._-]+)/g;

const files = await listTrackedFiles({ cwd: repoRoot });
const findings: PrivacyFinding[] = [];

for (const filePath of files) {
  if (shouldSkipFile({ filePath })) {
    continue;
  }
  const absolutePath = resolve(repoRoot, filePath);
  const file = Bun.file(absolutePath);
  const stats = await file.stat();
  if (typeof stats.isFile === "function" && !stats.isFile()) {
    continue;
  }
  if (stats.size > 2_000_000) {
    continue;
  }
  const content = await file.text();
  if (content.includes("\u0000")) {
    continue;
  }
  collectFindingsFromFile({
    filePath,
    content,
    findings,
  });
}

if (findings.length > 0) {
  process.stderr.write(
    `privacy-check: found ${findings.length} potential personal identifiers.\n`
  );
  for (const finding of findings) {
    process.stderr.write(
      `- ${finding.filePath}:${finding.lineNumber} [${finding.kind}] ${finding.snippet}\n`
    );
  }
  process.stderr.write(
    "\nUse neutral placeholders (for example remote-user@198.51.100.42, /Users/local-user) before commit.\n"
  );
  process.exitCode = 1;
} else {
  process.stdout.write("privacy-check: ok\n");
}

/**
 * Returns tracked repository files so privacy checks only evaluate committed sources.
 */
async function listTrackedFiles({
  cwd,
}: {
  readonly cwd: string;
}): Promise<readonly string[]> {
  const result = await runCommand({
    cwd,
    command: ["git", "ls-files", "-z"],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to enumerate tracked files: ${result.stderr.trim()}`
    );
  }
  return result.stdout
    .split("\u0000")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Determines whether a file path should be excluded from textual privacy checks.
 */
function shouldSkipFile({ filePath }: { readonly filePath: string }): boolean {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  if (ignoredFileNames.has(fileName)) {
    return true;
  }
  if (
    filePath.startsWith("dist/") ||
    filePath.startsWith("out/") ||
    filePath.startsWith(".turbo/") ||
    filePath.includes("/.hack/.internal/") ||
    filePath.includes("/.hack/.branch/") ||
    filePath.includes("/dist/") ||
    filePath.includes("/.turbo/")
  ) {
    return true;
  }
  const extension = extname(filePath).toLowerCase();
  return ignoredExtensions.has(extension);
}

/**
 * Scans one text file and appends any privacy findings.
 */
function collectFindingsFromFile({
  filePath,
  content,
  findings,
}: {
  readonly filePath: string;
  readonly content: string;
  readonly findings: PrivacyFinding[];
}): void {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    scanSshPrivateIp({
      filePath,
      line,
      lineNumber,
      findings,
    });
    scanTailnetDomain({
      filePath,
      line,
      lineNumber,
      findings,
    });
    scanHomePath({
      filePath,
      line,
      lineNumber,
      findings,
      pattern: macosHomePathPattern,
      kind: "macos-home-path",
    });
    scanHomePath({
      filePath,
      line,
      lineNumber,
      findings,
      pattern: linuxHomePathPattern,
      kind: "linux-home-path",
    });
  }
}

/**
 * Captures usernames paired with private-network IP addresses in SSH-style targets.
 */
function scanSshPrivateIp({
  filePath,
  line,
  lineNumber,
  findings,
}: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
  readonly findings: PrivacyFinding[];
}): void {
  sshPrivateIpPattern.lastIndex = 0;
  for (const match of line.matchAll(sshPrivateIpPattern)) {
    const username = match.groups?.user?.toLowerCase() ?? "";
    if (allowedUsernames.has(username)) {
      continue;
    }
    findings.push({
      filePath,
      lineNumber,
      kind: "ssh-private-ip",
      snippet: line.trim(),
    });
  }
}

/**
 * Flags real tailnet hostnames so docs/tests use neutral placeholders.
 */
function scanTailnetDomain({
  filePath,
  line,
  lineNumber,
  findings,
}: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
  readonly findings: PrivacyFinding[];
}): void {
  tailscaleDomainPattern.lastIndex = 0;
  for (const match of line.matchAll(tailscaleDomainPattern)) {
    const value = match[0]?.toLowerCase() ?? "";
    if (
      value.includes("example") ||
      value.includes("tailnet.ts.net") ||
      value.includes("tail1234.ts.net")
    ) {
      continue;
    }
    findings.push({
      filePath,
      lineNumber,
      kind: "tailscale-domain",
      snippet: line.trim(),
    });
  }
}

/**
 * Flags hardcoded home-directory paths when the username is not a known placeholder.
 */
function scanHomePath({
  filePath,
  line,
  lineNumber,
  findings,
  pattern,
  kind,
}: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
  readonly findings: PrivacyFinding[];
  readonly pattern: RegExp;
  readonly kind: "macos-home-path" | "linux-home-path";
}): void {
  pattern.lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const username = match.groups?.user?.toLowerCase() ?? "";
    if (allowedUsernames.has(username)) {
      continue;
    }
    findings.push({
      filePath,
      lineNumber,
      kind,
      snippet: line.trim(),
    });
  }
}

/**
 * Runs a shell command with inherited environment and captured output.
 */
async function runCommand({
  cwd,
  command,
}: {
  readonly cwd: string;
  readonly command: readonly string[];
}): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return {
    stdout,
    stderr,
    exitCode,
  };
}
