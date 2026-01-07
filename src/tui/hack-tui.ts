import {
  BoxRenderable,
  InputRenderable,
  RGBA,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  TextRenderable,
  createTextAttributes,
  createCliRenderer,
  dim,
  fg,
  type TextChunk,
  type MouseEvent,
  t
} from "@opentui/core"

import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { resolveHackInvocation } from "../lib/hack-cli.ts"
import { renderHackBanner } from "../lib/hack-banner.ts"
import { readInternalExtraHostsIp, resolveGlobalCaddyIp } from "../lib/caddy-hosts.ts"
import { ensureDir, writeTextFile } from "../lib/fs.ts"
import { isRecord } from "../lib/guards.ts"
import { defaultProjectSlugFromPath, readProjectConfig, readProjectDevHost } from "../lib/project.ts"
import { readProjectsRegistry } from "../lib/projects-registry.ts"
import { readRuntimeProjects } from "../lib/runtime-projects.ts"
import { exec } from "../lib/shell.ts"
import { parseTimeInput } from "../lib/time.ts"
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts"
import { copyToClipboard } from "../ui/clipboard.ts"

import type { ProjectContext } from "../lib/project.ts"
import type { RuntimeProject, RuntimeService } from "../lib/runtime-projects.ts"
import type { LogStreamBackend, LogStreamEvent } from "../ui/log-stream.ts"

type HackTuiOptions = {
  readonly project: ProjectContext
}

type LogState = {
  readonly entries: LogEntry[]
  maxEntries: number
  maxLines: number
}

type LogEntry = {
  readonly service: string | null
  line: string
  styled: StyledText
  readonly timestamp?: string
  key: string
  readonly level: string
  messagePlain: string
  readonly prefixWidth: number
  readonly prefixPlain: string
  readonly prefixChunks: TextChunk[]
  messageChunks: TextChunk[]
}

type DockerStatsSample = {
  readonly cpuPercent: number | null
  readonly memUsedBytes: number | null
  readonly memLimitBytes: number | null
  readonly memPercent: number | null
  readonly netInputBytes: number | null
  readonly netOutputBytes: number | null
  readonly blockInputBytes: number | null
  readonly blockOutputBytes: number | null
  readonly pids: number | null
}

class WrappedTextRenderable extends TextRenderable {
  protected override onResize(width: number, height: number): void {
    super.onResize(width, height)
    if (this.wrapMode !== "none" && width > 0) {
      this.textBufferView.setWrapWidth(width)
    }
  }

  public syncWrapWidth(): void {
    const width = Math.floor(this.width)
    if (this.wrapMode !== "none" && width > 0) {
      this.textBufferView.setWrapWidth(width)
    }
  }
}

class PausableScrollBoxRenderable extends ScrollBoxRenderable {
  public onScrollChange: ((event: MouseEvent) => void) | null = null

  protected override onMouseEvent(event: MouseEvent): void {
    super.onMouseEvent(event)
    if (event.type === "scroll") {
      this.onScrollChange?.(event)
    }
  }
}

export async function runHackTui({ project }: HackTuiOptions): Promise<number> {
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  const errorLogPath = resolve(homedir(), ".hack", "tui-error.log")
  let errorHandled = false
  let shutdown: (() => Promise<void>) | null = null
  let logsHasSelection = false
  let handleSelectionChange: (() => void) | null = null

  const logTuiError = async (opts: { readonly error: unknown; readonly source: string }) => {
    const message = formatErrorMessage({ error: opts.error })
    const payload = [
      `[${new Date().toISOString()}] ${opts.source}`,
      message,
      ""
    ].join("\n")
    await ensureDir(dirname(errorLogPath))
    await writeTextFile(errorLogPath, payload)
  }

  const handleFatal = async (opts: { readonly error: unknown; readonly source: string }) => {
    if (errorHandled) return
    errorHandled = true
    await logTuiError(opts)
    if (shutdown) {
      await shutdown()
    } else {
      await shutdownRenderer({ renderer })
    }
    process.stderr.write(
      `Hack TUI failed: ${formatErrorMessage({ error: opts.error })}\nSee ${errorLogPath}\n`
    )
  }

  const onUncaughtException = (error: Error) => {
    void handleFatal({ error, source: "uncaughtException" })
  }

  const onUnhandledRejection = (reason: unknown) => {
    void handleFatal({ error: reason, source: "unhandledRejection" })
  }

  process.on("uncaughtException", onUncaughtException)
  process.on("unhandledRejection", onUnhandledRejection)

  try {
    const cfg = await readProjectConfig(project)
    const controlPlane = await readControlPlaneConfig({ projectDir: project.projectRoot })
    const tuiLogsConfig = controlPlane.config.tui.logs
    const logMaxEntries = Math.max(1, tuiLogsConfig.maxEntries)
    const logMaxLines = Math.min(Math.max(1, tuiLogsConfig.maxLines), logMaxEntries)
    const historyTailStep = Math.min(Math.max(1, tuiLogsConfig.historyTailStep), logMaxEntries)
    const projectName = (cfg.name ?? "").trim() || defaultProjectSlugFromPath(project.projectRoot)
    const devHost = await readProjectDevHost(project)
    const projectId = await resolveProjectId({ project, projectName })
    const headerBanner = await renderHackBanner({ trimEmpty: true, maxLines: 1 })
    const headerBannerLine = headerBanner.length > 0 ? headerBanner.trim() : ""
    const headerLabel =
      headerBannerLine.length > 0 && !/[█░▒▓]/.test(headerBannerLine) ? headerBannerLine : "hack"

    const activeRenderer = await createCliRenderer({
      targetFps: 30,
      exitOnCtrlC: false,
      useConsole: false,
      useAlternateScreen: true,
      useMouse: true
    })
    renderer = activeRenderer

    activeRenderer.setBackgroundColor("#0f111a")

    const headerPaddingX = 2
    const headerPaddingY = 1
    const headerLineCount = headerLabel ? 2 : 1
    const headerHeight = headerLineCount + headerPaddingY * 2

    const root = new BoxRenderable(activeRenderer, {
      id: "hack-tui-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#0f111a"
    })

    const header = new BoxRenderable(activeRenderer, {
      id: "hack-tui-header",
      width: "100%",
      height: headerHeight,
      minHeight: headerHeight,
      paddingLeft: headerPaddingX,
      paddingRight: headerPaddingX,
      paddingTop: headerPaddingY,
      paddingBottom: headerPaddingY,
      border: false,
      backgroundColor: "#141b2d"
    })

    const headerText = new TextRenderable(activeRenderer, {
      id: "hack-tui-header-text",
      content: "",
      wrapMode: "none",
      width: "100%",
      height: "100%"
    })

    header.add(headerText)

    const body = new BoxRenderable(activeRenderer, {
      id: "hack-tui-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      alignItems: "stretch",
      padding: 1,
      gap: 1,
      backgroundColor: "#0f111a"
    })

    const sidebar = new BoxRenderable(activeRenderer, {
      id: "hack-tui-sidebar",
      width: 36,
      flexDirection: "column",
      gap: 1,
      backgroundColor: "#0f111a"
    })

    const metaPaddingX = 1
    const metaPaddingY = 1
    const metaFullLineCount = 11
    const metaCompactLineCount = 8
    const metaFullHeight = metaFullLineCount + metaPaddingY * 2 + 2
    const metaCompactHeight = metaCompactLineCount + metaPaddingY * 2 + 2
    const metaBoxMinHeight = metaFullHeight

    const metaBox = new BoxRenderable(activeRenderer, {
      id: "hack-tui-meta",
      width: "100%",
      minHeight: metaBoxMinHeight,
      height: metaBoxMinHeight,
      flexGrow: 0,
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#111726",
      title: "Project",
      titleAlignment: "left",
      paddingLeft: metaPaddingX,
      paddingRight: metaPaddingX,
      paddingTop: metaPaddingY,
      paddingBottom: metaPaddingY
    })

    const metaText = new TextRenderable(activeRenderer, {
      id: "hack-tui-meta-text",
      content: "",
      width: "100%",
      height: "100%",
      wrapMode: "none"
    })

    metaBox.add(metaText)

    const resourcesPaddingX = 1
    const resourcesPaddingY = 1
    const resourcesLineCount = 6
    const resourcesBoxMinHeight = resourcesLineCount + resourcesPaddingY * 2 + 2

    const resourcesBox = new BoxRenderable(activeRenderer, {
      id: "hack-tui-resources",
      width: "100%",
      minHeight: resourcesBoxMinHeight,
      height: resourcesBoxMinHeight,
      flexGrow: 0,
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#111726",
      title: "Resources",
      titleAlignment: "left",
      paddingLeft: resourcesPaddingX,
      paddingRight: resourcesPaddingX,
      paddingTop: resourcesPaddingY,
      paddingBottom: resourcesPaddingY
    })

    const resourcesText = new TextRenderable(activeRenderer, {
      id: "hack-tui-resources-text",
      content: "",
      width: "100%",
      height: "100%",
      wrapMode: "none"
    })

    resourcesBox.add(resourcesText)

    const servicesBox = new BoxRenderable(activeRenderer, {
      id: "hack-tui-services",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#131829",
      title: "Services",
      titleAlignment: "left"
    })

    const servicesSelect = new SelectRenderable(activeRenderer, {
      id: "hack-tui-services-select",
      width: "100%",
      height: "100%",
      backgroundColor: "#131829",
      focusedBackgroundColor: "#131829",
      textColor: "#c7d0ff",
      focusedTextColor: "#c7d0ff",
      selectedBackgroundColor: "#1f2540",
      selectedTextColor: "#9ad7ff",
      descriptionColor: "#6b7390",
      selectedDescriptionColor: "#7ea0d6",
      showDescription: false,
      showScrollIndicator: false,
      wrapSelection: true,
      options: [{ name: "Loading services...", description: "" }]
    })

    servicesBox.add(servicesSelect)

    const logsBox = new BoxRenderable(activeRenderer, {
      id: "hack-tui-logs",
      flexGrow: 1,
      flexDirection: "column",
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#0f111a",
      title: "Logs (all)",
      titleAlignment: "left"
    })

    const logsScroll = new PausableScrollBoxRenderable(activeRenderer, {
      id: "hack-tui-logs-scroll",
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      rootOptions: {
        backgroundColor: "#0f111a"
      },
      wrapperOptions: {
        backgroundColor: "#0f111a"
      },
      viewportOptions: {
        backgroundColor: "#0f111a"
      },
      contentOptions: {
        backgroundColor: "#0f111a",
        minHeight: "100%"
      },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: "#3b4160",
          backgroundColor: "#151a2a"
        }
      }
    })

  const logsText = new WrappedTextRenderable(activeRenderer, {
    id: "hack-tui-logs-text",
    width: "100%",
    content: "Waiting for logs...",
    wrapMode: "char",
    selectionBg: "#2b3355",
    selectionFg: "#e6f1ff",
    selectable: true
  })

    logsScroll.add(logsText)
    logsBox.add(logsScroll)

    const footer = new BoxRenderable(activeRenderer, {
      id: "hack-tui-footer",
      width: "100%",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 2,
      border: false,
      backgroundColor: "#141828"
    })

    const footerText = new TextRenderable(activeRenderer, {
      id: "hack-tui-footer-text",
      content: ""
    })

    footer.add(footerText)

    const searchOverlay = new BoxRenderable(activeRenderer, {
      id: "hack-tui-search-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: "#0b0f1a",
      opacity: 1,
      zIndex: 1000,
      alignItems: "center",
      justifyContent: "center",
      visible: false,
      live: true,
      shouldFill: true
    })

  const searchFieldBorderColor = "#2f344a"
  const searchFieldFocusBorderColor = "#7dcfff"

  const wrapSearchField = (opts: {
    readonly id: string
    readonly child: BoxRenderable | InputRenderable | SelectRenderable
    readonly backgroundColor: string
  }) => {
    const frame = new BoxRenderable(activeRenderer, {
      id: opts.id,
      width: "100%",
      border: true,
      borderColor: searchFieldBorderColor,
      backgroundColor: opts.backgroundColor,
      padding: 1,
      shouldFill: true
    })
    frame.add(opts.child)
    return frame
  }

  const bindSearchFieldFocus = (opts: {
    readonly field: InputRenderable | SelectRenderable
    readonly frame: BoxRenderable
  }) => {
    opts.field.on(RenderableEvents.FOCUSED, () => {
      opts.frame.borderColor = searchFieldFocusBorderColor
      opts.frame.requestRender()
    })
    opts.field.on(RenderableEvents.BLURRED, () => {
      opts.frame.borderColor = searchFieldBorderColor
      opts.frame.requestRender()
    })
  }

  const searchPanel = new BoxRenderable(activeRenderer, {
    id: "hack-tui-search-panel",
    width: "80%",
    maxWidth: 120,
    border: true,
    borderColor: "#2f344a",
    backgroundColor: "#141828",
    padding: 1,
    flexDirection: "column",
    gap: 1,
    shouldFill: true
  })

  const searchTitle = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-title",
    content: t`${fg("#9ad7ff")("Search logs")}`
  })

  const searchHint = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-hint",
    content: t`${dim("Enter to search | Esc to cancel | Tab to move")}`
  })

  const searchRecentText = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-recent",
    content: t`${dim("Recent: none")}`
  })

  const searchQueryLabel = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-query-label",
    content: t`${dim("Query")}`
  })

  const searchQueryInput = new InputRenderable(activeRenderer, {
    id: "hack-tui-search-query-input",
    width: "100%",
    height: 1,
    backgroundColor: "#0f111a",
    focusedBackgroundColor: "#141c2a",
    textColor: "#c0caf5",
    focusedTextColor: "#c0caf5",
    placeholder: "text to search (plain text)",
    placeholderColor: "#5c637a"
  })

  const searchQueryField = wrapSearchField({
    id: "hack-tui-search-query-field",
    child: searchQueryInput,
    backgroundColor: "#0f111a"
  })

  const searchFiltersRow = new BoxRenderable(activeRenderer, {
    id: "hack-tui-search-filters",
    width: "100%",
    flexDirection: "row",
    gap: 2
  })

  const searchServiceColumn = new BoxRenderable(activeRenderer, {
    id: "hack-tui-search-service-column",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1
  })

  const searchServiceLabel = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-service-label",
    content: t`${dim("Service")}`
  })

  const searchServiceSelect = new SelectRenderable(activeRenderer, {
    id: "hack-tui-search-service-select",
    width: "100%",
    height: 5,
    backgroundColor: "#131829",
    focusedBackgroundColor: "#1b2440",
    textColor: "#c7d0ff",
    focusedTextColor: "#c7d0ff",
    selectedBackgroundColor: "#1f2540",
    selectedTextColor: "#9ad7ff",
    descriptionColor: "#6b7390",
    selectedDescriptionColor: "#7ea0d6",
    showDescription: false,
    showScrollIndicator: false,
    wrapSelection: true,
    options: [{ name: "All services", description: "", value: null }]
  })

  const searchServiceField = wrapSearchField({
    id: "hack-tui-search-service-field",
    child: searchServiceSelect,
    backgroundColor: "#131829"
  })

  const searchLevelColumn = new BoxRenderable(activeRenderer, {
    id: "hack-tui-search-level-column",
    width: 24,
    flexDirection: "column",
    gap: 1
  })

  const searchLevelLabel = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-level-label",
    content: t`${dim("Level")}`
  })

  const searchLevelSelect = new SelectRenderable(activeRenderer, {
    id: "hack-tui-search-level-select",
    width: "100%",
    height: 5,
    backgroundColor: "#131829",
    focusedBackgroundColor: "#1b2440",
    textColor: "#c7d0ff",
    focusedTextColor: "#c7d0ff",
    selectedBackgroundColor: "#1f2540",
    selectedTextColor: "#9ad7ff",
    descriptionColor: "#6b7390",
    selectedDescriptionColor: "#7ea0d6",
    showDescription: false,
    showScrollIndicator: false,
    wrapSelection: true,
    options: [
      { name: "All levels", description: "", value: "all" },
      { name: "Debug", description: "", value: "debug" },
      { name: "Info", description: "", value: "info" },
      { name: "Warn", description: "", value: "warn" },
      { name: "Error", description: "", value: "error" }
    ]
  })

  const searchLevelField = wrapSearchField({
    id: "hack-tui-search-level-field",
    child: searchLevelSelect,
    backgroundColor: "#131829"
  })

  const searchTimeRow = new BoxRenderable(activeRenderer, {
    id: "hack-tui-search-time-row",
    width: "100%",
    flexDirection: "row",
    gap: 2
  })

  const searchSinceColumn = new BoxRenderable(activeRenderer, {
    id: "hack-tui-search-since-column",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1
  })

  const searchSinceLabel = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-since-label",
    content: t`${dim("Since")}`
  })

  const searchSinceInput = new InputRenderable(activeRenderer, {
    id: "hack-tui-search-since-input",
    width: "100%",
    height: 1,
    backgroundColor: "#0f111a",
    focusedBackgroundColor: "#141c2a",
    textColor: "#c0caf5",
    focusedTextColor: "#c0caf5",
    placeholder: "e.g. 1h, 30m, 2024-01-01T12:00Z",
    placeholderColor: "#5c637a"
  })

  const searchSinceField = wrapSearchField({
    id: "hack-tui-search-since-field",
    child: searchSinceInput,
    backgroundColor: "#0f111a"
  })

  const searchUntilColumn = new BoxRenderable(activeRenderer, {
    id: "hack-tui-search-until-column",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1
  })

  const searchUntilLabel = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-until-label",
    content: t`${dim("Until")}`
  })

  const searchUntilInput = new InputRenderable(activeRenderer, {
    id: "hack-tui-search-until-input",
    width: "100%",
    height: 1,
    backgroundColor: "#0f111a",
    focusedBackgroundColor: "#141c2a",
    textColor: "#c0caf5",
    focusedTextColor: "#c0caf5",
    placeholder: "optional",
    placeholderColor: "#5c637a"
  })

  const searchUntilField = wrapSearchField({
    id: "hack-tui-search-until-field",
    child: searchUntilInput,
    backgroundColor: "#0f111a"
  })

  const searchStatusText = new TextRenderable(activeRenderer, {
    id: "hack-tui-search-status",
    content: t`${dim("Ready")}`
  })

  searchServiceColumn.add(searchServiceLabel)
  searchServiceColumn.add(searchServiceField)
  searchLevelColumn.add(searchLevelLabel)
  searchLevelColumn.add(searchLevelField)
  searchFiltersRow.add(searchServiceColumn)
  searchFiltersRow.add(searchLevelColumn)

  searchSinceColumn.add(searchSinceLabel)
  searchSinceColumn.add(searchSinceField)
  searchUntilColumn.add(searchUntilLabel)
  searchUntilColumn.add(searchUntilField)
  searchTimeRow.add(searchSinceColumn)
  searchTimeRow.add(searchUntilColumn)

  searchPanel.add(searchTitle)
  searchPanel.add(searchHint)
  searchPanel.add(searchRecentText)
  searchPanel.add(searchQueryLabel)
  searchPanel.add(searchQueryField)
  searchPanel.add(searchFiltersRow)
  searchPanel.add(searchTimeRow)
  searchPanel.add(searchStatusText)
  searchOverlay.add(searchPanel)

  sidebar.add(metaBox)
  sidebar.add(resourcesBox)
  sidebar.add(servicesBox)

  body.add(sidebar)
  body.add(logsBox)

  root.add(header)
  root.add(body)
  root.add(footer)
  activeRenderer.root.add(root)
  activeRenderer.root.add(searchOverlay)

  const logState: LogState = {
    entries: [],
    maxEntries: logMaxEntries,
    maxLines: logMaxLines
  }

  const paneBorderColor = "#4a5374"
  const paneFocusBorderColor = "#8ad3ff"

  let activePane: "services" | "logs" = "services"
  let lastMainPane: "services" | "logs" = "services"
  let logStartTimestamp: string | null = null
  let logBackend: LogStreamBackend | null = null

  const historyState = {
    loading: false,
    canLoadMore: true,
    tailSize: historyTailStep,
    tailStep: historyTailStep
  }

  let isActive = true
  let running = true
  let logProc: ReturnType<typeof Bun.spawn> | null = null
  let searchProc: ReturnType<typeof Bun.spawn> | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let logUpdateTimer: ReturnType<typeof setTimeout> | null = null
  let selectedService: string | null = null
  let currentRuntime: RuntimeProject | null = null
  let searchOverlayVisible = false
  let searchMode: "live" | "results" = "live"
  let searchResults: LogEntry[] = []
  let searchSelectedIndex = 0
  let searchQuery = ""
  let searchFocusIndex = 0
  let toastMessage: StyledText | null = null
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let statsSnapshot: DockerStatsSample | null = null
  let statsError: string | null = null
  let statsLoading = false
  let logLastTimestamp: string | null = null
  let lastSearchBackend: "local" | "loki" = "local"
  let highlightQuery = ""
  let highlightEnabled = false
  let logFollow = true
  let pendingLogCount = 0
  let lastScrollTop = 0
  let collapseMultiline = false
  const enabledLevels = new Set(["debug", "info", "warn", "error"])
  let serviceScope: "all" | "selected" = "selected"
  let lastSelectedService: string | null = null
  let metaVariant: "full" | "compact" = "full"
  const recentSearches: string[] = []
  let caddyIp: string | null = null
  let caddyMappedIp: string | null = null
  let caddyMismatch = false
  let lastCaddyCheckAt = 0
  const caddyCheckIntervalMs = 10_000

  const setMainViewVisible = (visible: boolean) => {
    root.visible = visible
    root.requestRender()
  }

  const joinStyledText = (opts: { readonly parts: StyledText[]; readonly separator?: string }) => {
    const separator = opts.separator ?? "  "
    const chunks: TextChunk[] = []
    opts.parts.forEach((part, idx) => {
      chunks.push(...part.chunks)
      if (idx < opts.parts.length - 1) {
        chunks.push({ __isChunk: true, text: separator })
      }
    })
    return new StyledText(chunks)
  }

  const truncateLine = (line: string, width: number): string => {
    if (width <= 0) return ""
    if (line.length <= width) return line
    if (width <= 3) return line.slice(0, width)
    return `${line.slice(0, width - 3)}...`
  }

  const setToast = (opts: { readonly message: StyledText; readonly durationMs?: number }) => {
    if (!isActive) return
    toastMessage = opts.message
    renderFooter()
    if (toastTimer) {
      clearTimeout(toastTimer)
    }
    const duration = opts.durationMs ?? 1800
    toastTimer = setTimeout(() => {
      toastMessage = null
      toastTimer = null
      renderFooter()
    }, duration)
  }

  const updateSearchRecent = () => {
    if (!isActive) return
    if (recentSearches.length === 0) {
      searchRecentText.content = t`${dim("Recent: none")}`
      return
    }
    const trimmed = recentSearches.map(item => truncateLine(item, 18))
    searchRecentText.content = t`${dim("Recent:")} ${fg("#9ad7ff")(trimmed.join(" · "))}`
  }

  const recordSearchQuery = (opts: { readonly query: string }) => {
    const cleaned = opts.query.trim()
    if (cleaned.length === 0) return
    const existingIndex = recentSearches.findIndex(
      item => item.toLowerCase() === cleaned.toLowerCase()
    )
    if (existingIndex >= 0) {
      recentSearches.splice(existingIndex, 1)
    }
    recentSearches.unshift(cleaned)
    if (recentSearches.length > 5) {
      recentSearches.length = 5
    }
    updateSearchRecent()
  }

  const renderLevelHint = (): StyledText => {
    const tokens: Array<{
      readonly level: string
      readonly label: string
      readonly key: string
      readonly color: string
    }> = [
      { level: "info", label: "I", key: "1", color: "#7dcfff" },
      { level: "warn", label: "W", key: "2", color: "#e0af68" },
      { level: "error", label: "E", key: "3", color: "#f7768e" },
      { level: "debug", label: "D", key: "4", color: "#6b7390" }
    ]
    const chunks: TextChunk[] = [dim("lvl: ")]
    tokens.forEach((token, idx) => {
      const enabled = enabledLevels.has(token.level)
      const label = `${token.key}${token.label}`
      chunks.push(enabled ? fg(token.color)(label) : dim(label))
      if (idx < tokens.length - 1) {
        chunks.push({ __isChunk: true, text: " " })
      }
    })
    chunks.push({ __isChunk: true, text: " " })
    chunks.push(dim("["))
    chunks.push(fg("#9ad7ff")("0"))
    chunks.push(dim("]"))
    chunks.push(dim("all"))
    return new StyledText(chunks)
  }

  const describeEnabledLevels = (): string => {
    const order = ["info", "warn", "error", "debug"] as const
    const enabled = order.filter(level => enabledLevels.has(level))
    if (enabled.length === 0) return "none"
    return enabled.join(", ")
  }

  const toggleLevelFilter = (opts: { readonly level: string }) => {
    if (enabledLevels.has(opts.level)) {
      enabledLevels.delete(opts.level)
    } else {
      enabledLevels.add(opts.level)
    }
    setToast({
      message: t`${fg("#9ad7ff")("Levels")} ${dim(describeEnabledLevels())}`,
      durationMs: 1600
    })
    updateLogsTitle()
    flushLogUpdate({ force: true })
    renderFooter()
  }

  const resetLevelFilters = () => {
    enabledLevels.clear()
    enabledLevels.add("debug")
    enabledLevels.add("info")
    enabledLevels.add("warn")
    enabledLevels.add("error")
    setToast({
      message: t`${fg("#9ad7ff")("Levels")} ${dim("all")}`,
      durationMs: 1400
    })
    updateLogsTitle()
    flushLogUpdate({ force: true })
    renderFooter()
  }

  const toggleServiceScope = () => {
    if (serviceScope === "all") {
      serviceScope = "selected"
      if (!selectedService && lastSelectedService) {
        selectedService = lastSelectedService
        renderServices(currentRuntime)
      }
    } else {
      serviceScope = "all"
    }
    setToast({
      message:
        serviceScope === "all" ? t`${fg("#9ad7ff")("Scope")} ${dim("all services")}`
        : t`${fg("#9ad7ff")("Scope")} ${dim("selected service")}`,
      durationMs: 1400
    })
    updateLogsTitle()
    flushLogUpdate({ force: true })
    renderFooter()
    void refreshStats({ runtime: currentRuntime })
  }

  const toggleCollapse = () => {
    collapseMultiline = !collapseMultiline
    setToast({
      message:
        collapseMultiline ? t`${fg("#9ece6a")("Collapsed")} ${dim("multiline")}`
        : t`${fg("#9ad7ff")("Expanded")} ${dim("multiline")}`,
      durationMs: 1400
    })
    flushLogUpdate({ force: true })
    renderFooter()
  }

  const toggleHighlight = () => {
    if (!highlightEnabled) {
      if (highlightQuery.trim().length === 0) {
        setToast({ message: t`${fg("#e0af68")("No highlight query")}`, durationMs: 1600 })
        return
      }
      highlightEnabled = true
      setToast({
        message: t`${fg("#9ece6a")("Highlight on")}`,
        durationMs: 1200
      })
    } else {
      highlightEnabled = false
      setToast({
        message: t`${fg("#9ad7ff")("Highlight off")}`,
        durationMs: 1200
      })
    }
    flushLogUpdate({ force: true })
    renderFooter()
  }

  const clearSearchState = (opts: { readonly notify: boolean }) => {
    const hadQuery = highlightQuery.trim().length > 0 || searchQuery.trim().length > 0
    searchMode = "live"
    searchResults = []
    searchSelectedIndex = 0
    searchQuery = ""
    highlightQuery = ""
    highlightEnabled = false
    logsScroll.stickyScroll = logFollow
    updateLogsTitle()
    flushLogUpdate({ force: true })
    renderFooter()
    if (opts.notify && hadQuery) {
      setToast({ message: t`${fg("#9ad7ff")("Search cleared")}`, durationMs: 1400 })
    }
  }

  const filterLocalSearchEntries = (opts: {
    readonly query: string
    readonly level: string
    readonly service: string | null
    readonly since: string
    readonly until: string
  }): LogEntry[] => {
    const query = normalizeSearchText(opts.query.trim())
    const sinceTime = opts.since.trim().length > 0 ? parseTimeInput(opts.since) : null
    const untilTime = opts.until.trim().length > 0 ? parseTimeInput(opts.until) : null
    const sinceMs = sinceTime ? sinceTime.getTime() : null
    const untilMs = untilTime ? untilTime.getTime() : null

    return logState.entries.filter(entry => {
      if (opts.service && entry.service !== opts.service) return false
      if (opts.level !== "all" && entry.level !== opts.level) return false
      if (sinceMs !== null || untilMs !== null) {
        if (!entry.timestamp) return false
        const tsMs = Date.parse(entry.timestamp)
        if (!Number.isFinite(tsMs)) return false
        if (sinceMs !== null && tsMs < sinceMs) return false
        if (untilMs !== null && tsMs > untilMs) return false
      }
      if (query.length === 0) return true
      const haystack = [
        entry.line,
        entry.messagePlain,
        entry.service ?? ""
      ]
        .map(normalizeSearchText)
        .join(" ")
      return haystack.includes(query)
    })
  }

  const renderFooter = () => {
    const focusLabel =
      searchOverlayVisible ? "Search"
      : searchMode === "results" ? "Results"
      : activePane === "services" ? "Services"
      : "Logs"
    const focusHint = t`${dim("focus:")} ${fg("#9ad7ff")(focusLabel)}`
    const toastHint = toastMessage
    const copyHint = logsHasSelection ? t`${dim("[")}${fg("#9ad7ff")("c")}${dim("]")} copy` : null
    const resultsQuery =
      searchMode === "results" && searchQuery.trim().length > 0 ? searchQuery.trim() : null
    const highlightActive = highlightEnabled && highlightQuery.trim().length > 0
    const highlightValue = highlightActive ? highlightQuery.trim() : null
    const queryIndicator =
      resultsQuery ?
        t`${dim("search:")} ${fg("#9ad7ff")(truncateLine(resultsQuery, 18))}`
      : highlightValue ?
        t`${dim("hl:")} ${fg("#9ad7ff")(truncateLine(highlightValue, 18))}`
      : null
    const clearHint =
      resultsQuery || highlightValue ? t`${dim("[")}${fg("#9ad7ff")("x")}${dim("]")} clear` : null

    if (searchOverlayVisible) {
      const navHint = t`${dim("[")}${fg("#9ad7ff")("tab")}${dim("]")} next field  ${dim(
        "["
      )}${fg("#9ad7ff")("shift+tab")}${dim("]")} prev`
      const actions = t`${dim("[")}${fg("#9ad7ff")("enter")}${dim("]")} search  ${dim("[")}${fg(
        "#9ad7ff"
      )("esc")}${dim("]")} close  ${dim("[")}${fg("#9ad7ff")(
        "ctrl+c"
      )}${dim("]")} close`
      const parts = [navHint, actions, focusHint]
      if (toastHint) parts.push(toastHint)
      footerText.content = joinStyledText({ parts })
      return
    }

    if (searchMode === "results") {
      const navHint = t`${dim("[")}${fg("#9ad7ff")("↑/↓")}${dim("]")} select result  ${dim(
        "["
      )}${fg("#9ad7ff")("enter")}${dim("]")} jump`
      const actions = t`${dim("[")}${fg("#9ad7ff")("esc")}${dim("]")} back  ${dim("[")}${fg(
        "#9ad7ff"
      )("ctrl+f")}${dim("]")} new search`
      const parts = [navHint, actions, focusHint]
      if (queryIndicator) parts.push(queryIndicator)
      if (clearHint) parts.push(clearHint)
      if (copyHint) parts.push(copyHint)
      if (toastHint) parts.push(toastHint)
      footerText.content = joinStyledText({ parts })
      return
    }

    const navHint =
      activePane === "services" ?
        t`${dim("[")}${fg("#9ad7ff")("↑/↓")}${dim("]")} select service`
      : t`${dim("[")}${fg("#9ad7ff")("↑/↓")}${dim("]")} ${dim(
          logFollow ? "scroll logs" : "scroll logs (paused)"
        )}`
    const switchTarget = activePane === "services" ? "logs" : "services"
    const actions = t`${dim("[")}${fg("#9ad7ff")("tab")}${dim("]")} focus ${fg("#9ad7ff")(
      switchTarget
    )}  ${dim("[")}${fg("#9ad7ff")("ctrl+f")}${dim("]")} find  ${dim("[")}${fg("#9ad7ff")(
      "o"
    )}${dim("]")} open  ${dim("[")}${fg("#9ad7ff")("u")}${dim("]")} up  ${dim("[")}${fg(
      "#9ad7ff"
    )("d")}${dim("]")} down  ${dim("[")}${fg("#9ad7ff")("r")}${dim(
      "]"
    )} restart  ${dim("[")}${fg("#9ad7ff")("q")}${dim("]")} quit`
    const scopeLabel = serviceScope === "all" ? "all" : "sel"
    const scopeHint = t`${dim("scope:")} ${fg("#9ad7ff")(scopeLabel)}`
    const toggleHint = t`${dim("[")}${fg("#9ad7ff")("s")}${dim("]")} scope  ${dim("[")}${fg(
      "#9ad7ff"
    )("z")}${dim("]")} wrap  ${dim("[")}${fg("#9ad7ff")("h")}${dim("]")} hl`
    const followHint =
      !logFollow && activePane === "logs" ? t`${dim("[")}${fg("#9ad7ff")("f")}${dim("]")} follow` : null
    const parts = [navHint, actions, renderLevelHint(), scopeHint, toggleHint, focusHint]
    if (queryIndicator) parts.push(queryIndicator)
    if (clearHint) parts.push(clearHint)
    if (copyHint) parts.push(copyHint)
    if (followHint) parts.push(followHint)
    if (toastHint) parts.push(toastHint)
    footerText.content = joinStyledText({ parts })
  }

  const setActivePane = (pane: "services" | "logs") => {
    if (activePane === pane && !searchOverlayVisible) {
      renderHeader()
      renderMetaPanel({ runtime: currentRuntime })
      renderFooter()
      return
    }
    activePane = pane
    servicesBox.borderColor = pane === "services" ? paneFocusBorderColor : paneBorderColor
    logsBox.borderColor = pane === "logs" ? paneFocusBorderColor : paneBorderColor
    renderHeader()
    renderMetaPanel({ runtime: currentRuntime })
    renderFooter()
    if (pane === "services") {
      servicesSelect.focus()
    } else {
      logsScroll.focus()
    }
  }

  const formatPanelLine = (opts: {
    readonly label: string
    readonly value: string
    readonly color: string
    readonly width: number
  }): StyledText => {
    const label = `${opts.label}: `
    const valueWidth = Math.max(0, opts.width - label.length)
    const value = truncateLine(opts.value, valueWidth)
    return t`${dim(label)}${fg(opts.color)(value)}`
  }

  const renderHeader = () => {
    if (!isActive) return
    const headerWidth = Math.max(0, Math.floor(header.width || activeRenderer.width || 0))
    const maxLineWidth = Math.max(0, headerWidth - headerPaddingX * 2)
    const bannerLine = headerLabel.length > 0 ? truncateLine(headerLabel, maxLineWidth) : ""
    const projectLine = truncateLine(projectName, maxLineWidth)
    headerText.content =
      bannerLine.length > 0 ?
        t`${fg("#9ad7ff")(bannerLine)}\n${dim("Project")} ${fg("#c0caf5")(projectLine)}`
      : t`${fg("#c0caf5")(projectLine)}`
  }

  const renderMetaPanel = (opts: { readonly runtime: RuntimeProject | null }) => {
    if (!isActive) return
    const runtime = opts.runtime
    const serviceCount = runtime ? runtime.services.size : 0
    const runningCount = runtime ? countRunningServices(runtime) : 0
    const hostLabel = devHost ? devHost : "n/a"
    const focusLabel = activePane === "services" ? "Services" : "Logs"
    const historyLabel = logStartTimestamp ?
        formatDurationShort({ ms: Date.now() - Date.parse(logStartTimestamp) })
      : "n/a"
    const lagLabel = logLastTimestamp ?
        formatDurationShort({ ms: Date.now() - Date.parse(logLastTimestamp) })
      : "n/a"
    const logsBackendLabel = logBackend ?? "unknown"
    const searchBackendLabel = lastSearchBackend
    const status =
      !runtime ? { label: "Offline", color: "#6b7390" }
      : serviceCount === 0 ? { label: "Idle", color: "#6b7390" }
      : runningCount === 0 ? { label: "Stopped", color: "#e0af68" }
      : runningCount < serviceCount ? { label: "Partial", color: "#e0af68" }
      : { label: "Running", color: "#9ece6a" }
    const metaWidth = Math.max(
      0,
      Math.floor(metaBox.width || sidebar.width || activeRenderer.width || 0)
    )
    const lineWidth = Math.max(0, metaWidth - metaPaddingX * 2 - 2)
    const caddyValue =
      !caddyIp ? "n/a"
      : caddyMappedIp && caddyMismatch ? `${caddyIp} (stale ${caddyMappedIp})`
      : !caddyMappedIp ? `${caddyIp} (unmapped)`
      : caddyIp
    const caddyColor =
      !caddyIp ? "#6b7390"
      : caddyMismatch || !caddyMappedIp ? "#e0af68"
      : "#9ece6a"
    const caddyLine = formatPanelLine({
      label: "Caddy IP",
      value: caddyValue,
      color: caddyColor,
      width: lineWidth
    })
    const baseLines = [
      formatPanelLine({
        label: "Status",
        value: status.label,
        color: status.color,
        width: lineWidth
      }),
      formatPanelLine({
        label: "Project",
        value: projectName,
        color: "#c0caf5",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Project ID",
        value: projectId ?? "n/a",
        color: "#7dcfff",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Host",
        value: hostLabel,
        color: "#c0caf5",
        width: lineWidth
      }),
      caddyLine,
      formatPanelLine({
        label: "Services",
        value: `${runningCount}/${serviceCount}`,
        color: "#9ad7ff",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Logs",
        value: logsBackendLabel,
        color: "#c0caf5",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Search",
        value: searchBackendLabel,
        color: "#7dcfff",
        width: lineWidth
      })
    ]
    const fullLines = [
      ...baseLines.slice(0, 3),
      formatPanelLine({
        label: "Host",
        value: hostLabel,
        color: "#c0caf5",
        width: lineWidth
      }),
      caddyLine,
      formatPanelLine({
        label: "Services",
        value: `${runningCount}/${serviceCount}`,
        color: "#9ad7ff",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Focus",
        value: focusLabel,
        color: "#9ad7ff",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Logs",
        value: logsBackendLabel,
        color: "#c0caf5",
        width: lineWidth
      }),
      formatPanelLine({
        label: "History",
        value: historyLabel,
        color: "#c0caf5",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Lag",
        value: lagLabel,
        color: "#c0caf5",
        width: lineWidth
      }),
      formatPanelLine({
        label: "Search",
        value: searchBackendLabel,
        color: "#7dcfff",
        width: lineWidth
      })
    ]
    const lines = metaVariant === "compact" ? baseLines : fullLines
    metaText.content = joinStyledText({ parts: lines, separator: "\n" })
  }

  const refreshCaddyStatus = async () => {
    if (!isActive) return
    const now = Date.now()
    if (now - lastCaddyCheckAt < caddyCheckIntervalMs) return
    lastCaddyCheckAt = now

    const nextCaddyIp = await resolveGlobalCaddyIp()
    const nextMappedIp = await readInternalExtraHostsIp({ projectDir: project.projectDir })
    const nextMismatch =
      typeof nextCaddyIp === "string" &&
      typeof nextMappedIp === "string" &&
      nextCaddyIp.length > 0 &&
      nextMappedIp.length > 0 &&
      nextCaddyIp !== nextMappedIp

    const changed =
      nextCaddyIp !== caddyIp ||
      nextMappedIp !== caddyMappedIp ||
      nextMismatch !== caddyMismatch

    caddyIp = nextCaddyIp
    caddyMappedIp = nextMappedIp
    caddyMismatch = nextMismatch

    if (changed) {
      renderMetaPanel({ runtime: currentRuntime })
    }
  }

  const renderResourcesPanel = (opts: { readonly targetLabel: string }) => {
    if (!isActive) return
    const resourcesWidth = Math.max(
      0,
      Math.floor(resourcesBox.width || sidebar.width || activeRenderer.width || 0)
    )
    const lineWidth = Math.max(0, resourcesWidth - resourcesPaddingX * 2 - 2)
    const targetLine = formatPanelLine({
      label: "Target",
      value: opts.targetLabel,
      color: "#c0caf5",
      width: lineWidth
    })

    if (statsLoading && !statsSnapshot) {
      resourcesText.content = joinStyledText({
        parts: [targetLine, t`${dim("Loading stats...")}`],
        separator: "\n"
      })
      return
    }

    if (statsError) {
      resourcesText.content = joinStyledText({
        parts: [targetLine, t`${fg("#e0af68")("Stats unavailable")}`],
        separator: "\n"
      })
      return
    }

    if (!statsSnapshot) {
      resourcesText.content = joinStyledText({
        parts: [targetLine, t`${dim("No containers")}`],
        separator: "\n"
      })
      return
    }

    const cpuLabel =
      statsSnapshot.cpuPercent !== null ? `${statsSnapshot.cpuPercent.toFixed(1)}%` : "n/a"
    const memLabel =
      statsSnapshot.memUsedBytes !== null && statsSnapshot.memLimitBytes !== null ?
        `${formatBytes({ bytes: statsSnapshot.memUsedBytes })} / ${formatBytes({ bytes: statsSnapshot.memLimitBytes })} (${formatPercent({ percent: statsSnapshot.memPercent })})`
      : "n/a"
    const netLabel =
      statsSnapshot.netInputBytes !== null && statsSnapshot.netOutputBytes !== null ?
        `${formatBytes({ bytes: statsSnapshot.netInputBytes })} in / ${formatBytes({ bytes: statsSnapshot.netOutputBytes })} out`
      : "n/a"
    const blockLabel =
      statsSnapshot.blockInputBytes !== null && statsSnapshot.blockOutputBytes !== null ?
        `${formatBytes({ bytes: statsSnapshot.blockInputBytes })} in / ${formatBytes({ bytes: statsSnapshot.blockOutputBytes })} out`
      : "n/a"
    const pidsLabel = statsSnapshot.pids !== null ? String(statsSnapshot.pids) : "n/a"

    const lines = [
      targetLine,
      formatPanelLine({ label: "CPU", value: cpuLabel, color: "#9ad7ff", width: lineWidth }),
      formatPanelLine({ label: "Memory", value: memLabel, color: "#c0caf5", width: lineWidth }),
      formatPanelLine({ label: "Net", value: netLabel, color: "#7dcfff", width: lineWidth }),
      formatPanelLine({ label: "Block", value: blockLabel, color: "#7dcfff", width: lineWidth }),
      formatPanelLine({ label: "PIDs", value: pidsLabel, color: "#c0caf5", width: lineWidth })
    ]

    resourcesText.content = joinStyledText({ parts: lines, separator: "\n" })
  }

  const layoutSidebar = () => {
    if (!isActive) return
    const sidebarHeight = Math.floor(sidebar.height || 0)
    if (sidebarHeight <= 0) return
    const gapSize = 1
    let showResources = true
    let metaHeight = metaFullHeight
    let servicesMinHeight = 6

    let gapCount = showResources ? 2 : 1
    let needed =
      metaHeight + (showResources ? resourcesBoxMinHeight : 0) + servicesMinHeight + gapCount * gapSize

    if (sidebarHeight < needed) {
      showResources = false
      gapCount = 1
      needed = metaHeight + servicesMinHeight + gapCount * gapSize
    }

    if (sidebarHeight < needed) {
      metaHeight = metaCompactHeight
      needed = metaHeight + servicesMinHeight + gapCount * gapSize
    }

    if (sidebarHeight < needed) {
      servicesMinHeight = Math.max(3, sidebarHeight - metaHeight - gapCount * gapSize)
    }

    const nextVariant = metaHeight === metaCompactHeight ? "compact" : "full"
    if (metaVariant !== nextVariant) {
      metaVariant = nextVariant
      renderMetaPanel({ runtime: currentRuntime })
    }

    if (resourcesBox.visible !== showResources) {
      resourcesBox.visible = showResources
    }
    resourcesBox.height = showResources ? resourcesBoxMinHeight : 0
    resourcesBox.minHeight = showResources ? resourcesBoxMinHeight : 0
    metaBox.height = metaHeight
    metaBox.minHeight = metaHeight
    servicesBox.minHeight = servicesMinHeight
    sidebar.requestRender()
  }

  sidebar.onSizeChange = () => {
    layoutSidebar()
  }

  const renderServices = (runtime: RuntimeProject | null) => {
    if (!isActive) return
    if (!runtime || runtime.services.size === 0) {
      servicesSelect.options = [{ name: "No running services.", description: "" }]
      selectedService = null
      updateLogsTitle()
      return
    }

    const services = [...runtime.services.values()]
      .sort((a, b) => a.service.localeCompare(b.service))
      .map(service => {
        const total = service.containers.length
        const runningCount = service.containers.filter(c => c.state === "running").length
        const state = runningCount > 0 ? "running" : "stopped"
        return {
          name: `${service.service.padEnd(14)} ${state.padEnd(7)} ${runningCount}/${total}`,
          description: "",
          value: service.service
        }
      })

    const options = [{ name: "All services", description: "", value: null }, ...services]
    const selectedValue = selectedService ?? null
    servicesSelect.options = options
    const idx = options.findIndex(option => option.value === selectedValue)
    servicesSelect.setSelectedIndex(idx >= 0 ? idx : 0)
  }

  const renderSearchServices = (opts: { readonly runtime: RuntimeProject | null }) => {
    if (!isActive) return
    const runtime = opts.runtime
    if (!runtime || runtime.services.size === 0) {
      searchServiceSelect.options = [{ name: "All services", description: "", value: null }]
      return
    }

    const services = [...runtime.services.values()]
      .sort((a, b) => a.service.localeCompare(b.service))
      .map(service => ({ name: service.service, description: "", value: service.service }))

    const options = [{ name: "All services", description: "", value: null }, ...services]
    const selectedValue = searchServiceSelect.getSelectedOption()?.value ?? null
    searchServiceSelect.options = options
    const idx = options.findIndex(option => option.value === selectedValue)
    searchServiceSelect.setSelectedIndex(idx >= 0 ? idx : 0)
  }

  const resolveTargetContainers = (opts: {
    readonly runtime: RuntimeProject | null
    readonly serviceScope: "all" | "selected"
    readonly selectedService: string | null
  }): readonly string[] => {
    if (!opts.runtime) return []
    const containers: string[] = []
    const addContainers = (service: RuntimeService) => {
      for (const container of service.containers) {
        if (container.id) containers.push(container.id)
      }
    }
    if (opts.serviceScope === "all" || !opts.selectedService) {
      for (const service of opts.runtime.services.values()) {
        addContainers(service)
      }
      return containers
    }
    const service = opts.runtime.services.get(opts.selectedService) ?? null
    if (service) addContainers(service)
    return containers
  }

  const refreshStats = async (opts: { readonly runtime: RuntimeProject | null }) => {
    if (statsLoading) return
    statsLoading = true
    statsError = null

    const targetContainers = resolveTargetContainers({
      runtime: opts.runtime,
      serviceScope,
      selectedService
    })
    const targetLabel =
      serviceScope === "all" || !selectedService ? "All services" : selectedService
    renderResourcesPanel({ targetLabel })

    if (targetContainers.length === 0) {
      statsSnapshot = null
      statsLoading = false
      renderResourcesPanel({ targetLabel })
      return
    }

    const result = await exec(
      ["docker", "stats", "--no-stream", "--format", "{{json .}}", ...targetContainers],
      { stdin: "ignore" }
    )

    if (result.exitCode !== 0) {
      statsError = result.stderr.trim() || "stats failed"
      statsSnapshot = null
      statsLoading = false
      renderResourcesPanel({ targetLabel })
      return
    }

    const samples = parseDockerStatsOutput({ output: result.stdout })
    if (samples.length === 0) {
      statsError = "stats parse failed"
      statsSnapshot = null
      statsLoading = false
      renderResourcesPanel({ targetLabel })
      return
    }

    statsSnapshot = aggregateDockerStats({ samples })
    statsLoading = false
    renderResourcesPanel({ targetLabel })
  }

  const updateLogLastTimestamp = (entry: LogEntry) => {
    if (!entry.timestamp) return
    if (!logLastTimestamp || entry.timestamp > logLastTimestamp) {
      logLastTimestamp = entry.timestamp
      renderMetaPanel({ runtime: currentRuntime })
    }
  }

  const updateLogsTitle = () => {
    if (!isActive) return
    if (searchMode === "results") {
      logsBox.title = `Search results (${searchResults.length})`
      return
    }
    const base =
      serviceScope === "all" || !selectedService ? "Logs (all)" : `Logs (${selectedService})`
    const loadingSuffix = historyState.loading ? " • loading history" : ""
    const pausedSuffix =
      !logFollow ?
        pendingLogCount > 0 ? ` • paused (+${pendingLogCount})` : " • paused"
      : ""
    logsBox.title = base + loadingSuffix + pausedSuffix
  }

  const isScrollAtBottom = () => {
    const viewportHeight = Math.max(0, Math.floor(logsScroll.viewport.height || 0))
    const maxScrollTop = Math.max(0, logsScroll.scrollHeight - viewportHeight)
    if (maxScrollTop <= 1) return true
    return logsScroll.scrollTop >= maxScrollTop - 1
  }

  const pauseLogFollow = () => {
    if (!logFollow) return
    logFollow = false
    pendingLogCount = 0
    logsScroll.stickyScroll = false
    if (logUpdateTimer) {
      clearTimeout(logUpdateTimer)
      logUpdateTimer = null
    }
    updateLogsTitle()
    renderFooter()
  }

  const resumeLogFollow = () => {
    if (logFollow) return
    logFollow = true
    pendingLogCount = 0
    logsScroll.stickyScroll = true
    flushLogUpdate({ force: true })
    logsScroll.scrollTop = logsScroll.scrollHeight
    lastScrollTop = logsScroll.scrollTop
    updateLogsTitle()
    renderFooter()
  }

  logsScroll.onScrollChange = event => {
    if (!isActive || searchOverlayVisible || searchMode === "results") return
    if (event.type === "scroll" && logFollow) {
      pauseLogFollow()
    }
    lastScrollTop = logsScroll.scrollTop
  }

  const updateLogText = (opts?: { readonly force?: boolean }) => {
    if (!isActive) return
    const baseEntries = searchMode === "results" ? searchResults : logState.entries
    let activeEntries = baseEntries

    if (searchMode !== "results") {
      if (serviceScope === "selected" && selectedService) {
        activeEntries = activeEntries.filter(entry => entry.service === selectedService)
      }
      if (enabledLevels.size === 0) {
        logsText.content = "No levels selected."
        if (handleSelectionChange) handleSelectionChange()
        return
      }
      activeEntries = activeEntries.filter(entry => enabledLevels.has(entry.level))
    }

    if (searchMode === "live" && !logFollow && !opts?.force) {
      if (handleSelectionChange) handleSelectionChange()
      return
    }
    const visible = activeEntries.slice(-logState.maxLines)

    if (visible.length === 0) {
      logsText.content =
        searchMode === "results" ? "No search results."
        : enabledLevels.size < 4 || (serviceScope === "selected" && selectedService) ?
          "No logs match current filters."
        : "Waiting for logs..."
      if (handleSelectionChange) handleSelectionChange()
      return
    }

    const visibleOffset = Math.max(0, activeEntries.length - visible.length)
    const selectedIndex =
      searchMode === "results" ? searchSelectedIndex - visibleOffset : null
    const selectedLineIndex =
      selectedIndex !== null && selectedIndex >= 0 && selectedIndex < visible.length ?
        selectedIndex
      : null
    const highlightValue =
      searchMode === "results" ? searchQuery : highlightEnabled ? highlightQuery : null
    logsText.content = buildStyledLogText(visible, {
      highlightQuery: highlightValue,
      selectedIndex: selectedLineIndex,
      collapseMultiline
    })
    logsText.syncWrapWidth()
    if (handleSelectionChange) handleSelectionChange()
  }

  const scheduleLogUpdate = () => {
    if (!isActive || logUpdateTimer || searchOverlayVisible) return
    if (searchMode === "live" && !logFollow) return
    logUpdateTimer = setTimeout(() => {
      logUpdateTimer = null
      updateLogText()
    }, 80)
  }

  const flushLogUpdate = (opts?: { readonly force?: boolean }) => {
    if (searchOverlayVisible) return
    if (logUpdateTimer) {
      clearTimeout(logUpdateTimer)
      logUpdateTimer = null
    }
    updateLogText({ force: opts?.force === true })
  }

  const mergeLogEntry = (opts: { readonly target: LogEntry; readonly entry: LogEntry }) => {
    opts.target.messagePlain = `${opts.target.messagePlain}\n${opts.entry.messagePlain}`
    const continuationChunks = buildContinuationLineChunks({ prev: opts.target, entry: opts.entry })
    opts.target.messageChunks = [
      ...opts.target.messageChunks,
      { __isChunk: true, text: "\n" },
      ...continuationChunks
    ]
    opts.target.styled = new StyledText([
      ...opts.target.prefixChunks,
      ...opts.target.messageChunks
    ])
    opts.target.line = `${opts.target.prefixPlain}${opts.target.messagePlain}`
    opts.target.key = buildEntryKey({
      service: opts.target.service ?? null,
      timestamp: opts.target.timestamp ?? null,
      line: opts.target.line
    })
  }

  const findContinuationTarget = (opts: {
    readonly entries: readonly LogEntry[]
    readonly entry: LogEntry
  }): LogEntry | null => {
    if (!opts.entry.service || !opts.entry.timestamp) return null
    for (let i = opts.entries.length - 1; i >= 0; i -= 1) {
      const candidate = opts.entries[i]
      if (!candidate?.service || !candidate.timestamp) continue
      if (!shouldCollapseLogPrefix({ prev: candidate, next: opts.entry })) continue
      return candidate
    }
    return null
  }

  const appendLogEntry = (entry: LogEntry) => {
    if (!isActive) return
    updateLogLastTimestamp(entry)
    const holdUpdates = searchMode === "live" && !logFollow
    const continuationTarget = findContinuationTarget({ entries: logState.entries, entry })
    if (continuationTarget) {
      mergeLogEntry({ target: continuationTarget, entry })
      if (holdUpdates) {
        pendingLogCount += 1
        if (logsScroll.scrollTop !== lastScrollTop) {
          logsScroll.scrollTop = lastScrollTop
        }
        updateLogsTitle()
        return
      }
      scheduleLogUpdate()
      return
    }
    logState.entries.push(entry)
    let trimmed = false
    if (logState.entries.length > logState.maxEntries) {
      logState.entries.splice(0, logState.entries.length - logState.maxEntries)
      trimmed = true
    }
    if (entry.timestamp && (!logStartTimestamp || entry.timestamp < logStartTimestamp)) {
      logStartTimestamp = entry.timestamp
      renderHeader()
      renderMetaPanel({ runtime: currentRuntime })
    }
    if (trimmed) {
      updateLogStartTimestamp()
    }
    if (holdUpdates) {
      pendingLogCount += 1
      if (logsScroll.scrollTop !== lastScrollTop) {
        logsScroll.scrollTop = lastScrollTop
      }
      updateLogsTitle()
      return
    }
    scheduleLogUpdate()
  }

  const copySelectedLogs = async () => {
    const selected = logsText.getSelectedText()
    if (!selected) return
    const result = await copyToClipboard({ text: selected })
    setToast({
      message:
        result.ok ? t`${fg("#9ece6a")("Copied")} ${dim("to clipboard")}`
        : t`${fg("#e0af68")("Copy failed")}`,
      durationMs: result.ok ? 1600 : 2400
    })
    appendLogEntry(
      formatSystemLine({
        message: result.ok ? "[copy] selection copied" : `[copy] ${result.error}`,
        tone: result.ok ? "muted" : "warn"
      })
    )
  }

  const mergeHistoryEntries = (snapshot: LogEntry[]) => {
    const seen = new Set<string>()
    const merged: LogEntry[] = []
    const addEntry = (entry: LogEntry) => {
      if (seen.has(entry.key)) return
      seen.add(entry.key)
      merged.push(entry)
    }
    snapshot.forEach(addEntry)
    logState.entries.forEach(addEntry)
    logState.entries.splice(0, logState.entries.length, ...merged)
    if (logState.entries.length > logState.maxEntries) {
      logState.entries.splice(0, logState.entries.length - logState.maxEntries)
    }
    updateLogStartTimestamp()
  }

  const updateLogStartTimestamp = () => {
    let earliest: string | null = null
    for (const entry of logState.entries) {
      if (!entry.timestamp) continue
      if (!earliest || entry.timestamp < earliest) {
        earliest = entry.timestamp
      }
    }
    if (earliest !== logStartTimestamp) {
      logStartTimestamp = earliest
      renderHeader()
      renderMetaPanel({ runtime: currentRuntime })
    }
  }

  const fetchLogSnapshot = async (opts: {
    readonly tail: number
    readonly until?: string | null
    readonly backend: LogStreamBackend | null
  }): Promise<LogEntry[]> => {
    const invocation = await resolveHackInvocation()
    const args = [
      ...invocation.args,
      "logs",
      "--json",
      "--no-follow",
      "--tail",
      String(opts.tail),
      "--path",
      project.projectRoot
    ]
    if (opts.backend === "loki") args.push("--loki")
    if (opts.backend === "compose") args.push("--compose")
    if (opts.until) args.push("--until", opts.until)

    const proc = Bun.spawn([invocation.bin, ...args], {
      cwd: resolve(project.projectRoot),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore"
    })

    const entries: LogEntry[] = []

    const stdout = proc.stdout
    if (stdout && typeof stdout !== "number") {
      await consumeLogStream({
        stream: stdout,
        isActive: () => isActive,
        onLine: line => {
          const event = parseLogStreamEvent(line)
          if (!event || event.type !== "log" || !event.entry) return
          if (!logBackend) {
            logBackend = event.backend ?? event.entry.source
            renderMetaPanel({ runtime: currentRuntime })
          }
          const formatted = formatLogEntry(event)
          if (formatted) entries.push(formatted)
        }
      })
    }

    const stderr = proc.stderr
    if (stderr && typeof stderr !== "number") {
      void consumeLogStream({
        stream: stderr,
        isActive: () => isActive,
        onLine: line => {
          appendLogEntry(formatSystemLine({ message: `[history] ${line}`, tone: "warn" }))
        }
      })
    }

    await proc.exited
    return entries
  }

  const loadMoreHistory = async () => {
    if (!isActive || historyState.loading || !historyState.canLoadMore) return
    const remainingCapacity = logState.maxEntries - logState.entries.length
    if (remainingCapacity <= 0) {
      historyState.canLoadMore = false
      setToast({
        message: t`${fg("#9ad7ff")("Logs")} ${dim("history capped; increase controlPlane.tui.logs.maxEntries to load more")}`,
        durationMs: 2200
      })
      return
    }
    historyState.loading = true
    logsBox.title = "Logs (loading history...)"
    logsBox.requestRender()

    try {
      if (logBackend === "loki") {
        const tail = Math.min(historyState.tailStep, remainingCapacity)
        if (tail <= 0) {
          historyState.canLoadMore = false
          return
        }
        const snapshot = await fetchLogSnapshot({
          tail,
          until: logStartTimestamp,
          backend: "loki"
        })
        if (snapshot.length === 0) {
          historyState.canLoadMore = false
        } else {
          mergeHistoryEntries(snapshot)
        }
      } else {
        const nextTail = Math.min(historyState.tailSize + historyState.tailStep, logState.maxEntries)
        if (nextTail <= historyState.tailSize) {
          historyState.canLoadMore = false
          return
        }
        historyState.tailSize = nextTail
        const snapshot = await fetchLogSnapshot({
          tail: historyState.tailSize,
          backend: logBackend ?? "compose"
        })
        if (snapshot.length < historyState.tailSize) {
          historyState.canLoadMore = false
        }
        mergeHistoryEntries(snapshot)
      }
      if (logState.entries.length >= logState.maxEntries) {
        historyState.canLoadMore = false
      }
    } finally {
      historyState.loading = false
      updateLogsTitle()
      flushLogUpdate({ force: true })
    }
  }

  logsScroll.verticalScrollBar.on("change", payload => {
    if (!isActive || searchOverlayVisible || searchMode === "results") return
    const position = typeof payload?.position === "number" ? payload.position : logsScroll.scrollTop
    const movedUp = position < lastScrollTop - 1
    const atBottom = isScrollAtBottom()
    if (movedUp && logFollow) {
      pauseLogFollow()
    } else if (atBottom && !logFollow) {
      resumeLogFollow()
    }
    lastScrollTop = position
    if (position <= 1) {
      void loadMoreHistory()
    }
  })

  const refreshRuntime = async () => {
    if (!isActive) return
    const runtime = await resolveRuntimeProject({ project, projectName })
    if (!isActive) return
    currentRuntime = runtime
    renderHeader()
    renderMetaPanel({ runtime })
    renderServices(runtime)
    renderSearchServices({ runtime })
    layoutSidebar()
    void refreshStats({ runtime })
    void refreshCaddyStatus()
  }

  bindSearchFieldFocus({ field: searchQueryInput, frame: searchQueryField })
  bindSearchFieldFocus({ field: searchServiceSelect, frame: searchServiceField })
  bindSearchFieldFocus({ field: searchLevelSelect, frame: searchLevelField })
  bindSearchFieldFocus({ field: searchSinceInput, frame: searchSinceField })
  bindSearchFieldFocus({ field: searchUntilInput, frame: searchUntilField })

  const searchFocusables = [
    searchQueryInput,
    searchServiceSelect,
    searchLevelSelect,
    searchSinceInput,
    searchUntilInput
  ]

  const setSearchStatus = (opts: {
    readonly message: string
    readonly tone?: "muted" | "warn" | "info"
  }) => {
    const tone = opts.tone ?? "muted"
    searchStatusText.content =
      tone === "warn" ? t`${fg("#e0af68")(`${opts.message}`)}`
      : tone === "info" ? t`${fg("#7dcfff")(`${opts.message}`)}`
      : t`${dim(opts.message)}`
  }

  const focusSearchField = (opts: { readonly index: number }) => {
    const total = searchFocusables.length
    if (total === 0) return
    const wrappedIndex = ((opts.index % total) + total) % total
    searchFocusIndex = wrappedIndex
    searchFocusables[wrappedIndex]?.focus()
  }

  const openSearchOverlay = () => {
    if (!isActive) return
    searchOverlayVisible = true
    searchOverlay.visible = true
    searchOverlay.requestRender()
    lastMainPane = activePane
    setMainViewVisible(false)
    renderFooter()
    setSearchStatus({ message: "Ready" })
    updateSearchRecent()
    if (selectedService) {
      const idx = searchServiceSelect.options.findIndex(option => option.value === selectedService)
      searchServiceSelect.setSelectedIndex(idx >= 0 ? idx : 0)
    }
    focusSearchField({ index: 0 })
  }

  const closeSearchOverlay = () => {
    searchOverlayVisible = false
    searchOverlay.visible = false
    setMainViewVisible(true)
    setActivePane(lastMainPane)
    flushLogUpdate({ force: true })
  }

  const cancelSearchProc = () => {
    if (searchProc && searchProc.exitCode === null) {
      searchProc.kill()
    }
    searchProc = null
  }

  const runSearch = async () => {
    const query = searchQueryInput.value.trim()
    const service = searchServiceSelect.getSelectedOption()?.value ?? null
    const level = searchLevelSelect.getSelectedOption()?.value ?? "all"
    const since = searchSinceInput.value.trim()
    const until = searchUntilInput.value.trim()

    recordSearchQuery({ query })
    cancelSearchProc()
    closeSearchOverlay()
    searchMode = "live"
    searchResults = []
    searchSelectedIndex = 0
    updateLogsTitle()
    setSearchStatus({ message: "Searching...", tone: "info" })

    const searchBackend = logBackend ?? "compose"
    if (searchBackend !== "loki") {
      lastSearchBackend = "local"
      highlightQuery = query
      highlightEnabled = query.length > 0
      renderMetaPanel({ runtime: currentRuntime })
      const entries = filterLocalSearchEntries({
        query,
        level,
        service,
        since,
        until
      })
      setSearchStatus({
        message: `Found ${entries.length} matches (of ${logState.entries.length})`,
        tone: "info"
      })
      searchResults = entries
      searchSelectedIndex = 0
      searchQuery = query
      searchMode = "results"
      logsScroll.stickyScroll = false
      setActivePane("logs")
      updateLogsTitle()
      flushLogUpdate({ force: true })
      return
    }

    const invocation = await resolveHackInvocation()
    const args = [
      ...invocation.args,
      "logs",
      "--json",
      "--loki",
      "--no-follow",
      "--tail",
      "800",
      "--path",
      project.projectRoot
    ]
    if (service) {
      args.push("--services", service)
    }
    const sinceArg = since.length > 0 ? since : logStartTimestamp ?? ""
    if (sinceArg.length > 0) {
      args.push("--since", sinceArg)
    }
    if (until.length > 0) {
      args.push("--until", until)
    }

    searchProc = Bun.spawn([invocation.bin, ...args], {
      cwd: resolve(project.projectRoot),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore"
    })

    const entries: LogEntry[] = []
    const errors: string[] = []

    const searchStderr = searchProc.stderr
    if (searchStderr && typeof searchStderr !== "number") {
      void consumeLogStream({
        stream: searchStderr,
        isActive: () => isActive,
        onLine: line => {
          errors.push(line)
        }
      })
    }

    const searchStdout = searchProc.stdout
    if (searchStdout && typeof searchStdout !== "number") {
      await consumeLogStream({
        stream: searchStdout,
        isActive: () => isActive,
        onLine: line => {
          const event = parseLogStreamEvent(line)
          if (!event || event.type !== "log" || !event.entry) return
          const formatted = formatLogEntry(event)
          if (!formatted) return
          if (!matchesSearchQuery({ entry: event.entry, query, level })) return
          const continuationTarget = findContinuationTarget({ entries, entry: formatted })
          if (continuationTarget) {
            mergeLogEntry({ target: continuationTarget, entry: formatted })
          } else {
            entries.push(formatted)
          }
        }
      })
    }

    await searchProc.exited
    searchProc = null

    if (errors.length > 0) {
      lastSearchBackend = "loki"
      renderMetaPanel({ runtime: currentRuntime })
      setSearchStatus({ message: errors.slice(-2).join("\n"), tone: "warn" })
      appendLogEntry(
        formatSystemLine({
          message: `[search] ${errors[errors.length - 1] ?? "Search failed"}`,
          tone: "warn"
        })
      )
      searchMode = "live"
      logsScroll.stickyScroll = logFollow
      updateLogsTitle()
      flushLogUpdate({ force: true })
      renderFooter()
      return
    }

    lastSearchBackend = "loki"
    highlightQuery = query
    highlightEnabled = query.length > 0
    renderMetaPanel({ runtime: currentRuntime })
    setSearchStatus({ message: `Found ${entries.length} matches`, tone: "info" })
    searchResults = entries
    searchSelectedIndex = 0
    searchQuery = query
    searchMode = "results"
    logsScroll.stickyScroll = false
    setActivePane("logs")
    updateLogsTitle()
    flushLogUpdate({ force: true })
  }

  const startLogStream = async () => {
    const invocation = await resolveHackInvocation()
    const args = [
      ...invocation.args,
      "logs",
      "--json",
      "--follow",
      "--path",
      project.projectRoot
    ]
    logProc = Bun.spawn([invocation.bin, ...args], {
      cwd: resolve(project.projectRoot),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore"
    })

    const logStderr = logProc.stderr
    if (logStderr && typeof logStderr !== "number") {
      void consumeLogStream({
        stream: logStderr,
        isActive: () => isActive,
        onLine: line => {
          appendLogEntry(formatSystemLine({ message: `[stderr] ${line}`, tone: "warn" }))
        }
      })
    }

    const logStdout = logProc.stdout
    if (logStdout && typeof logStdout !== "number") {
      void consumeLogStream({
        stream: logStdout,
        isActive: () => isActive,
        onLine: line => {
          const event = parseLogStreamEvent(line)
          if (!event || event.type !== "log" || !event.entry) return
          if (!logBackend) {
            logBackend = event.backend ?? event.entry.source
          }
          const formatted = formatLogEntry(event)
          if (formatted) appendLogEntry(formatted)
        }
      })
    }

    void logProc.exited.then(exitCode => {
      if (!isActive) return
      appendLogEntry(
        formatSystemLine({ message: `[logs] stream ended (code ${exitCode})`, tone: "muted" })
      )
    })
  }

  shutdown = async () => {
    if (!running) return
    running = false
    isActive = false

    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }

    if (logUpdateTimer) {
      clearTimeout(logUpdateTimer)
      logUpdateTimer = null
    }
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }

    if (logProc && logProc.exitCode === null) {
      logProc.kill()
    }
    if (searchProc && searchProc.exitCode === null) {
      searchProc.kill()
    }

    if (handleSelectionChange) {
      activeRenderer.off("selection", handleSelectionChange)
    }
    activeRenderer.stop()
    activeRenderer.destroy()

    process.off("SIGINT", handleSignal)
    process.off("SIGTERM", handleSignal)
  }

  const handleSignal = () => {
    if (searchOverlayVisible) {
      closeSearchOverlay()
      return
    }
    void shutdown?.()
  }

  process.on("SIGINT", handleSignal)
  process.on("SIGTERM", handleSignal)

  const runAction = async (opts: {
    readonly label: string
    readonly args: readonly string[]
  }) => {
    appendLogEntry(
      formatSystemLine({ message: `[action] ${opts.label} requested`, tone: "muted" })
    )
    const invocation = await resolveHackInvocation()
    const cmd = [...invocation.args, ...opts.args, "--path", project.projectRoot]
    const proc = Bun.spawn([invocation.bin, ...cmd], {
      cwd: resolve(project.projectRoot),
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore"
    })

    const actionStderr = proc.stderr
    if (actionStderr && typeof actionStderr !== "number") {
      void consumeLogStream({
        stream: actionStderr,
        isActive: () => isActive,
        onLine: line =>
          appendLogEntry(formatSystemLine({ message: `[${opts.label}] ${line}`, tone: "warn" }))
      })
    }

    const exitCode = await proc.exited
    appendLogEntry(
      formatSystemLine({
        message: `[action] ${opts.label} finished (code ${exitCode})`,
        tone: "muted"
      })
    )
  }

  servicesSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (_index, option) => {
    selectedService = option?.value ?? null
    if (selectedService) {
      lastSelectedService = selectedService
    }
    updateLogsTitle()
    flushLogUpdate({ force: true })
    void refreshStats({ runtime: currentRuntime })
  })

  servicesSelect.on(RenderableEvents.FOCUSED, () => {
    if (searchOverlayVisible) return
    setActivePane("services")
  })

  logsScroll.on(RenderableEvents.FOCUSED, () => {
    if (searchOverlayVisible) return
    setActivePane("logs")
  })

  handleSelectionChange = () => {
    const next = logsText.hasSelection()
    if (next !== logsHasSelection) {
      logsHasSelection = next
      if (logsHasSelection && logFollow && activePane === "logs") {
        pauseLogFollow()
      }
      renderFooter()
    }
  }

  activeRenderer.on("selection", handleSelectionChange)

  activeRenderer.keyInput.on("keypress", key => {
    if ((key.ctrl || key.meta) && key.name === "f") {
      key.preventDefault()
      if (searchOverlayVisible) {
        closeSearchOverlay()
      } else {
        openSearchOverlay()
      }
      return
    }

    if (!searchOverlayVisible && searchMode !== "results" && key.name === "tab") {
      key.preventDefault()
      setActivePane(activePane === "services" ? "logs" : "services")
      return
    }

    if (searchOverlayVisible) {
      if ((key.ctrl || key.meta) && key.name === "c") {
        key.preventDefault()
        closeSearchOverlay()
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        closeSearchOverlay()
        return
      }
      if (key.name === "tab") {
        key.preventDefault()
        const direction = key.shift ? -1 : 1
        focusSearchField({ index: searchFocusIndex + direction })
        return
      }
      if (key.name === "enter" || key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        void runSearch()
        return
      }
      return
    }

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      key.preventDefault()
      void shutdown?.()
      return
    }

    if (logsHasSelection && key.name === "c" && !key.ctrl && !key.meta) {
      key.preventDefault()
      void copySelectedLogs()
      return
    }

    if (!key.ctrl && !key.meta) {
      if (key.name === "1") {
        key.preventDefault()
        toggleLevelFilter({ level: "info" })
        return
      }
      if (key.name === "2") {
        key.preventDefault()
        toggleLevelFilter({ level: "warn" })
        return
      }
      if (key.name === "3") {
        key.preventDefault()
        toggleLevelFilter({ level: "error" })
        return
      }
      if (key.name === "4") {
        key.preventDefault()
        toggleLevelFilter({ level: "debug" })
        return
      }
      if (key.name === "0") {
        key.preventDefault()
        resetLevelFilters()
        return
      }
      if (key.name === "f") {
        key.preventDefault()
        resumeLogFollow()
        return
      }
      if (key.name === "s") {
        key.preventDefault()
        toggleServiceScope()
        return
      }
      if (key.name === "z") {
        key.preventDefault()
        toggleCollapse()
        return
      }
      if (key.name === "h") {
        key.preventDefault()
        toggleHighlight()
        return
      }
      if (key.name === "x") {
        key.preventDefault()
        clearSearchState({ notify: true })
        return
      }
    }

    if (searchMode === "results") {
      if (key.name === "escape") {
        key.preventDefault()
        searchMode = "live"
        searchResults = []
        logsScroll.stickyScroll = logFollow
        updateLogsTitle()
        flushLogUpdate({ force: true })
        renderFooter()
        return
      }
      if (key.name === "up") {
        key.preventDefault()
        searchSelectedIndex = Math.max(0, searchSelectedIndex - 1)
        flushLogUpdate({ force: true })
        return
      }
      if (key.name === "down") {
        key.preventDefault()
        if (searchResults.length > 0) {
          searchSelectedIndex = Math.min(searchResults.length - 1, searchSelectedIndex + 1)
        }
        flushLogUpdate({ force: true })
        return
      }
      if (key.name === "enter" || key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        const selected = searchResults[searchSelectedIndex]
        if (selected?.service) {
          selectedService = selected.service
          lastSelectedService = selected.service
          renderServices(currentRuntime)
        }
        searchMode = "live"
        searchResults = []
        logsScroll.stickyScroll = logFollow
        updateLogsTitle()
        flushLogUpdate({ force: true })
        renderFooter()
        return
      }
    }

    if (key.name === "r") {
      key.preventDefault()
      void runAction({ label: "restart", args: ["restart"] })
      return
    }

    if (key.name === "o") {
      key.preventDefault()
      void runAction({ label: "open", args: ["open"] })
      return
    }

    if (key.name === "u") {
      key.preventDefault()
      void runAction({ label: "up", args: ["up"] })
      return
    }

    if (key.name === "d") {
      key.preventDefault()
      void runAction({ label: "down", args: ["down"] })
    }
  })

  await refreshRuntime()
  refreshTimer = setInterval(() => void refreshRuntime(), 2_000)
  await startLogStream()

  updateLogsTitle()
  setActivePane(activePane)
  logsScroll.verticalScrollBar.visible = true
  logsScroll.horizontalScrollBar.visible = false
  activeRenderer.start()

  while (running) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return 0
  } catch (error) {
    await handleFatal({ error, source: "startup" })
    return 1
  } finally {
    process.off("uncaughtException", onUncaughtException)
    process.off("unhandledRejection", onUnhandledRejection)
  }
}

async function resolveRuntimeProject(opts: {
  readonly project: ProjectContext
  readonly projectName: string
}): Promise<RuntimeProject | null> {
  const runtime = await readRuntimeProjects({ includeGlobal: false })
  const byWorkingDir = runtime.find(
    item => item.workingDir && resolve(item.workingDir) === resolve(opts.project.projectDir)
  )
  if (byWorkingDir) return byWorkingDir
  const byName = runtime.find(item => item.project === opts.projectName)
  return byName ?? null
}

async function resolveProjectId(opts: {
  readonly project: ProjectContext
  readonly projectName: string
}): Promise<string | null> {
  try {
    const registry = await readProjectsRegistry()
    const byDir = registry.projects.find(entry => entry.projectDir === opts.project.projectDir)
    if (byDir) return byDir.id
    const name = opts.projectName.trim().toLowerCase()
    if (name.length === 0) return null
    const byName = registry.projects.find(entry => entry.name === name)
    return byName?.id ?? null
  } catch {
    return null
  }
}

function countRunningServices(runtime: RuntimeProject): number {
  let total = 0
  for (const service of runtime.services.values()) {
    const running = service.containers.some(container => container.state === "running")
    if (running) total += 1
  }
  return total
}

function parseLogStreamEvent(line: string): LogStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (typeof parsed["type"] !== "string") return null
  return parsed as LogStreamEvent
}

function formatLogEntry(event: LogStreamEvent): LogEntry | null {
  const entry = event.entry
  if (!entry) return null
  const levelValue = resolveLevelValue(entry)
  const levelLabel = levelValue.toUpperCase()
  const timeLabel = entry.timestamp ? `[${isoToClock(entry.timestamp)}] ` : ""
  const levelLabelText = `[${levelLabel}] `
  const serviceLabelText = entry.service ? `[${entry.service}] ` : ""
  const prefixPlain = `${timeLabel}${levelLabelText}${serviceLabelText}`
  const prefixChunks: TextChunk[] = []
  if (timeLabel.length > 0) prefixChunks.push(dim(timeLabel))
  prefixChunks.push(colorLevel({ level: levelValue })(levelLabelText))
  if (serviceLabelText.length > 0 && entry.service) {
    prefixChunks.push(colorService(entry.service)(serviceLabelText))
  }
  const rawMessage =
    entry.message && entry.message.trim().length > 0 ? entry.message : entry.raw
  const messageParts = parseAnsiStyledText(rawMessage)
  const messageChunks = messageParts.hasAnsi ?
      messageParts.chunks
    : stylePlainMessage({ message: messageParts.plain, level: levelValue })
  const fieldsPlain = entry.fields ? ` ${formatFields(entry.fields)}` : ""
  const fieldsChunks = entry.fields ? buildFieldsChunks(entry.fields) : []
  const fullMessageChunks = [...messageChunks, ...fieldsChunks]
  const styled = new StyledText([...prefixChunks, ...fullMessageChunks])
  const line = `${prefixPlain}${messageParts.plain}${fieldsPlain}`.trim()
  const key = buildEntryKey({
    service: entry.service ?? null,
    timestamp: entry.timestamp ?? null,
    line
  })
  return {
    service: entry.service ?? null,
    line,
    styled,
    level: levelValue,
    messagePlain: `${messageParts.plain}${fieldsPlain}`,
    prefixWidth: prefixPlain.length,
    prefixPlain,
    prefixChunks,
    messageChunks: fullMessageChunks,
    timestamp: entry.timestamp ?? undefined,
    key
  }
}

function parseDockerStatsOutput(opts: { readonly output: string }): DockerStatsSample[] {
  const lines = opts.output
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
  const samples: DockerStatsSample[] = []

  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const cpuPercent = parsePercent({
      value: typeof parsed["CPUPerc"] === "string" ? parsed["CPUPerc"] : null
    })
    const memUsageRaw = typeof parsed["MemUsage"] === "string" ? parsed["MemUsage"] : null
    const memPercent = parsePercent({
      value: typeof parsed["MemPerc"] === "string" ? parsed["MemPerc"] : null
    })
    const netIo = parseIoPair({
      value: typeof parsed["NetIO"] === "string" ? parsed["NetIO"] : null
    })
    const blockIo = parseIoPair({
      value: typeof parsed["BlockIO"] === "string" ? parsed["BlockIO"] : null
    })
    const pidsValue = typeof parsed["PIDs"] === "string" ? parsed["PIDs"] : null

    let memUsedBytes: number | null = null
    let memLimitBytes: number | null = null
    if (memUsageRaw) {
      const [usedRaw = "", limitRaw = ""] = memUsageRaw.split("/").map(part => part.trim())
      memUsedBytes = parseBytes({ value: usedRaw.length > 0 ? usedRaw : null })
      memLimitBytes = parseBytes({ value: limitRaw.length > 0 ? limitRaw : null })
    }

    const parsedPids = pidsValue ? Number.parseInt(pidsValue, 10) : Number.NaN
    const pids = Number.isFinite(parsedPids) ? parsedPids : null

    samples.push({
      cpuPercent,
      memUsedBytes,
      memLimitBytes,
      memPercent,
      netInputBytes: netIo.inputBytes,
      netOutputBytes: netIo.outputBytes,
      blockInputBytes: blockIo.inputBytes,
      blockOutputBytes: blockIo.outputBytes,
      pids
    })
  }

  return samples
}

function aggregateDockerStats(opts: {
  readonly samples: readonly DockerStatsSample[]
}): DockerStatsSample | null {
  if (opts.samples.length === 0) return null

  const sumNullable = (values: readonly (number | null)[]): number | null => {
    let total = 0
    let count = 0
    for (const value of values) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue
      total += value
      count += 1
    }
    return count === 0 ? null : total
  }

  const cpuPercent = sumNullable(opts.samples.map(sample => sample.cpuPercent))
  const memUsedBytes = sumNullable(opts.samples.map(sample => sample.memUsedBytes))
  const memLimitBytes = sumNullable(opts.samples.map(sample => sample.memLimitBytes))
  const netInputBytes = sumNullable(opts.samples.map(sample => sample.netInputBytes))
  const netOutputBytes = sumNullable(opts.samples.map(sample => sample.netOutputBytes))
  const blockInputBytes = sumNullable(opts.samples.map(sample => sample.blockInputBytes))
  const blockOutputBytes = sumNullable(opts.samples.map(sample => sample.blockOutputBytes))
  const pids = sumNullable(opts.samples.map(sample => sample.pids))
  const memPercent =
    memUsedBytes !== null && memLimitBytes !== null && memLimitBytes > 0 ?
      (memUsedBytes / memLimitBytes) * 100
    : null

  return {
    cpuPercent,
    memUsedBytes,
    memLimitBytes,
    memPercent,
    netInputBytes,
    netOutputBytes,
    blockInputBytes,
    blockOutputBytes,
    pids
  }
}

function parsePercent(opts: { readonly value: string | null }): number | null {
  if (!opts.value) return null
  const match = opts.value.trim().match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number.parseFloat(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function parseIoPair(opts: {
  readonly value: string | null
}): { readonly inputBytes: number | null; readonly outputBytes: number | null } {
  if (!opts.value) {
    return { inputBytes: null, outputBytes: null }
  }
  const [inputRaw = "", outputRaw = ""] = opts.value.split("/").map(part => part.trim())
  return {
    inputBytes: parseBytes({ value: inputRaw.length > 0 ? inputRaw : null }),
    outputBytes: parseBytes({ value: outputRaw.length > 0 ? outputRaw : null })
  }
}

function parseBytes(opts: { readonly value: string | null }): number | null {
  if (!opts.value) return null
  const trimmed = opts.value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/)
  if (!match) return null
  const value = Number.parseFloat(match[1] ?? "")
  if (!Number.isFinite(value)) return null
  const unitRaw = (match[2] ?? "B").trim()
  const unit = unitRaw.toLowerCase()
  const multiplier =
    unit === "b" ? 1
    : unit === "kb" ? 1_000
    : unit === "kib" ? 1_024
    : unit === "mb" ? 1_000_000
    : unit === "mib" ? 1_048_576
    : unit === "gb" ? 1_000_000_000
    : unit === "gib" ? 1_073_741_824
    : unit === "tb" ? 1_000_000_000_000
    : unit === "tib" ? 1_099_511_627_776
    : null
  if (!multiplier) return null
  return value * multiplier
}

function formatBytes(opts: { readonly bytes: number }): string {
  if (!Number.isFinite(opts.bytes)) return "n/a"
  const sign = opts.bytes < 0 ? "-" : ""
  let value = Math.abs(opts.bytes)
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  const digits = value >= 10 || idx === 0 ? 0 : 1
  return `${sign}${value.toFixed(digits)} ${units[idx] ?? "B"}`
}

function formatPercent(opts: { readonly percent: number | null }): string {
  if (opts.percent === null || !Number.isFinite(opts.percent)) return "n/a"
  return `${opts.percent.toFixed(1)}%`
}

function isoToClock(value: string): string {
  const match = value.match(/T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/)
  if (!match) return value
  const hms = match[1] ?? value
  const frac = match[2]
  if (!frac) return hms
  const ms = frac.slice(0, 3).padEnd(3, "0")
  return `${hms}.${ms}`
}

function formatDurationShort(opts: { readonly ms: number }): string {
  if (!Number.isFinite(opts.ms) || opts.ms < 0) return "n/a"
  const totalSeconds = Math.floor(opts.ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) return `${totalHours}h`
  const totalDays = Math.floor(totalHours / 24)
  if (totalDays < 7) return `${totalDays}d`
  const totalWeeks = Math.floor(totalDays / 7)
  return `${totalWeeks}w`
}

function formatFields(fields: Record<string, string>): string {
  const parts: string[] = []
  for (const key of Object.keys(fields).sort()) {
    parts.push(`${key}=${fields[key]}`)
  }
  return parts.join(" ")
}

function buildFieldsChunks(fields: Record<string, string>): TextChunk[] {
  const chunks: TextChunk[] = []
  const keys = Object.keys(fields).sort()
  if (keys.length === 0) return chunks

  chunks.push({ __isChunk: true, text: " " })
  keys.forEach((key, idx) => {
    const value = fields[key]
    chunks.push(dim(`${key}=`))
    chunks.push(fg("#9ece6a")(String(value)))
    if (idx < keys.length - 1) {
      chunks.push({ __isChunk: true, text: " " })
    }
  })
  return chunks
}

function shouldCollapseLogPrefix(opts: { readonly prev: LogEntry; readonly next: LogEntry }): boolean {
  if (opts.prev.service !== opts.next.service) return false
  if (opts.prev.level !== opts.next.level) return false
  if (!opts.prev.timestamp || !opts.next.timestamp) return false
  if (opts.prev.timestamp.slice(0, 19) !== opts.next.timestamp.slice(0, 19)) return false

  const nextTrim = opts.next.messagePlain.trimStart()
  if (nextTrim.length === 0) return false
  if (nextTrim.startsWith("at ")) return true
  if (/^[\],}]/.test(nextTrim)) return true

  const hasIndent = opts.next.messagePlain.length > nextTrim.length
  if (!hasIndent) return false

  const prevTrim = opts.prev.messagePlain.trimEnd()
  return (
    /[{\[(]$/.test(prevTrim) ||
    /:$/.test(prevTrim) ||
    /,\s*$/.test(prevTrim) ||
    /=>\s*$/.test(prevTrim)
  )
}

function buildContinuationLineChunks(opts: { readonly prev: LogEntry; readonly entry: LogEntry }): TextChunk[] {
  const guide = dim("│ ")
  const padWidth = Math.max(0, opts.prev.prefixWidth - 2)
  const padding: TextChunk | null =
    padWidth > 0 ? { __isChunk: true, text: " ".repeat(padWidth) } : null
  return [
    guide,
    ...(padding ? [padding] : []),
    ...opts.entry.messageChunks
  ]
}

function buildStyledLogText(
  entries: readonly LogEntry[],
  opts?: {
    readonly highlightQuery?: string | null
    readonly selectedIndex?: number | null
    readonly collapseMultiline?: boolean
  }
): StyledText {
  const chunks: TextChunk[] = []
  const highlightQuery = opts?.highlightQuery?.trim() ?? ""
  const selectedIndex = opts?.selectedIndex ?? null
  const collapseMultiline = opts?.collapseMultiline ?? false
  let prevEntry: LogEntry | null = null
  for (const [index, entry] of entries.entries()) {
    let lineChunks: TextChunk[]
    if (prevEntry && shouldCollapseLogPrefix({ prev: prevEntry, next: entry })) {
      lineChunks = buildContinuationLineChunks({ prev: prevEntry, entry })
    } else {
      lineChunks = [...entry.prefixChunks, ...entry.messageChunks]
    }
    if (collapseMultiline) {
      lineChunks = collapseEntryChunks({ entry, chunks: lineChunks })
    }
    if (highlightQuery.length > 0) {
      lineChunks = highlightChunks({ chunks: lineChunks, query: highlightQuery })
    }
    if (selectedIndex !== null && index === selectedIndex) {
      lineChunks = highlightLine({ chunks: lineChunks })
    }
    chunks.push(...lineChunks)
    if (index < entries.length - 1) {
      chunks.push({ __isChunk: true, text: "\n" })
    }
    prevEntry = entry
  }
  return new StyledText(chunks)
}

function collapseEntryChunks(opts: { readonly entry: LogEntry; readonly chunks: TextChunk[] }): TextChunk[] {
  const parts = opts.entry.messagePlain.split("\n")
  if (parts.length <= 1) return opts.chunks
  const trailingEmpty = parts[parts.length - 1]?.trim().length === 0 ? 1 : 0
  const lineCount = Math.max(1, parts.length - trailingEmpty)
  if (lineCount <= 1) return opts.chunks
  const truncated = truncateChunksAtNewline({ chunks: opts.chunks })
  const extraLines = lineCount - 1
  const suffixText = extraLines === 1 ? " +1 line" : ` +${extraLines} lines`
  return [...truncated, ...t`${dim(suffixText)}`.chunks]
}

function truncateChunksAtNewline(opts: { readonly chunks: TextChunk[] }): TextChunk[] {
  const out: TextChunk[] = []
  for (const chunk of opts.chunks) {
    const idx = chunk.text.indexOf("\n")
    if (idx === -1) {
      out.push(cloneChunk({ chunk }))
      continue
    }
    if (idx > 0) {
      out.push(cloneChunk({ chunk, overrides: { text: chunk.text.slice(0, idx) } }))
    }
    break
  }
  return out
}

function highlightChunks(opts: { readonly chunks: TextChunk[]; readonly query: string }): TextChunk[] {
  const needle = opts.query.toLowerCase()
  if (needle.length === 0) return opts.chunks

  const out: TextChunk[] = []
  const highlightBg = RGBA.fromInts(92, 122, 212, 255)
  const highlightFg = RGBA.fromInts(238, 244, 255, 255)
  const highlightAttrs = createTextAttributes({ bold: true })

  for (const chunk of opts.chunks) {
    const text = chunk.text
    const lower = text.toLowerCase()
    let cursor = 0
    let idx = lower.indexOf(needle, cursor)
    if (idx === -1) {
      out.push(cloneChunk({ chunk }))
      continue
    }

    while (idx !== -1) {
      if (idx > cursor) {
        out.push(cloneChunk({ chunk, overrides: { text: text.slice(cursor, idx) } }))
      }
      const highlightOverrides: Partial<TextChunk> = {
        text: text.slice(idx, idx + needle.length),
        bg: highlightBg,
        attributes: (chunk.attributes ?? 0) | highlightAttrs
      }
      if (!chunk.fg) {
        highlightOverrides.fg = highlightFg
      }
      out.push(
        cloneChunk({
          chunk,
          overrides: highlightOverrides
        })
      )
      cursor = idx + needle.length
      idx = lower.indexOf(needle, cursor)
    }

    if (cursor < text.length) {
      out.push(cloneChunk({ chunk, overrides: { text: text.slice(cursor) } }))
    }
  }

  return out
}

function highlightLine(opts: { readonly chunks: TextChunk[] }): TextChunk[] {
  const bg = RGBA.fromInts(31, 38, 60, 255)
  return opts.chunks.map(chunk => cloneChunk({ chunk, overrides: { bg: chunk.bg ?? bg } }))
}

function cloneChunk(opts: { readonly chunk: TextChunk; readonly overrides?: Partial<TextChunk> }): TextChunk {
  const overrides = opts.overrides ?? {}
  return {
    __isChunk: true,
    text: overrides.text ?? opts.chunk.text,
    ...(opts.chunk.fg ? { fg: opts.chunk.fg } : {}),
    ...(opts.chunk.bg ? { bg: opts.chunk.bg } : {}),
    ...(opts.chunk.attributes !== undefined ? { attributes: opts.chunk.attributes } : {}),
    ...(opts.chunk.link ? { link: opts.chunk.link } : {}),
    ...overrides
  }
}

function formatSystemLine(opts: { readonly message: string; readonly tone: "warn" | "muted" }): LogEntry {
  const clean = normalizePlainText(stripAnsi(opts.message)).trim()
  const styled =
    opts.tone === "warn" ? t`${fg("#e0af68")(`${clean}`)}`
    : t`${dim(clean)}`
  const key = buildEntryKey({ service: null, timestamp: null, line: clean })
  const level = opts.tone === "warn" ? "warn" : "info"
  return {
    service: null,
    line: clean,
    styled,
    level,
    messagePlain: clean,
    prefixWidth: 0,
    prefixPlain: "",
    prefixChunks: [],
    messageChunks: styled.chunks,
    key
  }
}

function buildEntryKey(opts: {
  readonly service: string | null
  readonly timestamp: string | null
  readonly line: string
}): string {
  const service = opts.service ?? "all"
  const timestamp = opts.timestamp ?? "unknown"
  return `${service}|${timestamp}|${opts.line}`
}

function matchesSearchQuery(opts: {
  readonly entry: NonNullable<LogStreamEvent["entry"]>
  readonly query: string
  readonly level: string
}): boolean {
  const query = normalizeSearchText(opts.query).trim()
  if (opts.level !== "all") {
    const levelValue = resolveLevelValue(opts.entry)
    if (levelValue !== opts.level) return false
  }
  if (query.length === 0) return true

  const parts: string[] = []
  if (opts.entry.message) parts.push(opts.entry.message)
  if (opts.entry.raw) parts.push(opts.entry.raw)
  if (opts.entry.service) parts.push(opts.entry.service)
  if (opts.entry.project) parts.push(opts.entry.project)
  if (opts.entry.instance) parts.push(opts.entry.instance)
  if (opts.entry.fields) {
    for (const [key, value] of Object.entries(opts.entry.fields)) {
      parts.push(`${key}=${value}`)
    }
  }
  if (opts.entry.labels) {
    for (const [key, value] of Object.entries(opts.entry.labels)) {
      parts.push(`${key}=${value}`)
    }
  }

  const haystack = parts.map(normalizeSearchText).join(" ")
  return haystack.includes(query)
}

function resolveLevelValue(entry: NonNullable<LogStreamEvent["entry"]>): string {
  if (entry.level) return entry.level
  if (entry.stream === "stderr") return "error"
  const inferred = inferLevelFromMessage(entry.message ?? entry.raw)
  return inferred ?? "info"
}

function inferLevelFromMessage(message: string): string | null {
  const match = message.match(/\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\b/i)
  if (!match) return null
  const token = match[1]?.toLowerCase() ?? ""
  if (token === "warn" || token === "warning") return "warn"
  if (token === "error" || token === "fatal" || token === "panic") return "error"
  if (token === "debug" || token === "trace") return "debug"
  return "info"
}

function colorLevel(opts: { readonly level: string }) {
  const color =
    opts.level === "error" ? "#f7768e"
    : opts.level === "warn" ? "#e0af68"
    : opts.level === "debug" ? "#6b7390"
    : "#7dcfff"
  return fg(color)
}

function colorMessage(opts: { readonly level: string }) {
  const color =
    opts.level === "error" ? "#f7768e"
    : opts.level === "warn" ? "#e0af68"
    : opts.level === "debug" ? "#6b7390"
    : "#c0caf5"
  return fg(color)
}

function colorService(service: string) {
  const palette = ["#7aa2f7", "#9ece6a", "#bb9af7", "#f7768e", "#7dcfff", "#e0af68"] as const
  const idx = fnv1a32(service) % palette.length
  const color = palette[idx] ?? "#7aa2f7"
  return fg(color)
}

type MessageTokenKind = "method" | "status" | "duration" | "path"

type MessageTokenPattern = {
  readonly kind: MessageTokenKind
  readonly regex: RegExp
  readonly priority: number
}

const MESSAGE_TOKEN_PATTERNS: MessageTokenPattern[] = [
  { kind: "method", regex: /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g, priority: 0 },
  { kind: "status", regex: /\b[1-5]\d{2}\b/g, priority: 1 },
  { kind: "duration", regex: /\b\d+(?:\.\d+)?(?:ms|s|m|h|us)\b/g, priority: 2 },
  { kind: "path", regex: /\/[^\s)]+/g, priority: 3 }
]

function stylePlainMessage(opts: { readonly message: string; readonly level: string }): TextChunk[] {
  const text = normalizePlainText(opts.message)
  if (text.length === 0) {
    return [colorMessage({ level: opts.level })("")]
  }

  const base = colorMessage({ level: opts.level })
  const chunks: TextChunk[] = []
  let cursor = 0

  while (cursor < text.length) {
    const token = findNextMessageToken({ text, start: cursor })
    if (!token) {
      chunks.push(base(text.slice(cursor)))
      break
    }
    if (token.start > cursor) {
      chunks.push(base(text.slice(cursor, token.start)))
    }
    chunks.push(colorMessageToken({ kind: token.kind, value: text.slice(token.start, token.end) }))
    cursor = token.end
  }

  return chunks
}

function findNextMessageToken(opts: {
  readonly text: string
  readonly start: number
}): { readonly kind: MessageTokenKind; readonly start: number; readonly end: number } | null {
  let best: { readonly kind: MessageTokenKind; readonly start: number; readonly end: number } | null =
    null
  let bestPriority = Number.POSITIVE_INFINITY

  for (const pattern of MESSAGE_TOKEN_PATTERNS) {
    pattern.regex.lastIndex = opts.start
    const match = pattern.regex.exec(opts.text)
    if (!match) continue
    const start = match.index
    const end = start + match[0].length
    if (
      !best ||
      start < best.start ||
      (start === best.start && pattern.priority < bestPriority)
    ) {
      best = { kind: pattern.kind, start, end }
      bestPriority = pattern.priority
    }
  }

  return best
}

function colorMessageToken(opts: { readonly kind: MessageTokenKind; readonly value: string }): TextChunk {
  if (opts.kind === "method") {
    return fg("#7dcfff")(opts.value)
  }
  if (opts.kind === "status") {
    const code = Number.parseInt(opts.value, 10)
    if (code >= 500) return fg("#f7768e")(opts.value)
    if (code >= 400) return fg("#e0af68")(opts.value)
    if (code >= 300) return fg("#7aa2f7")(opts.value)
    return fg("#9ece6a")(opts.value)
  }
  if (opts.kind === "duration") {
    return fg("#bb9af7")(opts.value)
  }
  return fg("#7aa2f7")(opts.value)
}

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

function normalizePlainText(text: string): string {
  return text.replaceAll(/[\x00-\x1f\x7f]/g, " ")
}

function normalizeSearchText(text: string): string {
  return normalizePlainText(stripAnsi(text)).toLowerCase()
}

function parseAnsiStyledText(input: string): {
  readonly chunks: TextChunk[]
  readonly plain: string
  readonly hasAnsi: boolean
} {
  const pattern = /\x1b\[([0-9;]*)m/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let hasAnsi = false
  const chunks: TextChunk[] = []
  let plain = ""
  let style = createAnsiStyle()

  while ((match = pattern.exec(input))) {
    const idx = match.index
    if (idx > lastIndex) {
      const text = normalizePlainText(input.slice(lastIndex, idx))
      if (text.length > 0) {
        chunks.push(buildAnsiChunk({ text, style }))
        plain += text
      }
    }

    hasAnsi = true
    const rawCodes = match[1] ?? ""
    const codes =
      rawCodes.length === 0 ?
        [0]
      : rawCodes
          .split(";")
          .map(part => Number(part))
          .filter(n => Number.isFinite(n))
    style = applyAnsiCodes({ style, codes })
    lastIndex = idx + match[0].length
  }

  if (lastIndex < input.length) {
    const text = normalizePlainText(input.slice(lastIndex))
    if (text.length > 0) {
      chunks.push(buildAnsiChunk({ text, style }))
      plain += text
    }
  }

  if (plain.length === 0) {
    plain = normalizePlainText(stripAnsi(input))
  }

  return {
    chunks,
    plain,
    hasAnsi
  }
}

type AnsiStyle = {
  readonly fg?: RGBA
  readonly bg?: RGBA
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly strikethrough: boolean
  readonly inverse: boolean
}

function createAnsiStyle(): AnsiStyle {
  return {
    fg: undefined,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    inverse: false
  }
}

function buildAnsiChunk(opts: { readonly text: string; readonly style: AnsiStyle }): TextChunk {
  const attributes = createTextAttributes({
    bold: opts.style.bold,
    dim: opts.style.dim,
    italic: opts.style.italic,
    underline: opts.style.underline,
    strikethrough: opts.style.strikethrough,
    inverse: opts.style.inverse
  })
  const fg = opts.style.inverse ? opts.style.bg : opts.style.fg
  const bg = opts.style.inverse ? opts.style.fg : opts.style.bg
  return {
    __isChunk: true,
    text: opts.text,
    ...(fg ? { fg } : {}),
    ...(bg ? { bg } : {}),
    attributes
  }
}

function applyAnsiCodes(opts: { readonly style: AnsiStyle; readonly codes: number[] }): AnsiStyle {
  let style = { ...opts.style }
  let i = 0
  while (i < opts.codes.length) {
    const code = opts.codes[i] ?? 0
    switch (code) {
      case 0:
        style = createAnsiStyle()
        i += 1
        break
      case 1:
        style = { ...style, bold: true }
        i += 1
        break
      case 2:
        style = { ...style, dim: true }
        i += 1
        break
      case 3:
        style = { ...style, italic: true }
        i += 1
        break
      case 4:
        style = { ...style, underline: true }
        i += 1
        break
      case 7:
        style = { ...style, inverse: true }
        i += 1
        break
      case 9:
        style = { ...style, strikethrough: true }
        i += 1
        break
      case 22:
        style = { ...style, bold: false, dim: false }
        i += 1
        break
      case 23:
        style = { ...style, italic: false }
        i += 1
        break
      case 24:
        style = { ...style, underline: false }
        i += 1
        break
      case 27:
        style = { ...style, inverse: false }
        i += 1
        break
      case 29:
        style = { ...style, strikethrough: false }
        i += 1
        break
      case 39:
        style = { ...style, fg: undefined }
        i += 1
        break
      case 49:
        style = { ...style, bg: undefined }
        i += 1
        break
      default: {
        if (code >= 30 && code <= 37) {
          style = { ...style, fg: ansiToRgba(code - 30, false) }
          i += 1
          break
        }
        if (code >= 90 && code <= 97) {
          style = { ...style, fg: ansiToRgba(code - 90, true) }
          i += 1
          break
        }
        if (code >= 40 && code <= 47) {
          style = { ...style, bg: ansiToRgba(code - 40, false) }
          i += 1
          break
        }
        if (code >= 100 && code <= 107) {
          style = { ...style, bg: ansiToRgba(code - 100, true) }
          i += 1
          break
        }
        if (code === 38 || code === 48) {
          const isFg = code === 38
          const next = opts.codes[i + 1]
          if (next === 5) {
            const colorIndex = opts.codes[i + 2]
            if (typeof colorIndex === "number") {
              const rgba = xtermToRgba(colorIndex)
              style = isFg ? { ...style, fg: rgba } : { ...style, bg: rgba }
            }
            i += 3
            break
          }
          if (next === 2) {
            const r = opts.codes[i + 2]
            const g = opts.codes[i + 3]
            const b = opts.codes[i + 4]
            if ([r, g, b].every(v => typeof v === "number")) {
              const rgba = RGBA.fromInts(
                clampColor(r ?? 0),
                clampColor(g ?? 0),
                clampColor(b ?? 0),
                255
              )
              style = isFg ? { ...style, fg: rgba } : { ...style, bg: rgba }
            }
            i += 5
            break
          }
        }
        i += 1
        break
      }
    }
  }

  return style
}

function clampColor(value: number): number {
  if (value < 0) return 0
  if (value > 255) return 255
  return Math.round(value)
}

function ansiToRgba(code: number, bright: boolean): RGBA {
  const palette = [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255]
  ] as const
  const idx = bright ? code + 8 : code
  const rgb = palette[idx] ?? palette[7]
  return RGBA.fromInts(rgb[0], rgb[1], rgb[2], 255)
}

function xtermToRgba(code: number): RGBA {
  if (code < 0) return ansiToRgba(0, false)
  if (code < 16) return ansiToRgba(code % 8, code >= 8)
  if (code >= 232) {
    const shade = 8 + (code - 232) * 10
    return RGBA.fromInts(shade, shade, shade, 255)
  }

  const index = code - 16
  const r = Math.floor(index / 36)
  const g = Math.floor((index % 36) / 6)
  const b = index % 6
  const steps = [0, 95, 135, 175, 215, 255]
  return RGBA.fromInts(steps[r] ?? 0, steps[g] ?? 0, steps[b] ?? 0, 255)
}

async function consumeLogStream(opts: {
  readonly stream: ReadableStream<Uint8Array>
  readonly isActive: () => boolean
  readonly onLine: (line: string) => void
}): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""

  const reader = opts.stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!opts.isActive()) break
      if (!value || value.length === 0) continue
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf("\n")
      while (idx >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim().length > 0) {
          opts.onLine(line)
        }
        idx = buffer.indexOf("\n")
      }
    }
  } finally {
    reader.releaseLock()
  }

  const rest = buffer.trim()
  if (rest.length > 0 && opts.isActive()) {
    opts.onLine(rest)
  }
}

async function shutdownRenderer(opts: {
  readonly renderer: Awaited<ReturnType<typeof createCliRenderer>> | null
}): Promise<void> {
  if (!opts.renderer) return
  opts.renderer.stop()
  opts.renderer.destroy()
}

function formatErrorMessage(opts: { readonly error: unknown }): string {
  if (opts.error instanceof Error) {
    return opts.error.stack ?? opts.error.message
  }
  if (typeof opts.error === "string") return opts.error
  try {
    return JSON.stringify(opts.error, null, 2)
  } catch {
    return String(opts.error)
  }
}
