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
const PROJECT_AREAS: Readonly<Record<string, DoctorArea>> = {
  project: "project_files",
  "sessions mux": "project_files",
  "generated files": "project_files",
  "hack gitignore": "project_files",
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
  "compose backend features": "native",
  "native data services": "native",
  "amd64 emulation": "native",
  "native settings": "native",
  "native process wrappers": "native",
  "native source size": "native",
};
const MACHINE_AREAS: Readonly<Record<string, DoctorArea>> = {
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
  "browser local network": "routing_dns",
  "native https owner": "native",
  "native root trust": "certificates",
  "native ca repair": "certificates",
  "native https route": "native",
  "native host dns": "routing_dns",
  "native hack.local route": "routing_dns",
  "native hack.local repair": "routing_dns",
};

/** Closed IDs and prefixes only; never parse executable instructions from diagnostic text. */
export function doctorMetadata(opts: {
  readonly id: string;
  /** Mixed project/global checks set their actual scope at the observation site. */
  readonly scope?: DoctorScope;
}): DoctorMetadata {
  const projectArea = Object.hasOwn(PROJECT_AREAS, opts.id)
    ? PROJECT_AREAS[opts.id]
    : undefined;
  const machineArea = Object.hasOwn(MACHINE_AREAS, opts.id)
    ? MACHINE_AREAS[opts.id]
    : undefined;
  let area = projectArea ?? machineArea ?? "other";
  const network = [
    "network:",
    "resolver:",
    "dnsmasq.conf:",
    "dnsmasq:",
    "dns:",
  ].some((prefix) => opts.id.startsWith(prefix));
  if (network) {
    area = "routing_dns";
  }
  const knownMachine = Object.hasOwn(MACHINE_AREAS, opts.id) || network;
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
  return {
    area,
    scope,
    fix,
  };
}
