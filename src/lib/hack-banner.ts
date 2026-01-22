const hackBannerUrl = new URL("./hack.txt", import.meta.url);

const LINE_BREAK_PATTERN = /\r?\n/;

let cachedLines: string[] | null = null;

export async function loadHackBannerLines(): Promise<string[]> {
  if (cachedLines) {
    return cachedLines;
  }
  try {
    const text = await Bun.file(hackBannerUrl).text();
    cachedLines = text.split(LINE_BREAK_PATTERN);
  } catch {
    cachedLines = [];
  }
  return cachedLines;
}

export async function renderHackBanner(opts?: {
  readonly maxLines?: number;
  readonly trimEmpty?: boolean;
}): Promise<string> {
  const lines = await loadHackBannerLines();
  if (lines.length === 0) {
    return "";
  }
  const trimmed = opts?.trimEmpty ? trimEmptyLines(lines) : lines;
  if (trimmed.length === 0) {
    return "";
  }
  const maxLines = opts?.maxLines ?? trimmed.length;
  return trimmed.slice(0, Math.max(0, maxLines)).join("\n").trimEnd();
}

function trimEmptyLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim().length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
}
