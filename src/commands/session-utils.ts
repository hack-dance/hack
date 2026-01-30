export type SessionStreamContext = {
  readonly session: string;
  readonly target: string;
  readonly lines: number;
  readonly follow: boolean;
  readonly intervalMs?: number;
  readonly maxMs?: number;
};

export type TmuxPaneInfo = {
  readonly target: string;
  readonly active: boolean;
  readonly windowIndex: number;
  readonly windowName: string;
  readonly paneIndex: number;
  readonly command: string;
  readonly path: string | null;
};

export type SessionPanesContext = {
  readonly session: string;
};

export type SessionPanesEvent = {
  readonly type: "start" | "log" | "error" | "end";
  readonly ts: string;
  readonly session: string;
  readonly pane?: TmuxPaneInfo;
  readonly message?: string;
  readonly reason?: string;
};

export type SessionStreamEvent = {
  readonly type: "start" | "log" | "error" | "end";
  readonly ts: string;
  readonly session: string;
  readonly target: string;
  readonly lines: number;
  readonly follow: boolean;
  readonly intervalMs?: number;
  readonly maxMs?: number;
  readonly line?: string;
  readonly message?: string;
  readonly reason?: string;
};

export function buildSessionStreamStartEvent(opts: {
  readonly context: SessionStreamContext;
}): SessionStreamEvent {
  const { context } = opts;
  return {
    type: "start",
    ts: nowIso(),
    session: context.session,
    target: context.target,
    lines: context.lines,
    follow: context.follow,
    ...(context.intervalMs !== undefined
      ? { intervalMs: context.intervalMs }
      : {}),
    ...(context.maxMs !== undefined ? { maxMs: context.maxMs } : {}),
  };
}

export function buildSessionPanesStartEvent(opts: {
  readonly context: SessionPanesContext;
}): SessionPanesEvent {
  const { context } = opts;
  return {
    type: "start",
    ts: nowIso(),
    session: context.session,
  };
}

export function buildSessionPanesLogEvent(opts: {
  readonly context: SessionPanesContext;
  readonly pane: TmuxPaneInfo;
}): SessionPanesEvent {
  const { context, pane } = opts;
  return {
    type: "log",
    ts: nowIso(),
    session: context.session,
    pane,
  };
}

export function buildSessionPanesErrorEvent(opts: {
  readonly context: SessionPanesContext;
  readonly message: string;
}): SessionPanesEvent {
  const { context, message } = opts;
  return {
    type: "error",
    ts: nowIso(),
    session: context.session,
    message,
  };
}

export function buildSessionPanesEndEvent(opts: {
  readonly context: SessionPanesContext;
  readonly reason?: string;
}): SessionPanesEvent {
  const { context, reason } = opts;
  return {
    type: "end",
    ts: nowIso(),
    session: context.session,
    ...(reason ? { reason } : {}),
  };
}

export function buildSessionStreamLogEvent(opts: {
  readonly context: SessionStreamContext;
  readonly line: string;
}): SessionStreamEvent {
  const { context, line } = opts;
  return {
    type: "log",
    ts: nowIso(),
    session: context.session,
    target: context.target,
    lines: context.lines,
    follow: context.follow,
    ...(context.intervalMs !== undefined
      ? { intervalMs: context.intervalMs }
      : {}),
    ...(context.maxMs !== undefined ? { maxMs: context.maxMs } : {}),
    line,
  };
}

export function buildSessionStreamErrorEvent(opts: {
  readonly context: SessionStreamContext;
  readonly message: string;
}): SessionStreamEvent {
  const { context, message } = opts;
  return {
    type: "error",
    ts: nowIso(),
    session: context.session,
    target: context.target,
    lines: context.lines,
    follow: context.follow,
    ...(context.intervalMs !== undefined
      ? { intervalMs: context.intervalMs }
      : {}),
    ...(context.maxMs !== undefined ? { maxMs: context.maxMs } : {}),
    message,
  };
}

export function buildSessionStreamEndEvent(opts: {
  readonly context: SessionStreamContext;
  readonly reason?: string;
}): SessionStreamEvent {
  const { context, reason } = opts;
  return {
    type: "end",
    ts: nowIso(),
    session: context.session,
    target: context.target,
    lines: context.lines,
    follow: context.follow,
    ...(context.intervalMs !== undefined
      ? { intervalMs: context.intervalMs }
      : {}),
    ...(context.maxMs !== undefined ? { maxMs: context.maxMs } : {}),
    ...(reason ? { reason } : {}),
  };
}

export type SessionEvent = SessionStreamEvent | SessionPanesEvent;

export function writeSessionStreamEvent(opts: {
  readonly event: SessionEvent;
}): void {
  process.stdout.write(`${JSON.stringify(opts.event)}\n`);
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function diffNewLines(opts: {
  readonly previous: string;
  readonly next: string;
}): string {
  const { previous, next } = opts;
  if (next === previous) {
    return "";
  }
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }

  const prevLines = previous.split("\n");
  const nextLines = next.split("\n");
  let idx = 0;
  while (
    idx < prevLines.length &&
    idx < nextLines.length &&
    prevLines[idx] === nextLines[idx]
  ) {
    idx += 1;
  }

  const suffixLines = nextLines.slice(idx);
  return suffixLines.length > 0 ? suffixLines.join("\n") : "";
}

export function parseTmuxPanesOutput(output: string): TmuxPaneInfo[] {
  const panes: TmuxPaneInfo[] = [];
  for (const line of splitLines(output)) {
    const [
      target,
      activeRaw,
      windowIndexRaw,
      windowName,
      paneIndexRaw,
      command,
      path,
    ] = line.split("\t");

    if (!target) {
      continue;
    }

    const windowIndex = Number.parseInt(windowIndexRaw ?? "", 10);
    const paneIndex = Number.parseInt(paneIndexRaw ?? "", 10);

    panes.push({
      target,
      active: activeRaw === "1",
      windowIndex: Number.isNaN(windowIndex) ? 0 : windowIndex,
      windowName: windowName ?? "",
      paneIndex: Number.isNaN(paneIndex) ? 0 : paneIndex,
      command: command ?? "",
      path: path ? path : null,
    });
  }

  return panes;
}

function nowIso(): string {
  return new Date().toISOString();
}
