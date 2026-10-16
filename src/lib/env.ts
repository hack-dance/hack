export interface EnvMap {
  readonly [key: string]: string;
}

export function parseDotEnv(content: string): EnvMap {
  const out: Record<string, string> = {};
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    const normalizedLine = rawLine.trimStart();
    const eqIdx = normalizedLine.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, eqIdx).trim();
    const valueRaw = normalizedLine.slice(eqIdx + 1).trimStart();
    if (key.length === 0) {
      continue;
    }

    const parsed = parseEnvValue({
      lines,
      startIndex: index,
      rawValue: valueRaw,
    });
    out[key] = parsed.value;
    index = parsed.endIndex;
  }

  return out;
}

function parseEnvValue(input: {
  readonly lines: readonly string[];
  readonly startIndex: number;
  readonly rawValue: string;
}): {
  readonly value: string;
  readonly endIndex: number;
} {
  const quote = input.rawValue[0];
  if (quote !== `"` && quote !== `'`) {
    return {
      value: input.rawValue.trim(),
      endIndex: input.startIndex,
    };
  }

  let value = "";
  let currentIndex = input.startIndex;
  let segment = input.rawValue.slice(1);

  while (true) {
    const parsed = consumeQuotedSegment({
      segment,
      quote,
    });
    value += parsed.value;
    if (parsed.closed) {
      return {
        value,
        endIndex: currentIndex,
      };
    }

    currentIndex += 1;
    if (currentIndex >= input.lines.length) {
      return {
        value: `${quote}${value}`,
        endIndex: input.startIndex,
      };
    }
    value += "\n";
    segment = input.lines[currentIndex] ?? "";
  }
}

function consumeQuotedSegment(input: {
  readonly segment: string;
  readonly quote: `"` | `'`;
}): {
  readonly value: string;
  readonly closed: boolean;
} {
  let value = "";
  let escaped = false;

  for (const ch of input.segment) {
    if (escaped) {
      value += ch === input.quote || ch === "\\" ? ch : `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === input.quote) {
      return {
        value,
        closed: true,
      };
    }
    value += ch;
  }

  if (escaped) {
    value += "\\";
  }

  return {
    value,
    closed: false,
  };
}

export function serializeDotEnv(env: EnvMap): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${escapeEnvValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeEnvValue(value: string): string {
  const needsQuotes =
    value.includes(" ") ||
    value.includes("\n") ||
    value.includes('"') ||
    value.includes("\\");
  if (!needsQuotes) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
