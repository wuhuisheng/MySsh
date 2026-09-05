import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
}

export default function TerminalPanel({
  sessionId,
  channelId,
  active,
  closed,
  registerWriter,
  drainPending,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastDims = useRef({ cols: 0, rows: 0 });

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
    term.loadAddon(fit);
    term.open(hostRef.current);
    term.attachCustomKeyEventHandler((ev) => {
      // let the app handle copy/paste shortcuts; paste is delivered through onData
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "c" && term.hasSelection()) return false;
      return true;
    });

    termRef.current = term;
    fitRef.current = fit;

    const disposer = registerWriter((data) => term.write(data));

    // replay any output that was emitted before the writer was registered
    // (e.g. the shell prompt, which is often sent immediately after pty_open)
    for (const chunk of drainPending(channelId)) {
      term.write(chunk);
    }

    const dataSub = term.onData((data) => {
      api.ptyWrite(sessionId, channelId, textToBytes(data)).catch(() => {
        term.write("\r\n\x1b[31m[connection lost]\x1b[0m\r\n");
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
      ro.disconnect();
      hostRef.current?.removeEventListener("mousedown", focusOnClick);
      dataSub.dispose();
      disposer();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, channelId]);

  // re-fit when this tab becomes visible again
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
        termRef.current?.focus();
      });
    }
  }, [active]);

  return (
    <div
      ref={hostRef}
      className="term-host"
      style={{ display: active ? "block" : "none" }}
      aria-hidden={!active}
    >
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
