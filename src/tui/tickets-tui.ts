import {
  BoxRenderable,
  InputRenderable,
  RenderableEvents,
  RGBA,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  TextRenderable,
  createCliRenderer,
  createTextAttributes,
  dim,
  fg,
  t,
  type TextChunk
} from "@opentui/core"

import { createTicketsStore } from "../control-plane/extensions/tickets/store.ts"
import { gumFormat, isGumAvailable } from "../ui/gum.ts"

import type { TicketEvent, TicketSummary } from "../control-plane/extensions/tickets/store.ts"
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts"
import type { Logger } from "../ui/logger.ts"

const STATUS_LABELS: Record<string, string> = {
  open: "open",
  in_progress: "in_progress",
  blocked: "blocked",
  done: "done"
}

const STATUS_OPTIONS = ["open", "in_progress", "blocked", "done"] as const

type StatusOption = (typeof STATUS_OPTIONS)[number]

type TicketsTuiOptions = {
  readonly projectRoot: string
  readonly projectId?: string
  readonly projectName?: string
  readonly controlPlaneConfig: ControlPlaneConfig
  readonly logger: Logger
}

type MarkdownCacheEntry = {
  readonly updatedAt: string
  readonly content: StyledText | string
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

export async function runTicketsTui({
  projectRoot,
  projectId,
  projectName,
  controlPlaneConfig,
  logger
}: TicketsTuiOptions): Promise<number> {
  if (!process.stdout.isTTY) {
    logger.error({ message: "Tickets TUI requires a TTY. Run this from an interactive terminal." })
    return 1
  }

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  let running = true
  let activePane: "list" | "body" | "history" = "list"
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let detailToken = 0
  let detailTimer: ReturnType<typeof setTimeout> | null = null

  let ticketsCache: TicketSummary[] = []
  let ticketsById = new Map<string, TicketSummary>()
  let eventsByTicket = new Map<string, readonly TicketEvent[]>()

  const markdownCache = new Map<string, MarkdownCacheEntry>()

  const store = await createTicketsStore({
    projectRoot,
    projectId,
    projectName,
    controlPlaneConfig,
    logger
  })

  const shutdownRenderer = async () => {
    if (!renderer) return
    renderer.stop()
    renderer.destroy()
    renderer = null
  }

  const handleFatal = async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error"
    await shutdownRenderer()
    process.stderr.write(`Tickets TUI failed: ${message}\n`)
  }

  const handleSignal = () => {
    void shutdown()
  }

  process.on("SIGINT", handleSignal)
  process.on("SIGTERM", handleSignal)

  const shutdown = async () => {
    if (!running) return
    running = false
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (detailTimer) {
      clearTimeout(detailTimer)
      detailTimer = null
    }
    process.off("SIGINT", handleSignal)
    process.off("SIGTERM", handleSignal)
    await shutdownRenderer()
  }

  try {
    process.env.OTUI_USE_CONSOLE = "false"
    const activeRenderer = await createCliRenderer({
      targetFps: 30,
      exitOnCtrlC: false,
      useConsole: false,
      openConsoleOnError: false,
      useAlternateScreen: true,
      useMouse: true
    })
    renderer = activeRenderer
    activeRenderer.setBackgroundColor("#0f111a")

    const root = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#0f111a"
    })

    const header = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-header",
      width: "100%",
      height: 3,
      minHeight: 3,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      backgroundColor: "#141b2d"
    })

    const headerText = new TextRenderable(activeRenderer, {
      id: "tickets-tui-header-text",
      content: buildHeaderLabel({ projectName })
    })

    header.add(headerText)

    const main = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-main",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1
    })

    const listBox = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-list",
      width: "35%",
      minWidth: 28,
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#131829",
      title: "Tickets",
      titleAlignment: "left",
      flexDirection: "column"
    })

    const ticketsSelect = new SelectRenderable(activeRenderer, {
      id: "tickets-tui-list-select",
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
      showDescription: true,
      showScrollIndicator: false,
      wrapSelection: true,
      options: [{ name: "Loading tickets...", description: "", value: null }]
    })

    listBox.add(ticketsSelect)

    const detailBox = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-detail",
      flexGrow: 1,
      border: false,
      flexDirection: "column",
      gap: 1
    })

    const metaBox = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-meta",
      width: "100%",
      minHeight: 8,
      height: 8,
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#141b2d",
      title: "Ticket",
      titleAlignment: "left",
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1
    })

    const metaText = new TextRenderable(activeRenderer, {
      id: "tickets-tui-meta-text",
      content: t`${dim("Select a ticket to view details.")}`
    })

    metaBox.add(metaText)

    const bodyBox = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-body",
      width: "100%",
      flexGrow: 1,
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#0f111a",
      title: "Body",
      titleAlignment: "left"
    })

    const bodyScroll = new ScrollBoxRenderable(activeRenderer, {
      id: "tickets-tui-body-scroll",
      flexGrow: 1,
      rootOptions: { backgroundColor: "#0f111a" },
      wrapperOptions: { backgroundColor: "#0f111a" },
      viewportOptions: { backgroundColor: "#0f111a" },
      contentOptions: { backgroundColor: "#0f111a" },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: "#3b4160",
          backgroundColor: "#151a2a"
        }
      }
    })

    const bodyText = new WrappedTextRenderable(activeRenderer, {
      id: "tickets-tui-body-text",
      width: "100%",
      wrapMode: "word",
      content: "",
      selectable: true,
      selectionBg: "#2b3355",
      selectionFg: "#e6f1ff"
    })

    bodyScroll.add(bodyText)
    bodyBox.add(bodyScroll)

    const historyBox = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-history",
      width: "100%",
      minHeight: 8,
      height: 8,
      border: true,
      borderColor: "#4a5374",
      backgroundColor: "#121520",
      title: "History",
      titleAlignment: "left"
    })

    const historyScroll = new ScrollBoxRenderable(activeRenderer, {
      id: "tickets-tui-history-scroll",
      flexGrow: 1,
      rootOptions: { backgroundColor: "#121520" },
      wrapperOptions: { backgroundColor: "#121520" },
      viewportOptions: { backgroundColor: "#121520" },
      contentOptions: { backgroundColor: "#121520" },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: "#3b4160",
          backgroundColor: "#151a2a"
        }
      }
    })

    const historyText = new WrappedTextRenderable(activeRenderer, {
      id: "tickets-tui-history-text",
      width: "100%",
      wrapMode: "word",
      content: "",
      selectable: true,
      selectionBg: "#2b3355",
      selectionFg: "#e6f1ff"
    })

    historyScroll.add(historyText)
    historyBox.add(historyScroll)

    detailBox.add(metaBox)
    detailBox.add(bodyBox)
    detailBox.add(historyBox)

    const footer = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-footer",
      width: "100%",
      height: 3,
      minHeight: 3,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      backgroundColor: "#141828",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 2
    })

    const footerShortcutsText = new TextRenderable(activeRenderer, {
      id: "tickets-tui-footer-shortcuts",
      content: ""
    })

    const footerToastText = new TextRenderable(activeRenderer, {
      id: "tickets-tui-footer-toast",
      content: ""
    })

    footer.add(footerShortcutsText)
    footer.add(footerToastText)

    const overlay = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-overlay",
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
      shouldFill: true
    })

    const overlayPanel = new BoxRenderable(activeRenderer, {
      id: "tickets-tui-overlay-panel",
      width: "70%",
      maxWidth: 100,
      border: true,
      borderColor: "#2f344a",
      backgroundColor: "#141828",
      padding: 1,
      flexDirection: "column",
      gap: 1,
      shouldFill: true
    })

    const overlayTitle = new TextRenderable(activeRenderer, {
      id: "tickets-tui-overlay-title",
      content: ""
    })

    const overlayHint = new TextRenderable(activeRenderer, {
      id: "tickets-tui-overlay-hint",
      content: t`${dim("Enter to confirm | Esc to cancel | Tab to move")}`
    })

    const overlayStatus = new TextRenderable(activeRenderer, {
      id: "tickets-tui-overlay-status",
      content: t`${dim("Ready")}`
    })

    const titleLabel = new TextRenderable(activeRenderer, {
      id: "tickets-tui-new-title-label",
      content: t`${dim("Title")}`
    })

    const titleInput = new InputRenderable(activeRenderer, {
      id: "tickets-tui-new-title-input",
      width: "100%",
      height: 1,
      backgroundColor: "#0f111a",
      focusedBackgroundColor: "#141c2a",
      textColor: "#c0caf5",
      focusedTextColor: "#c0caf5",
      placeholder: "Short title",
      placeholderColor: "#5c637a"
    })

    const overlayFieldBorderColor = "#2f344a"
    const overlayFieldFocusBorderColor = "#7dcfff"

    const wrapOverlayInput = (opts: { readonly id: string; readonly child: InputRenderable }) => {
      const frame = new BoxRenderable(activeRenderer, {
        id: opts.id,
        width: "100%",
        height: 3,
        border: true,
        borderColor: overlayFieldBorderColor,
        backgroundColor: "#0f111a",
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
        shouldFill: true
      })
      frame.add(opts.child)
      return frame
    }

    const bindOverlayFieldFocus = (opts: {
      readonly field: InputRenderable
      readonly frame: BoxRenderable
    }) => {
      opts.field.on(RenderableEvents.FOCUSED, () => {
        opts.frame.borderColor = overlayFieldFocusBorderColor
        opts.frame.requestRender()
      })
      opts.field.on(RenderableEvents.BLURRED, () => {
        opts.frame.borderColor = overlayFieldBorderColor
        opts.frame.requestRender()
      })
    }

    const titleInputFrame = wrapOverlayInput({
      id: "tickets-tui-new-title-frame",
      child: titleInput
    })

    const bodyLabel = new TextRenderable(activeRenderer, {
      id: "tickets-tui-new-body-label",
      content: t`${dim("Body")}`
    })

    const bodyInput = new InputRenderable(activeRenderer, {
      id: "tickets-tui-new-body-input",
      width: "100%",
      height: 1,
      backgroundColor: "#0f111a",
      focusedBackgroundColor: "#141c2a",
      textColor: "#c0caf5",
      focusedTextColor: "#c0caf5",
      placeholder: "Optional summary (one line)",
      placeholderColor: "#5c637a"
    })

    const bodyInputFrame = wrapOverlayInput({
      id: "tickets-tui-new-body-frame",
      child: bodyInput
    })

    const statusSelectLabel = new TextRenderable(activeRenderer, {
      id: "tickets-tui-status-label",
      content: t`${dim("Status")}`
    })

    const statusSelect = new SelectRenderable(activeRenderer, {
      id: "tickets-tui-status-select",
      width: "100%",
      height: 4,
      backgroundColor: "#0f111a",
      focusedBackgroundColor: "#0f111a",
      textColor: "#c7d0ff",
      focusedTextColor: "#c7d0ff",
      selectedBackgroundColor: "#1f2540",
      selectedTextColor: "#9ad7ff",
      descriptionColor: "#6b7390",
      selectedDescriptionColor: "#7ea0d6",
      showDescription: false,
      showScrollIndicator: false,
      wrapSelection: true,
      options: STATUS_OPTIONS.map(value => ({ name: STATUS_LABELS[value] ?? value, value, description: "" }))
    })

    const overlayState = {
      mode: "none" as "none" | "new" | "status",
      focusIndex: 0,
      focusables: [] as Array<InputRenderable | SelectRenderable>
    }

    overlayPanel.add(overlayTitle)
    overlayPanel.add(overlayHint)
    overlayPanel.add(titleLabel)
    overlayPanel.add(titleInputFrame)
    overlayPanel.add(bodyLabel)
    overlayPanel.add(bodyInputFrame)
    overlayPanel.add(statusSelectLabel)
    overlayPanel.add(statusSelect)
    overlayPanel.add(overlayStatus)

    overlay.add(overlayPanel)

    root.add(header)
    root.add(main)
    root.add(footer)
    root.add(overlay)

    main.add(listBox)
    main.add(detailBox)

    activeRenderer.root.add(root)

    bindOverlayFieldFocus({ field: titleInput, frame: titleInputFrame })
    bindOverlayFieldFocus({ field: bodyInput, frame: bodyInputFrame })

    const setToast = (opts: { readonly message: string; readonly tone?: "info" | "warn" }) => {
      if (toastTimer) clearTimeout(toastTimer)
      const tone = opts.tone ?? "info"
      footerToastText.content =
        tone === "warn" ? t`${fg("#e0af68")(`${opts.message}`)}` : t`${fg("#7dcfff")(`${opts.message}`)}`
      footer.requestRender()
      toastTimer = setTimeout(() => {
        footerToastText.content = ""
        footer.requestRender()
      }, 3000)
    }

    const renderFooter = () => {
      const parts = [
        t`${fg("#9ad7ff")("n")}${dim(":new")}`,
        t`${fg("#9ad7ff")("s")}${dim(":status")}`,
        t`${fg("#9ad7ff")("r")}${dim(":refresh")}`,
        t`${fg("#9ad7ff")("tab")}${dim(":switch")}`,
        t`${fg("#9ad7ff")("q")}${dim(":quit")}`
      ]
      footerShortcutsText.content = joinStyledText({ parts, separator: "  " })
      footer.requestRender()
    }

    const setActivePane = (pane: "list" | "body" | "history") => {
      activePane = pane
      listBox.borderColor = pane === "list" ? "#7dcfff" : "#4a5374"
      bodyBox.borderColor = pane === "body" ? "#7dcfff" : "#4a5374"
      historyBox.borderColor = pane === "history" ? "#7dcfff" : "#4a5374"
      listBox.requestRender()
      bodyBox.requestRender()
      historyBox.requestRender()
    }

    const focusPane = (pane: "list" | "body" | "history") => {
      if (pane === "list") {
        ticketsSelect.focus()
      } else if (pane === "body") {
        bodyScroll.focus()
      } else {
        historyScroll.focus()
      }
    }

    const focusNextPane = (direction: number) => {
      const panes: Array<"list" | "body" | "history"> = ["list", "body", "history"]
      const idx = panes.indexOf(activePane)
      const next = ((idx + direction) % panes.length + panes.length) % panes.length
      const nextPane = panes[next] ?? "list"
      setActivePane(nextPane)
      focusPane(nextPane)
    }

    const selectedTicketId = () => {
      return ticketsSelect.getSelectedOption()?.value ?? null
    }

    const formatTicketRow = (ticket: TicketSummary) => {
      const updated = formatTimestamp(ticket.updatedAt)
      const label = STATUS_LABELS[ticket.status] ?? ticket.status
      const title = ticket.title || "(untitled)"
      return {
        name: `${ticket.ticketId} [${label}] ${title}`,
        description: updated,
        value: ticket.ticketId
      }
    }

    const updateTicketsList = (tickets: TicketSummary[]) => {
      if (tickets.length === 0) {
        ticketsSelect.options = [{ name: "No tickets yet.", description: "", value: null }]
        ticketsSelect.setSelectedIndex(0)
        return
      }

      const options = tickets.map(formatTicketRow)
      const current = selectedTicketId()
      ticketsSelect.options = options
      const idx = current ? options.findIndex(option => option.value === current) : 0
      ticketsSelect.setSelectedIndex(idx >= 0 ? idx : 0)
    }

    const renderMeta = (ticket: TicketSummary | null) => {
      if (!ticket) {
        metaText.content = t`${dim("Select a ticket to view details.")}`
        return
      }

      const meta = ticket.body ? parseTicketBodyMeta({ body: ticket.body }) : emptyTicketBodyMeta()
      const created = formatTimestamp(ticket.createdAt)
      const updated = formatTimestamp(ticket.updatedAt)
      const status = STATUS_LABELS[ticket.status] ?? ticket.status
      const dependencies = renderDependencyMeta({
        dependsOn: ticket.dependsOn,
        blocks: ticket.blocks
      })
      const lines = [
        t`${fg("#9ad7ff")(`${ticket.ticketId}`)} ${fg("#c0caf5")(`${ticket.title}`)}`,
        t`${dim(`status: ${status}`)}`,
        ...dependencies,
        ...renderMetaExtras(meta),
        t`${dim(`created: ${created}`)}`,
        t`${dim(`updated: ${updated}`)}`,
        ...(ticket.projectName ? [t`${dim(`project: ${ticket.projectName}`)}`] : []),
        ...(ticket.projectId ? [t`${dim(`project id: ${ticket.projectId}`)}`] : [])
      ]

      metaText.content = joinStyledText({ parts: lines, separator: "\n" })
    }

    const renderBody = async (opts: { readonly ticket: TicketSummary | null; readonly token: number }) => {
      const ticket = opts.ticket
      if (!ticket || !ticket.body) {
        bodyText.content = ticket ? t`${dim("No body provided.")}` : t`${dim("Select a ticket.")}`
        bodyText.syncWrapWidth()
        return
      }

      const cacheKey = ticket.ticketId
      const cached = markdownCache.get(cacheKey)
      if (cached && cached.updatedAt === ticket.updatedAt) {
        bodyText.content = cached.content
        bodyText.syncWrapWidth()
        return
      }

      const normalized = normalizeTicketBody({ body: ticket.body })
      const rendered = await renderMarkdown({ markdown: normalized })
      if (opts.token !== detailToken) return

      markdownCache.set(cacheKey, { updatedAt: ticket.updatedAt, content: rendered })
      bodyText.content = rendered
      bodyText.syncWrapWidth()
    }

    const renderHistory = (events: readonly TicketEvent[]) => {
      if (events.length === 0) {
        historyText.content = t`${dim("No history yet.")}`
        historyText.syncWrapWidth()
        return
      }
      const lines = events.map(formatEventLine)
      historyText.content = lines.join("\n")
      historyText.syncWrapWidth()
    }

    const refreshDetails = async () => {
      const token = ++detailToken
      const ticketId = selectedTicketId()
      if (!ticketId) {
        renderMeta(null)
        await renderBody({ ticket: null, token })
        renderHistory([])
        return
      }

      const ticket = ticketsById.get(ticketId) ?? null
      renderMeta(ticket)
      await renderBody({ ticket, token })
      if (token !== detailToken) return
      const events = eventsByTicket.get(ticketId) ?? []
      renderHistory(events)
    }

    const refreshTickets = async () => {
      const snapshot = await store.readSnapshot()
      ticketsCache = [...snapshot.tickets]
      ticketsById = new Map(ticketsCache.map(ticket => [ticket.ticketId, ticket]))
      eventsByTicket = new Map(snapshot.eventsByTicket)
      updateTicketsList(ticketsCache)
      await refreshDetails()
    }

    const scheduleRefreshDetails = () => {
      if (detailTimer) clearTimeout(detailTimer)
      detailTimer = setTimeout(() => {
        detailTimer = null
        void refreshDetails()
      }, 80)
    }

    const openOverlay = (mode: "new" | "status") => {
      overlay.visible = true
      overlay.requestRender()
      overlayState.mode = mode
      overlayState.focusIndex = 0
      overlayStatus.content = t`${dim("Ready")}`

      if (mode === "new") {
        overlayTitle.content = t`${fg("#9ad7ff")("New ticket")}`
        titleLabel.visible = true
        titleInputFrame.visible = true
        bodyLabel.visible = true
        bodyInputFrame.visible = true
        statusSelectLabel.visible = false
        statusSelect.visible = false
        titleInput.value = ""
        bodyInput.value = ""
        overlayState.focusables = [titleInput, bodyInput]
      } else {
        overlayTitle.content = t`${fg("#9ad7ff")("Update status")}`
        titleLabel.visible = false
        titleInputFrame.visible = false
        bodyLabel.visible = false
        bodyInputFrame.visible = false
        statusSelectLabel.visible = true
        statusSelect.visible = true
        const current = selectedTicketId()
        if (current) {
          void store.getTicket({ ticketId: current }).then(ticket => {
            const idx = STATUS_OPTIONS.findIndex(value => value === ticket?.status)
            statusSelect.setSelectedIndex(idx >= 0 ? idx : 0)
          })
        }
        overlayState.focusables = [statusSelect]
      }

      overlayState.focusables[0]?.focus()
    }

    const closeOverlay = () => {
      overlay.visible = false
      overlayState.mode = "none"
      overlayState.focusables = []
      overlay.requestRender()
      setActivePane(activePane)
      focusPane(activePane)
    }

    const submitOverlay = async () => {
      if (overlayState.mode === "new") {
        const title = titleInput.value.trim()
        const body = bodyInput.value.trim()
        if (!title) {
          overlayStatus.content = t`${fg("#e0af68")("Title is required.")}`
          return
        }

        overlayStatus.content = t`${fg("#7dcfff")("Creating ticket...")}`
        const created = await store.createTicket({
          title,
          body: body.length > 0 ? body : undefined
        })

        if (!created.ok) {
          overlayStatus.content = t`${fg("#f7768e")(`${created.error}`)}`
          return
        }

        closeOverlay()
        await refreshTickets()
        const index = ticketsSelect.options.findIndex(option => option.value === created.ticket.ticketId)
        ticketsSelect.setSelectedIndex(index >= 0 ? index : 0)
        setToast({ message: `Created ${created.ticket.ticketId}` })
        return
      }

      if (overlayState.mode === "status") {
        const ticketId = selectedTicketId()
        if (!ticketId) {
          overlayStatus.content = t`${fg("#e0af68")("Select a ticket first.")}`
          return
        }

        const next = statusSelect.getSelectedOption()?.value as StatusOption | undefined
        if (!next) {
          overlayStatus.content = t`${fg("#e0af68")("Select a status.")}`
          return
        }

        overlayStatus.content = t`${fg("#7dcfff")("Updating status...")}`
        const updated = await store.setStatus({ ticketId, status: next })
        if (!updated.ok) {
          overlayStatus.content = t`${fg("#f7768e")(`${updated.error}`)}`
          return
        }

        closeOverlay()
        await refreshTickets()
        setToast({ message: `Updated ${ticketId} -> ${next}` })
      }
    }

    ticketsSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
      scheduleRefreshDetails()
    })

    ticketsSelect.on(RenderableEvents.FOCUSED, () => {
      setActivePane("list")
    })

    bodyScroll.on(RenderableEvents.FOCUSED, () => {
      setActivePane("body")
    })

    historyScroll.on(RenderableEvents.FOCUSED, () => {
      setActivePane("history")
    })

    renderFooter()
    setActivePane("list")

    activeRenderer.keyInput.on("keypress", key => {
      if (overlayState.mode !== "none") {
        if (key.name === "escape") {
          key.preventDefault()
          closeOverlay()
          return
        }
        if (key.name === "tab") {
          key.preventDefault()
          const total = overlayState.focusables.length
          if (total === 0) return
          const next = (overlayState.focusIndex + (key.shift ? -1 : 1) + total) % total
          overlayState.focusIndex = next
          overlayState.focusables[next]?.focus()
          return
        }
        if (key.name === "enter" || key.name === "return" || key.name === "linefeed") {
          key.preventDefault()
          void submitOverlay()
          return
        }
        return
      }

      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        key.preventDefault()
        void shutdown()
        return
      }

      if (key.name === "tab") {
        key.preventDefault()
        focusNextPane(key.shift ? -1 : 1)
        return
      }

      if (key.name === "n" && !key.ctrl && !key.meta) {
        key.preventDefault()
        openOverlay("new")
        return
      }

      if (key.name === "s" && !key.ctrl && !key.meta) {
        key.preventDefault()
        openOverlay("status")
        return
      }

      if (key.name === "r" && !key.ctrl && !key.meta) {
        key.preventDefault()
        void refreshTickets().then(() => setToast({ message: "Refreshed tickets" }))
      }
    })

    await refreshTickets()
    setActivePane(activePane)
    ticketsSelect.focus()
    activeRenderer.start()

    return await new Promise<number>(resolve => {
      const interval = setInterval(() => {
        if (!running) {
          clearInterval(interval)
          resolve(0)
        }
      }, 100)
    })
  } catch (error: unknown) {
    await handleFatal(error)
    return 1
  }
}

function buildHeaderLabel(opts: { readonly projectName?: string }): StyledText {
  if (!opts.projectName) {
    return t`${fg("#9ad7ff")("tickets")}${dim(" | hack")}`
  }
  return t`${fg("#9ad7ff")("tickets")}${dim(` | ${opts.projectName}`)}`
}

function joinStyledText(opts: { readonly parts: StyledText[]; readonly separator?: string }): StyledText {
  if (opts.parts.length === 0) return new StyledText([])
  const first = opts.parts[0]
  if (opts.parts.length === 1 && first) return first

  const chunks: TextChunk[] = []
  const separator = opts.separator ?? " "
  for (const part of opts.parts) {
    chunks.push(...part.chunks)
    if (part !== opts.parts[opts.parts.length - 1]) {
      chunks.push({ __isChunk: true, text: separator })
    }
  }
  return new StyledText(chunks)
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const mins = String(date.getMinutes()).padStart(2, "0")
  return `${year}-${month}-${day} ${hours}:${mins}`
}

function formatEventLine(event: TicketEvent): string {
  const timestamp = formatTimestamp(event.tsIso)
  const actor = event.actor ? ` ${event.actor}` : ""
  if (event.type === "ticket.status_changed") {
    const next = typeof event.payload["status"] === "string" ? event.payload["status"] : ""
    return `${timestamp} status -> ${next}${actor}`
  }
  if (event.type === "ticket.updated") {
    return `${timestamp} updated${actor}`
  }
  if (event.type === "ticket.created") {
    return `${timestamp} created${actor}`
  }
  return `${timestamp} ${event.type}${actor}`
}

async function renderMarkdown(opts: {
  readonly markdown: string
}): Promise<StyledText | string> {
  const trimmed = opts.markdown.trim()
  if (trimmed.length === 0) return ""

  if (!isGumAvailable()) {
    return trimmed
  }

  const formatted = await gumFormat({
    input: trimmed,
    type: "markdown",
    theme: "dark",
    stripAnsi: false
  })

  if (!formatted.ok) {
    return trimmed
  }

  const parsed = parseAnsiStyledText(formatted.value)
  return new StyledText(parsed.chunks)
}

function normalizeTicketBody(opts: { readonly body: string }): string {
  if (!opts.body.includes("\\n") || opts.body.includes("\n")) {
    return opts.body
  }
  return opts.body.replaceAll("\\n", "\n")
}

type TicketBodyMeta = {
  readonly links: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly priority?: string
}

type MutableTicketBodyMeta = {
  links: string[]
  acceptanceCriteria: string[]
  priority?: string
}

function emptyTicketBodyMeta(): TicketBodyMeta {
  return {
    links: [],
    acceptanceCriteria: [],
    priority: undefined
  }
}

function parseTicketBodyMeta(opts: { readonly body: string }): TicketBodyMeta {
  const meta: MutableTicketBodyMeta = {
    links: [],
    acceptanceCriteria: [],
    priority: undefined
  }

  const normalized = normalizeTicketBody({ body: opts.body })
  const lines = normalized.split("\n")
  let inCodeBlock = false
  let section: "links" | "acceptance" | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headingMatch) {
      const heading = normalizeHeading(headingMatch[1] ?? "")
      section = resolveMetaSection(heading)
      continue
    }

    if (!meta.priority) {
      const priorityMatch = line.match(/^priority\s*:\s*(.+)$/i)
      if (priorityMatch?.[1]) {
        meta.priority = priorityMatch[1].trim()
        continue
      }
    }

    if (!section || line.length === 0) continue

    const listItem = extractListItem({ line })
    if (!listItem) continue

    if (section === "links") {
      const link = extractLinkLabel({ text: listItem }) ?? listItem
      meta.links.push(link)
    } else {
      meta.acceptanceCriteria.push(listItem)
    }
  }

  return {
    links: uniqueNonEmpty(meta.links),
    acceptanceCriteria: uniqueNonEmpty(meta.acceptanceCriteria),
    priority: meta.priority
  }
}

function renderMetaExtras(meta: TicketBodyMeta): StyledText[] {
  const extras: StyledText[] = []
  const priority = meta.priority ? meta.priority.trim() : ""
  if (priority) {
    extras.push(t`${dim("priority: ")}${fg("#c0caf5")(`${priority}`)}`)
  }

  const linksSummary = summarizeMetaItems({ items: meta.links, maxItems: 3 })
  if (linksSummary) {
    extras.push(t`${dim("links: ")}${fg("#9ad7ff")(`${linksSummary}`)}`)
  }

  const acceptanceSummary = summarizeMetaItems({ items: meta.acceptanceCriteria, maxItems: 3 })
  if (acceptanceSummary) {
    extras.push(t`${dim("acceptance: ")}${fg("#c0caf5")(`${acceptanceSummary}`)}`)
  }

  return extras
}

function renderDependencyMeta(opts: {
  readonly dependsOn: readonly string[]
  readonly blocks: readonly string[]
}): StyledText[] {
  const extras: StyledText[] = []
  const dependsSummary = summarizeMetaItems({ items: opts.dependsOn, maxItems: 3 })
  if (dependsSummary) {
    extras.push(t`${dim("depends on: ")}${fg("#e0af68")(`${dependsSummary}`)}`)
  }
  const blocksSummary = summarizeMetaItems({ items: opts.blocks, maxItems: 3 })
  if (blocksSummary) {
    extras.push(t`${dim("blocks: ")}${fg("#9ece6a")(`${blocksSummary}`)}`)
  }
  return extras
}

function resolveMetaSection(heading: string): "links" | "acceptance" | null {
  if (!heading) return null
  if (heading === "links" || heading === "link" || heading === "references" || heading === "reference") {
    return "links"
  }
  if (
    heading === "acceptance criteria" ||
    heading === "acceptance-criteria" ||
    heading === "acceptance" ||
    heading === "criteria" ||
    heading === "ac"
  ) {
    return "acceptance"
  }
  return null
}

function extractListItem(opts: { readonly line: string }): string | null {
  const checkbox = opts.line.match(/^\s*[-*]\s*\[(?:x| )\]\s+(.+)$/i)
  if (checkbox?.[1]) return checkbox[1].trim()

  const bullet = opts.line.match(/^\s*[-*]\s+(.+)$/)
  if (bullet?.[1]) return bullet[1].trim()

  const ordered = opts.line.match(/^\s*\d+\.\s+(.+)$/)
  if (ordered?.[1]) return ordered[1].trim()

  if (looksLikeUrl(opts.line)) return opts.line.trim()
  return null
}

function extractLinkLabel(opts: { readonly text: string }): string | null {
  const match = opts.text.match(/\[([^\]]+)\]\(([^)]+)\)/)
  if (match?.[1]) return match[1].trim()
  if (match?.[2]) return match[2].trim()
  return null
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ")
}

function summarizeMetaItems(opts: { readonly items: readonly string[]; readonly maxItems: number }): string {
  const cleaned = uniqueNonEmpty(opts.items)
  if (cleaned.length === 0) return ""
  const limited = cleaned.slice(0, Math.max(1, opts.maxItems))
  const suffix =
    cleaned.length > limited.length ? ` (+${cleaned.length - limited.length})` : ""
  return `${limited.join(", ")}${suffix}`
}

function uniqueNonEmpty(items: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const value = raw.trim()
    if (!value) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
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

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

function normalizePlainText(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  return normalized.replaceAll(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
}
