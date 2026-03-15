import { randomBytes } from "node:crypto";

const DIGITS_ONLY_PATTERN = /^\d+$/;
const LEGACY_TICKET_ID_PATTERN = /^T-(\d+)$/i;
const RANDOM_TICKET_ID_PATTERN = /^T-([0-9A-Z]{10})$/i;
const RANDOM_TICKET_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_TICKET_ID_PREFIX_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_TICKET_ID_LENGTH = 10;

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function getMonthStamp(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function formatTicketId(n: number): string {
  const padded = String(n).padStart(5, "0");
  return `T-${padded}`;
}

export function parseTicketNumber(ticketId: string): number | null {
  const trimmed = ticketId.trim();
  const match = LEGACY_TICKET_ID_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.trunc(n);
}

export function generateTicketId(): string {
  const prefix = generateRandomTicketIdChunk({
    alphabet: RANDOM_TICKET_ID_PREFIX_ALPHABET,
    length: 1,
  });
  const suffix = generateRandomTicketIdChunk({
    alphabet: RANDOM_TICKET_ID_ALPHABET,
    length: RANDOM_TICKET_ID_LENGTH - prefix.length,
  });
  return `T-${prefix}${suffix}`;
}

export function normalizeTicketRef(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const raw = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!raw) {
    return null;
  }
  const upper = raw.toUpperCase();
  if (upper.startsWith("T-")) {
    const n = parseTicketNumber(upper);
    if (n !== null) {
      return formatTicketId(n);
    }
    return RANDOM_TICKET_ID_PATTERN.test(upper) ? upper : null;
  }
  if (DIGITS_ONLY_PATTERN.test(raw)) {
    return formatTicketId(Number(raw));
  }
  return null;
}

export function compareTicketIds(left: string, right: string): number {
  const leftNumber = parseTicketNumber(left);
  const rightNumber = parseTicketNumber(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== null) {
    return -1;
  }
  if (rightNumber !== null) {
    return 1;
  }
  return left.localeCompare(right);
}

export function normalizeTicketRefs(inputs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of inputs) {
    const normalized = normalizeTicketRef(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort(compareTicketIds);
  return out;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableSort(value));
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSort);
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) {
      out[key] = stableSort(rec[key]);
    }
    return out;
  }
  return value;
}

function generateRandomTicketIdChunk(opts: {
  readonly alphabet: string;
  readonly length: number;
}): string {
  let chunkText = "";
  while (chunkText.length < opts.length) {
    const chunk = randomBytes(opts.length);
    for (const byte of chunk) {
      chunkText += opts.alphabet[byte % opts.alphabet.length] ?? "";
      if (chunkText.length === opts.length) {
        break;
      }
    }
  }
  return chunkText;
}
