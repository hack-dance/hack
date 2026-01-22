export type LogBackendChoice = "compose" | "loki";

export function resolveShouldTryLoki(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly follow: boolean;
  readonly followBackend: LogBackendChoice;
  readonly snapshotBackend: LogBackendChoice;
}): boolean {
  if (opts.forceCompose) {
    return false;
  }
  if (opts.wantsLokiExplicit) {
    return true;
  }
  return opts.follow
    ? opts.followBackend === "loki"
    : opts.snapshotBackend === "loki";
}

export function resolveUseLoki(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly shouldTryLoki: boolean;
  readonly lokiReachable: boolean;
}): boolean {
  if (opts.wantsLokiExplicit) {
    return true;
  }
  if (opts.forceCompose) {
    return false;
  }
  return opts.shouldTryLoki && opts.lokiReachable;
}

export function buildLogSelector(opts: {
  readonly project: string | null;
  readonly services: readonly string[];
}): string {
  const parts: string[] = [];
  if (opts.project) {
    parts.push(`project=${quoteLogql(opts.project)}`);
  }
  if (opts.services.length === 1) {
    parts.push(`service=${quoteLogql(opts.services[0] ?? "")}`);
  } else if (opts.services.length > 1) {
    const pattern = `^(${opts.services.map(escapeRegex).join("|")})$`;
    parts.push(`service=~${quoteLogql(pattern)}`);
  }

  return `{${parts.join(",")}}`;
}

function quoteLogql(value: string): string {
  return `"${value.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\"')}"`;
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\\\$&");
}
