/**
 * Opt-in repair for HACK-2323's polling watcher finding: remove exactly the
 * `CHOKIDAR_USEPOLLING: "true"` / `WATCHPACK_POLLING: "true"` map lines old
 * `hack init` generated into every service.
 *
 * - Selected only with `hack doctor --fix --only 'polling watchers'`; plain
 *   `doctor --fix` never runs it.
 * - Without `--yes` it prints the diff and writes nothing.
 * - Any other form (list entries, other values, numeric intervals,
 *   interpolation, comments on the line) is project configuration and is left
 *   alone, as are platform pins and images.
 * - Before writing, the parsed document must equal the original minus the
 *   removed variables, and the file must still hold the bytes the diff was
 *   computed from; otherwise nothing is written.
 */

import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { YAML } from "bun";
import { HackCliError } from "./cli-result.ts";
import {
  scanComposeServiceLines,
  splitYamlKey,
} from "./compose-service-lines.ts";
import {
  DEV_PERFORMANCE_GUIDE_URL,
  isLegacyPollingLine,
  POLLING_WATCHERS_CHECK,
} from "./doctor-dev-performance.ts";
import { isRecord } from "./guards.ts";

export const POLLING_FIX_ID = POLLING_WATCHERS_CHECK;

export type PollingFixRemoval = {
  readonly service: string;
  readonly variable: string;
  /** 1-based line in the original file. */
  readonly line: number;
};

export type PollingFixPlan = {
  readonly before: string;
  readonly after: string;
  readonly removed: readonly PollingFixRemoval[];
  /** Unified diff of the change; empty when nothing would change. */
  readonly diff: string;
};

const DIFF_CONTEXT = 2;

type LineChange = { readonly index: number; readonly replacement?: string };

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The change for one Compose text: legacy lines out, an emptied block closed. */
export function planPollingFix(opts: {
  readonly text: string;
  /** Project-relative path shown in the diff header. */
  readonly file: string;
}): PollingFixPlan {
  const lines = opts.text.split("\n");
  const changes = new Map<number, LineChange>();
  const removed: PollingFixRemoval[] = [];
  for (const [service, info] of scanComposeServiceLines(opts.text)) {
    const legacy = info.environment.filter(isLegacyPollingLine);
    if (legacy.length === 0 || info.environmentBlock === null) {
      continue;
    }
    for (const entry of legacy) {
      changes.set(entry.line - 1, { index: entry.line - 1 });
      removed.push({ service, variable: entry.key, line: entry.line });
    }
    closeEmptiedBlock({
      lines,
      header: info.environmentBlock - 1,
      propertyIndent: info.propertyIndent ?? 0,
      // A service left with no properties would parse as null.
      onlyProperty: info.keys.size <= 1,
      changes,
    });
  }
  if (changes.size === 0) {
    return { before: opts.text, after: opts.text, removed, diff: "" };
  }
  const after: string[] = [];
  for (const [index, line] of lines.entries()) {
    const change = changes.get(index);
    if (!change) {
      after.push(line);
    } else if (change.replacement !== undefined) {
      after.push(change.replacement);
    }
  }
  return {
    before: opts.text,
    after: after.join("\n"),
    removed,
    diff: unifiedDiff({ lines, changes, file: opts.file }),
  };
}

/**
 * When every entry of an `environment:` block is removed, drop the header
 * too (an empty block would parse as null). Comments in the block are kept;
 * the header then becomes `environment: {}`.
 */
function closeEmptiedBlock(opts: {
  readonly lines: readonly string[];
  readonly header: number;
  readonly propertyIndent: number;
  readonly onlyProperty: boolean;
  readonly changes: Map<number, LineChange>;
}): void {
  let keepsEntry = false;
  let keepsComment = false;
  for (let i = opts.header + 1; i < opts.lines.length; i += 1) {
    const line = opts.lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const indent = indentOf(line);
    // Comments at or left of the property indent belong to what follows.
    const ownsLine =
      indent > opts.propertyIndent ||
      (indent === opts.propertyIndent &&
        trimmed.startsWith("-") &&
        !trimmed.startsWith("#"));
    if (!ownsLine) {
      break;
    }
    if (opts.changes.has(i)) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      keepsComment = true;
    } else {
      keepsEntry = true;
    }
  }
  if (keepsEntry) {
    return;
  }
  const header = opts.lines[opts.header] ?? "";
  const comment = header.slice(header.indexOf(":") + 1).trim();
  const eol = header.endsWith("\r") ? "\r" : "";
  opts.changes.set(
    opts.header,
    keepsComment || opts.onlyProperty
      ? {
          index: opts.header,
          replacement: `${" ".repeat(indentOf(header))}environment: {}${comment ? ` ${comment}` : ""}${eol}`,
        }
      : { index: opts.header }
  );
}

const REDACTED = "[REDACTED]";

/**
 * A context line with its value replaced: keys and structure stay, values
 * and comments never reach the printed or JSON diff (a neighbouring entry
 * can be a credential). Removed lines are always the generated
 * `KEY: "true"` form, so they are shown as they are.
 */
export function redactContextLine(line: string): string {
  const eol = line.endsWith("\r") ? "\r" : "";
  return `${redactContextBody(eol ? line.slice(0, -1) : line)}${eol}`;
}

function redactContextBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return body;
  }
  const indent = body.slice(0, body.length - body.trimStart().length);
  if (trimmed.startsWith("#")) {
    return `${indent}# ${REDACTED}`;
  }
  if (trimmed.startsWith("-")) {
    return `${indent}- ${redactScalarLine(trimmed.slice(1).trim())}`;
  }
  return `${indent}${redactScalarLine(trimmed)}`;
}

/**
 * Keeps a key only when it is a plain identifier (`KEY=` or `key:`), so
 * block-scalar text such as `psql -W pw -c "x: y"` is never split into a
 * fake key; everything else is `[REDACTED]`.
 */
function redactScalarLine(text: string): string {
  const unquoted = text.replace(QUOTES, "");
  const eq = unquoted.indexOf("=");
  if (eq > 0 && PLAIN_KEY.test(unquoted.slice(0, eq))) {
    return `${unquoted.slice(0, eq)}=${REDACTED}`;
  }
  const split = splitYamlKey(text);
  if (!(split && PLAIN_KEY.test(split.key))) {
    return REDACTED;
  }
  return split.rest && !split.rest.startsWith("#")
    ? `${split.key}: ${REDACTED}`
    : `${split.key}:`;
}

/**
 * A removed or replaced line in the diff. Generated entries carry no
 * comment; only the `environment:` header can, and its comment is shown
 * redacted. The written bytes keep it.
 */
function redactChangedLine(line: string): string {
  const eol = line.endsWith("\r") ? "\r" : "";
  const body = eol ? line.slice(0, -1) : line;
  const match = HEADER_COMMENT.exec(body);
  return match ? `${match[1]}# ${REDACTED}${eol}` : line;
}

const QUOTES = /^["']|["']$/g;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const HEADER_COMMENT =
  /^(\s*(?:environment|"environment"|'environment')\s*:\s*(?:\{\}\s*)?)#.*$/;

function unifiedDiff(opts: {
  readonly lines: readonly string[];
  readonly changes: ReadonlyMap<number, LineChange>;
  readonly file: string;
}): string {
  const indices = [...opts.changes.keys()].sort((a, b) => a - b);
  const hunks: [number, number][] = [];
  for (const index of indices) {
    const last = hunks.at(-1);
    if (last && index - last[1] <= 2 * DIFF_CONTEXT + 1) {
      last[1] = index;
    } else {
      hunks.push([index, index]);
    }
  }
  // A trailing newline leaves one empty element that is not a line.
  const lineCount =
    opts.lines.at(-1) === "" ? opts.lines.length - 1 : opts.lines.length;
  const out = [`--- a/${opts.file}`, `+++ b/${opts.file}`];
  let delta = 0;
  for (const [first, last] of hunks) {
    const start = Math.max(0, first - DIFF_CONTEXT);
    const end = Math.min(lineCount - 1, last + DIFF_CONTEXT);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i += 1) {
      const line = opts.lines[i] ?? "";
      const change = opts.changes.get(i);
      oldCount += 1;
      if (!change) {
        body.push(` ${redactContextLine(line)}`);
        newCount += 1;
        continue;
      }
      body.push(`-${redactChangedLine(line)}`);
      if (change.replacement !== undefined) {
        body.push(`+${redactChangedLine(change.replacement)}`);
        newCount += 1;
      }
    }
    out.push(
      `@@ -${start + 1},${oldCount} +${start + 1 + delta},${newCount} @@`,
      ...body
    );
    delta += newCount - oldCount;
  }
  return `${out.join("\n")}\n`;
}

function normalizedServices(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = YAML.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The parsed document after the change equals the original with only the
 * removed variables gone (an emptied `environment` may be absent or `{}`).
 */
export function pollingFixPreservesDocument(plan: PollingFixPlan): boolean {
  const before = normalizedServices(plan.before);
  const after = normalizedServices(plan.after);
  if (!(before && after)) {
    return false;
  }
  const expected = structuredClone(before);
  const services = isRecord(expected.services) ? expected.services : {};
  for (const removal of plan.removed) {
    const service = services[removal.service];
    if (isRecord(service) && isRecord(service.environment)) {
      Reflect.deleteProperty(service.environment, removal.variable);
    }
  }
  const strip = (doc: Record<string, unknown>) => {
    const svc = isRecord(doc.services) ? doc.services : {};
    for (const value of Object.values(svc)) {
      if (
        isRecord(value) &&
        isRecord(value.environment) &&
        Object.keys(value.environment).length === 0
      ) {
        Reflect.deleteProperty(value, "environment");
      }
    }
    return doc;
  };
  return Bun.deepEquals(strip(expected), strip(structuredClone(after)), true);
}

/**
 * Plans, and with `apply` writes, the removal for one Compose file. Refuses
 * when the file changed since it was read or the change would alter anything
 * else in the parsed document.
 */
export async function runPollingFixForFile(opts: {
  readonly composeFile: string;
  readonly displayPath: string;
  readonly apply: boolean;
}): Promise<{
  readonly plan: PollingFixPlan;
  readonly changed: boolean;
  readonly confirmed: boolean;
}> {
  const read = async () => {
    try {
      return await Bun.file(opts.composeFile).text();
    } catch {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message: `Selected repair could not read ${opts.displayPath}.`,
      });
    }
  };
  const before = await read();
  const plan = planPollingFix({ text: before, file: opts.displayPath });
  if (plan.removed.length === 0) {
    return { plan, changed: false, confirmed: true };
  }
  if (!pollingFixPreservesDocument(plan)) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `Selected repair would change more than the generated polling lines in ${opts.displayPath}; nothing written. Remove them by hand. Guide: ${DEV_PERFORMANCE_GUIDE_URL}`,
    });
  }
  if (!opts.apply) {
    return { plan, changed: false, confirmed: false };
  }
  const info = await lstat(opts.composeFile);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `${opts.displayPath} is a symlink or not a regular file; nothing written. Edit the target by hand.`,
    });
  }
  const mode = info.mode & 0o777;
  if ((await read()) !== before) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `${opts.displayPath} changed while the repair ran; nothing written.`,
    });
  }
  const temp = join(
    dirname(opts.composeFile),
    `.${basename(opts.composeFile)}.hack-fix-${process.pid}`
  );
  let created = false;
  let renamed = false;
  try {
    await writeFile(temp, plan.after, { mode, flag: "wx" });
    created = true;
    await rename(temp, opts.composeFile);
    renamed = true;
  } finally {
    // Never remove a temp path another run left behind.
    if (created && !renamed) {
      await rm(temp, { force: true });
    }
  }
  const after = await read();
  const confirmed =
    after === plan.after &&
    planPollingFix({ text: after, file: opts.displayPath }).removed.length ===
      0;
  return { plan, changed: true, confirmed };
}
