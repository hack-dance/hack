import { defineOption } from "./command.ts";

export const optPath = defineOption({
  name: "path",
  type: "string",
  long: "--path",
  short: "-p",
  valueHint: "<dir>",
  description:
    "Run a project command against a repo path (overrides cwd search)",
} as const);

export const optProject = defineOption({
  name: "project",
  type: "string",
  long: "--project",
  valueHint: "<name>",
  description:
    "Target a registered project by name (from ~/.hack/projects.json)",
} as const);

export const optBranch = defineOption({
  name: "branch",
  type: "string",
  long: "--branch",
  valueHint: "<name>",
  description:
    "Run against a branch-specific instance (compose name + hostnames)",
} as const);

export const optFollow = defineOption({
  name: "follow",
  type: "boolean",
  long: "--follow",
  short: "-f",
  description: "Follow logs (default for `hack logs`)",
} as const);

export const optNoFollow = defineOption({
  name: "noFollow",
  type: "boolean",
  long: "--no-follow",
  description: "Print logs and exit (do not follow)",
} as const);

export const optTail = defineOption({
  name: "tail",
  type: "number",
  long: "--tail",
  valueHint: "<n>",
  description: "Tail last N log lines",
  defaultValue: "200",
} as const);

export const optProfile = defineOption({
  name: "profile",
  type: "string",
  long: "--profile",
  valueHint: "<name[,name...]>",
  description: "Enable one or more compose profiles (comma-separated)",
} as const);

export const optDetach = defineOption({
  name: "detach",
  type: "boolean",
  long: "--detach",
  short: "-d",
  description: "Run in background (docker compose up -d)",
} as const);

export const optPretty = defineOption({
  name: "pretty",
  type: "boolean",
  long: "--pretty",
  description: "Pretty-print logs (best-effort JSON parsing + formatting)",
} as const);

export const optJson = defineOption({
  name: "json",
  type: "boolean",
  long: "--json",
  description: "Output JSON (machine-readable)",
} as const);

export const optSince = defineOption({
  name: "since",
  type: "string",
  long: "--since",
  valueHint: "<time>",
  description: "Start time for Loki logs (RFC3339 or duration like 15m)",
} as const);

export const optUntil = defineOption({
  name: "until",
  type: "string",
  long: "--until",
  valueHint: "<time>",
  description: "End time for Loki logs (RFC3339 or duration like 15m)",
} as const);
