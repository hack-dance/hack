export const HACK_PROJECT_DIR_PRIMARY = ".hack" as const;
export const HACK_PROJECT_DIR_LEGACY = ".dev" as const;

export const DEFAULT_INGRESS_NETWORK = "hack-dev" as const;
export const DEFAULT_LOGGING_NETWORK = "hack-logging" as const;
export const DEFAULT_INGRESS_SUBNET = "172.30.0.0/16" as const;
export const DEFAULT_INGRESS_GATEWAY = "172.30.0.1" as const;
export const DEFAULT_CADDY_IP = "172.30.0.2" as const;
export const DEFAULT_COREDNS_IP = "172.30.0.53" as const;

export const DEFAULT_PROJECT_TLD = "hack" as const;
export const DEFAULT_GRAFANA_HOST = `logs.${DEFAULT_PROJECT_TLD}` as const;
export const DEFAULT_LOKI_HOST = `loki.${DEFAULT_PROJECT_TLD}` as const;
export const DEFAULT_SCHEMAS_HOST = `schemas.${DEFAULT_PROJECT_TLD}` as const;

/**
 * OAuth providers (notably Google) require `localhost` or a host that ends with a real public suffix.
 *
 * We keep `.hack` as the primary local dev domain, and optionally expose an alias domain for OAuth flows.
 * Default: `*.hack.gy` → 127.0.0.1 (via dnsmasq + OS resolver).
 */
export const DEFAULT_OAUTH_ALIAS_TLD = "gy" as const;
export const DEFAULT_OAUTH_ALIAS_ROOT =
  `${DEFAULT_PROJECT_TLD}.${DEFAULT_OAUTH_ALIAS_TLD}` as const;

export const GLOBAL_HACK_DIR_NAME = ".hack" as const;
export const GLOBAL_CONFIG_FILENAME = "hack.config.json" as const;
export const GLOBAL_DAEMON_DIR_NAME = "daemon" as const;
export const GLOBAL_DAEMON_SOCKET_FILENAME = "hackd.sock" as const;
export const GLOBAL_DAEMON_PID_FILENAME = "hackd.pid" as const;
export const GLOBAL_DAEMON_LOG_FILENAME = "hackd.log" as const;
export const GLOBAL_CLOUDFLARE_DIR_NAME = "cloudflare" as const;
export const GLOBAL_CADDY_DIR_NAME = "caddy" as const;
export const GLOBAL_LOGGING_DIR_NAME = "logging" as const;
export const GLOBAL_SCHEMAS_DIR_NAME = "schemas" as const;
export const GLOBAL_CERTS_DIR_NAME = "certs" as const;
export const GLOBAL_COREDNS_FILENAME = "Corefile" as const;

export const GLOBAL_ONLY_EXTENSION_IDS = [
  "dance.hack.cloudflare",
  "dance.hack.tailscale",
] as const;

export const GLOBAL_PROJECTS_REGISTRY_FILENAME = "projects.json" as const;

export const DAEMON_PROCESS_TITLE = "dance.hack.hackd" as const;
export const DAEMON_LAUNCHD_LABEL = "dance.hack.hackd" as const;
export const DAEMON_LAUNCHD_PLIST_FILENAME = "dance.hack.hackd.plist" as const;

export const GLOBAL_CADDY_COMPOSE_FILENAME = "docker-compose.yml" as const;
export const GLOBAL_LOGGING_COMPOSE_FILENAME = "docker-compose.yml" as const;
export const GLOBAL_ALLOY_FILENAME = "alloy.alloy" as const;
export const GLOBAL_LOKI_CONFIG_FILENAME = "loki.yaml" as const;

export const GLOBAL_GRAFANA_DIR_NAME = "grafana" as const;
export const GLOBAL_GRAFANA_PROVISIONING_DIR = "grafana/provisioning" as const;
export const GLOBAL_GRAFANA_DATASOURCE_FILENAME =
  "grafana/provisioning/datasources/hack-datasources.yaml" as const;
export const GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME =
  "grafana/provisioning/dashboards/hack-dashboards.yaml" as const;
export const GLOBAL_GRAFANA_DASHBOARDS_DIR = "grafana/dashboards" as const;
export const GLOBAL_GRAFANA_DASHBOARD_FILENAME =
  "grafana/dashboards/hack-logs.json" as const;

export const PROJECT_COMPOSE_FILENAME = "docker-compose.yml" as const;
export const PROJECT_ENV_FILENAME = ".env" as const;
export const PROJECT_CONFIG_FILENAME = "hack.config.json" as const;
export const PROJECT_CONFIG_LEGACY_FILENAME = "hack.toml" as const;
export const PROJECT_BRANCHES_FILENAME = "hack.branches.json" as const;

export const GLOBAL_CONFIG_SCHEMA_FILENAME = "hack.config.schema.json" as const;
export const GLOBAL_BRANCHES_SCHEMA_FILENAME =
  "hack.branches.schema.json" as const;
