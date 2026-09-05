import { useMemo } from "react";
import { formatBytes } from "../services/ipc";
import type { TransferProgress } from "../types";

interface Props {
  items: TransferProgress[];
  onCancel: (transferId: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** Bottom panel listing every file transfer with live progress. */
export default function TransferPanel({ items, onCancel, onClear, onClose }: Props) {
  const batches = useMemo(() => {
    const m = new Map<string, TransferProgress[]>();
    for (const it of items) {
      const arr = m.get(it.transferId) ?? [];
      arr.push(it);
      m.set(it.transferId, arr);
    }
    return [...m.entries()].reverse();
  }, [items]);

  const activeIds = new Set(items.filter((i) => i.status === "active").map((i) => i.transferId));

  return (
    <div className="transfer-panel">
      <div className="transfer-head">
        <strong>传输任务</strong>
        <span className="muted">
          {items.filter((i) => i.status === "active").length} 个进行中 · 共 {items.length} 项
        </span>
        <span className="spacer" />
        <button className="btn btn-icon" title="清空列表" onClick={onClear}>
          ⌫
        </button>
        <button className="btn btn-icon" title="收起面板" onClick={onClose}>
          ▾
        </button>
      </div>
      <div className="transfer-list">
        {items.length === 0 && <div className="sftp-status">暂无传输任务</div>}
        {batches.map(([tid, files]) => (
          <div key={tid} className="transfer-batch">
            <div className="transfer-batch-head">
              <span>
                {files[0].direction === "download" ? "⬇ 下载" : "⬆ 上传"} · {files.length} 个文件
              </span>
              {activeIds.has(tid) && (
                <button className="btn btn-mini" onClick={() => onCancel(tid)}>
                  取消
                </button>
              )}
            </div>
            {files.map((f) => (
              <div key={f.path + f.name} className={"transfer-row status-" + f.status}>
                <span className="transfer-name" title={f.path}>
                  {f.name}
                </span>
                <div className="transfer-bar">
                  <div
                    className="transfer-bar-fill"
                    style={{
                      width: f.total ? `${Math.min(100, (f.transferred / f.total) * 100)}%` : "0%",
                    }}
                  />
                </div>
                <span className="transfer-meta">
                  {f.status === "active" &&
                    `${formatBytes(f.transferred)} / ${formatBytes(f.total)}`}
                  {f.status === "done" && "✓ 完成"}
                  {f.status === "cancelled" && "已取消"}
                  {f.status === "error" && `✗ ${f.error ?? "失败"}`}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
