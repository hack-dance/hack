import { dirname } from "node:path";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { ensureDir, readTextFile, writeTextFileIfChanged } from "./fs.ts";
import { isRecord } from "./guards.ts";

/**
 * Updates a value in the global config file at ~/.hack/hack.config.json.
 *
 * @param opts.path - Dot-separated path to the config key (e.g. "controlPlane.daemon.launchd.installed")
 * @param opts.value - The value to set
 * @returns Whether the config was changed
 */
export async function updateGlobalConfig({
  path,
  value,
}: {
  readonly path: string;
  readonly value: unknown;
}): Promise<{ readonly changed: boolean }> {
  const configPath = resolveGlobalConfigPath();
  const parsedPath = parseKeyPath({ raw: path });

  if (parsedPath.length === 0) {
    throw new Error(`Invalid config path: ${path}`);
  }

  const jsonText = await readTextFile(configPath);
  const config: Record<string, unknown> =
    jsonText !== null ? parseJsonSafe(jsonText) : {};

  setPathValue({ target: config, path: parsedPath, value });

  const nextText = `${JSON.stringify(config, null, 2)}\n`;
  await ensureDir(dirname(configPath));
  const result = await writeTextFileIfChanged(configPath, nextText);

  return { changed: result.changed };
}

/**
 * Reads a value from the global config file.
 *
 * @param opts.path - Dot-separated path to the config key
 * @returns The value at the path, or undefined if not found
 */
export async function readGlobalConfig({
  path,
}: {
  readonly path: string;
}): Promise<unknown> {
  const configPath = resolveGlobalConfigPath();
  const parsedPath = parseKeyPath({ raw: path });

  if (parsedPath.length === 0) {
    return undefined;
  }

  const jsonText = await readTextFile(configPath);
  if (jsonText === null) {
    return undefined;
  }

  const config = parseJsonSafe(jsonText);
  return getPathValue({ target: config, path: parsedPath });
}

function parseJsonSafe(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseKeyPath(opts: { readonly raw: string }): readonly string[] {
  const parts: string[] = [];
  let buffer = "";
  let escape = false;
  let inBracket = false;
  let quote: '"' | "'" | null = null;

  const pushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
    buffer = "";
  };

  for (let i = 0; i < opts.raw.length; i += 1) {
    const ch = opts.raw[i] ?? "";
    if (inBracket) {
      if (escape) {
        buffer += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (quote) {
        if (ch === quote) {
          quote = null;
          continue;
        }
        buffer += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "]") {
        inBracket = false;
        pushBuffer();
        continue;
      }
      buffer += ch;
      continue;
    }

    if (escape) {
      buffer += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === ".") {
      pushBuffer();
      continue;
    }
    if (ch === "[") {
      if (buffer.trim().length > 0) {
        pushBuffer();
      } else {
        buffer = "";
      }
      inBracket = true;
      continue;
    }
    buffer += ch;
  }

  if (escape) {
    buffer += "\\";
  }
  if (buffer.length > 0) {
    pushBuffer();
  }

  return parts;
}

function getPathValue(opts: {
  readonly target: Record<string, unknown>;
  readonly path: readonly string[];
}): unknown {
  let current: unknown = opts.target;
  for (const key of opts.path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function setPathValue(opts: {
  readonly target: Record<string, unknown>;
  readonly path: readonly string[];
  readonly value: unknown;
}): void {
  let current: Record<string, unknown> = opts.target;
  for (let i = 0; i < opts.path.length - 1; i += 1) {
    const key = opts.path[i] ?? "";
    const existing = current[key];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[key] = next;
      current = next;
      continue;
    }
    if (!isRecord(existing)) {
      const next: Record<string, unknown> = {};
      current[key] = next;
      current = next;
      continue;
    }
    current = existing;
  }

  const lastKey = opts.path.at(-1) ?? "";
  current[lastKey] = opts.value;
}
