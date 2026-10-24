import {
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_GRAFANA_HOST,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_LOGGING_NETWORK,
  DEFAULT_LOKI_HOST,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_OAUTH_ALIAS_TLD,
  DEFAULT_PROJECT_TLD,
  DEFAULT_SCHEMAS_HOST,
  GLOBAL_ALLOY_FILENAME,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_GRAFANA_DASHBOARD_FILENAME,
  GLOBAL_GRAFANA_DASHBOARDS_DIR,
  GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
  GLOBAL_GRAFANA_DATASOURCE_FILENAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOKI_CONFIG_FILENAME,
  LEGACY_GRAFANA_HOST,
  LEGACY_LOKI_HOST,
  LEGACY_SCHEMAS_HOST,
} from "./constants.ts";
import { parseDefaultDomain } from "./lib/default-domain.ts";

export function renderGlobalCaddyCompose(opts?: {
  readonly useStaticCoreDnsIp?: boolean;
  readonly useStaticCaddyIp?: boolean;
}): string {
  const useStaticCoreDnsIp = opts?.useStaticCoreDnsIp === true;
  const useStaticCaddyIp = opts?.useStaticCaddyIp === true;
  return [
    "name: hack-dev-proxy",
    "services:",
    "  caddy:",
    "    image: lucaslorentz/caddy-docker-proxy:2.10.0-alpine",
    "    command:",
    "      - docker-proxy",
    "      - --polling-interval",
    "      - 5s",
    "    ports:",
    '      - "80:80"',
    '      - "443:443"',
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock",
    "      - caddy_data:/data",
    "      - ../schemas:/srv/schemas:ro",
    "    extra_hosts:",
    '      - "host.docker.internal:host-gateway"',
    "    labels:",
    `      caddy: ${DEFAULT_SCHEMAS_HOST}, ${LEGACY_SCHEMAS_HOST}`,
    "      caddy.root: /srv/schemas",
    '      caddy.file_server: ""',
    "      caddy.tls: internal",
    "    environment:",
    `      CADDY_INGRESS_NETWORKS: ${DEFAULT_INGRESS_NETWORK}`,
    ...(useStaticCaddyIp
      ? [
          "    networks:",
          "      default:",
          `        ipv4_address: ${DEFAULT_CADDY_IP}`,
        ]
      : []),
    "",
    "  coredns:",
    "    image: coredns/coredns:1.11.1",
    `    command: -conf /etc/coredns/${GLOBAL_COREDNS_FILENAME}`,
    "    volumes:",
    `      - ./${GLOBAL_COREDNS_FILENAME}:/etc/coredns/${GLOBAL_COREDNS_FILENAME}:ro`,
    "    networks:",
    "      default:",
    ...(useStaticCoreDnsIp
      ? [`        ipv4_address: ${DEFAULT_COREDNS_IP}`]
      : []),
    "",
    "networks:",
    "  default:",
    `    name: ${DEFAULT_INGRESS_NETWORK}`,
    "    external: true",
    "",
    "volumes:",
    "  caddy_data:",
    "",
  ].join("\n");
}

export function renderGlobalCoreDnsConfig(opts?: {
  readonly useStaticCaddyIp?: boolean;
  readonly defaultDomain?: string;
}): string {
  const useStaticCaddyIp = opts?.useStaticCaddyIp === true;
  const defaultDomain = parseDefaultDomain(
    opts?.defaultDomain ?? DEFAULT_NEW_PROJECT_TLD
  );
  const builtInDomains: ReadonlySet<string> = new Set([
    DEFAULT_PROJECT_TLD,
    DEFAULT_NEW_PROJECT_TLD,
    DEFAULT_OAUTH_ALIAS_ROOT,
  ]);
  const builtInPattern = "(.*)\\.hack(\\..*)?\\.?";
  const pattern = builtInDomains.has(defaultDomain)
    ? `${builtInPattern}$`
    : `(?:${builtInPattern}|(.*)\\.${defaultDomain.replaceAll(".", "\\.")}\\.?)$`;
  return [
    ".:53 {",
    ...(useStaticCaddyIp
      ? [
          "  template IN A {",
          `    match ${pattern}`,
          `    answer "{{ .Name }} 30 IN A ${DEFAULT_CADDY_IP}"`,
          "    fallthrough",
          "  }",
        ]
      : [`  rewrite name regex ${pattern} caddy`]),
    "  forward . 127.0.0.11",
    "  cache 30",
    "}",
  ].join("\n");
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
    `      caddy: ${DEFAULT_LOKI_HOST}, ${LEGACY_LOKI_HOST}`,
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
    `      - ${GLOBAL_ALLOY_DATA_VOLUME}:${GLOBAL_ALLOY_STORAGE_PATH}`,
    `      - ./${GLOBAL_ALLOY_FILENAME}:/etc/alloy/config.alloy:ro`,
    `    command: run --storage.path=${GLOBAL_ALLOY_STORAGE_PATH} /etc/alloy/config.alloy`,
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
    `      caddy: ${DEFAULT_GRAFANA_HOST}, ${LEGACY_GRAFANA_HOST}`,
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
    `  ${GLOBAL_ALLOY_DATA_VOLUME}:`,
    "",
  ].join("\n");
}

/**
 * Named volume that holds Alloy's component data, above all the
 * `loki.source.docker` positions file (`positions.yml`). Without it the
 * positions live in the container's writable layer, so every recreated Alloy
 * container (`hack global down` then `hack global up`, or an image change)
 * read every retained container log again and could resend entries Loki
 * already held. `docker compose down` keeps named volumes;
 * `hack global logs-reset` (`down -v`) removes it together with Loki's data.
 */
export const GLOBAL_ALLOY_DATA_VOLUME = "alloy-data";

/**
 * Alloy's `--storage.path` inside the container: the directory the official
 * image creates for it and names in its default command. The image's default
 * command is replaced to point at the mounted config, so the flag is repeated
 * explicitly; without it Alloy falls back to `data-alloy/` under its working
 * directory, outside the volume.
 */
export const GLOBAL_ALLOY_STORAGE_PATH = "/var/lib/alloy/data";

// Back-compat alias (internal). Promtail has been replaced by Grafana Alloy.
export function renderGlobalPromtailYaml(): string {
  return renderGlobalAlloyConfig();
}

/**
 * Docker discovery poll interval for the global Alloy config. A container that
 * starts, exits and is removed within one interval can still be missed; one
 * that exits but is kept (the Compose default) is shipped on the next poll.
 */
export const GLOBAL_ALLOY_DOCKER_REFRESH_INTERVAL = "5s";

/**
 * Container states Alloy discovers. `exited` is what lets short-lived Compose
 * services reach Loki; the others match Docker's default running-only listing.
 */
export const GLOBAL_ALLOY_DOCKER_STATUSES = [
  "running",
  "restarting",
  "paused",
  "exited",
] as const;

/**
 * Minimum level of Alloy's own log output. Alloy's container is itself a
 * Compose service that Alloy ships to Loki, so info-level component logs (a
 * "finished transferring logs" line on every log reopen, which repeats every
 * 5 seconds for each kept exited container that never logged a line) would
 * grow Loki without bound.
 */
export const GLOBAL_ALLOY_LOG_LEVEL = "warn";

export function renderGlobalAlloyConfig(): string {
  // Docs:
  // - https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.docker/
  // - https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.relabel/
  // - https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/
  // - https://grafana.com/docs/alloy/latest/reference/components/loki/loki.write/
  //
  // Short-lived containers (HACK-1277): discovery.docker polls the Docker API and,
  // by default, lists only running containers once a minute. A one-shot Compose
  // service that started and exited between two polls was never tailed, so Loki
  // had nothing while `docker compose logs` still showed its output. Docker sets
  // `all=true` when a `status` filter is present, so exited containers are listed
  // too and loki.source.docker ships their retained logs. The poll interval is
  // shortened so a container removed soon after it exits (for example
  // `docker compose run --rm`) has a smaller window to be missed.
  //
  // Cost (Alloy v1.12.0, internal/component/loki/source/docker/runner.go):
  // loki.source.docker calls ContainerInspect on every discovered target every
  // 5s, running or exited, for as long as Docker keeps the container. It then
  // reopens the log (one more inspect call and one logs call) when
  // `res.State.Running || finished.Unix() >= t.target.Last()` and the log is
  // not already open. `finished` is `State.FinishedAt` in whole seconds (0
  // when unparsable). `Last()` is the wall-clock unix second at which Alloy
  // last processed a line from the container (dockertarget/target.go stores
  // `time.Now()` after each line); it starts at 0 when the target is created
  // and is not kept in the positions file. A reopen asks Docker for lines
  // `since` the position, a whole second that Docker includes, so it reads at
  // least the container's last line again and moves `Last()` past `finished`.
  // For an exited container:
  // - one that never logged a line keeps `Last()` at 0 and is reopened every
  //   5s for as long as Docker keeps it;
  // - one whose last line Alloy read in or before the second it finished (it
  //   logged and then exited while followed), or whose lines the positions
  //   file already covers (after an Alloy restart), is reopened once, resends
  //   its last logged second, and then stays closed (a second reopen happens
  //   only when the first falls within the second the container finished);
  // - one whose last line Alloy read in a later second than it finished in
  //   is not reopened.
  // Discovery exposes no container state or exit time, so the config cannot
  // age kept containers out; removing them (`hack down`,
  // `docker compose down`) ends the inspect calls. Each reopen also logs an
  // info line ("finished transferring logs"); Alloy runs as a Compose service,
  // so those lines would be shipped into Loki, one every 5s for each kept
  // container that never logged. The `logging` block keeps Alloy's own output
  // at warn and above.
  //
  // Read positions are written under `--storage.path`, which the logging
  // compose maps to the GLOBAL_ALLOY_DATA_VOLUME volume, so a recreated Alloy
  // container resumes after the last line it shipped instead of reading every
  // retained log again. A position is a whole second and Docker's `since`
  // includes that second, so lines from the last second Alloy read can be sent
  // again.
  return [
    "logging {",
    `  level  = "${GLOBAL_ALLOY_LOG_LEVEL}"`,
    '  format = "logfmt"',
    "}",
    "",
    'discovery.docker "local" {',
    '  host             = "unix:///var/run/docker.sock"',
    `  refresh_interval = "${GLOBAL_ALLOY_DOCKER_REFRESH_INTERVAL}"`,
    "",
    "  // Include exited containers so one-shot services are shipped after they stop.",
    "  filter {",
    '    name   = "status"',
    `    values = [${GLOBAL_ALLOY_DOCKER_STATUSES.map((status) => `"${status}"`).join(", ")}]`,
    "  }",
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
    "",
    "  // Keep each container's target identity stable when it stops: an exited",
    "  // container loses its IP, endpoint and published ports. loki.source.docker",
    "  // keys tailers and read positions by the full label set, so a changed set",
    "  // would re-read (duplicate) the container's whole log. Nothing below uses",
    "  // the network or port metadata.",
    "  rule {",
    '    action = "labeldrop"',
    '    regex  = "__meta_docker_(network|port)_.+"',
    "  }",
    "",
    "  rule {",
    '    action        = "replace"',
    '    source_labels = ["__meta_docker_container_id"]',
    '    target_label  = "__address__"',
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
    "",
  ].join("\n");
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
    "",
  ].join("\n");
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
    "",
  ].join("\n");
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
          wrapLogMessage: true,
        },
        // Loki rejects empty selectors in some configs; `app="docker"` is set by Alloy on all scraped streams.
        targets: [{ expr: '{app="docker"}', refId: "A" }],
        title: "Logs",
        type: "logs",
      },
    ],
    refresh: "10s",
    schemaVersion: 39,
    tags: ["hack"],
    templating: { list: [] },
    time: { from: "now-15m", to: "now" },
    timezone: "",
    title: "Hack Logs",
    uid: "hack-logs",
    version: 1,
  } as const;

  return `${JSON.stringify(dashboard, null, 2)}\n`;
}

/**
 * Begin marker of the hack-managed block in the committed `.hack/.gitignore`.
 * The block covers machine-local generated files so linked worktrees and
 * fresh clones inherit the ignore rules automatically.
 */
export const HACK_DIR_GITIGNORE_BEGIN_MARKER =
  "# managed by hack — machine-local generated files (do not edit between markers)" as const;

/** End marker of the hack-managed block in the committed `.hack/.gitignore`. */
export const HACK_DIR_GITIGNORE_END_MARKER = "# end managed by hack" as const;

/**
 * Canonical ignore entries for the committed `.hack/.gitignore`, relative to
 * the `.hack/` directory. Root-level `.hack.secret.key` stays in the root
 * `.gitignore` (see `ensureProjectEnvSecretKey`). The retired `tickets/`
 * entry remains upgrade-safe so existing machine-local caches cannot be staged.
 * `.hack.env*.tmp` covers the `.<layer>.<uuid>.tmp` staging sibling that
 * `writeTextFileAtomicIfChanged` leaves behind when an env layer write is
 * killed before its commit rename; it holds a whole layer, including
 * machine-local values, so it must never be staged.
 */
export const HACK_DIR_GITIGNORE_ENTRIES = [
  ".internal/",
  ".branch/",
  ".env",
  ".env.state.json",
  "hack.env.local.yaml",
  "hack.env.*.local.yaml",
  ".hack.env*.tmp",
  "tickets/",
] as const;

/**
 * Built-in (non-discovery) compose templates.
 *
 * We intentionally keep this minimal and generic; multi-service setups should
 * use the discovery-driven wizard in `hack init`.
 */
export function renderProjectConfigJson(opts: {
  readonly name: string;
  readonly devHost: string;
  readonly oauth?: {
    readonly enabled?: boolean;
    readonly tld?: string;
  };
}): string {
  const oauthEnabled = opts.oauth?.enabled === true;
  const oauthTldRaw = opts.oauth?.tld?.trim();
  const oauthTld =
    oauthTldRaw && oauthTldRaw.length > 0
      ? oauthTldRaw
      : DEFAULT_OAUTH_ALIAS_TLD;

  const config = {
    $schema: `https://${DEFAULT_SCHEMAS_HOST}/hack.config.schema.json`,
    name: opts.name,
    dev_host: opts.devHost,
    logs: {
      follow_backend: "compose",
      snapshot_backend: "loki",
      clear_on_down: false,
    },
    internal: {
      dns: true,
      tls: true,
    },
    oauth: {
      enabled: oauthEnabled,
      ...(oauthTld ? { tld: oauthTld } : {}),
    },
    open: {
      prefer: "auto",
    },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

export function renderProjectEnvContractJson(): string {
  const contract = {
    $schema: `https://${DEFAULT_SCHEMAS_HOST}/hack.env.schema.json`,
    version: 1,
    vars: [],
  };
  return `${JSON.stringify(contract, null, 2)}\n`;
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
      defaultEnvConfig: { type: "string" },
      default_env_config: { type: "string" },
      logs: {
        type: "object",
        additionalProperties: true,
        properties: {
          follow_backend: { type: "string", enum: ["compose", "loki"] },
          snapshot_backend: { type: "string", enum: ["compose", "loki"] },
          clear_on_down: { type: "boolean" },
          retention_period: { type: "string" },
        },
      },
      internal: {
        type: "object",
        additionalProperties: true,
        properties: {
          dns: { type: "boolean" },
          tls: { type: "boolean" },
          extra_hosts: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
      oauth: {
        type: "object",
        additionalProperties: true,
        properties: {
          enabled: { type: "boolean" },
          tld: { type: "string" },
        },
      },
      open: {
        type: "object",
        additionalProperties: true,
        properties: {
          prefer: { type: "string", enum: ["auto", "alias", "dev"] },
        },
      },
      worktree: {
        type: "object",
        additionalProperties: true,
        properties: {
          auto_branch: { type: "boolean" },
          inherit_local: { type: "boolean" },
        },
      },
      sessions: {
        type: "object",
        additionalProperties: true,
        properties: {
          mux: { type: "string", enum: ["auto", "tmux", "zellij", "none"] },
        },
      },
      startup: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                run: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                persistent: { type: "boolean" },
                singleton: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ports: {
                      type: "array",
                      minItems: 1,
                      uniqueItems: true,
                      items: { type: "integer", minimum: 1 },
                    },
                    onConflict: {
                      type: "string",
                      enum: ["adopt", "fail"],
                    },
                  },
                  required: ["ports"],
                },
              },
              anyOf: [{ required: ["run"] }, { required: ["command"] }],
            },
          ],
        },
      },
      lifecycle: {
        type: "object",
        additionalProperties: false,
        properties: {
          up: {
            type: "object",
            additionalProperties: false,
            properties: {
              before: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["command"],
                      properties: {
                        name: { type: "string" },
                        command: { type: "string" },
                        cwd: { type: "string" },
                        persistent: { type: "boolean" },
                        singleton: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            ports: {
                              type: "array",
                              minItems: 1,
                              uniqueItems: true,
                              items: { type: "integer", minimum: 1 },
                            },
                            onConflict: {
                              type: "string",
                              enum: ["adopt", "fail"],
                            },
                          },
                          required: ["ports"],
                        },
                      },
                    },
                  ],
                },
              },
              after: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["command"],
                      properties: {
                        name: { type: "string" },
                        command: { type: "string" },
                        cwd: { type: "string" },
                        persistent: { type: "boolean" },
                        singleton: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            ports: {
                              type: "array",
                              minItems: 1,
                              uniqueItems: true,
                              items: { type: "integer", minimum: 1 },
                            },
                            onConflict: {
                              type: "string",
                              enum: ["adopt", "fail"],
                            },
                          },
                          required: ["ports"],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          down: {
            type: "object",
            additionalProperties: false,
            properties: {
              before: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["command"],
                      properties: {
                        name: { type: "string" },
                        command: { type: "string" },
                        cwd: { type: "string" },
                        persistent: { type: "boolean" },
                        singleton: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            ports: {
                              type: "array",
                              minItems: 1,
                              uniqueItems: true,
                              items: { type: "integer", minimum: 1 },
                            },
                            onConflict: {
                              type: "string",
                              enum: ["adopt", "fail"],
                            },
                          },
                          required: ["ports"],
                        },
                      },
                    },
                  ],
                },
              },
              after: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["command"],
                      properties: {
                        name: { type: "string" },
                        command: { type: "string" },
                        cwd: { type: "string" },
                        persistent: { type: "boolean" },
                        singleton: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            ports: {
                              type: "array",
                              minItems: 1,
                              uniqueItems: true,
                              items: { type: "integer", minimum: 1 },
                            },
                            onConflict: {
                              type: "string",
                              enum: ["adopt", "fail"],
                            },
                          },
                          required: ["ports"],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          processes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "command"],
              properties: {
                name: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                singleton: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ports: {
                      type: "array",
                      minItems: 1,
                      uniqueItems: true,
                      items: { type: "integer", minimum: 1 },
                    },
                    onConflict: {
                      type: "string",
                      enum: ["adopt", "fail"],
                    },
                  },
                  required: ["ports"],
                },
              },
            },
          },
        },
      },
      controlPlane: {
        type: "object",
        additionalProperties: true,
        properties: {
          extensions: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: true,
              properties: {
                enabled: { type: "boolean" },
                cliNamespace: { type: "string" },
                config: {
                  type: "object",
                  additionalProperties: true,
                },
              },
            },
          },
          supervisor: {
            type: "object",
            additionalProperties: true,
            properties: {
              enabled: { type: "boolean" },
              maxConcurrentJobs: { type: "number" },
              logsMaxBytes: { type: "number" },
            },
          },
          tui: {
            type: "object",
            additionalProperties: true,
            properties: {
              logs: {
                type: "object",
                additionalProperties: true,
                properties: {
                  maxEntries: { type: "number" },
                  maxLines: { type: "number" },
                  historyTailStep: { type: "number" },
                },
              },
            },
          },
          usage: {
            type: "object",
            additionalProperties: true,
            properties: {
              watchIntervalMs: { type: "number" },
              historySize: { type: "number" },
            },
          },
          daemon: {
            type: "object",
            additionalProperties: true,
            properties: {
              autoStart: { type: "boolean" },
            },
          },
          gateway: {
            type: "object",
            additionalProperties: true,
            properties: {
              enabled: { type: "boolean" },
              bind: { type: "string" },
              port: { type: "number" },
              allowWrites: { type: "boolean" },
            },
          },
          cluster: {
            type: "object",
            additionalProperties: true,
            properties: {
              defaultNodeId: { type: "string" },
              staleAfterMs: { type: "number" },
              offlineAfterMs: { type: "number" },
            },
          },
          secrets: {
            type: "object",
            additionalProperties: true,
            properties: {
              backend: {
                type: "string",
                enum: ["keychain", "encrypted_file", "cloud"],
              },
              allowEnvAuthRefs: { type: "boolean" },
              storePlaintextInBackend: { type: "boolean" },
              encryptedFile: {
                type: "object",
                additionalProperties: true,
                properties: {
                  path: { type: "string" },
                  keyPath: { type: "string" },
                },
              },
              cloud: {
                type: "object",
                additionalProperties: true,
                properties: {
                  provider: {
                    type: "string",
                    enum: ["aws", "gcp", "azure", "vault"],
                  },
                  project: { type: "string" },
                  secretPrefix: { type: "string" },
                },
              },
            },
          },
          nodeId: { type: "string" },
        },
      },
    },
    required: ["name", "dev_host"],
  } as const;

  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function renderProjectEnvSchemaJson(): string {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "hack.env.json",
    type: "object",
    additionalProperties: true,
    required: ["version", "vars"],
    properties: {
      $schema: { type: "string" },
      version: { type: "integer", const: 1 },
      vars: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["key"],
          properties: {
            key: {
              type: "string",
              pattern: "^[A-Z_][A-Z0-9_]*$",
              minLength: 1,
            },
            required: { type: "boolean" },
            source: { type: "string", enum: ["plain_env", "keychain"] },
            services: {
              type: "array",
              items: { type: "string" },
            },
            description: { type: "string" },
          },
        },
      },
    },
  } as const;

  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function renderProjectEnvConfigYaml(opts?: {
  readonly environment?: string;
}): string {
  const environment = opts?.environment ?? "default";
  return [
    "version: 1",
    `environment: ${environment}`,
    "secretsprovider: project_key",
    "values:",
    "  global: {}",
    "",
  ].join("\n");
}

export function renderProjectManagedEnvSchemaJson(): string {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "hack.env.managed.json",
    type: "object",
    additionalProperties: false,
    required: ["version", "environment", "metadata", "entries"],
    properties: {
      $schema: { type: "string" },
      version: { type: "integer", const: 1 },
      environment: { type: "string", minLength: 1 },
      metadata: {
        type: "object",
        additionalProperties: false,
        required: ["updatedAt", "updatedBy", "source"],
        properties: {
          description: { type: "string" },
          updatedAt: { type: "string", format: "date-time" },
          updatedBy: { type: "string", minLength: 1 },
          source: { type: "string", minLength: 1 },
        },
      },
      entries: {
        type: "array",
        description:
          "Managed env entries sorted by key. Duplicate keys and unsorted entries must be rejected by dedicated artifact parsers and writers.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value", "required"],
          properties: {
            key: {
              type: "string",
              pattern: "^[A-Z_][A-Z0-9_]*$",
              minLength: 1,
            },
            value: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "text"],
              properties: {
                kind: { type: "string", enum: ["plaintext", "secret"] },
                text: { type: "string" },
              },
            },
            required: { type: "boolean" },
            services: {
              anyOf: [
                { type: "null" },
                {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                  uniqueItems: true,
                },
              ],
            },
            description: { type: "string" },
          },
        },
      },
    },
  } as const;

  return `${JSON.stringify(schema, null, 2)}\n`;
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
              minLength: 1,
            },
            note: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            last_used_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
  } as const;

  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function renderGlobalLokiConfigYaml(): string {
  // Base: https://raw.githubusercontent.com/grafana/loki/v2.9.4/cmd/loki/loki-local-config.yaml
  //
  // Retention docs:
  // - https://grafana.com/docs/loki/latest/operations/storage/retention/
  // Minimum retention is 24h; keep this modest for local dev. Users can edit ~/.hack/logging/loki.yaml.
  const retentionPeriod = "168h";

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
    "",
  ].join("\n");
}

export function templateFilenames(): string[] {
  return [
    GLOBAL_CADDY_COMPOSE_FILENAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME,
    GLOBAL_ALLOY_FILENAME,
    GLOBAL_LOKI_CONFIG_FILENAME,
    GLOBAL_GRAFANA_DATASOURCE_FILENAME,
    GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
    GLOBAL_GRAFANA_DASHBOARD_FILENAME,
  ];
}
