use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use russh::client::{self, Handle};
use russh::keys::known_hosts::learn_known_hosts_path;
use russh::keys::{check_known_hosts_path, load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Commands that the frontend can push into a running PTY loop.
pub enum PtyCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

/// Payload of the `pty-output` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPayload {
    pub channel_id: u32,
    /// base64-encoded bytes from the remote
    pub data: String,
}

/// Payload of the `pty-exit` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitPayload {
    pub channel_id: u32,
}

/// Connection parameters accepted by `ssh_connect`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key" | "auto"
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub key_passphrase: Option<String>,
    /// accept any server host key without checking ~/.ssh/known_hosts
    pub skip_host_check: bool,
}

impl Default for ConnectParams {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_method: "auto".to_string(),
            password: None,
            private_key_path: None,
            key_passphrase: None,
            skip_host_check: false,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub session_id: String,
    pub home: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
}

/// russh client handler: verifies the server host key against ~/.ssh/known_hosts
/// using trust-on-first-use semantics.
struct SshHandler {
    host: String,
    port: u16,
    /// when set, accept any host key without consulting known_hosts
    skip_host_check: bool,
    /// set when the server key is rejected, so connect() can surface a clear error
    reject_reason: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        if self.skip_host_check {
            return Ok(true);
        }
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            // OpenSSH certificates are not matched against known_hosts here
            PublicKeyOrCertificate::Certificate(_) => return Ok(true),
        };
        let Some(home) = dirs::home_dir() else {
            return Ok(true);
        };
        let kh = home.join(".ssh").join("known_hosts");
        if !kh.exists() {
            // no known_hosts file yet: record and trust
            let _ = learn_known_hosts_path(&self.host, self.port, &key, &kh);
            return Ok(true);
        }
        match check_known_hosts_path(&self.host, self.port, &key, &kh) {
            Ok(true) => Ok(true),
            Ok(false) => {
                // host seen for the first time: trust on first use
                let _ = learn_known_hosts_path(&self.host, self.port, &key, &kh);
                Ok(true)
            }
            Err(_) => {
                *self.reject_reason.lock().unwrap() = Some(format!(
                    "主机密钥校验失败（{}:{}）：~/.ssh/known_hosts 中记录的密钥与服务器当前密钥不一致，可能存在中间人攻击风险。如确认服务器密钥已更换，请删除 known_hosts 中对应行后重试。",
                    self.host, self.port
                ));
                Ok(false)
            }
        }
    }
}

/// A live SSH connection with lazily-created SFTP and zero or more PTYs.
pub struct SshConnection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    handle: Handle<SshHandler>,
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    ptys: Mutex<HashMap<u32, mpsc::UnboundedSender<PtyCommand>>>,
    next_channel: AtomicU32,
}

impl SshConnection {
    /// Returns the shared SFTP session, creating it on first use.
    pub async fn sftp(&self) -> Result<Arc<SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("SFTP 子系统启动失败（服务器可能不支持 SFTP）")?;
        let sftp = Arc::new(sftp);
        *guard = Some(sftp.clone());
        Ok(sftp)
    }

    pub fn pty_sender(&self, channel_id: u32) -> Option<mpsc::UnboundedSender<PtyCommand>> {
        self.ptys.lock().unwrap().get(&channel_id).cloned()
    }

    pub fn close_pty(&self, channel_id: u32) {
        self.ptys.lock().unwrap().remove(&channel_id);
    }

    pub async fn shutdown(&self) {
        // dropping the senders ends the PTY loops
        self.ptys.lock().unwrap().clear();
        if let Some(sftp) = self.sftp.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(3), sftp.close()).await;
        }
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "client closed", "en")
            .await;
    }
}

/// Establish a connection and authenticate. Returns a ready-to-use connection.
pub async fn connect(params: &ConnectParams) -> Result<SshConnection> {
    if params.host.trim().is_empty() {
        return Err(anyhow!("请填写主机地址"));
    }
    if params.username.trim().is_empty() {
        return Err(anyhow!("请填写用户名"));
    }

    let reject_reason = Arc::new(Mutex::new(None));
    let handler = SshHandler {
        host: params.host.clone(),
        port: params.port,
        skip_host_check: params.skip_host_check,
        reject_reason: reject_reason.clone(),
    };

    let config = Arc::new(client::Config {
        // detect dead connections (NAT timeouts, cable pulls) instead of
        // hanging forever: probe every 30s, give up after 3 unanswered
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let connect_fut = client::connect(config, (params.host.as_str(), params.port), handler);

    let mut handle = match tokio::time::timeout(Duration::from_secs(20), connect_fut).await {
        Err(_) => return Err(anyhow!("连接 {}:{} 超时（20 秒），请检查地址与网络", params.host, params.port)),
        Ok(Err(e)) => {
            if let Some(reason) = reject_reason.lock().unwrap().take() {
                return Err(anyhow!(reason));
            }
            return Err(anyhow!("无法连接 {}:{}：{}", params.host, params.port, e));
        }
        Ok(Ok(handle)) => handle,
    };

    let auth_ok = authenticate(&mut handle, params).await?;
    if !auth_ok {
        return Err(anyhow!(
            "认证失败：{}@{} — 请检查密码或私钥是否正确",
            params.username, params.host
        ));
    }

    Ok(SshConnection {
        id: uuid::Uuid::new_v4().to_string(),
        host: params.host.clone(),
        port: params.port,
        username: params.username.clone(),
        auth_method: params.auth_method.clone(),
        handle,
        sftp: tokio::sync::Mutex::new(None),
        ptys: Mutex::new(HashMap::new()),
        next_channel: AtomicU32::new(1),
    })
}

async fn key_auth(handle: &mut Handle<SshHandler>, params: &ConnectParams) -> Result<bool> {
    let path = params.private_key_path.as_deref().unwrap_or("");
    if path.is_empty() {
        return Err(anyhow!("未指定私钥文件路径"));
    }
    let key = load_secret_key(path, params.key_passphrase.as_deref())
        .with_context(|| format!("读取私钥失败：{}", path))?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let res = handle
        .authenticate_publickey(
            &params.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await?;
    Ok(res.success())
}

async fn password_auth(handle: &mut Handle<SshHandler>, params: &ConnectParams) -> Result<bool> {
    let Some(pw) = params.password.as_deref() else {
        return Err(anyhow!("未填写密码"));
    };
    let res = handle.authenticate_password(&params.username, pw).await?;
    Ok(res.success())
}

async fn authenticate(handle: &mut Handle<SshHandler>, params: &ConnectParams) -> Result<bool> {
    let has_key = params
        .private_key_path
        .as_deref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    let has_pw = params.password.as_deref().map(|p| !p.is_empty()).unwrap_or(false);

    match params.auth_method.as_str() {
        "password" => {
            if !has_pw {
                return Err(anyhow!("密码认证需要在下方填写密码"));
            }
            password_auth(handle, params).await
        }
        "key" => {
            if !has_key {
                return Err(anyhow!("私钥认证需要指定私钥文件"));
            }
            key_auth(handle, params).await
        }
        // auto: prefer the key, fall back to password
        _ => {
            if !has_key && !has_pw {
                return Err(anyhow!("请填写密码或选择私钥文件"));
            }
            if has_key && key_auth(handle, params).await.unwrap_or(false) {
                return Ok(true);
            }
            if has_pw && password_auth(handle, params).await.unwrap_or(false) {
                return Ok(true);
            }
            Ok(false)
        }
    }
}

/// Opens a PTY + shell channel and spawns its event loop.
/// Output is forwarded to the frontend via the `pty-output` event (base64).
pub async fn open_pty(
    app: &AppHandle,
    conn: &Arc<SshConnection>,
    cols: u32,
    rows: u32,
) -> Result<u32> {
    let mut channel = conn.handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", cols.max(10), rows.max(4), 0, 0, &[])
        .await?;
    channel.request_shell(true).await?;

    let channel_id = conn.next_channel.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<PtyCommand>();
    conn.ptys.lock().unwrap().insert(channel_id, tx);

    let app = app.clone();
    let conn = conn.clone();

    tokio::spawn(async move {
        enum Ev {
            Cmd(Option<PtyCommand>),
            Msg(Option<ChannelMsg>),
        }
        loop {
            // extract the select result first so the `wait()` future is dropped
            // before the handler bodies borrow the channel again
            let ev = tokio::select! {
                c = rx.recv() => Ev::Cmd(c),
                m = channel.wait() => Ev::Msg(m),
            };
            match ev {
                Ev::Cmd(Some(PtyCommand::Write(data))) => {
                    if channel.data_bytes(data).await.is_err() {
                        break;
                    }
                }
                Ev::Cmd(Some(PtyCommand::Resize { cols, rows })) => {
                    let _ = channel.window_change(cols, rows, 0, 0).await;
                }
                Ev::Cmd(None) => break,
                Ev::Msg(Some(ChannelMsg::Data { ref data })) => {
                    let _ = app.emit(
                        "pty-output",
                        PtyOutputPayload {
                            channel_id,
                            data: B64.encode(data),
                        },
                    );
                }
                Ev::Msg(Some(ChannelMsg::ExtendedData { ref data, .. })) => {
                    let _ = app.emit(
                        "pty-output",
                        PtyOutputPayload {
                            channel_id,
                            data: B64.encode(data),
                        },
                    );
                }
                Ev::Msg(Some(ChannelMsg::ExitStatus { .. })) => {
                    let _ = channel.eof().await;
                }
                Ev::Msg(None) | Ev::Msg(Some(ChannelMsg::Eof)) | Ev::Msg(Some(ChannelMsg::Close)) => {
                    break;
                }
                _ => {}
            }
        }
        conn.close_pty(channel_id);
        let _ = app.emit("pty-exit", PtyExitPayload { channel_id });
    });

    Ok(channel_id)
}
