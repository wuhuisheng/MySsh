import { useMemo, useState } from "react";
import type { SavedSession } from "../types";

interface Props {
  sessions: SavedSession[];
  liveConn: { host: string; username: string } | null;
  onConnect: (session: SavedSession) => void;
  onNew: () => void;
  onEdit: (session: SavedSession) => void;
  onDelete: (session: SavedSession) => void;
  onBackToWorkspace: () => void;
}

function timeAgo(ms?: number): string {
  if (!ms) return "从未连接";
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString();
}

function authBadge(s: SavedSession): { label: string; cls: string } {
  if (s.authMethod === "password") return { label: "密码", cls: "badge-yellow" };
  if (s.authMethod === "key") return { label: "密钥", cls: "badge-cyan" };
  return { label: "自动", cls: "badge-violet" };
}

const FEATURES = [
  { icon: "⌨️", text: "交互式 PTY 终端" },
  { icon: "🗂️", text: "SFTP 文件浏览器，10 路并行传输" },
  { icon: "👁️", text: "预览代码、图片与压缩包" },
  { icon: "✏️", text: "远程文件编辑，语法高亮" },
];

export default function SessionManager({
  sessions,
  liveConn,
  onConnect,
  onNew,
  onEdit,
  onDelete,
  onBackToWorkspace,
}: Props) {
  const [query, setQuery] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sessions.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.host.toLowerCase().includes(q) ||
            s.username.toLowerCase().includes(q),
        )
      : sessions;
    return [...list].sort((a, b) => {
      const ta = a.lastConnectedAt ?? 0;
      const tb = b.lastConnectedAt ?? 0;
      if (ta !== tb) return tb - ta;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }, [sessions, query]);

  return (
    <div className="home-screen">
      <div className="brand-glow glow-a" />
      <div className="brand-glow glow-b" />

      <header className="home-header">
        <div className="home-logo">
          <img src="/app-icon.png" width={34} height={34} alt="" />
          <span className="home-title">SShDesk</span>
        </div>

        {liveConn && (
          <button className="btn btn-accent" onClick={onBackToWorkspace}>
            ● {liveConn.host} — 返回工作区
          </button>
        )}

        <span className="spacer" />
        <input
          className="home-search"
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <button className="btn btn-primary" onClick={onNew}>
          ＋ 新建会话
        </button>
      </header>

      <main className="home-body">
        <div className="home-section-title">
          会话
          <span className="muted"> · 已保存 {sessions.length} 个</span>
        </div>

        {sessions.length === 0 ? (
          <div className="home-empty">
            <img src="/app-icon.png" width={72} height={72} alt="" />
            <h2>还没有会话</h2>
            <p>创建第一个会话，即刻解锁：</p>
            <ul>
              {FEATURES.map((f) => (
                <li key={f.text}>
                  <span>{f.icon}</span> {f.text}
                </li>
              ))}
            </ul>
            <button className="btn btn-primary" onClick={onNew}>
              ＋ 创建第一个会话
            </button>
          </div>
        ) : (
          <div className="session-grid">
            <button className="new-card" onClick={onNew}>
              <span className="new-card-plus">＋</span>
              <span>新建会话</span>
            </button>

            {filtered.map((s) => {
              const badge = authBadge(s);
              return (
                <div key={s.id} className="session-card">
                  <div className="card-top">
                    <span className="card-name" title={s.name}>
                      {s.name}
                    </span>
                    <span className={"badge " + badge.cls}>{badge.label}</span>
                  </div>
                  <div className="card-host">
                    {s.username}@<span>{s.host}</span>
                    <em>:{s.port}</em>
                  </div>
                  <div className="card-meta">
                    <span title="最近连接">◷ {timeAgo(s.lastConnectedAt)}</span>
                    {s.password && <span title="已记住密码">● 已存密码</span>}
                  </div>
                  <div className="card-actions">
                    <button className="btn btn-primary btn-mini" onClick={() => onConnect(s)}>
                      连接
                    </button>
                    <button
                      className="btn btn-icon btn-mini"
                      title="编辑会话"
                      onClick={() => onEdit(s)}
                    >
                      ✎
                    </button>
                    {confirmId === s.id ? (
                      <>
                        <button
                          className="btn btn-mini btn-danger"
                          onClick={() => {
                            onDelete(s);
                            setConfirmId(null);
                          }}
                        >
                          确认删除
                        </button>
                        <button className="btn btn-mini" onClick={() => setConfirmId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-icon btn-mini"
                        title="删除会话"
                        onClick={() => setConfirmId(s.id)}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
