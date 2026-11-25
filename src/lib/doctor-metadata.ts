/** Stable presentation metadata. Neither detail text nor a check ID grants repair authority. */
export type DoctorArea =
  | "engine"
  | "routing_dns"
  | "certificates"
  | "daemon"
  | "env_secrets"
  | "project_files"
  | "native"
  | "other";

export type DoctorScope = "machine" | "project";
export type DoctorMetadata = {
  readonly area: DoctorArea;
  readonly scope: DoctorScope;
  readonly fix: {
    readonly kind: "safe" | "admin" | "manual";
    /** Argv after `hack`; empty means consult the documentation, not a runnable repair. */
    readonly args: readonly string[];
    readonly doc_url: string;
  };
};

const DOC_URL =
  "https://github.com/hack-dance/hack/blob/next/docs/versions/v5/troubleshooting.md";
/** HACK-2323 checks link the runtime safety guide's existing-project section. */
const DEV_GUIDE_URL =
  "https://github.com/hack-dance/hack/blob/next/docs/guides/development-runtime-safety.md#check-an-existing-project";
const DEV_REPORT_ONLY = new Set([
  "emulated services",
  "shared volume architectures",
  "dev image tags",
  "shared source installs",
]);
const PROJECT_AREAS = {
  // Error rows can use the short probe label instead of the optional tool ID.
  brew: "other",
  dnsmasq: "other",
  mkcert: "other",
  gum: "other",
  fzf: "other",
  tmux: "other",
  go: "other",
  caddy: "other",
  asdf: "other",
  prerequisites: "other",
  "lifecycle supervisor": "other",
  "native temporary aliases": "other",
  "browser local network": "routing_dns",
  "native https route": "native",
  "native host dns": "routing_dns",
  project: "project_files",
  "sessions mux": "project_files",
  "generated files": "project_files",
  "hack gitignore": "project_files",
  "root-owned checkout files": "project_files",
  "runtime hygiene": "engine",
  "lifecycle hygiene": "engine",
  "worktree instances": "engine",
  "compose networks": "routing_dns",
  "caddy hosts": "routing_dns",
  DEV_HOST: "routing_dns",
  "env mode": "env_secrets",
  "env materialization": "env_secrets",
  "env overlay warnings": "env_secrets",
  "worktree keys": "env_secrets",
  "env key": "env_secrets",
  "secret integrity": "env_secrets",
  "secrets hygiene": "env_secrets",
  "compose env at rest": "env_secrets",
  "env override coverage": "env_secrets",
  "compose backend features": "native",
  "native data services": "native",
  "amd64 emulation": "native",
  "native settings": "native",
  "native process wrappers": "native",
  "native source size": "native",
  "native image builder": "native",
  "emulated services": "engine",
  "polling watchers": "engine",
  "shared volume architectures": "engine",
  "dev image tags": "project_files",
  "shared source installs": "project_files",
} as const satisfies Readonly<Record<string, DoctorArea>>;
const MACHINE_AREAS = {
  bun: "engine",
  docker: "engine",
  "docker compose": "engine",
  "docker daemon": "engine",
  "brew (optional)": "engine",
  "dnsmasq (optional)": "routing_dns",
  "mkcert (optional)": "certificates",
  "gum (optional)": "other",
  "fzf (optional)": "other",
  "tmux (sessions)": "engine",
  mutagen: "engine",
  "go (optional)": "engine",
  "caddy (optional)": "routing_dns",
  "asdf (optional)": "other",
  "global files": "routing_dns",
  daemon: "daemon",
  "daemon service": "daemon",
  "autostart login service": "daemon",
  "gateway config": "other",
  "gateway tokens": "other",
  "linux dns route": "routing_dns",
  grafana: "other",
  "proxy ports": "routing_dns",
  "proxy network": "routing_dns",
  "coredns forwarding": "routing_dns",
  "caddy local ca": "certificates",
  "local ca trust": "certificates",
  "host tls trust": "certificates",
  "superseded caddy roots": "certificates",
  "native https owner": "native",
  "native root trust": "certificates",
  "native ca repair": "certificates",
  "native hack.local route": "routing_dns",
  "native hack.local repair": "routing_dns",
  "native pool idle": "native",
  "native disk usage": "native",
} as const satisfies Readonly<Record<string, DoctorArea>>;

const ROUTING_CHECK_PREFIXES = [
  "network:",
  "resolver:",
  "dnsmasq.conf:",
  "dnsmasq:",
  "dns:",
] as const;
const CHECK_PREFIXES = [...ROUTING_CHECK_PREFIXES, "prerequisite "] as const;

/** Fixed IDs and dynamic ID families (marked with a trailing asterisk). */
export const DOCTOR_CHECK_IDS = [
  ...Object.keys(PROJECT_AREAS),
  ...Object.keys(MACHINE_AREAS),
  ...CHECK_PREFIXES.map((prefix) => `${prefix}*`),
] as const;

export type DoctorCheckId =
  | keyof typeof PROJECT_AREAS
  | keyof typeof MACHINE_AREAS
  | `${(typeof CHECK_PREFIXES)[number]}${string}`;

function checkArea(
  areas: Readonly<Record<string, DoctorArea>>,
  id: string
): DoctorArea | undefined {
  return Object.hasOwn(areas, id) ? areas[id] : undefined;
}

/** Closed IDs and prefixes only; never parse executable instructions from diagnostic text. */
export function doctorMetadata(opts: {
  readonly id: string;
  /** Mixed project/global checks set their actual scope at the observation site. */
  readonly scope?: DoctorScope;
}): DoctorMetadata {
  const projectArea = checkArea(PROJECT_AREAS, opts.id);
  const machineArea = checkArea(MACHINE_AREAS, opts.id);
  let area = projectArea ?? machineArea ?? "other";
  const network = ROUTING_CHECK_PREFIXES.some((prefix) =>
    opts.id.startsWith(prefix)
  );
  if (network) {
    area = "routing_dns";
  }
  const knownMachine = machineArea !== undefined || network;
  const scope = opts.scope ?? (knownMachine ? "machine" : "project");
  const adminTrust = [
    "local ca trust",
    "host tls trust",
    "native root trust",
    "native ca repair",
  ].includes(opts.id);
  const fix: DoctorMetadata["fix"] = {
    kind: adminTrust ? "admin" : "manual",
    args: opts.id === "local ca trust" ? ["global", "trust"] : [],
    doc_url: DOC_URL,
  };
  if (opts.id === "hack gitignore") {
    return {
      area,
      scope,
      fix: {
        kind: "safe",
        args: [
          "doctor",
          "--fix",
          "--only",
          "hack gitignore",
          "--yes",
          "--json",
        ],
        doc_url: DOC_URL,
      },
    };
  }
  if (opts.id === "polling watchers") {
    // Shows the diff only (exit 0, nothing written); applying needs a human
    // to review it and rerun with --yes, so it is not a one-click safe fix.
    return {
      area,
      scope,
      fix: {
        kind: "manual",
        args: ["doctor", "--fix", "--only", "polling watchers", "--json"],
        doc_url: DEV_GUIDE_URL,
      },
    };
  }
  if (DEV_REPORT_ONLY.has(opts.id)) {
    return {
      area,
      scope,
      fix: { kind: "manual", args: [], doc_url: DEV_GUIDE_URL },
    };
  }
  return {
    area,
    scope,
    fix,
  };
}
