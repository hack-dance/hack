import { basename } from "node:path";
import { sanitizeProjectSlug } from "../lib/project.ts";
import type { ServiceCandidate } from "./discovery.ts";

export function guessServiceName(candidate: ServiceCandidate): string {
  const scriptPart =
    candidate.scriptName.includes(":") && candidate.scriptName !== "dev"
      ? candidate.scriptName.split(":").slice(1).join("-")
      : "";

  const dirPart =
    candidate.packageRelativeDir === "."
      ? "www"
      : sanitizeProjectSlug(basename(candidate.packageRelativeDir));

  const pkgPart = candidate.packageName
    ? lastNameSegment(candidate.packageName)
    : "";

  const raw =
    scriptPart.length > 0
      ? sanitizeProjectSlug(scriptPart)
      : dirPart !== "www"
        ? dirPart
        : pkgPart.length > 0
          ? sanitizeProjectSlug(pkgPart)
          : "www";

  if (raw.length > 0 && raw !== "project") return raw;
  return dirPart;
}

function lastNameSegment(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

export function guessRole(candidate: ServiceCandidate): "http" | "internal" {
  const haystack =
    `${candidate.scriptName} ${candidate.scriptCommand}`.toLowerCase();

  const internalSignals = [
    "worker",
    "queue",
    "cron",
    "job",
    "bull",
    "scheduler",
    "pipeline",
  ];
  if (internalSignals.some((s) => haystack.includes(s))) return "internal";

  const httpSignals = [
    "next dev",
    "vite",
    "astro dev",
    "nuxt dev",
    "remix dev",
    "react-scripts start",
    "serve",
    "elysia",
    "hono",
    "http",
  ];
  if (httpSignals.some((s) => haystack.includes(s))) return "http";

  // Fallback heuristic: dev scripts are usually HTTP.
  return "http";
}

export function inferPortFromScript(scriptCommand: string): number | null {
  const patterns: RegExp[] = [
    /--port\s+(\d{2,5})/i,
    /--port=(\d{2,5})/i,
    /(?:^|\s)-p\s+(\d{2,5})(?:\s|$)/i,
    /(?:^|\s)-p=(\d{2,5})(?:\s|$)/i,
    /(?:^|\s)PORT=(\d{2,5})(?:\s|$)/i,
  ];

  for (const re of patterns) {
    const match = scriptCommand.match(re);
    const raw = match?.[1];
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n < 65_536) return n;
  }

  return null;
}

export function guessDefaultPort(serviceName: string): number {
  const n = serviceName.toLowerCase();
  if (n === "www" || n === "web" || n === "frontend") return 3000;
  if (n.includes("api")) return 4000;
  if (n.includes("email")) return 8788;
  if (n.includes("vite")) return 5173;
  if (n.includes("admin")) return 3001;
  return 3000;
}

export function buildSuggestedCommand(opts: {
  readonly candidate: ServiceCandidate;
  readonly role: "http" | "internal";
  readonly port?: number;
}): string {
  const base = `bun run ${opts.candidate.scriptName}`;
  if (opts.role === "internal") return base;

  const port =
    opts.port ?? inferPortFromScript(opts.candidate.scriptCommand) ?? 3000;
  const cmdLower = opts.candidate.scriptCommand.toLowerCase();

  // Next.js prefers -p / -H, but accepts --port/--hostname in newer versions too.
  if (cmdLower.includes("next") && cmdLower.includes("dev")) {
    return `${base} -- -p ${port} -H 0.0.0.0`;
  }

  return `${base} -- --port ${port} --host 0.0.0.0`;
}
