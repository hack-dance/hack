/**
 * Read the single regular file `docker cp <container>:<path> -` streams as a
 * tar archive. The archive is already in bounded memory, so no path is ever
 * reopened: what is parsed here is what was received.
 *
 * Strict by design (fail closed): exactly one regular-file entry with the
 * expected base name, valid header checksums, optional PAX extended headers
 * before it (their `path` and `size` records apply), and only zero padding
 * after. Links, directories, devices, GNU long names and anything else are
 * refused.
 */

const BLOCK = 512;
const PAX_HEADER = "x";
const REGULAR_TYPES = new Set(["0", "\0"]);
const OCTAL_FIELD = /^[0-7]{1,12}$/;
const PAX_LENGTH = /^\d{1,6}$/;
const PAX_SIZE = /^\d{1,12}$/;
const TRAILING_SLASHES = /\/+$/;

type PaxRecords = { readonly path?: string; readonly size?: number };

type Entry = {
  readonly type: string;
  readonly headerName: string;
  readonly data: Uint8Array;
  readonly next: number;
};

function field(block: Uint8Array, offset: number, length: number): string {
  const raw = Buffer.from(block.subarray(offset, offset + length)).toString(
    "latin1"
  );
  const end = raw.indexOf("\0");
  return end === -1 ? raw : raw.slice(0, end);
}

function octal(
  block: Uint8Array,
  offset: number,
  length: number
): number | null {
  const text = field(block, offset, length).trim();
  return OCTAL_FIELD.test(text) ? Number.parseInt(text, 8) : null;
}

function checksumValid(block: Uint8Array): boolean {
  const recorded = octal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return recorded !== null && sum === recorded;
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function parsePaxRecord(
  bytes: Buffer,
  offset: number
): {
  readonly key: string;
  readonly value: string;
  readonly next: number;
} | null {
  const space = bytes.indexOf(0x20, offset);
  const lengthText =
    space === -1 ? "" : bytes.subarray(offset, space).toString("latin1");
  const length = PAX_LENGTH.test(lengthText)
    ? Number.parseInt(lengthText, 10)
    : 0;
  const end = offset + length;
  if (
    length <= lengthText.length + 1 ||
    end > bytes.length ||
    bytes[end - 1] !== 0x0a
  ) {
    return null;
  }
  const body = bytes.subarray(space + 1, end - 1).toString("utf8");
  const separator = body.indexOf("=");
  return separator <= 0
    ? null
    : {
        key: body.slice(0, separator),
        value: body.slice(separator + 1),
        next: end,
      };
}

function parsePax(data: Uint8Array): PaxRecords | null {
  const bytes = Buffer.from(data);
  const records: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < bytes.length) {
    const record = parsePaxRecord(bytes, offset);
    if (record === null) {
      return null;
    }
    offset = record.next;
    if (record.key === "path") {
      records.path = record.value;
    } else if (record.key === "size") {
      if (!PAX_SIZE.test(record.value)) {
        return null;
      }
      records.size = Number.parseInt(record.value, 10);
    }
  }
  return records;
}

function baseName(path: string): string {
  const trimmed = path.replace(TRAILING_SLASHES, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Read one header and its data; `null` for a corrupt or truncated entry. */
function readEntry(opts: {
  readonly archive: Uint8Array;
  readonly offset: number;
  readonly paxSize: number | undefined;
}): Entry | null {
  const header = opts.archive.subarray(opts.offset, opts.offset + BLOCK);
  if (!checksumValid(header)) {
    return null;
  }
  const type = field(header, 156, 1) || "\0";
  const headerSize = octal(header, 124, 12);
  if (headerSize === null) {
    return null;
  }
  const size = type === PAX_HEADER ? headerSize : (opts.paxSize ?? headerSize);
  const start = opts.offset + BLOCK;
  if (start + size > opts.archive.length) {
    return null;
  }
  return {
    type,
    headerName: field(header, 0, 100),
    data: opts.archive.subarray(start, start + size),
    next: start + Math.ceil(size / BLOCK) * BLOCK,
  };
}

/**
 * Return the content of the archive's only entry when it is a regular file
 * named `name` of at most `maxBytes`; otherwise `null`.
 */
export function readSingleRegularFileFromTar(opts: {
  readonly archive: Uint8Array;
  readonly name: string;
  readonly maxBytes: number;
}): Uint8Array | null {
  const { archive } = opts;
  let offset = 0;
  let pax: PaxRecords = {};
  while (offset + BLOCK <= archive.length) {
    if (isZero(archive.subarray(offset, offset + BLOCK))) {
      return null;
    }
    const entry = readEntry({ archive, offset, paxSize: pax.size });
    if (entry === null) {
      return null;
    }
    if (entry.type === PAX_HEADER) {
      const parsed = parsePax(entry.data);
      if (parsed === null) {
        return null;
      }
      pax = { ...pax, ...parsed };
      offset = entry.next;
      continue;
    }
    const accepted =
      REGULAR_TYPES.has(entry.type) &&
      baseName(pax.path ?? entry.headerName) === opts.name &&
      entry.data.length <= opts.maxBytes &&
      isZero(archive.subarray(entry.next));
    return accepted ? Uint8Array.from(entry.data) : null;
  }
  return null;
}
