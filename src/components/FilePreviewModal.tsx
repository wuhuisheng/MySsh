import { useEffect, useState } from "react";
import LazyMonacoEditor from "./LazyMonacoEditor";
import { api, formatBytes } from "../services/ipc";
import type { ArchiveEntry, ArchiveEntryContent, PreviewResult } from "../types";

interface Props {
  sessionId: string;
  path: string;
  onClose: () => void;
  onToast: (text: string, kind?: "info" | "error") => void;
}

/** Read-only preview: text/code with syntax highlighting, images, archive listing. */
export default function FilePreviewModal({ sessionId, path, onClose, onToast }: Props) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entryContent, setEntryContent] = useState<ArchiveEntryContent | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setResult(null);
    setError(null);
    setEntryContent(null);
    setSelectedEntry(null);
    api
      .sftpPreviewFile(sessionId, path)
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, path]);

  const openArchiveEntry = async (entry: ArchiveEntry) => {
    if (entry.isDir) return;
    if (result?.kind !== "archive") return;
    setSelectedEntry(entry.path);
    setEntryContent(null);
    setEntryLoading(true);
    try {
      const c = await api.sftpReadArchiveEntry(sessionId, path, entry.path);
      setEntryContent(c);
    } catch (e) {
      onToast(String(e), "error");
    } finally {
      setEntryLoading(false);
    }
  };

  const sizeLabel =
    result && result.kind !== "unsupported" ? ` · ${formatBytes(result.size)}` : "";

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-lg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <strong>文件预览</strong>
            <span className="muted" title={path}>
              {path}
              {sizeLabel}
            </span>
          </div>
          <button className="btn btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="sftp-error">{error}</div>}
          {!error && !result && <div className="sftp-status">加载中…</div>}

          {result?.kind === "text" && (
            <>
              {result.truncated && (
                <div className="notice">文件共 {formatBytes(result.size)}，仅显示前 1 MB</div>
              )}
              <LazyMonacoEditor
                height="100%"
                language={result.language}
                value={result.content}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: true },
                  fontSize: 13,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: "off",
                  renderWhitespace: "none",
                }}
              />
            </>
          )}

          {result?.kind === "image" && (
            <div className="image-view">
              <img src={`data:${result.mime};base64,${result.dataB64}`} alt={path} />
            </div>
          )}

          {result?.kind === "archive" && (
            <div className="archive-view">
              <div className="archive-list">
                {result.entries.map((entry) => (
                  <div
                    key={entry.path}
                    className={"archive-row" + (selectedEntry === entry.path ? " selected" : "")}
                    onClick={() => openArchiveEntry(entry)}
                  >
                    <span>{entry.isDir ? "📁" : "📄"}</span>
                    <span className="file-name" title={entry.path}>
                      {entry.path}
                    </span>
                    <span className="muted">{entry.isDir ? "" : formatBytes(entry.size)}</span>
                  </div>
                ))}
                {result.entries.length === 0 && (
                  <div className="sftp-status">压缩包为空</div>
                )}
              </div>
              <div className="archive-content">
                {entryLoading && <div className="sftp-status">正在加载条目…</div>}
                {entryContent && (
                  <>
                    {entryContent.truncated && (
                      <div className="notice">条目内容在 2 MB 处截断</div>
                    )}
                    <LazyMonacoEditor
                      height="100%"
                      value={entryContent.content}
                      theme="vs-dark"
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        fontSize: 13,
                        automaticLayout: true,
                        wordWrap: "on",
                      }}
                    />
                  </>
                )}
                {!entryLoading && !entryContent && (
                  <div className="sftp-status">
                    选择压缩包内的文本文件进行查看
                  </div>
                )}
              </div>
            </div>
          )}

          {result?.kind === "unsupported" && (
            <div className="unsupported-view">
              <p>😠</p>
              <p>{result.reason}</p>
              <p className="muted">可在左侧 SFTP 面板中下载此文件查看。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
