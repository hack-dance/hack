"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import styles from "./gateway.module.css";

interface GatewayProject {
  project_id: string;
  project_name: string;
}

interface ProjectsResponse {
  projects: GatewayProject[];
}

interface ShellResponse {
  shell: {
    shellId: string;
    status: string;
  };
}

type GatewayCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

type XTermTerminal = import("xterm").Terminal;
type XTermFitAddon = import("xterm-addon-fit").FitAddon;

export default function GatewayPage() {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:7788");
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState<GatewayProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("Idle");
  const [terminalReady, setTerminalReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<XTermFitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.project_id === projectId) ?? null,
    [projects, projectId]
  );

  useEffect(() => {
    let active = true;
    let resizeObserver: ResizeObserver | null = null;
    let disposeInput: { dispose: () => void } | null = null;

    const setupTerminal = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("xterm"),
        import("xterm-addon-fit"),
      ]);
      if (!active) {
        return;
      }

      const terminal = new Terminal({
        fontSize: 14,
        fontFamily:
          "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: {
          background: "#0b0d12",
          foreground: "#e6e8ef",
          cursor: "#9ab7ff",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      if (terminalContainerRef.current) {
        terminal.open(terminalContainerRef.current);
        fitAddon.fit();
        terminal.focus();
      }

      disposeInput = terminal.onData((data) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(JSON.stringify({ type: "input", data }));
      });

      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          })
        );
      });

      if (terminalContainerRef.current) {
        resizeObserver.observe(terminalContainerRef.current);
      }

      setTerminalReady(true);
    };

    void setupTerminal();

    return () => {
      active = false;
      resizeObserver?.disconnect();
      disposeInput?.dispose();
      wsRef.current?.close();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  const loadProjects = async () => {
    setError(null);
    setStatus("Loading projects…");
    const result = await callGateway<ProjectsResponse>({
      baseUrl,
      token,
      path: "/v1/projects",
      method: "GET",
    });
    if (!result.ok) {
      setError(formatGatewayError({ error: result.error }));
      setStatus("Idle");
      return;
    }
    const nextProjects = result.data.projects ?? [];
    setProjects(nextProjects);
    if (nextProjects.length > 0 && !projectId) {
      setProjectId(nextProjects[0]?.project_id ?? "");
    }
    setStatus("Projects loaded");
  };

  const connectShell = async () => {
    setError(null);
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!(terminal && fitAddon)) {
      setError("Terminal not ready yet.");
      return;
    }

    if (!token.trim()) {
      setError("Missing gateway token.");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Missing gateway URL.");
      return;
    }
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }

    wsRef.current?.close();
    terminal.reset();
    fitAddon.fit();

    setStatus("Creating shell…");
    const create = await callGateway<ShellResponse>({
      baseUrl,
      token,
      path: `/control-plane/projects/${projectId}/shells`,
      method: "POST",
      body: { cols: terminal.cols, rows: terminal.rows },
    });

    if (!create.ok) {
      setError(formatGatewayError({ error: create.error }));
      setStatus("Idle");
      return;
    }

    const shellId = create.data.shell?.shellId;
    if (!shellId) {
      setError("Shell create failed: missing shell id.");
      setStatus("Idle");
      return;
    }

    const wsUrl = buildWebSocketUrl({ baseUrl, shellId, projectId, token });
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("Shell connected");
      ws.send(
        JSON.stringify({
          type: "hello",
          cols: terminal.cols,
          rows: terminal.rows,
        })
      );
    };

    ws.onmessage = (event) => {
      const payload = parseMessage({ data: event.data });
      if (payload.type === "output") {
        terminal.write(payload.data);
        return;
      }
      if (payload.type === "exit") {
        setStatus(`Shell exited (${payload.exitCode ?? "unknown"})`);
        return;
      }
      if (payload.type === "text") {
        terminal.write(payload.data);
      }
    };

    ws.onerror = () => {
      setError("WebSocket error. Check the token + allowWrites.");
    };

    ws.onclose = () => {
      setStatus("Shell disconnected");
    };
  };

  const disconnectShell = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("Shell disconnected");
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.title}>Gateway Shell (MVP)</div>
        <p className={styles.subtitle}>
          Connect to the hack gateway and open a supervisor shell in your
          browser. This uses the gateway HTTP API for setup and a WebSocket for
          the PTY stream.
        </p>
      </header>

      <div className={styles.layout}>
        <section className={styles.panel}>
          <div className={styles.panelTitle}>Connection</div>
          <label className={styles.field}>
            <span className={styles.label}>Gateway URL</span>
            <input
              className={styles.input}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://gateway.example.com"
              value={baseUrl}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Gateway token (write scope)</span>
            <input
              className={styles.input}
              onChange={(event) => setToken(event.target.value)}
              placeholder="paste token"
              type="password"
              value={token}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Project</span>
            <select
              className={styles.select}
              onChange={(event) => setProjectId(event.target.value)}
              value={projectId}
            >
              {projects.length === 0 ? (
                <option value="">Load projects first</option>
              ) : (
                projects.map((project) => (
                  <option key={project.project_id} value={project.project_id}>
                    {project.project_name} ({project.project_id})
                  </option>
                ))
              )}
            </select>
          </label>
          <div className={styles.actions}>
            <button
              className={styles.button}
              onClick={loadProjects}
              type="button"
            >
              Load projects
            </button>
            <button
              className={styles.button}
              disabled={!terminalReady}
              onClick={connectShell}
              type="button"
            >
              Connect shell
            </button>
            <button
              className={`${styles.button} ${styles.buttonSecondary}`}
              onClick={disconnectShell}
              type="button"
            >
              Disconnect
            </button>
            <button
              className={`${styles.button} ${styles.buttonSecondary}`}
              onClick={() => terminalRef.current?.clear()}
              type="button"
            >
              Clear terminal
            </button>
          </div>
          <div className={styles.statusRow}>
            <div>
              Status: <span className={styles.statusValue}>{status}</span>
            </div>
            {selectedProject ? (
              <div>
                Project:{" "}
                <span className={styles.statusValue}>
                  {selectedProject.project_name}
                </span>
              </div>
            ) : null}
            {error ? <div className={styles.error}>{error}</div> : null}
          </div>
          <p className={styles.notice}>
            Browser WebSocket clients cannot set headers, so the token is sent
            in the WS query string. Treat URLs as sensitive and avoid sharing
            screenshots.
          </p>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Terminal</div>
          <div className={styles.terminalShell} ref={terminalContainerRef} />
        </section>
      </div>
    </div>
  );
}

function buildWebSocketUrl(opts: {
  baseUrl: string;
  projectId: string;
  shellId: string;
  token: string;
}): string {
  const base = new URL(opts.baseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/control-plane/projects/${opts.projectId}/shells/${opts.shellId}/stream`;
  base.searchParams.set("token", opts.token);
  return base.toString();
}

async function callGateway<T>(opts: {
  baseUrl: string;
  token: string;
  path: string;
  method: string;
  body?: unknown;
}): Promise<GatewayCallResult<T>> {
  try {
    const response = await fetch("/api/gateway", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: opts.baseUrl,
        token: opts.token,
        path: opts.path,
        method: opts.method,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      }),
    });
    const text = await response.text();
    const data = parseJson({ value: text });
    if (!response.ok) {
      const error =
        (isRecord(data) && typeof data.error === "string" && data.error) ||
        `HTTP ${response.status}`;
      return { ok: false, error };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "request_failed",
    };
  }
}

type ParsedMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "text"; data: string };

function parseMessage(opts: { data: string }): ParsedMessage {
  const raw = parseJson({ value: opts.data });
  if (!isRecord(raw)) {
    return { type: "text", data: opts.data };
  }
  if (raw.type === "output" && typeof raw.data === "string") {
    return { type: "output", data: raw.data };
  }
  if (raw.type === "exit") {
    const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : null;
    return { type: "exit", exitCode };
  }
  return { type: "text", data: opts.data };
}

function parseJson(opts: { value: string }): unknown {
  try {
    return opts.value ? JSON.parse(opts.value) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatGatewayError(opts: { error: string }): string {
  if (opts.error === "writes_disabled") {
    return "writes_disabled: enable allowWrites and restart hackd.";
  }
  if (opts.error === "write_scope_required") {
    return "write_scope_required: create a write-scoped token.";
  }
  if (opts.error === "missing_token") {
    return "missing_token: paste a gateway token.";
  }
  return opts.error;
}
