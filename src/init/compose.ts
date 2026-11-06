import { YAML } from "bun";

import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";

/**
 * Sentinel image value a caller can set on `PlannedService.image` to mark a
 * service whose runtime looks non-JS (see `detectPackageRuntime` in
 * `./validation.ts`). `renderCompose` replaces this literal with a visibly
 * wrong placeholder image (`alpine:3`) rather than silently defaulting to
 * the bun-node image — paired with a required `comments` entry explaining
 * why.
 */
export const TODO_IMAGE_SENTINEL = "TODO-set-image";

/** Visible placeholder image substituted for `TODO_IMAGE_SENTINEL`. */
export const TODO_IMAGE_PLACEHOLDER = "alpine:3";

export type PlannedServiceRole = "http" | "internal";

/**
 * Runtime backend an init scaffold targets. `compose` is the v4 Docker
 * Compose output, unchanged. `native` writes the same services in the form
 * the native backend starts: the shared ingress network becomes the reviewed
 * `x-hack-isolated` replacement, and each routed service gets the native HTTP
 * readiness probe its route requires. Docker Compose ignores both extension
 * fields, so a native scaffold still starts on the Compose backend.
 */
export type InitComposeBackend = "compose" | "native";

/**
 * Starting values for a scaffolded native HTTP probe. They match the
 * `HACK_NATIVE_ADAPTATION` `httpProbes` defaults: one-second samples, a
 * two-second request timeout, 60 failed samples to unhealthy, and a
 * two-minute start period for a dev server's first build.
 */
export const INIT_NATIVE_HTTP_PROBE = {
  path: "/",
  interval_ms: 1000,
  timeout_ms: 2000,
  retries: 60,
  start_period_ms: 120_000,
} as const;

export interface PlannedService {
  readonly name: string; // docker compose service key
  readonly role: PlannedServiceRole;
  readonly image: string;
  readonly workingDir: string;
  readonly command: string;
  readonly env: ReadonlyMap<string, string>;
  readonly labels: ReadonlyMap<string, string>;
  readonly networks: readonly string[];
  /**
   * Container port the service's Caddy route proxies to. Set for routed
   * (`http`) services; a native scaffold probes this port.
   */
  readonly httpPort?: number;
  /**
   * Comment lines injected immediately above this service's `  <name>:` key
   * in the rendered YAML (e.g. a runtime-mismatch TODO). Rendered as `# `
   * prefixed lines; injection is a post-process step over the stringified
   * YAML and is idempotent — re-running against already-commented output
   * does not duplicate lines.
   */
  readonly comments?: readonly string[];
}

export interface ComposePlan {
  readonly name?: string;
  readonly services: readonly PlannedService[];
  /**
   * Comment lines injected as a block at the very top of the rendered file
   * (e.g. backing-service discovery warnings). See `PlannedService.comments`
   * for per-service comments.
   */
  readonly headerComments?: readonly string[];
  /** Backend the scaffold targets (default `compose`). */
  readonly backend?: InitComposeBackend;
}

export function renderCompose(plan: ComposePlan): string {
  const native = plan.backend === "native";
  const services: Record<string, ComposeServiceSpec> = {};
  const planned = native
    ? plan.services.map(withNativeProbeComment)
    : plan.services;

  for (const svc of planned) {
    const probePort = native ? nativeProbePort(svc) : undefined;
    services[svc.name] = {
      image:
        svc.image === TODO_IMAGE_SENTINEL ? TODO_IMAGE_PLACEHOLDER : svc.image,
      working_dir: svc.workingDir,
      volumes: ["..:/app"],
      command: svc.command,
      ...(svc.env.size > 0 ? { environment: recordFromMap(svc.env) } : {}),
      ...(svc.labels.size > 0 ? { labels: recordFromMap(svc.labels) } : {}),
      ...(svc.networks.length > 0 ? { networks: [...svc.networks] } : {}),
      ...(probePort === undefined
        ? {}
        : {
            healthcheck: {
              "x-hack-http": { port: probePort, ...INIT_NATIVE_HTTP_PROBE },
            },
          }),
    };
  }

  const compose: ComposeFileSpec = {
    ...(plan.name ? { name: plan.name } : {}),
    services,
    networks: {
      // Native start refuses an external network it would have to join; the
      // reviewed replacement creates an owned bridge under the same name.
      [DEFAULT_INGRESS_NETWORK]: native
        ? { external: true, "x-hack-isolated": true }
        : { external: true },
    },
  };

  const yaml = YAML.stringify(compose, null, 2);
  const cleaned = ensureTrailingNewline(cleanupYaml(yaml));

  const withServiceComments = injectServiceComments({
    yaml: cleaned,
    services: planned,
  });

  return injectHeaderComments({
    yaml: withServiceComments,
    headerComments: plan.headerComments ?? [],
  });
}

/**
 * The port a native scaffold probes: the routed service's proxied port. A
 * service without a route port gets no probe, because native requires probes
 * only for routes and never invents one for an unrouted service.
 */
function nativeProbePort(svc: PlannedService): number | undefined {
  return svc.role === "http" && svc.httpPort !== undefined
    ? svc.httpPort
    : undefined;
}

function withNativeProbeComment(svc: PlannedService): PlannedService {
  const port = nativeProbePort(svc);
  if (port === undefined) {
    return svc;
  }
  return {
    ...svc,
    comments: [
      ...(svc.comments ?? []),
      `Native readiness: GET ${INIT_NATIVE_HTTP_PROBE.path} on port ${port} inside the container must return 2xx.`,
      "Point healthcheck.x-hack-http.path at your app's health endpoint if / does not.",
    ],
  };
}

/**
 * Prefixes each line with `# ` to form a YAML comment block; blank input
 * lines become bare `#` lines (no trailing space).
 */
function toCommentBlock(lines: readonly string[]): string[] {
  return lines.map((line) => (line.length > 0 ? `# ${line}` : "#"));
}

const HEADER_COMMENT_MARKER = "# --- hack-init discovery notes ---";

function injectHeaderComments(opts: {
  readonly yaml: string;
  readonly headerComments: readonly string[];
}): string {
  if (opts.headerComments.length === 0) {
    return opts.yaml;
  }
  if (opts.yaml.includes(HEADER_COMMENT_MARKER)) {
    // Idempotent: header block already present, do not duplicate it.
    return opts.yaml;
  }

  const block = [
    HEADER_COMMENT_MARKER,
    ...toCommentBlock(opts.headerComments),
    "",
  ].join("\n");

  return `${block}\n${opts.yaml}`;
}

function injectServiceComments(opts: {
  readonly yaml: string;
  readonly services: readonly PlannedService[];
}): string {
  let out = opts.yaml;

  for (const svc of opts.services) {
    if (!svc.comments || svc.comments.length === 0) {
      continue;
    }

    const serviceKeyPattern = new RegExp(
      `^(\\s{2}${escapeRegExp(svc.name)}:)$`,
      "m"
    );
    const match = out.match(serviceKeyPattern);
    if (!match) {
      continue;
    }

    const marker = `  # hack-init: ${svc.name}`;
    if (out.includes(marker)) {
      // Idempotent: this service's comment block was already injected.
      continue;
    }

    const commentLines = [
      marker,
      ...toCommentBlock(svc.comments).map((l) => `  ${l}`),
    ].join("\n");
    out = out.replace(serviceKeyPattern, `${commentLines}\n${match[0]}`);
  }

  return out;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ComposeServiceSpec = {
  readonly image: string;
  readonly working_dir?: string;
  readonly volumes?: readonly string[];
  readonly command?: string;
  readonly environment?: Record<string, string>;
  readonly labels?: Record<string, string>;
  readonly networks?: readonly string[];
  readonly healthcheck?: {
    readonly "x-hack-http": Readonly<Record<string, number | string>>;
  };
};

type ComposeFileSpec = {
  readonly name?: string;
  readonly services: Record<string, ComposeServiceSpec>;
  readonly networks: Record<
    string,
    { readonly external: boolean; readonly "x-hack-isolated"?: boolean }
  >;
};

function recordFromMap(
  map: ReadonlyMap<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of map.entries()) {
    out[k] = v;
  }
  return out;
}

function cleanupYaml(yaml: string): string {
  // Bun.YAML.stringify currently emits `key: ` (space before newline) for nested maps.
  // Clean it up to a more conventional `key:` format.
  const out = yaml.replaceAll(/: \n/g, ":\n");

  return out;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
