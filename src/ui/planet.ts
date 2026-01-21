import { resolve } from "node:path";
import { pathExists } from "../lib/fs.ts";
import { loadLipgloss } from "./lipgloss.ts";
import type { PlanetAnimation } from "./planet-animations.ts";
import { isTty } from "./terminal.ts";

type LipglossModule = NonNullable<Awaited<ReturnType<typeof loadLipgloss>>>;
type PlanetStyle = {
  readonly open: string;
  readonly close: string;
  readonly render: (text: string) => string;
};

type PlanetTheme = {
  readonly border: PlanetStyle;
  readonly title: PlanetStyle;
  readonly footer: PlanetStyle;
  readonly mainBackground: PlanetStyle;
  readonly videoBorder: PlanetStyle;
  readonly videoBackground: PlanetStyle;
  readonly panelBorder: PlanetStyle;
  readonly panelText: PlanetStyle;
  readonly panelAccent: PlanetStyle;
  readonly panelWarn: PlanetStyle;
  readonly panelNoise: PlanetStyle;
  readonly overlayBorder: PlanetStyle;
  readonly overlayText: PlanetStyle;
  readonly overlayAccent: PlanetStyle;
  readonly overlayWarn: PlanetStyle;
};

export async function playPlanetAnimation(opts: {
  readonly animations: readonly PlanetAnimation[];
  readonly loop: boolean;
}): Promise<boolean> {
  if (!isTty()) {
    process.stderr.write("This command must be run in an interactive TTY.\n");
    return false;
  }

  const animations = opts.animations.filter((a) => a.frames.length > 0);
  if (animations.length === 0) {
    return true;
  }

  const size = readTerminalSize();
  const layout =
    size.cols !== null && size.rows !== null
      ? buildChafaLayout({ cols: size.cols, rows: size.rows })
      : null;
  if (layout) {
    return await playCompositedAnimations({
      animations,
      loop: opts.loop,
      layout,
    });
  }

  const ranChafa = await tryRunChafaAnimations({ animations, loop: opts.loop });
  if (ranChafa) {
    return true;
  }

  const lipgloss = await loadLipgloss();
  const prepared = animations.map((anim) => ({
    anim,
    metrics: computeFrameMetrics(anim.frames),
  }));

  const banner = lipgloss ? buildPlanetBanner(lipgloss) : null;
  const renderFrame = (opts: RenderFrameOptions) =>
    renderPlanetFrame({ ...opts, banner });

  const restore = enterAltScreen();
  const stop = installExitHandlers(restore);

  try {
    // Initial clear (reset styles first to avoid odd terminal state on entry).
    process.stdout.write("\x1b[0m\x1b[H\x1b[J");

    do {
      for (const { anim, metrics } of prepared) {
        const frameMs = Math.max(1, Math.round(1000 / anim.fps));
        for (const frame of anim.frames) {
          if (stop.shouldStop()) {
            break;
          }

          // Reset styles before clearing to avoid per-frame ANSI state leaking into the border.
          process.stdout.write("\x1b[0m\x1b[H\x1b[J");
          const size = readTerminalSize();
          process.stdout.write(
            renderFrame({
              frame,
              contentWidth: metrics.width,
              contentHeight: metrics.height,
              cols: size.cols ?? undefined,
              rows: size.rows ?? undefined,
            })
          );

          await sleep(frameMs);
        }
        if (stop.shouldStop()) {
          break;
        }
      }
    } while (opts.loop && !stop.shouldStop());
  } finally {
    stop.dispose();
    restore();
  }

  return true;
}

async function tryRunChafaAnimations(opts: {
  readonly animations: readonly PlanetAnimation[];
  readonly loop: boolean;
}): Promise<boolean> {
  const chafaPath = Bun.which("chafa");
  if (!chafaPath) {
    return false;
  }

  const size = readTerminalSize();
  const _layout: null = null;

  const entries = await resolveChafaEntries(opts.animations);
  if (!entries) {
    return false;
  }

  const restore = enterAltScreen();
  const stop = installStopSignal();
  try {
    process.stdout.write("\x1b[0m\x1b[H\x1b[J");

    const viewSize: null = null;

    const targetWidth = Math.max(20, Math.min(120, size.cols ?? 120));
    const targetHeight = Math.max(12, Math.min(32, size.rows ?? 32));

    const firstEntry = entries[0];
    if (!firstEntry) {
      return false;
    }

    if (opts.loop && entries.length === 1) {
      const ok = await runChafaOnce({
        chafaPath,
        entry: firstEntry,
        durationSeconds: null,
        shouldStop: stop.shouldStop,
        size: { cols: targetWidth, rows: targetHeight },
        viewSize,
        clear: true,
        align: "mid,mid",
        offsetRow: null,
        offsetCol: null,
      });
      return ok;
    }

    do {
      for (const entry of entries) {
        if (stop.shouldStop()) {
          return true;
        }
        const ok = await runChafaOnce({
          chafaPath,
          entry,
          durationSeconds: entry.durationSeconds,
          shouldStop: stop.shouldStop,
          size: { cols: targetWidth, rows: targetHeight },
          viewSize,
          clear: true,
          align: "mid,mid",
          offsetRow: null,
          offsetCol: null,
        });
        if (!ok) {
          return false;
        }
      }
    } while (opts.loop && !stop.shouldStop());
  } finally {
    stop.dispose();
    restore();
  }

  return true;
}

async function playCompositedAnimations(opts: {
  readonly animations: readonly PlanetAnimation[];
  readonly loop: boolean;
  readonly layout: ChafaLayout;
}): Promise<boolean> {
  const restore = enterAltScreen();
  const stop = installExitHandlers(restore);
  const seed = Math.floor(Math.random() * 100_000);
  const theme = buildPlanetTheme({ lipgloss: null });
  const videoBox = buildVideoBox({ layout: opts.layout });
  let tick = 0;

  try {
    process.stdout.write("\x1b[0m\x1b[H\x1b[J");
    do {
      for (const anim of opts.animations) {
        const frameMs = Math.max(1, Math.round(1000 / anim.fps));
        for (const frame of anim.frames) {
          if (stop.shouldStop()) {
            break;
          }
          const contentLines = fitFrameToArea({
            frame,
            width: videoBox.innerWidth,
            height: videoBox.innerHeight,
          });
          const panelLines = opts.layout.panel
            ? renderPanelFrame({
                tick,
                seed,
                panel: opts.layout.panel,
                theme,
              })
            : null;

          const screen = renderCompositedFrame({
            layout: opts.layout,
            theme,
            tick,
            contentLines,
            panelLines,
            videoBox,
          });
          process.stdout.write(`\x1b[H${screen}`);
          if (shouldShowOverlay(tick)) {
            const overlay = renderOverlayFrame({
              tick,
              layout: opts.layout,
              theme,
            });
            if (overlay) {
              writeOverlayFrame(overlay);
            }
          }
          await sleep(frameMs);
          tick += 1;
        }
        if (stop.shouldStop()) {
          break;
        }
      }
    } while (opts.loop && !stop.shouldStop());
  } finally {
    stop.dispose();
    restore();
  }

  return true;
}

type ChafaEntry = {
  readonly path: string;
  readonly fps: number;
  readonly durationSeconds: number;
};

async function resolveChafaEntries(
  animations: readonly PlanetAnimation[]
): Promise<readonly ChafaEntry[] | null> {
  const entries: ChafaEntry[] = [];
  for (const anim of animations) {
    const gifPath = await resolvePlanetGifPath(anim.name);
    if (!gifPath) {
      return null;
    }
    const fps = Number.isFinite(anim.fps) && anim.fps > 0 ? anim.fps : 20;
    const durationSeconds = Math.max(1, Math.round(anim.frames.length / fps));
    entries.push({ path: gifPath, fps, durationSeconds });
  }
  return entries;
}

async function resolvePlanetGifPath(name: string): Promise<string | null> {
  const file =
    name === "cut" ? "cut.gif" : name === "mash" ? "hacker-mash.gif" : null;
  if (!file) {
    return null;
  }

  const repoRoot = resolve(import.meta.dir, "..", "..", "/assets");
  const candidates = [resolve(repoRoot, file), resolve(process.cwd(), file)];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function runChafaOnce(opts: {
  readonly chafaPath: string;
  readonly entry: ChafaEntry;
  readonly durationSeconds: number | null;
  readonly shouldStop: () => boolean;
  readonly size: { readonly cols: number; readonly rows: number };
  readonly viewSize: { readonly cols: number; readonly rows: number } | null;
  readonly clear: boolean;
  readonly align: string;
  readonly offsetRow: number | null;
  readonly offsetCol: number | null;
}): Promise<boolean> {
  const cmd = [
    opts.chafaPath,
    opts.entry.path,
    "--format=symbols",
    "--animate=on",
    `--size=${opts.size.cols}x${opts.size.rows}`,
    "--symbols=all",
    "--colors=8",
    "--dither=none",
    "--preprocess=off",
    "--work=1",
    "--optimize=9",
    "--relative=on",
    `--align=${opts.align}`,
    ...(opts.clear ? ["--clear"] : []),
    "--speed",
    `${opts.entry.fps}fps`,
  ];

  if (opts.viewSize) {
    cmd.push(`--view-size=${opts.viewSize.cols}x${opts.viewSize.rows}`);
    cmd.push("--margin-bottom", "1");
  }

  if (opts.durationSeconds !== null) {
    cmd.push("--duration", String(opts.durationSeconds));
  }

  if (opts.offsetRow !== null && opts.offsetCol !== null) {
    process.stdout.write(`\x1b[${opts.offsetRow};${opts.offsetCol}H`);
  }

  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const stopInterval = setInterval(() => {
    if (opts.shouldStop()) {
      proc.kill();
    }
  }, 50);

  const exitCode = await proc.exited;
  clearInterval(stopInterval);
  return exitCode === 0 || opts.shouldStop();
}

type ChafaPanel = {
  readonly width: number;
  readonly height: number;
  readonly offsetCol: number;
  readonly startRow: number;
};

type ChafaChrome = {
  readonly cols: number;
  readonly rows: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly panel: ChafaPanel | null;
  readonly contentCols: number;
  readonly contentRows: number;
  readonly contentStartRow: number;
  readonly contentStartCol: number;
};

type ChafaLayout = ChafaChrome;

type VideoBox = {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
};

function buildChafaLayout(opts: {
  readonly cols: number;
  readonly rows: number;
}): ChafaLayout | null {
  if (opts.cols < 70 || opts.rows < 18) {
    return null;
  }

  const headerHeight = 1;
  const footerHeight = 1;
  const innerWidth = opts.cols - 2;
  const innerHeight = opts.rows - 2;
  const contentRows = innerHeight - headerHeight - footerHeight;
  if (contentRows < 10) {
    return null;
  }

  const gap = 2;
  const desiredPanelWidth = Math.min(
    34,
    Math.max(24, Math.floor(innerWidth * 0.26))
  );
  const panelWidth = innerWidth >= 90 ? desiredPanelWidth : 0;
  let contentCols = innerWidth;
  let panel: ChafaPanel | null = null;

  if (panelWidth > 0) {
    const remaining = innerWidth - panelWidth - gap;
    if (remaining >= 44) {
      contentCols = remaining;
      panel = {
        width: panelWidth,
        height: contentRows,
        offsetCol: 1 + 1 + contentCols + gap,
        startRow: 1 + headerHeight + 1,
      };
    }
  }

  return {
    cols: opts.cols,
    rows: opts.rows,
    innerWidth,
    innerHeight,
    panel,
    contentCols,
    contentRows,
    contentStartRow: 1 + headerHeight + 1,
    contentStartCol: 2,
  };
}

function buildVideoBox(opts: { readonly layout: ChafaLayout }): VideoBox {
  const topPad = 1;
  const sidePad = 2;
  const bottomPad = 2;
  const maxWidth = Math.max(10, opts.layout.contentCols - sidePad * 2);
  const maxHeight = Math.max(6, opts.layout.contentRows - topPad - bottomPad);
  const width = Math.min(
    maxWidth,
    Math.max(36, Math.floor(opts.layout.contentCols * 0.8))
  );
  const height = Math.min(
    maxHeight,
    Math.max(12, Math.floor(opts.layout.contentRows * 0.38))
  );
  const col = Math.max(0, Math.floor((opts.layout.contentCols - width) / 2));
  const row = Math.min(topPad, Math.max(0, opts.layout.contentRows - height));
  return {
    row,
    col,
    width,
    height,
    innerWidth: Math.max(1, width - 2),
    innerHeight: Math.max(1, height - 2),
  };
}

function buildPlanetTheme(_: {
  readonly lipgloss: LipglossModule | null;
}): PlanetTheme {
  return {
    border: makeAnsiStyle({ fg: "#46ffb4", bg: "#0a1511", bold: true }),
    title: makeAnsiStyle({ fg: "#bdfcf0", bg: "#0a1511", bold: true }),
    footer: makeAnsiStyle({ fg: "#7bd7c4", bg: "#0a1511" }),
    mainBackground: makeAnsiStyle({ fg: "#7bd7c4", bg: "#0b1114" }),
    videoBorder: makeAnsiStyle({ fg: "#52ffd9", bg: "#050a0b", bold: true }),
    videoBackground: makeAnsiStyle({ fg: "#dbe7e4", bg: "#050a0b" }),
    panelBorder: makeAnsiStyle({ fg: "#52ffd9", bg: "#06110d" }),
    panelText: makeAnsiStyle({ fg: "#bdfcf0", bg: "#06110d" }),
    panelAccent: makeAnsiStyle({ fg: "#ff6ad5", bg: "#06110d", bold: true }),
    panelWarn: makeAnsiStyle({ fg: "#ff7b7b", bg: "#06110d", bold: true }),
    panelNoise: makeAnsiStyle({ fg: "#37d6a4", bg: "#06110d" }),
    overlayBorder: makeAnsiStyle({ fg: "#52ffd9", bg: "#040b08", bold: true }),
    overlayText: makeAnsiStyle({ fg: "#bdfcf0", bg: "#040b08", bold: true }),
    overlayAccent: makeAnsiStyle({ fg: "#ff6ad5", bg: "#040b08", bold: true }),
    overlayWarn: makeAnsiStyle({ fg: "#ffd479", bg: "#040b08", bold: true }),
  };
}

function renderBorderedLine(opts: {
  readonly borderStyle: PlanetStyle;
  readonly contentStyle: PlanetStyle;
  readonly content: string;
  readonly innerWidth: number;
}): string {
  const padded = padToWidth(opts.content, opts.innerWidth);
  const borderOpen = opts.borderStyle.open;
  const contentOpen = opts.contentStyle.open;
  const close = opts.borderStyle.close || opts.contentStyle.close;

  if (!(borderOpen || contentOpen)) {
    return `│${padded}│`;
  }

  return `${borderOpen}│${contentOpen}${padded}${borderOpen}│${close}`;
}

function _renderChafaChrome(
  layout: ChafaLayout,
  theme: PlanetTheme,
  tick: number
): void {
  const chrome = buildChromeLines({ layout, theme, tick });

  process.stdout.write("\x1b[s");
  writeAt({ row: 1, col: 1, text: chrome.topLine });
  writeAt({ row: 2, col: 1, text: chrome.titleLine });
  writeAt({ row: layout.rows - 1, col: 1, text: chrome.tickerLine });
  writeAt({ row: layout.rows, col: 1, text: chrome.bottomLine });

  const { leftEdge, rightEdge } = chrome;
  for (let row = 2; row <= layout.rows - 1; row += 1) {
    writeAt({ row, col: 1, text: leftEdge });
    writeAt({ row, col: layout.cols, text: rightEdge });
  }

  process.stdout.write("\x1b[u");
}

function renderTickerLine(
  layout: ChafaLayout,
  theme: PlanetTheme,
  tick: number
): void {
  const tickerLine = buildChromeLines({ layout, theme, tick }).tickerLine;

  process.stdout.write("\x1b[s");
  writeAt({ row: layout.rows - 1, col: 1, text: tickerLine });
  process.stdout.write("\x1b[u");
}

function _startPanelTicker(opts: {
  readonly layout: ChafaLayout;
  readonly lipgloss: NonNullable<Awaited<ReturnType<typeof loadLipgloss>>>;
}): { readonly dispose: () => void } {
  const panel = opts.layout.panel;
  const seed = Math.floor(Math.random() * 100_000);
  let tick = 0;
  const theme = buildPlanetTheme({ lipgloss: opts.lipgloss });

  const timer = setInterval(() => {
    renderTickerLine(opts.layout, theme, tick);

    if (panel) {
      const frame = renderPanelFrame({
        tick,
        seed,
        panel,
        theme,
      });
      writePanelFrame(panel, frame);
    }

    tick += 1;
  }, 450);

  return {
    dispose: () => clearInterval(timer),
  };
}

function writePanelFrame(panel: ChafaPanel, lines: readonly string[]): void {
  for (let i = 0; i < lines.length; i += 1) {
    const row = panel.startRow + i;
    process.stdout.write(`\x1b[${row};${panel.offsetCol}H${lines[i]}`);
  }
}

function renderPanelFrame(opts: {
  readonly tick: number;
  readonly seed: number;
  readonly panel: ChafaPanel;
  readonly theme: PlanetTheme;
}): string[] {
  const innerWidth = Math.max(4, opts.panel.width - 2);
  const borderStyle = opts.theme.panelBorder;
  const textStyle = opts.theme.panelText;
  const accentStyle = opts.theme.panelAccent;
  const warnStyle = opts.theme.panelWarn;

  const rng = createRng(opts.seed + opts.tick * 97);
  const progress = (Math.sin(opts.tick / 4) + 1) / 2;
  const progress2 = (Math.sin(opts.tick / 6 + 1.4) + 1) / 2;
  const barWidth = Math.max(6, innerWidth - 12);
  const bar = buildProgressBar({ width: barWidth, value: progress });
  const bar2 = buildProgressBar({ width: barWidth, value: progress2 });
  const showPopup = opts.tick % 18 < 6;

  const connectionLines = [
    "CONNECTED",
    `IP: 172.16.55.${100 + Math.floor(rng() * 30)}`,
    "NODE: LOCALHOST",
    "UPLINK: ONLINE",
    `PING: ${Math.floor(18 + rng() * 12)}ms`,
  ];

  const uploadLines = [
    "UPLOADING VIRUS",
    `CHUNK ${Math.floor(rng() * 90 + 10)}/99`,
    `DATA ${bar}`,
    `VERIFY ${bar2}`,
    "SENDING...",
  ];

  const traceLines = Array.from({ length: 5 }, () => {
    const hex = randomHex(rng, Math.max(8, innerWidth - 6));
    return `> ${hex}`;
  });

  const boxes = [
    renderPanelBox({
      title: "CONNECTION",
      lines: connectionLines,
      innerWidth,
      borderStyle,
      textStyle,
      titleStyle: accentStyle,
    }),
    renderPanelBox({
      title: "UPLOAD",
      lines: uploadLines,
      innerWidth,
      borderStyle,
      textStyle,
      titleStyle: accentStyle,
    }),
    renderPanelBox({
      title: "TRACE",
      lines: traceLines,
      innerWidth,
      borderStyle,
      textStyle,
      titleStyle: accentStyle,
    }),
  ];

  if (showPopup) {
    boxes.splice(
      1,
      0,
      renderPanelBox({
        title: "ALERT",
        lines: ["LAUNCHING VIRUS", "TARGET: MAINFRAME", "STATUS: LIVE"],
        innerWidth,
        borderStyle,
        textStyle: warnStyle,
        titleStyle: warnStyle,
      })
    );
  }

  const out: string[] = [];
  for (const box of boxes) {
    out.push(...box, textStyle.render(` ${" ".repeat(innerWidth)} `));
  }

  const noiseStyle = opts.theme.panelNoise;
  while (out.length < opts.panel.height) {
    const noise = randomNoiseLine(rng, innerWidth);
    out.push(noiseStyle.render(` ${noise} `));
  }

  return out.slice(0, opts.panel.height);
}

function renderPanelBox(opts: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly innerWidth: number;
  readonly borderStyle: PlanetStyle;
  readonly textStyle: PlanetStyle;
  readonly titleStyle?: PlanetStyle;
}): string[] {
  const top = opts.borderStyle.render(`╭${"─".repeat(opts.innerWidth)}╮`);
  const titleStyle = opts.titleStyle ?? opts.textStyle;
  const title = renderBorderedLine({
    borderStyle: opts.borderStyle,
    contentStyle: titleStyle,
    content: centerLine(opts.title, opts.innerWidth),
    innerWidth: opts.innerWidth,
  });
  const rows = opts.lines.map((line) =>
    renderBorderedLine({
      borderStyle: opts.borderStyle,
      contentStyle: opts.textStyle,
      content: line,
      innerWidth: opts.innerWidth,
    })
  );
  const bottom = opts.borderStyle.render(`╰${"─".repeat(opts.innerWidth)}╯`);
  return [top, title, ...rows, bottom];
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xff_ff_ff_ff;
  };
}

function randomHex(rng: () => number, length: number): string {
  const chars = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(rng() * chars.length)];
  }
  return out;
}

function randomNoiseLine(rng: () => number, length: number): string {
  const glyphs = "01#*+/\\=-_:;.,";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += glyphs[Math.floor(rng() * glyphs.length)];
  }
  return out;
}

function buildTickerLine(opts: {
  readonly tick: number;
  readonly width: number;
  readonly prefix: string;
}): string {
  if (opts.width <= 0) {
    return "";
  }
  const spinner = ["|", "/", "-", "\\"];
  const pulse = spinner[opts.tick % spinner.length] ?? "|";
  const link = Math.floor(40 + (Math.sin(opts.tick / 4) + 1) * 30);
  const payload = `${opts.prefix}  ${pulse} LINK ${link}%  TRACE ${opts.tick % 9999}`;
  return padToWidth(payload, opts.width).slice(0, opts.width);
}

function writeAt(opts: {
  readonly row: number;
  readonly col: number;
  readonly text: string;
}): void {
  process.stdout.write(`\x1b[${opts.row};${opts.col}H${opts.text}`);
}

type OverlayFrame = {
  readonly row: number;
  readonly col: number;
  readonly lines: readonly string[];
};

function shouldShowOverlay(tick: number): boolean {
  return tick % 28 < 6;
}

function renderOverlayFrame(opts: {
  readonly tick: number;
  readonly layout: ChafaLayout;
  readonly theme: PlanetTheme;
}): OverlayFrame | null {
  const maxWidth = opts.layout.contentCols - 4;
  const maxHeight = opts.layout.contentRows - 4;
  if (maxWidth < 26 || maxHeight < 6) {
    return null;
  }

  const width = Math.min(52, maxWidth);
  const innerWidth = width - 2;

  const borderStyle = opts.theme.overlayBorder;
  const textStyle = opts.theme.overlayText;
  const accentStyle = opts.theme.overlayAccent;
  const warnStyle = opts.theme.overlayWarn;

  const progress = (Math.sin(opts.tick / 5) + 1) / 2;
  const bar = buildProgressBar({
    width: Math.max(10, innerWidth - 16),
    value: progress,
  });
  const titles = [
    "ACCESS GRANTED",
    "UPLINK STABLE",
    "LAUNCHING VIRUS",
    "TRACE ACTIVE",
  ];
  const title = titles[opts.tick % titles.length] ?? "ACCESS GRANTED";

  const body = [
    `REMOTE NODE: 10.45.100.${120 + (opts.tick % 80)}`,
    `SESSION KEY: ${randomHex(createRng(opts.tick + 91), 12)}`,
    `UPLOAD: ${bar}`,
    `STATUS: ${title.includes("VIRUS") ? "LIVE" : "ONLINE"}`,
  ];

  const top = borderStyle.render(`╔${"═".repeat(innerWidth)}╗`);
  const titleLine = renderBorderedLine({
    borderStyle,
    contentStyle: accentStyle,
    content: centerLine(title, innerWidth),
    innerWidth,
  });
  const rows = body.map((line, idx) => {
    const style = idx === 2 && title.includes("VIRUS") ? warnStyle : textStyle;
    return renderBorderedLine({
      borderStyle,
      contentStyle: style,
      content: line,
      innerWidth,
    });
  });
  const bottom = borderStyle.render(`╚${"═".repeat(innerWidth)}╝`);

  const lines = [top, titleLine, ...rows, bottom];
  if (lines.length > maxHeight) {
    return null;
  }

  const row =
    opts.layout.contentStartRow +
    Math.max(0, Math.floor((opts.layout.contentRows - lines.length) / 2));
  const col =
    opts.layout.contentStartCol +
    Math.max(0, Math.floor((opts.layout.contentCols - width) / 2));

  return { row, col, lines };
}

function writeOverlayFrame(frame: OverlayFrame): void {
  process.stdout.write("\x1b[s");
  for (let i = 0; i < frame.lines.length; i += 1) {
    const line = frame.lines[i] ?? "";
    writeAt({ row: frame.row + i, col: frame.col, text: line });
  }
  process.stdout.write("\x1b[u");
}

function buildChromeLines(opts: {
  readonly layout: ChafaLayout;
  readonly theme: PlanetTheme;
  readonly tick: number;
}): {
  readonly topLine: string;
  readonly titleLine: string;
  readonly tickerLine: string;
  readonly bottomLine: string;
  readonly leftEdge: string;
  readonly rightEdge: string;
} {
  const borderStyle = opts.theme.border;
  const titleStyle = opts.theme.title;
  const footerStyle = opts.theme.footer;

  const inner = opts.layout.innerWidth;
  const top = `╔${"═".repeat(inner)}╗`;
  const bottom = `╚${"═".repeat(inner)}╝`;
  const titleText = padToWidth(centerLine("HACK THE PLANET", inner), inner);
  const tickerText = buildTickerLine({
    tick: opts.tick,
    width: inner,
    prefix: "CTRL+C TO EXIT",
  });

  const topLine = borderStyle.render(top);
  const titleLine = renderBorderedLine({
    borderStyle,
    contentStyle: titleStyle,
    content: titleText,
    innerWidth: inner,
  });
  const tickerLine = renderBorderedLine({
    borderStyle,
    contentStyle: footerStyle,
    content: tickerText,
    innerWidth: inner,
  });
  const bottomLine = borderStyle.render(bottom);
  const leftEdge = borderStyle.render("║");
  const rightEdge = borderStyle.render("║");

  return { topLine, titleLine, tickerLine, bottomLine, leftEdge, rightEdge };
}

function renderCompositedFrame(opts: {
  readonly layout: ChafaLayout;
  readonly theme: PlanetTheme;
  readonly tick: number;
  readonly contentLines: readonly string[];
  readonly panelLines: readonly string[] | null;
  readonly videoBox: VideoBox;
}): string {
  const chrome = buildChromeLines({
    layout: opts.layout,
    theme: opts.theme,
    tick: opts.tick,
  });
  const lines: string[] = [];
  lines.push(chrome.topLine, chrome.titleLine);

  const reset = "\x1b[0m";
  const panel = opts.layout.panel;
  const gap = panel
    ? Math.max(0, panel.offsetCol - (opts.layout.contentCols + 2))
    : 0;
  const gapSpaces = gap > 0 ? " ".repeat(gap) : "";
  const mainFill = opts.theme.mainBackground.render(
    " ".repeat(opts.layout.contentCols)
  );
  const videoTop = opts.theme.videoBorder.render(
    `╔${"═".repeat(opts.videoBox.innerWidth)}╗`
  );
  const videoBottom = opts.theme.videoBorder.render(
    `╚${"═".repeat(opts.videoBox.innerWidth)}╝`
  );
  const videoSide = opts.theme.videoBorder.render("║");

  for (let row = 0; row < opts.layout.contentRows; row += 1) {
    let content = mainFill;
    if (
      row >= opts.videoBox.row &&
      row < opts.videoBox.row + opts.videoBox.height
    ) {
      const leftPad = " ".repeat(opts.videoBox.col);
      const rightPad = " ".repeat(
        opts.layout.contentCols - opts.videoBox.col - opts.videoBox.width
      );
      const left = opts.theme.mainBackground.render(leftPad);
      const right = opts.theme.mainBackground.render(rightPad);
      const inVideo = row - opts.videoBox.row;

      let videoLine = "";
      if (inVideo === 0) {
        videoLine = videoTop;
      } else if (inVideo === opts.videoBox.height - 1) {
        videoLine = videoBottom;
      } else {
        const frameLine =
          opts.contentLines[inVideo - 1] ??
          " ".repeat(opts.videoBox.innerWidth);
        const filled = opts.theme.videoBackground.render(
          padAnsiLine(frameLine, opts.videoBox.innerWidth)
        );
        videoLine = `${videoSide}${filled}${videoSide}`;
      }

      content = `${left}${videoLine}${right}${reset}`;
    }

    let inner = content;
    if (panel) {
      const panelLine = opts.panelLines?.[row] ?? " ".repeat(panel.width);
      inner = `${content}${reset}${gapSpaces}${panelLine}`;
    }
    lines.push(`${chrome.leftEdge}${inner}${reset}${chrome.rightEdge}`);
  }

  lines.push(chrome.tickerLine, chrome.bottomLine);
  return lines.join("\n");
}

function computeFrameMetrics(frames: readonly string[]): {
  readonly width: number;
  readonly height: number;
} {
  let width = 0;
  let height = 0;

  for (const frame of frames) {
    const lines = trimFinalNewline(frame).split("\n");
    if (lines.length > height) {
      height = lines.length;
    }
    for (const line of lines) {
      const w = visibleWidth(line);
      if (w > width) {
        width = w;
      }
    }
  }

  return { width, height };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function enterAltScreen(): () => void {
  // Alternate screen + hidden cursor, like `less`.
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  return () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
}

function installExitHandlers(restore: () => void): {
  readonly shouldStop: () => boolean;
  readonly dispose: () => void;
} {
  let stopping = false;

  const onSigInt = () => {
    stopping = true;
  };

  const onExit = () => {
    try {
      restore();
    } catch {
      // ignore
    }
  };

  process.once("SIGINT", onSigInt);
  process.once("exit", onExit);

  return {
    shouldStop: () => stopping,
    dispose: () => {
      process.off("SIGINT", onSigInt);
      process.off("exit", onExit);
    },
  };
}

function installStopSignal(): {
  readonly shouldStop: () => boolean;
  readonly dispose: () => void;
} {
  let stopping = false;

  const onSigInt = () => {
    stopping = true;
  };

  process.once("SIGINT", onSigInt);

  return {
    shouldStop: () => stopping,
    dispose: () => {
      process.off("SIGINT", onSigInt);
    },
  };
}

type RenderFrameOptions = {
  readonly frame: string;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly cols?: number;
  readonly rows?: number;
};

type PlanetBanner = {
  readonly title: string;
  readonly footer: string;
};

function buildPlanetBanner(
  lipgloss: NonNullable<Awaited<ReturnType<typeof loadLipgloss>>>
): PlanetBanner {
  const { Style, Color } = lipgloss;
  const title = new Style()
    .bold(true)
    .foreground(Color("#bdfcf0"))
    .background(Color("#0b1713"))
    .render("HACK THE PLANET");
  const footer = new Style()
    .foreground(Color("#7bd7c4"))
    .background(Color("#0b1411"))
    .render("CTRL+C TO EXIT");
  return { title, footer };
}

function renderPlanetFrame(
  opts: RenderFrameOptions & { readonly banner: PlanetBanner | null }
): string {
  const body = renderTvFrameLegacy(opts);
  if (!opts.banner) {
    return body;
  }

  const lines = splitLines(body);
  const width = measureLines(lines).width;
  const header = centerLine(opts.banner.title, width);
  const footer = centerLine(opts.banner.footer, width);
  return [header, body, footer].join("\n");
}

function renderTvFrameLegacy(opts: RenderFrameOptions): string {
  const reset = "\x1b[0m";
  const rawLines = trimFinalNewline(opts.frame).split("\n");
  const lines = padLinesToHeight({
    lines: rawLines,
    height: opts.contentHeight,
  });
  const contentWidth = opts.contentWidth;
  const contentHeight = opts.contentHeight;

  const cols =
    typeof opts.cols === "number" && opts.cols > 0 ? opts.cols : null;
  const rows =
    typeof opts.rows === "number" && opts.rows > 0 ? opts.rows : null;

  const desiredPadX = 4;
  const desiredPadY = 1;

  const maxPadX = cols
    ? Math.max(0, Math.floor((cols - contentWidth - 2) / 2))
    : desiredPadX;
  const maxPadY = rows
    ? Math.max(0, Math.floor((rows - contentHeight - 2) / 2))
    : desiredPadY;

  const padX = Math.min(desiredPadX, maxPadX);
  const padY = Math.min(desiredPadY, maxPadY);

  const innerWidth = contentWidth + padX * 2;
  const outerWidth = innerWidth + 2;
  const outerHeight = contentHeight + padY * 2 + 2;

  // If the terminal is too small to fit the border, just center the raw frame.
  if (
    (cols !== null && contentWidth > cols) ||
    (rows !== null && contentHeight > rows)
  ) {
    return centerRaw({
      lines,
      width: contentWidth,
      height: contentHeight,
      cols,
      rows,
    });
  }
  if (cols !== null && outerWidth > cols) {
    return centerRaw({
      lines,
      width: contentWidth,
      height: contentHeight,
      cols,
      rows,
    });
  }
  if (rows !== null && outerHeight > rows) {
    return centerRaw({
      lines,
      width: contentWidth,
      height: contentHeight,
      cols,
      rows,
    });
  }

  const leftMargin =
    cols !== null ? Math.max(0, Math.floor((cols - outerWidth) / 2)) : 0;
  const topMargin =
    rows !== null ? Math.max(0, Math.floor((rows - outerHeight) / 2)) : 0;

  const out: string[] = [];
  for (let i = 0; i < topMargin; i += 1) {
    out.push("");
  }

  const margin = leftMargin > 0 ? " ".repeat(leftMargin) : "";
  const h = "━".repeat(innerWidth);

  out.push(`${reset}${margin}╭${h}╮${reset}`);
  for (let i = 0; i < padY; i += 1) {
    out.push(`${reset}${margin}┃${" ".repeat(innerWidth)}┃${reset}`);
  }

  for (const line of lines) {
    const padRight = Math.max(0, contentWidth - visibleWidth(line));
    out.push(
      `${reset}${margin}┃${" ".repeat(padX)}${line}${reset}${" ".repeat(padRight)}${" ".repeat(padX)}┃${reset}`
    );
  }

  for (let i = 0; i < padY; i += 1) {
    out.push(`${reset}${margin}┃${" ".repeat(innerWidth)}┃${reset}`);
  }
  out.push(`${reset}${margin}╰${h}╯${reset}`);

  return out.join("\n");
}

function centerRaw(opts: {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly cols: number | null;
  readonly rows: number | null;
}): string {
  const reset = "\x1b[0m";
  const lines = padLinesToHeight({ lines: opts.lines, height: opts.height });
  const width = opts.width;
  const height = opts.height;

  const leftMargin =
    opts.cols !== null ? Math.max(0, Math.floor((opts.cols - width) / 2)) : 0;
  const topMargin =
    opts.rows !== null ? Math.max(0, Math.floor((opts.rows - height) / 2)) : 0;

  const out: string[] = [];
  for (let i = 0; i < topMargin; i += 1) {
    out.push("");
  }

  const margin = leftMargin > 0 ? " ".repeat(leftMargin) : "";
  for (const line of lines) {
    const padRight = Math.max(0, width - visibleWidth(line));
    out.push(`${reset}${margin}${line}${reset}${" ".repeat(padRight)}`);
  }
  return out.join("\n");
}

function trimFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function splitLines(text: string): string[] {
  return trimFinalNewline(text).split("\n");
}

function measureLines(lines: readonly string[]): {
  readonly width: number;
  readonly height: number;
} {
  let width = 0;
  for (const line of lines) {
    const w = visibleWidth(line);
    if (w > width) {
      width = w;
    }
  }
  return { width, height: lines.length };
}

function centerLine(text: string, width: number): string {
  const lineWidth = visibleWidth(text);
  if (lineWidth >= width) {
    return text;
  }
  const padLeft = Math.floor((width - lineWidth) / 2);
  const padRight = Math.max(0, width - lineWidth - padLeft);
  return `${" ".repeat(padLeft)}${text}${" ".repeat(padRight)}`;
}

function padToWidth(text: string, width: number): string {
  const lineWidth = visibleWidth(text);
  if (lineWidth >= width) {
    return text;
  }
  return `${text}${" ".repeat(width - lineWidth)}`;
}

function buildProgressBar(opts: {
  readonly width: number;
  readonly value: number;
}): string {
  const width = Math.max(1, opts.width);
  const clamped = Math.max(0, Math.min(1, opts.value));
  const filled = Math.min(width, Math.round(width * clamped));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function makeAnsiStyle(opts: {
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
}): PlanetStyle {
  const open = buildAnsiOpen(opts);
  const close = open.length > 0 ? "\x1b[0m" : "";
  return {
    open,
    close,
    render: (text: string) =>
      open.length > 0 ? `${open}${text}${close}` : text,
  };
}

function buildAnsiOpen(opts: {
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
}): string {
  const codes: string[] = [];
  if (opts.bold) {
    codes.push("1");
  }
  if (opts.fg) {
    const { r, g, b } = hexToRgb(opts.fg);
    codes.push(`38;2;${r};${g};${b}`);
  }
  if (opts.bg) {
    const { r, g, b } = hexToRgb(opts.bg);
    codes.push(`48;2;${r};${g};${b}`);
  }
  return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

function hexToRgb(hex: string): {
  readonly r: number;
  readonly g: number;
  readonly b: number;
} {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  if (normalized.length !== 6) {
    return { r: 255, g: 255, b: 255 };
  }
  const value = Number.parseInt(normalized, 16);
  if (Number.isNaN(value)) {
    return { r: 255, g: 255, b: 255 };
  }
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function fitFrameToArea(opts: {
  readonly frame: string;
  readonly width: number;
  readonly height: number;
}): readonly string[] {
  const rawLines = trimFinalNewline(opts.frame).split("\n");
  const frameHeight = rawLines.length;
  const frameWidth = Math.max(0, ...rawLines.map((line) => visibleWidth(line)));
  const targetWidth = Math.max(1, opts.width);
  const targetHeight = Math.max(1, opts.height);

  const cropTop =
    frameHeight > targetHeight
      ? Math.floor((frameHeight - targetHeight) / 2)
      : 0;
  const padTop =
    frameHeight < targetHeight
      ? Math.floor((targetHeight - frameHeight) / 2)
      : 0;
  const startCol =
    frameWidth > targetWidth ? Math.floor((frameWidth - targetWidth) / 2) : 0;
  const padLeft =
    frameWidth < targetWidth ? Math.floor((targetWidth - frameWidth) / 2) : 0;

  const out: string[] = [];
  for (let row = 0; row < targetHeight; row += 1) {
    const sourceIndex = row - padTop + cropTop;
    if (sourceIndex < 0 || sourceIndex >= frameHeight) {
      out.push(" ".repeat(targetWidth));
      continue;
    }
    const sourceLine = rawLines[sourceIndex] ?? "";
    if (frameWidth > targetWidth) {
      out.push(
        padAnsiLine(
          sliceAnsiLine(sourceLine, startCol, targetWidth),
          targetWidth
        )
      );
    } else {
      const padded = `${" ".repeat(padLeft)}${sourceLine}`;
      out.push(padAnsiLine(padded, targetWidth));
    }
  }

  return out;
}

function sliceAnsiLine(line: string, start: number, width: number): string {
  if (width <= 0) {
    return "";
  }
  let out = "";
  let visible = 0;
  let i = 0;

  while (i < line.length && visible < start + width) {
    const ch = line[i];
    if (ch === "\x1b") {
      const match = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }

    const codePoint = line.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const charWidth = wcwidth(codePoint);

    if (visible + charWidth > start && visible < start + width) {
      out += char;
    }

    visible += charWidth;
    i += char.length;
  }

  return out;
}

function padAnsiLine(line: string, width: number): string {
  const visible = visibleWidth(line);
  return visible >= width ? line : `${line}${" ".repeat(width - visible)}`;
}

function visibleWidth(text: string): number {
  return stringWidth(stripAnsi(text));
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function padLinesToHeight(opts: {
  readonly lines: readonly string[];
  readonly height: number;
}): readonly string[] {
  if (opts.lines.length === opts.height) {
    return opts.lines;
  }
  if (opts.lines.length > opts.height) {
    return opts.lines.slice(0, opts.height);
  }
  return [
    ...opts.lines,
    ...Array.from({ length: opts.height - opts.lines.length }, () => ""),
  ];
}

function stringWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    width += wcwidth(codePoint);
  }
  return width;
}

function wcwidth(codePoint: number): number {
  // Fast-path common ASCII.
  if (codePoint >= 0x20 && codePoint < 0x7f) {
    return 1;
  }

  // Control chars.
  if (codePoint === 0) {
    return 0;
  }
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (isCombining(codePoint)) {
    return 0;
  }
  if (isWide(codePoint)) {
    return 2;
  }
  return 1;
}

function isCombining(codePoint: number): boolean {
  return isInRanges(codePoint, COMBINING_RANGES);
}

function isWide(codePoint: number): boolean {
  // Includes CJK wide/fullwidth + common emoji blocks.
  return (
    isInRanges(codePoint, WIDE_RANGES) || isInRanges(codePoint, EMOJI_RANGES)
  );
}

function isInRanges(
  codePoint: number,
  ranges: readonly (readonly [number, number])[]
): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
}

const COMBINING_RANGES = [
  [0x03_00, 0x03_6f],
  [0x1a_b0, 0x1a_ff],
  [0x1d_c0, 0x1d_ff],
  [0x20_d0, 0x20_ff],
  [0xfe_20, 0xfe_2f],
] as const;

// Rough wcwidth wide table (covers what we need for chafa frames).
const WIDE_RANGES = [
  [0x11_00, 0x11_5f],
  [0x23_29, 0x23_2a],
  [0x2e_80, 0xa4_cf],
  [0xac_00, 0xd7_a3],
  [0xf9_00, 0xfa_ff],
  [0xfe_10, 0xfe_19],
  [0xfe_30, 0xfe_6f],
  [0xff_00, 0xff_60],
  [0xff_e0, 0xff_e6],
  [0x2_00_00, 0x2_ff_fd],
  [0x3_00_00, 0x3_ff_fd],
] as const;

const EMOJI_RANGES = [
  [0x1_f3_00, 0x1_f5_ff],
  [0x1_f6_00, 0x1_f6_4f],
  [0x1_f6_80, 0x1_f6_ff],
  [0x1_f7_00, 0x1_f7_7f],
  [0x1_f7_80, 0x1_f7_ff],
  [0x1_f8_00, 0x1_f8_ff],
  [0x1_f9_00, 0x1_f9_ff],
  [0x1_fa_00, 0x1_fa_ff],
] as const;

type TerminalSize = {
  readonly cols: number | null;
  readonly rows: number | null;
};

function readTerminalSize(): TerminalSize {
  const cols =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : null;
  const rows =
    typeof process.stdout.rows === "number" && process.stdout.rows > 0
      ? process.stdout.rows
      : null;
  if (cols !== null && rows !== null) {
    return { cols, rows };
  }

  const win = tryGetWindowSize();
  const env = tryGetEnvSize();

  return {
    cols: cols ?? win.cols ?? env.cols,
    rows: rows ?? win.rows ?? env.rows,
  };
}

function tryGetEnvSize(): TerminalSize {
  const cols = parsePositiveInt(process.env.COLUMNS);
  const rows = parsePositiveInt(process.env.LINES);
  return { cols, rows };
}

function parsePositiveInt(value: string | undefined): number | null {
  const v = (value ?? "").trim();
  if (v.length === 0) {
    return null;
  }
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

type WindowSized = { readonly getWindowSize: () => unknown };

function hasGetWindowSize(value: unknown): value is WindowSized {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return typeof rec.getWindowSize === "function";
}

function tryGetWindowSize(): TerminalSize {
  const stdout: unknown = process.stdout;
  if (!hasGetWindowSize(stdout)) {
    return { cols: null, rows: null };
  }
  const out = stdout.getWindowSize();
  if (!Array.isArray(out) || out.length < 2) {
    return { cols: null, rows: null };
  }
  const cols = typeof out[0] === "number" && out[0] > 0 ? out[0] : null;
  const rows = typeof out[1] === "number" && out[1] > 0 ? out[1] : null;
  return { cols, rows };
}
