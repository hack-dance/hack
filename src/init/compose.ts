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
}

export function renderCompose(plan: ComposePlan): string {
  const services: Record<string, ComposeServiceSpec> = {};

  for (const svc of plan.services) {
    services[svc.name] = {
      image:
        svc.image === TODO_IMAGE_SENTINEL ? TODO_IMAGE_PLACEHOLDER : svc.image,
      working_dir: svc.workingDir,
      volumes: ["..:/app"],
      command: svc.command,
      ...(svc.env.size > 0 ? { environment: recordFromMap(svc.env) } : {}),
      ...(svc.labels.size > 0 ? { labels: recordFromMap(svc.labels) } : {}),
      ...(svc.networks.length > 0 ? { networks: [...svc.networks] } : {}),
    };
  }

  const compose: ComposeFileSpec = {
    ...(plan.name ? { name: plan.name } : {}),
    services,
    networks: {
      [DEFAULT_INGRESS_NETWORK]: { external: true },
    },
  };

  const yaml = YAML.stringify(compose, null, 2);
  const cleaned = ensureTrailingNewline(cleanupYaml(yaml));

  const withServiceComments = injectServiceComments({
    yaml: cleaned,
    services: plan.services,
  });

  return injectHeaderComments({
    yaml: withServiceComments,
    headerComments: plan.headerComments ?? [],
  });
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
};

type ComposeFileSpec = {
  readonly name?: string;
  readonly services: Record<string, ComposeServiceSpec>;
  readonly networks: Record<string, { readonly external: boolean }>;
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
