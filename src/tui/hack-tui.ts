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
  t
} from "@opentui/core"

import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { resolveHackInvocation } from "../lib/hack-cli.ts"
import { renderHackBanner } from "../lib/hack-banner.ts"
import { ensureDir, writeTextFile } from "../lib/fs.ts"
import { isRecord } from "../lib/guards.ts"
import { defaultProjectSlugFromPath, readProjectConfig, readProjectDevHost } from "../lib/project.ts"
import { readRuntimeProjects } from "../lib/runtime-projects.ts"

import type { ProjectContext } from "../lib/project.ts"
import type { RuntimeProject } from "../lib/runtime-projects.ts"
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
  readonly line: string
  readonly styled: StyledText
  readonly timestamp?: string
  readonly key: string
}

class WrappedTextRenderable extends TextRenderable {
  protected onResize(width: number, height: number): void {
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

export async function runHackTui({ project }: HackTuiOptions): Promise<number> {
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  const errorLogPath = resolve(homedir(), ".hack", "tui-error.log")
  let errorHandled = false
  let shutdown: (() => Promise<void>) | null = null

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
    const projectName = (cfg.name ?? "").trim() || defaultProjectSlugFromPath(project.projectRoot)
    const devHost = await readProjectDevHost(project)
    const headerBanner = await renderHackBanner({ trimEmpty: true, maxLines: 1 })
    const headerBannerLine = headerBanner.length > 0 ? headerBanner.trim() : ""
    const headerLabel =
      headerBannerLine.length > 0 && !/[█░▒▓]/.test(headerBannerLine) ? headerBannerLine : "hack"

    renderer = await createCliRenderer({
      targetFps: 30,
      exitOnCtrlC: false,
      useConsole: false,
      useAlternateScreen: true
    })

    renderer.setBackgroundColor("#0f111a")

  const headerPaddingX = 1
  const headerPaddingY = 0
  const headerLineCount = headerLabel ? 2 : 1
  const headerHeight = headerLineCount + headerPaddingY * 2

  const root = new BoxRenderable(renderer, {
    id: "hack-tui-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0f111a"
  })

  const header = new BoxRenderable(renderer, {
    id: "hack-tui-header",
    width: "100%",
    height: headerHeight,
    minHeight: headerHeight,
    paddingLeft: headerPaddingX,
    paddingRight: headerPaddingX,
    paddingTop: headerPaddingY,
    paddingBottom: headerPaddingY,
    border: false,
    backgroundColor: "#141828"
  })

  const headerText = new TextRenderable(renderer, {
    id: "hack-tui-header-text",
    content: "",
    wrapMode: "none",
    width: "100%",
    height: "100%"
  })

  header.add(headerText)

  const body = new BoxRenderable(renderer, {
    id: "hack-tui-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "stretch",
    padding: 1,
    gap: 1,
    backgroundColor: "#0f111a"
  })

  const servicesBox = new BoxRenderable(renderer, {
    id: "hack-tui-services",
    width: 36,
    flexDirection: "column",
    border: true,
    borderColor: "#2f344a",
    backgroundColor: "#131829",
    title: "Services",
    titleAlignment: "left"
  })

  const servicesSelect = new SelectRenderable(renderer, {
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

  const logsBox = new BoxRenderable(renderer, {
    id: "hack-tui-logs",
    flexGrow: 1,
    flexDirection: "column",
    border: true,
    borderColor: "#2f344a",
    backgroundColor: "#0f111a",
    title: "Logs (aggregate)",
    titleAlignment: "left"
  })

  const logsScroll = new ScrollBoxRenderable(renderer, {
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

  const logsText = new WrappedTextRenderable(renderer, {
    id: "hack-tui-logs-text",
    width: "100%",
    content: "Waiting for logs...",
    wrapMode: "char"
  })

  logsScroll.add(logsText)
  logsBox.add(logsScroll)

  const footer = new BoxRenderable(renderer, {
    id: "hack-tui-footer",
    width: "100%",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
    paddingBottom: 1,
    border: false,
    backgroundColor: "#141828"
  })

    const footerText = new TextRenderable(renderer, {
    id: "hack-tui-footer-text",
    content: ""
  })

  footer.add(footerText)

  const searchOverlay = new BoxRenderable(renderer, {
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
    const frame = new BoxRenderable(renderer, {
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

  const searchPanel = new BoxRenderable(renderer, {
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

  const searchTitle = new TextRenderable(renderer, {
    id: "hack-tui-search-title",
    content: t`${fg("#9ad7ff")("Search logs")}`
  })

  const searchHint = new TextRenderable(renderer, {
    id: "hack-tui-search-hint",
    content: t`${dim("Enter to search | Esc to cancel | Tab to move")}`
  })

  const searchQueryLabel = new TextRenderable(renderer, {
    id: "hack-tui-search-query-label",
    content: t`${dim("Query")}`
  })

  const searchQueryInput = new InputRenderable(renderer, {
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

  const searchFiltersRow = new BoxRenderable(renderer, {
    id: "hack-tui-search-filters",
    width: "100%",
    flexDirection: "row",
    gap: 2
  })

  const searchServiceColumn = new BoxRenderable(renderer, {
    id: "hack-tui-search-service-column",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1
  })

  const searchServiceLabel = new TextRenderable(renderer, {
    id: "hack-tui-search-service-label",
    content: t`${dim("Service")}`
  })

  const searchServiceSelect = new SelectRenderable(renderer, {
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

  const searchLevelColumn = new BoxRenderable(renderer, {
    id: "hack-tui-search-level-column",
    width: 24,
    flexDirection: "column",
    gap: 1
  })

  const searchLevelLabel = new TextRenderable(renderer, {
    id: "hack-tui-search-level-label",
    content: t`${dim("Level")}`
  })

  const searchLevelSelect = new SelectRenderable(renderer, {
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

  const searchTimeRow = new BoxRenderable(renderer, {
    id: "hack-tui-search-time-row",
    width: "100%",
    flexDirection: "row",
    gap: 2
  })

  const searchSinceColumn = new BoxRenderable(renderer, {
    id: "hack-tui-search-since-column",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1
  })

  const searchSinceLabel = new TextRenderable(renderer, {
    id: "hack-tui-search-since-label",
    content: t`${dim("Since")}`
  })

  const searchSinceInput = new InputRenderable(renderer, {
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

  const searchUntilColumn = new BoxRenderable(renderer, {
    id: "hack-tui-search-until-column",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1
  })

  const searchUntilLabel = new TextRenderable(renderer, {
    id: "hack-tui-search-until-label",
    content: t`${dim("Until")}`
  })

  const searchUntilInput = new InputRenderable(renderer, {
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

  const searchStatusText = new TextRenderable(renderer, {
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
  searchPanel.add(searchQueryLabel)
  searchPanel.add(searchQueryField)
  searchPanel.add(searchFiltersRow)
  searchPanel.add(searchTimeRow)
  searchPanel.add(searchStatusText)
  searchOverlay.add(searchPanel)

  body.add(servicesBox)
  body.add(logsBox)

  root.add(header)
  root.add(body)
  root.add(footer)
  renderer.root.add(root)
  renderer.root.add(searchOverlay)

    const logState: LogState = {
    entries: [],
    maxEntries: 2000,
    maxLines: 400
  }

    const paneBorderColor = "#2f344a"
    const paneFocusBorderColor = "#7dcfff"

    let activePane: "services" | "logs" = "services"
    let lastMainPane: "services" | "logs" = "services"
    let logStartTimestamp: string | null = null
    let logBackend: LogStreamBackend | null = null

    const historyState = {
      loading: false,
      canLoadMore: true,
      tailSize: 200,
      tailStep: 200
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

  const setMainViewVisible = (visible: boolean) => {
    root.visible = visible
    root.requestRender()
  }

  const joinFooterText = (parts: StyledText[], separator = "  "): StyledText => {
    const chunks: TextChunk[] = []
    parts.forEach((part, idx) => {
      chunks.push(...part.chunks)
      if (idx < parts.length - 1) {
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

  const renderFooter = () => {
    const focusLabel =
      searchOverlayVisible ? "Search"
      : searchMode === "results" ? "Results"
      : activePane === "services" ? "Services"
      : "Logs"
    const focusHint = t`${dim("focus:")} ${fg("#9ad7ff")(focusLabel)}`

    if (searchOverlayVisible) {
      const navHint = t`${dim("[")}${fg("#9ad7ff")("tab")}${dim("]")} next field  ${dim(
        "["
      )}${fg("#9ad7ff")("shift+tab")}${dim("]")} prev`
      const actions = t`${dim("[")}${fg("#9ad7ff")("enter")}${dim("]")} search  ${dim("[")}${fg(
        "#9ad7ff"
      )("esc")}${dim("]")} close  ${dim("[")}${fg("#9ad7ff")(
        "ctrl+c"
      )}${dim("]")} close`
      footerText.content = joinFooterText([navHint, actions, focusHint])
      return
    }

    if (searchMode === "results") {
      const navHint = t`${dim("[")}${fg("#9ad7ff")("↑/↓")}${dim("]")} select result  ${dim(
        "["
      )}${fg("#9ad7ff")("enter")}${dim("]")} jump`
      const actions = t`${dim("[")}${fg("#9ad7ff")("esc")}${dim("]")} back  ${dim("[")}${fg(
        "#9ad7ff"
      )("ctrl+f")}${dim("]")} new search`
      footerText.content = joinFooterText([navHint, actions, focusHint])
      return
    }

    const navHint =
      activePane === "services" ?
        t`${dim("[")}${fg("#9ad7ff")("↑/↓")}${dim("]")} select service`
      : t`${dim("[")}${fg("#9ad7ff")("↑/↓")}${dim("]")} scroll logs`
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
    footerText.content = joinFooterText([navHint, actions, focusHint])
  }

  const setActivePane = (pane: "services" | "logs") => {
    if (activePane === pane && !searchOverlayVisible) {
      renderHeader(currentRuntime)
      renderFooter()
      return
    }
    activePane = pane
    servicesBox.borderColor = pane === "services" ? paneFocusBorderColor : paneBorderColor
    logsBox.borderColor = pane === "logs" ? paneFocusBorderColor : paneBorderColor
    renderHeader(currentRuntime)
    renderFooter()
    if (pane === "services") {
      servicesSelect.focus()
    } else {
      logsScroll.focus()
    }
  }

  const renderHeader = (runtime: RuntimeProject | null) => {
    if (!isActive) return
    const serviceCount = runtime ? runtime.services.size : 0
    const runningCount = runtime ? countRunningServices(runtime) : 0
    const hostLabel = devHost ? devHost : "n/a"
    const focusLabel = activePane === "services" ? "Services" : "Logs"
    const sinceLabel = logStartTimestamp ? isoToClock(logStartTimestamp) : "n/a"
    const metaLine =
      `Project: ${projectName}  Host: ${hostLabel}  Services: ${runningCount}/${serviceCount}` +
      `  Focus: ${focusLabel}  Logs since: ${sinceLabel}  [q] quit`
    const headerWidth = Math.max(0, Math.floor(header.width || renderer?.width || 0))
    const maxLineWidth = Math.max(0, headerWidth - headerPaddingX * 2)
    const bannerLine = headerLabel.length > 0 ? truncateLine(headerLabel, maxLineWidth) : ""
    const metaLineTrim = truncateLine(metaLine, maxLineWidth)
    headerText.content = bannerLine.length > 0 ? `${bannerLine}\n${metaLineTrim}` : metaLineTrim
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

  const updateLogsTitle = () => {
    if (!isActive) return
    if (searchMode === "results") {
      logsBox.title = `Search results (${searchResults.length})`
      return
    }
    const base = selectedService ? `Logs (${selectedService})` : "Logs (all)"
    const suffix = historyState.loading ? " • loading history" : ""
    logsBox.title = base + suffix
  }

  const updateLogText = () => {
    if (!isActive) return
    const activeEntries =
      searchMode === "results" ?
        searchResults
      : selectedService ?
        logState.entries.filter(entry => entry.service === selectedService)
      : logState.entries
    const visible = activeEntries.slice(-logState.maxLines)

    if (visible.length === 0) {
      logsText.content = searchMode === "results" ? "No search results." : "Waiting for logs..."
      return
    }

    const visibleOffset = Math.max(0, activeEntries.length - visible.length)
    const selectedIndex =
      searchMode === "results" ? searchSelectedIndex - visibleOffset : null
    const selectedLineIndex =
      selectedIndex !== null && selectedIndex >= 0 && selectedIndex < visible.length ?
        selectedIndex
      : null
    logsText.content = buildStyledLogText(visible, {
      highlightQuery: searchMode === "results" ? searchQuery : null,
      selectedIndex: selectedLineIndex
    })
    logsText.syncWrapWidth()
  }

  const scheduleLogUpdate = () => {
    if (!isActive || logUpdateTimer || searchOverlayVisible) return
    logUpdateTimer = setTimeout(() => {
      logUpdateTimer = null
      updateLogText()
    }, 80)
  }

  const flushLogUpdate = () => {
    if (searchOverlayVisible) return
    if (logUpdateTimer) {
      clearTimeout(logUpdateTimer)
      logUpdateTimer = null
    }
    updateLogText()
  }

  const appendLogEntry = (entry: LogEntry) => {
    if (!isActive) return
    logState.entries.push(entry)
    let trimmed = false
    if (logState.entries.length > logState.maxEntries) {
      logState.entries.splice(0, logState.entries.length - logState.maxEntries)
      trimmed = true
    }
    if (entry.timestamp && (!logStartTimestamp || entry.timestamp < logStartTimestamp)) {
      logStartTimestamp = entry.timestamp
      renderHeader(currentRuntime)
    }
    if (trimmed) {
      updateLogStartTimestamp()
    }
    scheduleLogUpdate()
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
      renderHeader(currentRuntime)
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

    if (proc.stdout) {
      await consumeLogStream({
        stream: proc.stdout,
        isActive: () => isActive,
        onLine: line => {
          const event = parseLogStreamEvent(line)
          if (!event || event.type !== "log" || !event.entry) return
          if (!logBackend) {
            logBackend = event.backend ?? event.entry.source
          }
          const formatted = formatLogEntry(event)
          if (formatted) entries.push(formatted)
        }
      })
    }

    if (proc.stderr) {
      void consumeLogStream({
        stream: proc.stderr,
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
    historyState.loading = true
    logsBox.title = "Logs (loading history...)"
    logsBox.requestRender()

    try {
      if (logBackend === "loki") {
        const snapshot = await fetchLogSnapshot({
          tail: historyState.tailStep,
          until: logStartTimestamp,
          backend: "loki"
        })
        if (snapshot.length === 0) {
          historyState.canLoadMore = false
        } else {
          logState.maxEntries = Math.max(logState.maxEntries, logState.entries.length + snapshot.length + 500)
          mergeHistoryEntries(snapshot)
        }
      } else {
        historyState.tailSize += historyState.tailStep
        const snapshot = await fetchLogSnapshot({
          tail: historyState.tailSize,
          backend: logBackend ?? "compose"
        })
        if (snapshot.length < historyState.tailSize) {
          historyState.canLoadMore = false
        }
        logState.maxEntries = Math.max(logState.maxEntries, historyState.tailSize + 500)
        mergeHistoryEntries(snapshot)
      }
    } finally {
      historyState.loading = false
      updateLogsTitle()
      flushLogUpdate()
    }
  }

  logsScroll.verticalScrollBar.on("change", payload => {
    if (!isActive || searchOverlayVisible || searchMode === "results") return
    const position = typeof payload?.position === "number" ? payload.position : logsScroll.scrollTop
    if (position <= 1) {
      void loadMoreHistory()
    }
  })

  const refreshRuntime = async () => {
    if (!isActive) return
    const runtime = await resolveRuntimeProject({ project, projectName })
    if (!isActive) return
    currentRuntime = runtime
    renderHeader(runtime)
    renderServices(runtime)
    renderSearchServices({ runtime })
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
    flushLogUpdate()
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

    cancelSearchProc()
    closeSearchOverlay()
    searchMode = "live"
    searchResults = []
    searchSelectedIndex = 0
    updateLogsTitle()
    setSearchStatus({ message: "Searching...", tone: "info" })

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
    if (since.length > 0) {
      args.push("--since", since)
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

    if (searchProc.stderr) {
      void consumeLogStream({
        stream: searchProc.stderr,
        isActive: () => isActive,
        onLine: line => {
          errors.push(line)
        }
      })
    }

    if (searchProc.stdout) {
      await consumeLogStream({
        stream: searchProc.stdout,
        isActive: () => isActive,
        onLine: line => {
          const event = parseLogStreamEvent(line)
          if (!event || event.type !== "log" || !event.entry) return
          const formatted = formatLogEntry(event)
          if (!formatted) return
          if (!matchesSearchQuery({ entry: event.entry, query, level })) return
          entries.push(formatted)
        }
      })
    }

    await searchProc.exited
    searchProc = null

    if (errors.length > 0) {
      setSearchStatus({ message: errors.slice(-2).join("\n"), tone: "warn" })
      appendLogEntry(
        formatSystemLine({
          message: `[search] ${errors[errors.length - 1] ?? "Search failed"}`,
          tone: "warn"
        })
      )
      searchMode = "live"
      logsScroll.stickyScroll = true
      updateLogsTitle()
      flushLogUpdate()
      renderFooter()
      return
    }

    setSearchStatus({ message: `Found ${entries.length} matches`, tone: "info" })
    searchResults = entries
    searchSelectedIndex = 0
    searchQuery = query
    searchMode = "results"
    logsScroll.stickyScroll = false
    setActivePane("logs")
    updateLogsTitle()
    flushLogUpdate()
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

    if (logProc.stderr) {
      void consumeLogStream({
        stream: logProc.stderr,
        isActive: () => isActive,
        onLine: line => {
          appendLogEntry(formatSystemLine({ message: `[stderr] ${line}`, tone: "warn" }))
        }
      })
    }

    if (logProc.stdout) {
      void consumeLogStream({
        stream: logProc.stdout,
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

    if (logProc && logProc.exitCode === null) {
      logProc.kill()
    }
    if (searchProc && searchProc.exitCode === null) {
      searchProc.kill()
    }

    if (renderer) {
      renderer.stop()
      renderer.destroy()
    }

    process.off("SIGINT", handleSignal)
    process.off("SIGTERM", handleSignal)
  }

  const handleSignal = () => {
    if (searchOverlayVisible) {
      closeSearchOverlay()
      return
    }
    void shutdown()
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

    if (proc.stderr) {
      void consumeLogStream({
        stream: proc.stderr,
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
    updateLogsTitle()
    flushLogUpdate()
  })

  servicesSelect.on(RenderableEvents.FOCUSED, () => {
    if (searchOverlayVisible) return
    setActivePane("services")
  })

  logsScroll.on(RenderableEvents.FOCUSED, () => {
    if (searchOverlayVisible) return
    setActivePane("logs")
  })

  renderer.keyInput.on("keypress", key => {
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
      void shutdown()
      return
    }

    if (searchMode === "results") {
      if (key.name === "escape") {
        key.preventDefault()
        searchMode = "live"
        searchResults = []
        logsScroll.stickyScroll = true
        updateLogsTitle()
        flushLogUpdate()
        renderFooter()
        return
      }
      if (key.name === "up") {
        key.preventDefault()
        searchSelectedIndex = Math.max(0, searchSelectedIndex - 1)
        flushLogUpdate()
        return
      }
      if (key.name === "down") {
        key.preventDefault()
        if (searchResults.length > 0) {
          searchSelectedIndex = Math.min(searchResults.length - 1, searchSelectedIndex + 1)
        }
        flushLogUpdate()
        return
      }
      if (key.name === "enter" || key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        const selected = searchResults[searchSelectedIndex]
        if (selected?.service) {
          selectedService = selected.service
          renderServices(currentRuntime)
        }
        searchMode = "live"
        searchResults = []
        logsScroll.stickyScroll = true
        updateLogsTitle()
        flushLogUpdate()
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
  renderer.start()

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
  const timeChunk = entry.timestamp ? dim(`[${isoToClock(entry.timestamp)}] `) : null
  const levelChunk = colorLevel({ level: levelValue })(`[${levelLabel}] `)
  const serviceChunk = entry.service ? colorService(entry.service)(`[${entry.service}] `) : null
  const rawMessage =
    entry.message && entry.message.trim().length > 0 ? entry.message : entry.raw
  const messageParts = parseAnsiStyledText(rawMessage)
  const messageChunks = messageParts.hasAnsi ?
      messageParts.chunks
    : stylePlainMessage({ message: messageParts.plain, level: levelValue })
  const fieldsPlain = entry.fields ? ` ${formatFields(entry.fields)}` : ""
  const fieldsChunks = entry.fields ? buildFieldsChunks(entry.fields) : []
  const styled = new StyledText([
    ...(timeChunk ? [timeChunk] : []),
    ...(levelChunk ? [levelChunk] : []),
    ...(serviceChunk ? [serviceChunk] : []),
    ...messageChunks,
    ...fieldsChunks
  ])
  const line = `${entry.timestamp ? `[${isoToClock(entry.timestamp)}] ` : ""}[${levelLabel}] ${
    entry.service ? `[${entry.service}] ` : ""
  }${messageParts.plain}${fieldsPlain}`.trim()
  const key = buildEntryKey({
    service: entry.service ?? null,
    timestamp: entry.timestamp ?? null,
    line
  })
  return {
    service: entry.service ?? null,
    line,
    styled,
    timestamp: entry.timestamp ?? undefined,
    key
  }
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

function buildStyledLogText(
  entries: readonly LogEntry[],
  opts?: { readonly highlightQuery?: string | null; readonly selectedIndex?: number | null }
): StyledText {
  const chunks: TextChunk[] = []
  const highlightQuery = opts?.highlightQuery?.trim() ?? ""
  const selectedIndex = opts?.selectedIndex ?? null
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    let lineChunks = entry.styled.chunks
    if (highlightQuery.length > 0) {
      lineChunks = highlightChunks({ chunks: lineChunks, query: highlightQuery })
    }
    if (selectedIndex !== null && i === selectedIndex) {
      lineChunks = highlightLine({ chunks: lineChunks })
    }
    chunks.push(...lineChunks)
    if (i < entries.length - 1) {
      chunks.push({ __isChunk: true, text: "\n" })
    }
  }
  return new StyledText(chunks)
}

function highlightChunks(opts: { readonly chunks: TextChunk[]; readonly query: string }): TextChunk[] {
  const needle = opts.query.toLowerCase()
  if (needle.length === 0) return opts.chunks

  const out: TextChunk[] = []
  const highlightBg = RGBA.fromInts(39, 48, 76, 255)

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
      out.push(
        cloneChunk({
          chunk,
          overrides: {
            text: text.slice(idx, idx + needle.length),
            bg: highlightBg
          }
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
  return { service: null, line: clean, styled, key }
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
  const query = opts.query.trim().toLowerCase()
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

  return parts.join(" ").toLowerCase().includes(query)
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
  readonly stream: AsyncIterable<Uint8Array>
  readonly isActive: () => boolean
  readonly onLine: (line: string) => void
}): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""

  for await (const chunk of opts.stream) {
    if (!opts.isActive()) break
    buffer += decoder.decode(chunk, { stream: true })
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
