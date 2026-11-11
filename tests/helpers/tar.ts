/** Minimal ustar writer for tests that fake `docker cp <src> -` output. */

export type TarEntry = {
  readonly name: string;
  readonly content?: string | Uint8Array;
  /** ustar typeflag: "0" file, "2" symlink, "5" directory, "x" PAX header. */
  readonly type?: string;
  readonly linkName?: string;
  /** Corrupt the header checksum. */
  readonly badChecksum?: boolean;
};

const BLOCK = 512;

function put(block: Uint8Array, offset: number, length: number, text: string) {
  block.set(Buffer.from(text, "latin1").subarray(0, length), offset);
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(entry: TarEntry, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  put(block, 0, 100, entry.name);
  put(block, 100, 8, octal(0o644, 8));
  put(block, 108, 8, octal(0, 8));
  put(block, 116, 8, octal(0, 8));
  put(block, 124, 12, octal(size, 12));
  put(block, 136, 12, octal(0, 12));
  put(block, 148, 8, "        ");
  put(block, 156, 1, entry.type ?? "0");
  put(block, 157, 100, entry.linkName ?? "");
  put(block, 257, 6, "ustar\0");
  put(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  put(
    block,
    148,
    8,
    `${(entry.badChecksum ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `
  );
  return block;
}

/** PAX extended header records (`path`, `size`, ...). */
export function paxRecords(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([key, value]) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (`${length}${body}`.length !== length) {
        length += 1;
      }
      return `${length}${body}`;
    })
    .join("");
}

export function tarArchive(
  entries: readonly TarEntry[],
  opts: { readonly trailer?: Uint8Array } = {}
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const content =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : (entry.content ?? new Uint8Array());
    parts.push(header(entry, content.length));
    parts.push(content);
    parts.push(new Uint8Array((BLOCK - (content.length % BLOCK)) % BLOCK));
  }
  parts.push(opts.trailer ?? new Uint8Array(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Encode an archive the way `exec` with `maxStdoutBytes` reports stdout. */
export function asExecStdout(archive: Uint8Array): string {
  return Buffer.from(archive).toString("latin1");
}
