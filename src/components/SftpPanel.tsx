import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatBytes, formatTime, joinRemote, parentRemote, permissionsToRwx } from "../services/ipc";
import type { FileEntry } from "../types";

interface Props {
  sessionId: string;
  home: string;
  refreshNonce: number;
  onCwdChange: (cwd: string) => void;
  onPreview: (path: string) => void;
  onEdit: (path: string) => void;
  onDownload: (paths: string[]) => void;
  onUpload: () => void;
  onToast: (text: string, kind?: "info" | "error") => void;
}

interface MenuState {
  x: number;
  y: number;
  entry: FileEntry;
}

function iconFor(e: FileEntry): string {
  if (e.isDir) return "📁";
  if (e.isSymlink) return "🔗";
  const n = e.name.toLowerCase();
  if (/\.(zip|tar|gz|tgz|bz2|7z|rar|jar|apk)$/.test(n)) return "📦";
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(n)) return "🖼️";
  if (/\.(mp3|wav|flac|m4a)$/.test(n)) return "🎵";
  if (/\.(mp4|mkv|mov|avi|webm)$/.test(n)) return "🎬";
  if (/\.(sh|py|js|ts|rs|go|c|cpp|h|java|rb|php|lua|pl)$/.test(n)) return "📜";
  if (/\.(json|yaml|yml|toml|ini|conf|xml|env|properties)$/.test(n)) return "⚙️";
  if (/\.(md|txt|log|csv)$/.test(n)) return "📄";
  return "📃";
}

export default function SftpPanel({
  sessionId,
  home,
  refreshNonce,
  onCwdChange,
  onPreview,
  onEdit,
  onDownload,
  onUpload,
  onToast,
}: Props) {
  const [cwd, setCwd] = useState(home);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [creating, setCreating] = useState<"dir" | "file" | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const anchor = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onCwdChange(cwd);
  }, [cwd, onCwdChange]);

  const load = useCallback(
    async (dir: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.sftpList(sessionId, dir);
        setEntries(list);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    load(cwd);
  }, [cwd, refreshNonce, load]);

  const navigate = (dir: string) => {
    setSelected(new Set());
    setRenaming(null);
    setCwd(dir);
  };

  const goUp = () => {
    const p = parentRemote(cwd);
    if (p !== null) navigate(p);
  };

  const isSelected = (path: string) => selected.has(path);

  const selectWithModifiers = (entry: FileEntry, index: number, ev: React.MouseEvent) => {
    if (ev.metaKey || ev.ctrlKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      anchor.current = index;
    } else if (ev.shiftKey && anchor.current !== null) {
      const [a, b] = [anchor.current, index].sort((x, y) => x - y);
      setSelected(new Set(entries.slice(a, b + 1).map((e) => e.path)));
    } else {
      setSelected(new Set([entry.path]));
      anchor.current = index;
    }
  };

  const openEntry = (entry: FileEntry) => {
    if (entry.isDir) {
      navigate(entry.path);
    } else {
      onPreview(entry.path);
    }
  };

  const selectedPaths = useMemo(
    () => entries.filter((e) => selected.has(e.path)).map((e) => e.path),
    [entries, selected],
  );

  const menuEntryIsSelected = menu ? isSelected(menu.entry.path) : false;

  const doDelete = async (paths: string[]) => {
    try {
      await api.sftpRemove(sessionId, paths);
      onToast(`已删除 ${paths.length} 个项目`);
      setConfirmDelete(null);
      setSelected(new Set());
      load(cwd);
    } catch (e) {
      onToast(String(e), "error");
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { path, name } = renaming;
    const trimmed = name.trim();
    setRenaming(null);
    if (!trimmed) return;
    const dir = parentRemote(path) ?? cwd;
    const newPath = joinRemote(dir, trimmed);
    if (newPath === path) return;
    try {
      await api.sftpRename(sessionId, path, newPath);
      load(cwd);
    } catch (e) {
      onToast(String(e), "error");
    }
  };

  const commitCreate = async () => {
    const trimmed = creatingName.trim();
    const kind = creating;
    setCreating(null);
    setCreatingName("");
    if (!trimmed || !kind) return;
    const target = joinRemote(cwd, trimmed);
    try {
      if (kind === "dir") await api.sftpMkdir(sessionId, target);
      else await api.sftpTouch(sessionId, target);
      load(cwd);
    } catch (e) {
      onToast(String(e), "error");
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      onToast("路径已复制");
    } catch {
      onToast(path);
    }
  };

  // close the context menu on any click / Escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (renaming || creating) return;
    if (ev.key === "Delete" && selectedPaths.length) {
      setConfirmDelete(selectedPaths);
    } else if (ev.key === "Enter" && selectedPaths.length === 1) {
      const entry = entries.find((e) => e.path === selectedPaths[0]);
      if (entry) openEntry(entry);
    } else if (ev.key === "Backspace") {
      goUp();
    }
  };

  const crumbs = useMemo(() => {
    const parts = cwd.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += "/" + p;
      out.push({ label: p, path: acc });
    }
    return out;
  }, [cwd]);

  return (
    <div className="sftp-panel" onKeyDown={onKeyDown} tabIndex={0}>
      <div className="sftp-toolbar">
        <button className="btn btn-icon" title="上级目录" onClick={goUp} disabled={cwd === "/"}>
          ↑
        </button>
        <button className="btn btn-icon" title="主目录" onClick={() => navigate(home)}>
          ⌂
        </button>
        <button className="btn btn-icon" title="刷新" onClick={() => load(cwd)}>
          ⟳
        </button>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb">
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className="crumb-btn" onClick={() => navigate(c.path)}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="sftp-actions">
        <button className="btn" onClick={onUpload} title="上传文件">
          ⬆ 上传
        </button>
        <button
          className="btn"
          disabled={!selectedPaths.length}
          onClick={() => onDownload(selectedPaths)}
          title="下载所选"
        >
          ⬇ 下载
        </button>
        <span className="spacer" />
        <button className="btn btn-icon" title="新建文件夹" onClick={() => setCreating("dir")}>
          📁+
        </button>
        <button className="btn btn-icon" title="新建文件" onClick={() => setCreating("file")}>
          📄+
        </button>
        <button
          className="btn btn-icon"
          title="删除所选"
          disabled={!selectedPaths.length}
          onClick={() => setConfirmDelete(selectedPaths)}
        >
          🗑
        </button>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      <div className="sftp-list" ref={listRef}>
        <div className="sftp-head">
          <span className="col-name">Name</span>
          <span className="col-size">Size</span>
          <span className="col-mtime">Modified</span>
          <span className="col-perms">Perms</span>
        </div>
        {loading && <div className="sftp-status">加载中…</div>}
        {!loading && entries.length === 0 && !creating && (
          <div className="sftp-status">空目录</div>
        )}

        {creating && (
          <div className="sftp-row creating">
            <span className="col-name">
              {creating === "dir" ? "📁" : "📄"}
              <input
                autoFocus
                className="inline-input"
                value={creatingName}
                placeholder={creating === "dir" ? "文件夹名称" : "文件名称"}
                onChange={(e) => setCreatingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreate();
                  if (e.key === "Escape") {
                    setCreating(null);
                    setCreatingName("");
                  }
                }}
                onBlur={commitCreate}
                spellCheck={false}
              />
            </span>
            <span className="col-size" />
            <span className="col-mtime" />
            <span className="col-perms" />
          </div>
        )}

        {entries.map((entry, i) => {
          const sel = isSelected(entry.path);
          const isRenaming = renaming?.path === entry.path;
          return (
            <div
              key={entry.path}
              className={"sftp-row" + (sel ? " selected" : "")}
              onClick={(ev) => selectWithModifiers(entry, i, ev)}
              onDoubleClick={() => openEntry(entry)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                if (!isSelected(entry.path)) {
                  setSelected(new Set([entry.path]));
                  anchor.current = i;
                }
                setMenu({ x: ev.clientX, y: ev.clientY, entry });
              }}
            >
              <span className="col-name">
                <span className="file-icon">{iconFor(entry)}</span>
                {isRenaming ? (
                  <input
                    autoFocus
                    className="inline-input"
                    value={renaming.name}
                    onChange={(e) => setRenaming({ path: entry.path, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={commitRename}
                    spellCheck={false}
                  />
                ) : (
                  <span className="file-name" title={entry.path}>
                    {entry.name}
                    {entry.isSymlink ? " →" : ""}
                  </span>
                )}
              </span>
              <span className="col-size">{entry.isDir ? "—" : formatBytes(entry.size)}</span>
              <span className="col-mtime">{formatTime(entry.mtime)}</span>
              <span className="col-perms">{permissionsToRwx(entry.permissions)}</span>
            </div>
          );
        })}
      </div>

      <div className="sftp-foot">
        {entries.filter((e) => !e.isDir).length} 个文件 · {entries.filter((e) => e.isDir).length} 个文件夹
        {selected.size > 0 && ` · 已选 ${selected.size} 项`}
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 190), top: menu.y }}
        >
          {menu.entry.isDir ? (
            <button
              className="ctx-item"
              onClick={() => {
                navigate(menu.entry.path);
                setMenu(null);
              }}
            >
              打开
            </button>
          ) : (
            <button
              className="ctx-item"
              onClick={() => {
                onPreview(menu.entry.path);
                setMenu(null);
              }}
            >
              预览
            </button>
          )}
          {!menu.entry.isDir && (
            <button
              className="ctx-item"
              onClick={() => {
                onEdit(menu.entry.path);
                setMenu(null);
              }}
            >
              编辑
            </button>
          )}
          <button
            className="ctx-item"
            onClick={() => {
              const paths = menuEntryIsSelected ? selectedPaths : [menu.entry.path];
              onDownload(paths);
              setMenu(null);
            }}
          >
            下载
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setRenaming({ path: menu.entry.path, name: menu.entry.name });
              setMenu(null);
            }}
          >
            重命名
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              copyPath(menu.entry.path);
              setMenu(null);
            }}
          >
            复制路径
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item ctx-danger"
            onClick={() => {
              const paths = menuEntryIsSelected ? selectedPaths : [menu.entry.path];
              setConfirmDelete(paths);
              setMenu(null);
            }}
          >
            Delete…
          </button>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmDelete(null)}>
          <div className="modal modal-sm" onMouseDown={(e) => e.stopPropagation()}>
            <h3>确认删除 {confirmDelete.length} 个项目？</h3>
            <p className="muted">
              {confirmDelete.length === 1
                ? confirmDelete[0]
                : confirmDelete.slice(0, 5).join("\n") + (confirmDelete.length > 5 ? `\n… +${confirmDelete.length - 5} more` : "")}
            </p>
            <p className="warn-text">文件夹将被递归删除，此操作不可恢复。</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
              <button className="btn btn-danger" onClick={() => doDelete(confirmDelete)}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
