import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import DeployKeyModal from "./DeployKeyModal";
import type { SavedSession, SessionSubmit } from "../types";

interface Props {
  /** null = create a new session */
  initial: SavedSession | null;
  connecting: boolean;
  error: string | null;
  onSubmit: (submit: SessionSubmit) => void;
  onClose: () => void;
  onToast: (text: string, kind?: "info" | "error") => void;
  /** clears the stale connect error shown in the form */
  onErrorClear: () => void;
}

type AuthMethod = "password" | "key" | "auto";

const AUTH_LABELS: Record<AuthMethod, string> = {
  auto: "自动",
  password: "密码",
  key: "私钥",
};

export default function SessionFormModal({
  initial,
  connecting,
  error,
  onSubmit,
  onClose,
  onToast,
  onErrorClear,
}: Props) {
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(initial?.authMethod ?? "auto");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [privateKeyPath, setPrivateKeyPath] = useState(initial?.privateKeyPath ?? "");
  const [keyPassphrase, setKeyPassphrase] = useState(initial?.keyPassphrase ?? "");
  const [skipHostCheck, setSkipHostCheck] = useState(initial?.skipHostCheck ?? false);
  const [saveChecked, setSaveChecked] = useState(true);
  const [name, setName] = useState(initial?.name ?? "");
  const [deployOpen, setDeployOpen] = useState(false);

  /** connection params as currently filled in the form, for key deployment */
  const currentParams = {
    host: host.trim(),
    port,
    username: username.trim(),
    authMethod,
    password: password || undefined,
    privateKeyPath: privateKeyPath.trim() || undefined,
    keyPassphrase: keyPassphrase || undefined,
    skipHostCheck: skipHostCheck || undefined,
  };

  // a previous failed attempt's error goes stale as soon as the user edits
  // any field (e.g. filling in the key path it complains about)
  useEffect(() => {
    onErrorClear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, username, authMethod, password, privateKeyPath, keyPassphrase, skipHostCheck]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedHost = host.trim();
    const trimmedUser = username.trim();
    const finalName = (name.trim() || `${trimmedUser}@${trimmedHost}`).slice(0, 80);
    const saveMode = saveChecked ? (initial ? "update" : "create") : "none";
    onSubmit({
      params: {
        host: trimmedHost,
        port,
        username: trimmedUser,
        authMethod,
        password: password || undefined,
        privateKeyPath: privateKeyPath.trim() || undefined,
        keyPassphrase: keyPassphrase || undefined,
        skipHostCheck: skipHostCheck || undefined,
      },
      saveMode,
      sessionId: initial?.id,
      name: finalName,
    });
  };

  const browseKey = async () => {
    const file = await openDialog({ multiple: false, title: "选择私钥文件" });
    if (typeof file === "string") setPrivateKeyPath(file);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-form" onMouseDown={(e) => e.stopPropagation()}>
        <form className="connect-card in-modal" onSubmit={submit}>
          <h2>{initial ? "编辑会话" : "新建会话"}</h2>
          <p className="card-sub">
            {initial ? `更新「${initial.name}」` : "连接信息将保存在本机。"}
          </p>

          <label>
            会话名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="留空则自动使用 用户名@主机"
              spellCheck={false}
            />
          </label>

          <div className="form-row">
            <label className="flex2">
              主机
              <input
                autoFocus
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10 或 example.com"
                spellCheck={false}
              />
            </label>
            <label className="flex1">
              端口
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
              />
            </label>
          </div>

          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
              spellCheck={false}
            />
          </label>

          <div className="field-label">认证方式</div>
          <div className="seg">
            {(["auto", "password", "key"] as AuthMethod[]).map((m) => (
              <button
                type="button"
                key={m}
                className={"seg-item" + (authMethod === m ? " seg-on" : "")}
                onClick={() => setAuthMethod(m)}
              >
                {AUTH_LABELS[m]}
              </button>
            ))}
          </div>

          {authMethod !== "key" && (
            <label>
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={authMethod === "auto" ? "使用密钥时可不填" : "必填"}
                autoComplete="off"
              />
            </label>
          )}

          {authMethod !== "password" && (
            <>
              <label>
                私钥文件
                <div className="key-row">
                  <input
                    value={privateKeyPath}
                    onChange={(e) => setPrivateKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    spellCheck={false}
                  />
                  <button type="button" className="btn" onClick={browseKey}>
                    浏览…
                  </button>
                </div>
              </label>
              <label>
                私钥口令
                <input
                  type="password"
                  value={keyPassphrase}
                  onChange={(e) => setKeyPassphrase(e.target.value)}
                  placeholder="可选"
                  autoComplete="off"
                />
              </label>
            </>
          )}

          <div className="deploy-entry">
            <button
              type="button"
              className="btn btn-block"
              onClick={() => setDeployOpen(true)}
              disabled={!host.trim() || !username.trim()}
              title="用当前连接信息登录服务器，把本机公钥写入 authorized_keys"
            >
              🔑 部署公钥到服务器…
            </button>
            <p className="muted deploy-hint">
              部署完成后可将认证方式改为「私钥 / 自动」，实现免密码登录。
            </p>
          </div>

          <label className="checkbox-row checkbox-warn">
            <input
              type="checkbox"
              checked={skipHostCheck}
              onChange={(e) => setSkipHostCheck(e.target.checked)}
            />
            跳过主机密钥检查（不安全）
          </label>
          {skipHostCheck && (
            <div className="field-note">
              将不再核对 ~/.ssh/known_hosts，任何服务器密钥都会被接受，仅建议在测试环境或首次排查密钥问题时开启。
            </div>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={saveChecked}
              onChange={(e) => setSaveChecked(e.target.checked)}
            />
            {initial ? "更新此保存的会话" : "保存到会话列表"}
          </label>

          {deployOpen && (
        <DeployKeyModal
          params={currentParams}
          onClose={() => setDeployOpen(false)}
          onToast={onToast}
        />
      )}

      {error && <div className="connect-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={connecting}>
              取消
            </button>
            <button className="btn btn-primary" type="submit" disabled={connecting}>
              {connecting ? (
                <>
                  <span className="spinner" /> 连接中…
                </>
              ) : (
                "连接"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
