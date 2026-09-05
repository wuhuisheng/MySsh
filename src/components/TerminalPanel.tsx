import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { api, textToBytes } from "../services/ipc";

interface Props {
  sessionId: string;
  channelId: number;
  active: boolean;
  closed: boolean;
  registerWriter: (fn: (data: Uint8Array) => void) => () => void;
  /** output that arrived before this component mounted, keyed to our channel */
  drainPending: (channelId: number) => Uint8Array[];
  /** increments when the toolbar search button is pressed */
  searchRequest: number;
}

export default function TerminalPanel({
  sessionId,
  channelId,
  active,
  closed,
  registerWriter,
  drainPending,
  searchRequest,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const lastDims = useRef({ cols: 0, rows: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#16161e",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightWhite: "#c0caf5",
      },
      scrollback: 10000,
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(hostRef.current);
    term.attachCustomKeyEventHandler((ev) => {
      // Ctrl/Cmd+F opens the search bar; Cmd+C with selection copies
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "f" && ev.type === "keydown") {
        setSearchOpen(true);
        return false;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "c" && term.hasSelection()) return false;
      return true;
    });

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const disposer = registerWriter((data) => term.write(data));

    // replay any output that was emitted before the writer was registered
    // (e.g. the shell prompt, which is often sent immediately after pty_open)
    for (const chunk of drainPending(channelId)) {
      term.write(chunk);
    }

    const dataSub = term.onData((data) => {
      api.ptyWrite(sessionId, channelId, textToBytes(data)).catch(() => {
        term.write("\r\n\x1b[31m[连接已断开]\x1b[0m\r\n");
      });
    });

    const tryFit = () => {
      try {
        fit.fit();
        const { cols, rows } = term;
        if (cols !== lastDims.current.cols || rows !== lastDims.current.rows) {
          lastDims.current = { cols, rows };
          api.ptyResize(sessionId, channelId, cols, rows).catch(() => {});
        }
      } catch {
        /* element hidden — skip */
      }
    };
    tryFit();

    const ro = new ResizeObserver(() => tryFit());
    ro.observe(hostRef.current);
    const focusOnClick = () => term.focus();
    hostRef.current.addEventListener("mousedown", focusOnClick);

    return () => {
      // dispose the WebGL renderer FIRST: xterm destroys addons in reverse
      // registration order, and SearchAddon's dispose throws if the renderer
      // is already gone. Everything is guarded so a failure here can never
      // blank the whole app.
      try {
        syncWebGL(false);
      } catch {
        /* ignore */
      }
      try {
        ro.disconnect();
      } catch {
        /* ignore */
      }
      try {
        hostRef.current?.removeEventListener("mousedown", focusOnClick);
      } catch {
        /* ignore */
      }
      try {
        dataSub.dispose();
      } catch {
        /* ignore */
      }
      try {
        search.dispose();
      } catch {
        /* ignore */
      }
      try {
        disposer();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      searchRef.current = null;
      webglRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, channelId]);

  // focus the search input whenever the bar opens
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
    else termRef.current?.focus();
  }, [searchOpen]);

  // toolbar search button: only the visible tab reacts
  useEffect(() => {
    if (searchRequest > 0 && active) setSearchOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRequest]);

  const doSearch = (dir: "next" | "prev") => {
    if (!searchText || !searchRef.current) return;
    if (dir === "next") searchRef.current.findNext(searchText, { caseSensitive: false });
    else searchRef.current.findPrevious(searchText, { caseSensitive: false });
  };

  const closeSearch = () => {
    try {
      searchRef.current?.clearDecorations();
    } catch {
      /* ignore */
    }
    setSearchOpen(false);
  };

  // WebGL renderer: loaded only while the tab is visible (contexts are a
  // limited browser resource); falls back to the canvas renderer on failure
  const syncWebGL = (on: boolean) => {
    const term = termRef.current;
    if (!term) return;
    if (on && !webglRef.current) {
      try {
        const w = new WebglAddon();
        w.onContextLoss(() => {
          try {
            w.dispose();
          } catch {
            /* ignore */
          }
          if (webglRef.current === w) webglRef.current = null;
        });
        term.loadAddon(w);
        webglRef.current = w;
      } catch {
        webglRef.current = null;
      }
    } else if (!on && webglRef.current) {
      try {
        webglRef.current.dispose();
      } catch {
        /* ignore */
      }
      webglRef.current = null;
    }
  };

  // re-fit when this tab becomes visible again
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        syncWebGL(true);
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
        termRef.current?.focus();
      });
    } else {
      syncWebGL(false);
    }
  }, [active]);

  return (
    <div
      ref={hostRef}
      className="term-host"
      style={{ display: active ? "block" : "none" }}
      aria-hidden={!active}
    >
      {searchOpen && (
        <div className="term-search" onMouseDown={(e) => e.stopPropagation()}>
          <input
            ref={searchInputRef}
            value={searchText}
            placeholder="搜索终端内容…"
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doSearch(e.shiftKey ? "prev" : "next");
              if (e.key === "Escape") closeSearch();
            }}
            spellCheck={false}
          />
          <button className="btn btn-mini" title="上一个 (Shift+Enter)" onClick={() => doSearch("prev")}>
            ↑
          </button>
          <button className="btn btn-mini" title="下一个 (Enter)" onClick={() => doSearch("next")}>
            ↓
          </button>
          <button className="btn btn-mini" title="关闭 (Esc)" onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}
      {closed && active && (
        <div className="term-closed-overlay">
          <div>
            <p>会话已结束</p>
            <p className="muted">请关闭此标签页，或打开一个新终端。</p>
          </div>
        </div>
      )}
    </div>
  );
}
