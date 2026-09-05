import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../services/ipc";
import type { ConnectParams, DeployResult, LocalPubKey } from "../types";

interface Props {
  /** connection credentials taken from the session form */
  params: ConnectParams;
  onClose: () => void;
  onToast: (text: string, kind?: "info" | "error") => void;
}

type Source = "local" | "paste";

/** Deploy a local public key to the remote server's authorized_keys. */
export default function DeployKeyModal({ params, onClose, onToast }: Props) {
  const [localKeys, setLocalKeys] = useState<LocalPubKey[]>([]);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [source, setSource] = useState<Source>("local");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listLocalPubkeys()
      .then((keys) => {
        setLocalKeys(keys);
        setSelectedPath(keys[0]?.path ?? null);
        if (keys.length === 0) setSource("paste");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLocalLoaded(true));
  }, []);

  const selectedContent = useMemo(() => {
    if (source === "paste") return pasted.trim();
    return localKeys.find((k) => k.path === selectedPath)?.content ?? "";
  }, [source, pasted, localKeys, selectedPath]);

  const browse = async () => {
    const file = await openDialog({
      multiple: false,
      title: "选择公钥文件（*.pub）",
      filters: [{ name: "公钥文件", extensions: ["pub"] }],
    });
    if (typeof file !== "string") return;
    try {
      const key = await api.readPubkeyFile(file);
      setLocalKeys((keys) => [...keys.filter((k) => k.path !== key.path), key]);
      setSelectedPath(key.path);
      setSource("local");
    } catch (e) {
      onToast(String(e), "error");
    }
  };

  const deploy = async () => {
    if (!selectedContent) {
      setError("请先选择本地公钥或粘贴公钥内容");
      return;
    }
    setDeploying(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.deployPublicKey(params, selectedContent);
      setResult(r);
      onToast(r.added ? "公钥部署成功" : "该公钥已存在于服务器");
    } catch (e) {
      setError(String(e));
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-form" onMouseDown={(e) => e.stopPropagation()}>
        <div className="deploy-body">
          <h2>部署公钥到服务器</h2>
          <p className="card-sub">
            将公钥追加到 <code>~/.ssh/authorized_keys</code>，之后即可免密码登录。
          </p>

          <div className="deploy-conn muted">
            {params.username}@{params.host}:{params.port} — 使用当前表单的
            {params.authMethod === "key" ? "私钥" : params.authMethod === "password" ? "密码" : "自动（密钥 → 密码）"}
            认证
          </div>

          <div className="field-label">公钥来源</div>
          <div className="seg">
            <button
              type="button"
              className={"seg-item" + (source === "local" ? " seg-on" : "")}
              disabled={localLoaded && localKeys.length === 0}
              onClick={() => setSource("local")}
            >
              本地公钥
            </button>
            <button
              type="button"
              className={"seg-item" + (source === "paste" ? " seg-on" : "")}
              onClick={() => setSource("paste")}
            >
              选择文件 / 粘贴
            </button>
          </div>

          {source === "local" && (
            <div className="deploy-list">
              {localKeys.map((k) => (
                <label key={k.path} className={"deploy-row" + (selectedPath === k.path ? " selected" : "")}>
                  <input
                    type="radio"
                    name="pubkey"
                    checked={selectedPath === k.path}
                    onChange={() => setSelectedPath(k.path)}
                  />
                  <span className="deploy-name" title={k.path}>
                    {k.path.split("/").pop()}
                  </span>
                  <span className="deploy-preview">{k.content.slice(0, 40)}…</span>
                </label>
              ))}
              {!localLoaded && <div className="sftp-status">正在扫描 ~/.ssh…</div>}
              {localLoaded && localKeys.length === 0 && (
                <div className="sftp-status">未在 ~/.ssh 下找到 *.pub 文件</div>
              )}
            </div>
          )}

          {source === "paste" && (
            <>
              <div className="paste-row">
                <button type="button" className="btn" onClick={browse}>
                  选择 .pub 文件…
                </button>
                <span className="muted">或直接粘贴下方</span>
              </div>
              <textarea
                className="paste-area"
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… user@host"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={4}
                spellCheck={false}
              />
            </>
          )}

          {selectedContent && (
            <div className="field-note ok-note">
              将部署 {selectedContent.split("\n").filter((l) => l.trim()).length} 条公钥：
              {" " + selectedContent.slice(0, 60)}
              {selectedContent.length > 60 ? "…" : ""}
            </div>
          )}

          {error && <div className="connect-error">{error}</div>}

          {result && (
            <div className={"deploy-result " + (result.added ? "ok" : "warn")}>
              {result.added
                ? `✓ 已添加到 ${result.authorizedKeysPath}（现共 ${result.totalKeys} 条）`
                : `该公钥已存在于服务器（${result.authorizedKeysPath}），无需重复添加`}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={deploying}>
              关闭
            </button>
            <button
              className="btn btn-primary"
              onClick={deploy}
              disabled={deploying || !selectedContent}
            >
              {deploying ? (
                <>
                  <span className="spinner" /> 部署中…
                </>
              ) : (
                "开始部署"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
