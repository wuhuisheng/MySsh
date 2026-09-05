import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import SessionManager from "./components/SessionManager";
import SessionFormModal from "./components/SessionFormModal";
import TerminalPanel from "./components/TerminalPanel";
import SftpPanel from "./components/SftpPanel";
import TransferPanel from "./components/TransferPanel";
import FilePreviewModal from "./components/FilePreviewModal";
import FileEditorModal from "./components/FileEditorModal";

import { api, b64ToUint8 } from "./services/ipc";
import type {
  ConnectInfo,
  PtyExitEvent,
  PtyOutputEvent,
  SavedSession,
  SessionSubmit,
  TerminalTab,
  TransferFinished,
  TransferProgress,
} from "./types";

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export default function App() {
  const [view, setView] = useState<"home" | "workspace">("home");
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SavedSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [conn, setConn] = useState<ConnectInfo | null>(null);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTab, setActiveTab] = useState<number | null>(null);

  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const [transfersOpen, setTransfersOpen] = useState(false);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [sftpRefreshNonce, setSftpRefreshNonce] = useState(0);

  const [sftpWidth, setSftpWidth] = useState(480);
  const [dropActive, setDropActive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  // channelId -> write function owned by each TerminalPanel
  const writers = useRef<Map<number, (data: Uint8Array) => void>>(new Map());
  // PTY output that arrived before the terminal component registered its writer
  const pendingOutput = useRef<Map<number, Uint8Array[]>>(new Map());
  // current sftp cwd, kept for drag-drop upload destination
  const sftpCwd = useRef<string>("");
  // latest connection for callbacks registered once at mount
  const connRef = useRef<ConnectInfo | null>(null);
  connRef.current = conn;

  const pushToast = useCallback((text: string, kind: "info" | "error" = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // ------------------------------------------------------------- sessions io

  const persistSessions = useCallback((list: SavedSession[]) => {
    setSessions(list);
    api.sessionsSave(list).catch((e) => console.error("failed to save sessions:", e));
  }, []);

  useEffect(() => {
    api
      .sessionsLoad()
      .then(setSessions)
      .catch((e) => console.error("failed to load sessions:", e));
  }, []);

  // ------------------------------------------------------------ event wiring

  useEffect(() => {
    // Guard against the StrictMode mount→unmount→mount cycle: listen() resolves
    // asynchronously, so a cleanup that only calls the (still undefined)
    // unlisten fn would leak the first registration — and duplicated listeners
    // make every PTY byte render twice.
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const reg = (p: Promise<UnlistenFn>) => {
      p.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });
    };

    reg(
      listen<PtyOutputEvent>("pty-output", (e) => {
        const { channelId, data } = e.payload;
        const bytes = b64ToUint8(data);
        const writer = writers.current.get(channelId);
        if (writer) {
          writer(bytes);
        } else {
          // terminal not mounted yet — buffer until it registers
          const arr = pendingOutput.current.get(channelId) ?? [];
          arr.push(bytes);
          pendingOutput.current.set(channelId, arr);
        }
      }),
    );

    reg(
      listen<PtyExitEvent>("pty-exit", (e) => {
        setTabs((tabs) =>
          tabs.map((t) => (t.channelId === e.payload.channelId ? { ...t, closed: true } : t)),
        );
      }),
    );

    reg(
      listen<TransferProgress>("transfer-progress", (e) => {
        setTransfers((list) => {
          const p = e.payload;
          const idx = list.findIndex((x) => x.transferId === p.transferId && x.path === p.path);
          if (idx >= 0) {
            const copy = [...list];
            copy[idx] = p;
            return copy;
          }
          return [p, ...list].slice(0, 200);
        });
        if (e.payload.status === "active") setTransfersOpen(true);
      }),
    );

    reg(
      listen<TransferFinished>("transfer-finished", () => {
        /* per-file statuses already carry the outcome */
      }),
    );

    // whole-window file drop uploads to the current SFTP directory
    reg(
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over" || event.payload.type === "enter") {
            setDropActive(true);
          } else if (event.payload.type === "leave") {
            setDropActive(false);
          } else if (event.payload.type === "drop") {
            setDropActive(false);
            const paths = (event.payload as { paths: string[] }).paths ?? [];
            if (paths.length && connRef.current && sftpCwd.current) {
              startUpload(paths);
            }
          }
        }),
    );

    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
    // registered once at mount: handlers read mutable refs so they never go stale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------- connect flow

  const enterWorkspace = useCallback(async (info: ConnectInfo) => {
    setConn(info);
    setTabs([]);
    setActiveTab(null);
    setTransfers([]);
    setView("workspace");
    pendingOutput.current.clear();
    const ch = await api.ptyOpen(info.sessionId, 80, 24);
    setTabs([{ channelId: ch, title: "Shell 1" }]);
    setActiveTab(ch);
  }, []);

  const connectInFlight = useRef(false);
  const handleSessionSubmit = useCallback(
    async (submit: SessionSubmit) => {
      // ignore double clicks on the card / form button while a connect runs
      if (connectInFlight.current) return;
      connectInFlight.current = true;
      setConnecting(true);
      setConnectError(null);
      try {
        const info = await api.sshConnect(submit.params);

        if (submit.saveMode !== "none") {
          const now = Date.now();
          let list: SavedSession[];
          if (submit.saveMode === "update") {
            list = sessions.map((s) =>
              s.id === submit.sessionId
                ? {
                    ...s,
                    name: submit.name,
                    host: submit.params.host,
                    port: submit.params.port,
                    username: submit.params.username,
                    authMethod: submit.params.authMethod,
                    password: submit.params.password,
                    privateKeyPath: submit.params.privateKeyPath,
                    keyPassphrase: submit.params.keyPassphrase,
                    skipHostCheck: submit.params.skipHostCheck ?? false,
                    lastConnectedAt: now,
                  }
                : s,
            );
          } else {
            list = [
              {
                id: crypto.randomUUID(),
                name: submit.name,
                host: submit.params.host,
                port: submit.params.port,
                username: submit.params.username,
                authMethod: submit.params.authMethod,
                password: submit.params.password,
                privateKeyPath: submit.params.privateKeyPath,
                keyPassphrase: submit.params.keyPassphrase,
                skipHostCheck: submit.params.skipHostCheck ?? false,
                createdAt: now,
                lastConnectedAt: now,
              },
              ...sessions,
            ];
          }
          persistSessions(list);
        }

        setFormOpen(false);
        setEditing(null);
        await enterWorkspace(info);
      } catch (e) {
        const msg = String(e);
        setConnectError(msg);
        pushToast(`连接失败：${msg}`, "error");
        // 从卡片直接连接失败时，弹出预填表单让错误可见、可修改后重试
        if (!formOpen) {
          const origin =
            submit.saveMode === "update"
              ? sessions.find((s) => s.id === submit.sessionId) ?? null
              : null;
          setEditing(origin);
          setFormOpen(true);
        }
      } finally {
        setConnecting(false);
        connectInFlight.current = false;
      }
    },
    [sessions, persistSessions, enterWorkspace, formOpen, pushToast],
  );

  const connectSaved = useCallback(
    (s: SavedSession) => {
      setConnectError(null);
      pushToast(`正在连接 ${s.host}…`);
      handleSessionSubmit({
        params: {
          host: s.host,
          port: s.port,
          username: s.username,
          authMethod: s.authMethod,
          password: s.password,
          privateKeyPath: s.privateKeyPath,
          keyPassphrase: s.keyPassphrase,
          skipHostCheck: s.skipHostCheck,
        },
        saveMode: "update",
        sessionId: s.id,
        name: s.name,
      });
    },
    [handleSessionSubmit],
  );

  const openLocalWorkspace = useCallback(async () => {
    setConnectError(null);
    setFormOpen(false);
    setEditing(null);
    if (conn?.sessionId === "local") {
      setView("workspace");
      return;
    }
    const info: ConnectInfo = {
      sessionId: "local",
      home: "~",
      host: "本机",
      port: 0,
      username: "local",
      authMethod: "local",
    };
    await enterWorkspace(info);
  }, [conn, enterWorkspace]);

  const handleDisconnect = async () => {
    if (!conn) return;
    const sid = conn.sessionId;
    setConn(null);
    setTabs([]);
    setActiveTab(null);
    setPreviewPath(null);
    setEditorPath(null);
    setTransfers([]);
    setView("home");
    sftpCwd.current = "";
    pendingOutput.current.clear();
    writers.current.clear();
    try {
      await api.sshDisconnect(sid);
    } catch {
      /* already gone */
    }
  };

  const openNewTerminal = async () => {
    if (!conn) return;
    try {
      const ch = await api.ptyOpen(conn.sessionId, 80, 24);
      setTabs((t) => [...t, { channelId: ch, title: `Shell ${t.length + 1}` }]);
      setActiveTab(ch);
    } catch (e) {
      pushToast(String(e), "error");
    }
  };

  const closeTerminal = async (channelId: number) => {
    if (!conn) return;
    setTabs((t) => {
      const next = t.filter((x) => x.channelId !== channelId);
      if (activeTab === channelId)
        setActiveTab(next.length ? next[next.length - 1].channelId : null);
      return next;
    });
    writers.current.delete(channelId);
    try {
      await api.ptyClose(conn.sessionId, channelId);
    } catch {
      /* already closed */
    }
  };

  // ------------------------------------------------------------ transfers

  const startDownload = useCallback(
    async (remotePaths: string[]) => {
      if (!conn || !remotePaths.length) return;
      try {
        const dir = await openDialog({ directory: true, title: "Download to folder" });
        if (!dir || typeof dir !== "string") return;
        await api.transferDownload(conn.sessionId, remotePaths, dir);
        setTransfersOpen(true);
        pushToast(`正在下载 ${remotePaths.length} 项到 ${dir}`);
      } catch (e) {
        pushToast(String(e), "error");
      }
    },
    [conn, pushToast],
  );

  const startUpload = useCallback(
    async (localPaths: string[]) => {
      const c = connRef.current;
      if (!c || !localPaths.length || !sftpCwd.current) return;
      try {
        await api.transferUpload(c.sessionId, localPaths, sftpCwd.current);
        setTransfersOpen(true);
        pushToast(`正在上传 ${localPaths.length} 项到 ${sftpCwd.current}`);
      } catch (e) {
        pushToast(String(e), "error");
      }
    },
    [pushToast],
  );

  const pickAndUpload = useCallback(async () => {
    try {
      const files = await openDialog({ multiple: true, title: "Select files to upload" });
      const paths = Array.isArray(files)
        ? files.filter((f): f is string => !!f)
        : files
          ? [files]
          : [];
      if (paths.length) await startUpload(paths);
    } catch (e) {
      pushToast(String(e), "error");
    }
  }, [startUpload, pushToast]);

  const cancelTransfer = useCallback(
    async (transferId: string) => {
      try {
        await api.transferCancel(transferId);
      } catch (e) {
        pushToast(String(e), "error");
      }
    },
    [pushToast],
  );

  // ---------------------------------------------------------- sftp panel resize

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sftpWidth;
    const move = (ev: MouseEvent) => {
      const w = startW + (startX - ev.clientX);
      setSftpWidth(Math.min(760, Math.max(360, w)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ------------------------------------------------------------------ render

  const activeCount = transfers.filter((t) => t.status === "active").length;

  return (
    <>
      {/* workspace stays mounted so terminals & scrollback survive switching home */}
      <div className="app" style={{ display: view === "workspace" && conn ? "flex" : "none" }}>
        {conn && (
          <>
            <header className="app-header">
          <div className="header-left">
            <button
              className="btn btn-icon"
              title="返回会话列表"
              onClick={() => setView("home")}
            >
              ⌂
            </button>
            <div className="conn-chip">
              <span className="dot" />
              <div className="conn-text">
                <strong>{conn?.sessionId === "local" ? "本地终端" : conn?.host}</strong>
                <span>
                  {conn?.sessionId === "local"
                    ? "本机 shell"
                    : `${conn?.username}@${conn?.host}:${conn?.port}`}
                </span>
              </div>
            </div>
          </div>
          <div className="app-actions">
            <button className="btn" onClick={openNewTerminal} title="打开新终端">
              ＋ 终端
            </button>
            <button
              className={"btn" + (activeCount ? " btn-accent" : "")}
              onClick={() => setTransfersOpen((v) => !v)}
            >
              ⇅ 传输 {activeCount ? `(${activeCount})` : ""}
            </button>
            <button className="btn btn-danger" onClick={handleDisconnect}>
              {conn?.sessionId === "local" ? "关闭本地终端" : "断开连接"}
            </button>
          </div>
        </header>

        <div className="app-body">
          <div className="term-area">
            <div className="term-tabs">
              {tabs.map((t) => (
                <div
                  key={t.channelId}
                  className={
                    "term-tab" +
                    (activeTab === t.channelId ? " term-tab-active" : "") +
                    (t.closed ? " term-tab-closed" : "")
                  }
                  onClick={() => setActiveTab(t.channelId)}
                >
                  <span className="term-tab-title">{t.title}</span>
                  <span
                    className="term-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(t.channelId);
                    }}
                  >
                    ×
                  </span>
                </div>
              ))}
            </div>
            <div className="term-stack">
              {tabs.map((t) => (
                <TerminalPanel
                  key={t.channelId}
                  sessionId={conn!.sessionId}
                  channelId={t.channelId}
                  active={activeTab === t.channelId && view === "workspace"}
                  closed={!!t.closed}
                  registerWriter={(fn) => {
                    writers.current.set(t.channelId, fn);
                    return () => writers.current.delete(t.channelId);
                  }}
                  drainPending={(ch) => {
                    const arr = pendingOutput.current.get(ch) ?? [];
                    pendingOutput.current.delete(ch);
                    return arr;
                  }}
                />
              ))}
              {tabs.length === 0 && (
                <div className="term-empty">
                  没有打开的终端
                  <button className="btn" onClick={openNewTerminal}>
                    打开终端
                  </button>
                </div>
              )}
            </div>
          </div>

          {conn!.sessionId !== "local" && (
            <>
              <div className="sash" onMouseDown={startResize} />

              <aside className="sftp-area" style={{ width: sftpWidth }}>
                <SftpPanel
                  sessionId={conn!.sessionId}
                  home={conn!.home}
                  refreshNonce={sftpRefreshNonce}
                  onCwdChange={(cwd) => (sftpCwd.current = cwd)}
                  onPreview={setPreviewPath}
                  onEdit={setEditorPath}
                  onDownload={startDownload}
                  onUpload={pickAndUpload}
                  onToast={pushToast}
                />
                {transfersOpen && (
                  <TransferPanel
                    items={transfers}
                    onCancel={cancelTransfer}
                    onClear={() => setTransfers([])}
                    onClose={() => setTransfersOpen(false)}
                  />
                )}
              </aside>
            </>
          )}
        </div>

        {previewPath && (
          <FilePreviewModal
            sessionId={conn!.sessionId}
            path={previewPath}
            onClose={() => setPreviewPath(null)}
            onToast={pushToast}
          />
        )}
        {editorPath && (
          <FileEditorModal
            sessionId={conn!.sessionId}
            path={editorPath}
            onClose={() => setEditorPath(null)}
            onSaved={() => setSftpRefreshNonce((n) => n + 1)}
            onToast={pushToast}
          />
        )}

        {dropActive && (
          <div className="drop-overlay">
            <div className="drop-box">松开鼠标，上传到 {sftpCwd.current}</div>
          </div>
        )}
          </>
        )}
      </div>

      {view === "home" && (
        <SessionManager
          sessions={sessions}
          liveConn={conn && view === "home" ? { host: conn.host, username: conn.username } : null}
          onConnect={connectSaved}
          onNew={() => {
            setEditing(null);
            setConnectError(null);
            setFormOpen(true);
          }}
          onEdit={(s) => {
            setEditing(s);
            setConnectError(null);
            setFormOpen(true);
          }}
          onDelete={(s) => persistSessions(sessions.filter((x) => x.id !== s.id))}
          onBackToWorkspace={() => setView("workspace")}
          onLocalTerminal={openLocalWorkspace}
        />
      )}

      {formOpen && (
        <SessionFormModal
          initial={editing}
          connecting={connecting}
          error={connectError}
          onSubmit={handleSessionSubmit}
          onToast={pushToast}
          onErrorClear={() => setConnectError(null)}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
