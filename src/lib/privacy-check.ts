import { extname } from "node:path";

export type FindingKind =
  | "ssh-private-ip"
  | "tailscale-domain"
  | "macos-home-path"
  | "linux-home-path"
  | "local-temp-path";

export type PrivacyFinding = {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly kind: FindingKind;
  readonly snippet: string;
};

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
const lineBreakPattern = /\r?\n/;

const missionArtifactRoots = [".factory/library/", ".factory/validation/"];
const missionLocalTempRoots = [
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
  "/private/var/folders/",
];
const missionArtifactSanitizedTempRootPatterns = [
  /\/private\/tmp(?=\/)/g,
  /\/tmp(?=\/)/g,
  /\/private\/var\/folders(?=\/)/g,
  /\/var\/folders(?=\/)/g,
] as const;
const missionArtifactSanitizedTempHomePattern =
  /<tmp>(?:\/[^<>"'\s]+)*\/home(?=(?:\/|["'\s]|$))/g;
const missionArtifactSanitizedDaemonSocketPattern =
  /<tmp>(?:\/[^<>"'\s]+)*\/home\/\.hack\/daemon\/hackd\.sock/g;

/**
 * Determines whether a file path should be excluded from textual privacy checks.
 */
export function shouldSkipPrivacyCheckFile(input: {
  readonly filePath: string;
}): boolean {
  const { filePath } = input;
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
 * Scans one tracked text file for privacy leaks.
 */
export function collectPrivacyFindings(input: {
  readonly filePath: string;
  readonly content: string;
}): PrivacyFinding[] {
  const { filePath, content } = input;
  const findings: PrivacyFinding[] = [];
  const lines = content.split(lineBreakPattern);

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
    scanMissionLocalTempPath({
      filePath,
      line,
      lineNumber,
      findings,
    });
  }

  return findings;
}

/**
 * Replaces workstation-specific roots in committed mission artifacts with stable placeholders while
 * preserving the meaningful path suffixes that make the evidence understandable.
 */
export function sanitizeCommittedMissionArtifactText(input: {
  readonly text: string;
  readonly repoRoot?: string;
  readonly missionDir?: string;
}): string {
  let sanitized = replaceLiteralText({
    text: input.text,
    needle: input.repoRoot,
    replacement: "<repo>",
  });
  sanitized = replaceLiteralText({
    text: sanitized,
    needle: input.missionDir,
    replacement: "<mission-dir>",
  });
  for (const pattern of missionArtifactSanitizedTempRootPatterns) {
    sanitized = sanitized.replace(pattern, "<tmp>");
  }
  sanitized = sanitized.replace(
    missionArtifactSanitizedDaemonSocketPattern,
    "<tmp-daemon-sock>"
  );
  sanitized = sanitized.replace(
    missionArtifactSanitizedTempHomePattern,
    "<tmp-home>"
  );
  return sanitized;
}

function scanSshPrivateIp(input: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
  readonly findings: PrivacyFinding[];
}): void {
  sshPrivateIpPattern.lastIndex = 0;
  for (const match of input.line.matchAll(sshPrivateIpPattern)) {
    const username = match.groups?.user?.toLowerCase() ?? "";
    if (allowedUsernames.has(username)) {
      continue;
    }
    input.findings.push({
      filePath: input.filePath,
      lineNumber: input.lineNumber,
      kind: "ssh-private-ip",
      snippet: input.line.trim(),
    });
  }
}

function scanTailnetDomain(input: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
  readonly findings: PrivacyFinding[];
}): void {
  tailscaleDomainPattern.lastIndex = 0;
  for (const match of input.line.matchAll(tailscaleDomainPattern)) {
    const value = match[0]?.toLowerCase() ?? "";
    if (
      value.includes("example") ||
      value.includes("tailnet.ts.net") ||
      value.includes("tail1234.ts.net")
    ) {
      continue;
    }
    input.findings.push({
      filePath: input.filePath,
      lineNumber: input.lineNumber,
      kind: "tailscale-domain",
      snippet: input.line.trim(),
    });
  }
}

function scanHomePath(input: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
  readonly findings: PrivacyFinding[];
  readonly pattern: RegExp;
  readonly kind: "macos-home-path" | "linux-home-path";
}): void {
  input.pattern.lastIndex = 0;
  for (const match of input.line.matchAll(input.pattern)) {
    const username = match.groups?.user?.toLowerCase() ?? "";
    if (allowedUsernames.has(username)) {
      continue;
    }
    input.findings.push({
      filePath: input.filePath,
      lineNumber: input.lineNumber,
      kind: input.kind,
      snippet: input.line.trim(),
    });
  }
}

function scanMissionLocalTempPath(input: {
  readonly filePath: string;
  readonly line: string;
  readonly lineNumber: number;
  readonly findings: PrivacyFinding[];
}): void {
  if (!isMissionArtifactFile({ filePath: input.filePath })) {
    return;
  }
  if (!missionLocalTempRoots.some((root) => input.line.includes(root))) {
    return;
  }
  input.findings.push({
    filePath: input.filePath,
    lineNumber: input.lineNumber,
    kind: "local-temp-path",
    snippet: input.line.trim(),
  });
}

function isMissionArtifactFile(input: { readonly filePath: string }): boolean {
  return missionArtifactRoots.some((root) => input.filePath.startsWith(root));
}

function replaceLiteralText(input: {
  readonly text: string;
  readonly needle?: string;
  readonly replacement: string;
}): string {
  if (!input.needle || input.needle.length === 0) {
    return input.text;
  }
  return input.text.replaceAll(input.needle, input.replacement);
}
