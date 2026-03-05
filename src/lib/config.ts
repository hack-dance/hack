import { dirname, resolve } from "node:path";
import { PROJECT_CONFIG_FILENAME } from "../constants.ts";
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
  return await updateConfigFileAtPath({
    configPath,
    path,
    value,
  });
}

/**
 * Updates a value in the project config file at <project>/.hack/hack.config.json.
 *
 * @param opts.projectDir - Project `.hack` directory path
 * @param opts.path - Dot-separated path to the config key
 * @param opts.value - The value to set
 * @returns Whether the config was changed
 */
export async function updateProjectConfig({
  projectDir,
  path,
  value,
}: {
  readonly projectDir: string;
  readonly path: string;
  readonly value: unknown;
}): Promise<{ readonly changed: boolean }> {
  const configPath = resolve(projectDir, PROJECT_CONFIG_FILENAME);
  return await updateConfigFileAtPath({
    configPath,
    path,
    value,
  });
}

async function updateConfigFileAtPath({
  configPath,
  path,
  value,
}: {
  readonly configPath: string;
  readonly path: string;
  readonly value: unknown;
}): Promise<{ readonly changed: boolean }> {
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
  const state = createKeyPathParserState();

  for (let i = 0; i < opts.raw.length; i += 1) {
    const ch = opts.raw[i] ?? "";
    if (state.inBracket) {
      handleBracketChar(state, ch);
      continue;
    }
    handlePathChar(state, ch);
  }

  finalizeKeyPath(state);
  return state.parts;
}

type KeyPathParserState = {
  parts: string[];
  buffer: string;
  escaped: boolean;
  inBracket: boolean;
  quote: '"' | "'" | null;
};

function createKeyPathParserState(): KeyPathParserState {
  return {
    parts: [],
    buffer: "",
    escaped: false,
    inBracket: false,
    quote: null,
  };
}

function handleBracketChar(state: KeyPathParserState, ch: string): void {
  if (state.escaped) {
    state.buffer += ch;
    state.escaped = false;
    return;
  }

  if (ch === "\\") {
    state.escaped = true;
    return;
  }

  if (state.quote) {
    if (ch === state.quote) {
      state.quote = null;
      return;
    }
    state.buffer += ch;
    return;
  }

  if (ch === "'" || ch === '"') {
    state.quote = ch;
    return;
  }

  if (ch === "]") {
    state.inBracket = false;
    pushKeyPathBuffer(state);
    return;
  }

  state.buffer += ch;
}

function handlePathChar(state: KeyPathParserState, ch: string): void {
  if (state.escaped) {
    state.buffer += ch;
    state.escaped = false;
    return;
  }

  if (ch === "\\") {
    state.escaped = true;
    return;
  }

  if (ch === ".") {
    pushKeyPathBuffer(state);
    return;
  }

  if (ch === "[") {
    if (state.buffer.trim().length > 0) {
      pushKeyPathBuffer(state);
    } else {
      state.buffer = "";
    }
    state.inBracket = true;
    return;
  }

  state.buffer += ch;
}

function pushKeyPathBuffer(state: KeyPathParserState): void {
  const trimmed = state.buffer.trim();
  if (trimmed.length > 0) {
    state.parts.push(trimmed);
  }
  state.buffer = "";
}

function finalizeKeyPath(state: KeyPathParserState): void {
  if (state.escaped) {
    state.buffer += "\\";
    state.escaped = false;
  }

  if (state.buffer.length > 0) {
    pushKeyPathBuffer(state);
  }
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
