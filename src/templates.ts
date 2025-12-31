import {
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_LOGGING_NETWORK,
  DEFAULT_LOKI_HOST,
  DEFAULT_OAUTH_ALIAS_TLD,
  DEFAULT_PROJECT_TLD,
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_SCHEMAS_HOST,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_ALLOY_FILENAME,
  GLOBAL_GRAFANA_DASHBOARDS_DIR,
  GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
  GLOBAL_GRAFANA_DASHBOARD_FILENAME,
  GLOBAL_GRAFANA_DATASOURCE_FILENAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOKI_CONFIG_FILENAME
} from "./constants.ts"

export function renderGlobalCaddyCompose(opts?: {
  readonly useStaticCoreDnsIp?: boolean
  readonly useStaticCaddyIp?: boolean
}): string {
  const useStaticCoreDnsIp = opts?.useStaticCoreDnsIp === true
  const useStaticCaddyIp = opts?.useStaticCaddyIp === true
  return [
    "name: hack-dev-proxy",
    "services:",
    "  caddy:",
    "    image: lucaslorentz/caddy-docker-proxy:2.10",
    "    ports:",
    '      - "80:80"',
    '      - "443:443"',
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock",
    "      - caddy_data:/data",
    "      - ../schemas:/srv/schemas:ro",
    "    labels:",
    `      caddy: ${DEFAULT_SCHEMAS_HOST}`,
    "      caddy.root: /srv/schemas",
    "      caddy.file_server: \"\"",
    "      caddy.tls: internal",
    "    environment:",
    `      CADDY_INGRESS_NETWORKS: ${DEFAULT_INGRESS_NETWORK}`,
    ...(useStaticCaddyIp ?
        ["    networks:", "      default:", `        ipv4_address: ${DEFAULT_CADDY_IP}`]
      : []),
    "",
    "  coredns:",
    "    image: coredns/coredns:1.11.1",
    `    command: -conf /etc/coredns/${GLOBAL_COREDNS_FILENAME}`,
    "    volumes:",
    `      - ./${GLOBAL_COREDNS_FILENAME}:/etc/coredns/${GLOBAL_COREDNS_FILENAME}:ro`,
    "    networks:",
    "      default:",
    ...(useStaticCoreDnsIp ? [`        ipv4_address: ${DEFAULT_COREDNS_IP}`] : []),
    "",
    "networks:",
    "  default:",
    `    name: ${DEFAULT_INGRESS_NETWORK}`,
    "    external: true",
    "",
    "volumes:",
    "  caddy_data:",
    ""
  ].join("\n")
}

export function renderGlobalCoreDnsConfig(opts?: { readonly useStaticCaddyIp?: boolean }): string {
  const useStaticCaddyIp = opts?.useStaticCaddyIp === true
  return [
    ".:53 {",
    ...(useStaticCaddyIp ?
        [
          "  template IN A {",
          "    match (.*)\\.hack(\\..*)?\\.?$",
          `    answer \"{{ .Name }} 30 IN A ${DEFAULT_CADDY_IP}\"`,
          "    fallthrough",
          "  }"
        ]
      : ["  rewrite name regex (.*)\\.hack(\\..*)?\\.?$ caddy"]),
    "  forward . 127.0.0.11",
    "  cache 30",
    "}"
  ].join("\n")
}

export function renderGlobalLoggingCompose(): string {
  return [
    "name: hack-logging",
    "services:",
    "  loki:",
    "    image: grafana/loki:2.9.4",
    "    command: -config.file=/etc/loki/config.yaml",
    "    ports:",
    '      - "127.0.0.1:3100:3100"',
    "    volumes:",
    "      - loki-data:/loki",
    `      - ./${GLOBAL_LOKI_CONFIG_FILENAME}:/etc/loki/config.yaml:ro`,
    "    labels:",
    `      caddy: ${DEFAULT_LOKI_HOST}`,
    '      caddy.reverse_proxy: "{{upstreams 3100}}"',
    "      caddy.tls: internal",
    "    networks:",
    `      - ${DEFAULT_INGRESS_NETWORK}`,
    `      - ${DEFAULT_LOGGING_NETWORK}`,
    "",
    "  alloy:",
    "    image: grafana/alloy:v1.12.0",
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock",
    `      - ./${GLOBAL_ALLOY_FILENAME}:/etc/alloy/config.alloy:ro`,
    "    command: run /etc/alloy/config.alloy",
    "    networks:",
    `      - ${DEFAULT_LOGGING_NETWORK}`,
    "",
    "  grafana:",
    "    image: grafana/grafana:10.4.0",
    "    environment:",
    "      GF_SECURITY_ADMIN_PASSWORD: admin",
    "    volumes:",
    "      - grafana-data:/var/lib/grafana",
    `      - ./${GLOBAL_GRAFANA_DATASOURCE_FILENAME}:/etc/grafana/provisioning/datasources/hack-datasources.yaml:ro`,
    `      - ./${GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME}:/etc/grafana/provisioning/dashboards/hack-dashboards.yaml:ro`,
    `      - ./${GLOBAL_GRAFANA_DASHBOARDS_DIR}:/var/lib/grafana/dashboards:ro`,
    "    labels:",
    `      caddy: logs.${DEFAULT_PROJECT_TLD}`,
    '      caddy.reverse_proxy: "{{upstreams 3000}}"',
    "      caddy.tls: internal",
    "    networks:",
    `      - ${DEFAULT_INGRESS_NETWORK}`,
    `      - ${DEFAULT_LOGGING_NETWORK}`,
    "",
    "networks:",
    `  ${DEFAULT_INGRESS_NETWORK}:`,
    "    external: true",
    `  ${DEFAULT_LOGGING_NETWORK}:`,
    "    external: true",
    "",
    "volumes:",
    "  loki-data:",
    "  grafana-data:",
    ""
  ].join("\n")
}

// Back-compat alias (internal). Promtail has been replaced by Grafana Alloy.
export function renderGlobalPromtailYaml(): string {
  return renderGlobalAlloyConfig()
}

export function renderGlobalAlloyConfig(): string {
  // Docs:
  // - https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.docker/
  // - https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.relabel/
  // - https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/
  // - https://grafana.com/docs/alloy/latest/reference/components/loki/loki.write/
  return [
    'discovery.docker "local" {',
    '  host = "unix:///var/run/docker.sock"',
    "}",
    "",
    'discovery.relabel "docker_compose" {',
    "  targets = discovery.docker.local.targets",
    "",
    "  // Only ingest Docker Compose containers (prevents unlabelled streams and avoids",
    "  // Loki rejecting huge backfills from random containers with very old timestamps).",
    "  rule {",
    '    action        = "keep"',
    '    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]',
    '    regex         = ".+"',
    "  }",
    "",
    "  // Promote useful Docker/Compose metadata into stable labels.",
    "  rule {",
    '    action        = "replace"',
    '    source_labels = ["__meta_docker_container_name"]',
    '    target_label  = "container"',
    "  }",
    "",
    "  rule {",
    '    action        = "replace"',
    '    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]',
    '    target_label  = "service"',
    "  }",
    "",
    "  rule {",
    '    action        = "replace"',
    '    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]',
    '    target_label  = "project"',
    "  }",
    "}",
    "",
    'loki.source.docker "default" {',
    '  host       = "unix:///var/run/docker.sock"',
    "  targets    = discovery.relabel.docker_compose.output",
    '  labels     = {"app" = "docker"}',
    "  forward_to = [loki.write.local.receiver]",
    "}",
    "",
    'loki.write "local" {',
    "  endpoint {",
    '    url = "http://loki:3100/loki/api/v1/push"',
    '    // Lower latency for local dev tailing (default is "1s")',
    '    batch_wait = "200ms"',
    "  }",
    "}",
    ""
  ].join("\n")
}

export function renderGlobalGrafanaDatasourceYaml(): string {
  return [
    "apiVersion: 1",
    "",
    "datasources:",
    "  - name: Loki",
    "    uid: hack-loki",
    "    type: loki",
    "    access: proxy",
    "    url: http://loki:3100",
    "    isDefault: true",
    "    editable: false",
    ""
  ].join("\n")
}

export function renderGlobalGrafanaDashboardsProvisioningYaml(): string {
  return [
    "apiVersion: 1",
    "",
    "providers:",
    "  - name: hack",
    "    orgId: 1",
    '    folder: "Hack"',
    "    type: file",
    "    disableDeletion: false",
    "    editable: true",
    "    options:",
    "      path: /var/lib/grafana/dashboards",
    ""
  ].join("\n")
}

export function renderGlobalGrafanaLogsDashboardJson(): string {
  const dashboard = {
    annotations: { list: [] },
    editable: true,
    graphTooltip: 0,
    id: null,
    links: [],
    panels: [
      {
        datasource: { type: "loki", uid: "hack-loki" },
        gridPos: { h: 24, w: 24, x: 0, y: 0 },
        id: 1,
        options: {
          showLabels: true,
          showTime: true,
          sortOrder: "Descending",
          wrapLogMessage: true
        },
        // Loki rejects empty selectors in some configs; `app="docker"` is set by Alloy on all scraped streams.
        targets: [{ expr: '{app="docker"}', refId: "A" }],
        title: "Logs",
        type: "logs"
      }
    ],
    refresh: "10s",
    schemaVersion: 39,
    tags: ["hack"],
    templating: { list: [] },
    time: { from: "now-15m", to: "now" },
    timezone: "",
    title: "Hack Logs",
    uid: "hack-logs",
    version: 1
  } as const

  return `${JSON.stringify(dashboard, null, 2)}\n`
}

/**
 * Built-in (non-discovery) compose templates.
 *
 * We intentionally keep this minimal and generic; multi-service setups should
 * use the discovery-driven wizard in `hack init`.
 */
export function renderProjectConfigJson(opts: {
  readonly name: string
  readonly devHost: string
  readonly oauth?: {
    readonly enabled?: boolean
    readonly tld?: string
  }
}): string {
  const oauthEnabled = opts.oauth?.enabled === true
  const oauthTldRaw = opts.oauth?.tld?.trim()
  const oauthTld = oauthTldRaw && oauthTldRaw.length > 0 ? oauthTldRaw : DEFAULT_OAUTH_ALIAS_TLD

  const config = {
    $schema: `https://${DEFAULT_SCHEMAS_HOST}/hack.config.schema.json`,
    name: opts.name,
    dev_host: opts.devHost,
    logs: {
      follow_backend: "compose",
      snapshot_backend: "loki",
      clear_on_down: false
    },
    internal: {
      dns: true,
      tls: true
    },
    oauth: {
      enabled: oauthEnabled,
      ...(oauthTld ? { tld: oauthTld } : {})
    }
  }

  return `${JSON.stringify(config, null, 2)}\n`
}

export function renderProjectConfigSchemaJson(): string {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "hack.config.json",
    type: "object",
    additionalProperties: true,
    properties: {
      $schema: { type: "string" },
      name: { type: "string" },
      dev_host: { type: "string" },
      logs: {
        type: "object",
        additionalProperties: true,
        properties: {
          follow_backend: { type: "string", enum: ["compose", "loki"] },
          snapshot_backend: { type: "string", enum: ["compose", "loki"] },
          clear_on_down: { type: "boolean" },
          retention_period: { type: "string" }
        }
      },
      internal: {
        type: "object",
        additionalProperties: true,
        properties: {
          dns: { type: "boolean" },
          tls: { type: "boolean" }
        }
      },
      oauth: {
        type: "object",
        additionalProperties: true,
        properties: {
          enabled: { type: "boolean" },
          tld: { type: "string" }
        }
      }
    },
    required: ["name", "dev_host"]
  } as const

  return `${JSON.stringify(schema, null, 2)}\n`
}

export function renderProjectBranchesSchemaJson(): string {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "hack.branches.json",
    type: "object",
    additionalProperties: false,
    required: ["version", "branches"],
    properties: {
      $schema: { type: "string" },
      version: { type: "integer", const: 1 },
      branches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "slug"],
          properties: {
            name: { type: "string", minLength: 1 },
            slug: {
              type: "string",
              pattern: "^[a-z0-9][a-z0-9-]*$",
              minLength: 1
            },
            note: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            last_used_at: { type: "string", format: "date-time" }
          }
        }
      }
    }
  } as const

  return `${JSON.stringify(schema, null, 2)}\n`
}

export function renderGlobalLokiConfigYaml(): string {
  // Base: https://raw.githubusercontent.com/grafana/loki/v2.9.4/cmd/loki/loki-local-config.yaml
  //
  // Retention docs:
  // - https://grafana.com/docs/loki/latest/operations/storage/retention/
  // Minimum retention is 24h; keep this modest for local dev. Users can edit ~/.hack/logging/loki.yaml.
  const retentionPeriod = "168h"

  return [
    "auth_enabled: false",
    "",
    "server:",
    "  http_listen_port: 3100",
    "  grpc_listen_port: 9096",
    "",
    "common:",
    "  instance_addr: 127.0.0.1",
    "  path_prefix: /loki",
    "  storage:",
    "    filesystem:",
    "      chunks_directory: /loki/chunks",
    "      rules_directory: /loki/rules",
    "  replication_factor: 1",
    "  ring:",
    "    kvstore:",
    "      store: inmemory",
    "",
    "query_range:",
    "  results_cache:",
    "    cache:",
    "      embedded_cache:",
    "        enabled: true",
    "        max_size_mb: 100",
    "",
    "schema_config:",
    "  configs:",
    "    - from: 2020-10-24",
    "      store: boltdb-shipper",
    "      object_store: filesystem",
    "      schema: v11",
    "      index:",
    "        prefix: index_",
    "        period: 24h",
    "",
    "limits_config:",
    `  retention_period: ${retentionPeriod}`,
    "",
    "compactor:",
    "  working_directory: /loki/retention",
    "  compaction_interval: 10m",
    "  retention_enabled: true",
    "  retention_delete_delay: 2h",
    "  retention_delete_worker_count: 50",
    "  delete_request_store: filesystem",
    ""
  ].join("\n")
}

export function templateFilenames(): string[] {
  return [
    GLOBAL_CADDY_COMPOSE_FILENAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME,
    GLOBAL_ALLOY_FILENAME,
    GLOBAL_LOKI_CONFIG_FILENAME,
    GLOBAL_GRAFANA_DATASOURCE_FILENAME,
    GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
    GLOBAL_GRAFANA_DASHBOARD_FILENAME
  ]
}
