use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::ssh_session::{self, ConnectParams};

/// One local `*.pub` file found in ~/.ssh.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalPubKey {
    pub path: String,
    pub content: String,
}

/// Outcome of a deployment.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeployResult {
    /// true when the key was appended; false when it was already present
    pub added: bool,
    pub authorized_keys_path: String,
    pub total_keys: usize,
}

/// Lists readable `*.pub` files under ~/.ssh (cross-platform via the user
/// home directory).
pub fn list_local_pubkeys() -> Result<Vec<LocalPubKey>> {
    let Some(home) = dirs::home_dir() else {
        bail!("无法定位用户主目录");
    };
    let ssh_dir = home.join(".ssh");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&ssh_dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().map(|x| x == "pub").unwrap_or(false) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let content = content.trim().to_string();
                    if !content.is_empty() {
                        out.push(LocalPubKey {
                            path: path.to_string_lossy().into_owned(),
                            content,
                        });
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Basic sanity check for an OpenSSH public key line
/// ("ssh-ed25519 AAAA... comment" and friends).
fn validate_pubkey(line: &str) -> Result<()> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 2 {
        bail!("公钥格式不正确：至少需要「类型 + 密钥体」两段");
    }
    let known = [
        "ssh-ed25519", "ssh-rsa", "ssh-dss", "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
    ];
    let is_known = known.iter().any(|k| fields[0].starts_with(*k) || fields[0] == *k);
    let looks_like_cert = fields[0].ends_with("-cert.v00@openssh.com");
    if !is_known && !looks_like_cert {
        bail!("无法识别的公钥类型：{}", fields[0]);
    }
    if fields[1].len() < 32 {
        bail!("公钥体过短，内容可能不完整");
    }
    Ok(())
}

/// The "type + base64 body" part of a key line, used for duplicate detection
/// (comments may differ between additions).
fn key_identity(line: &str) -> String {
    line.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

/// Connects with the given credentials and appends `public_key` to the
/// remote `~/.ssh/authorized_keys` over SFTP (no shell involved, so the
/// remote just needs SFTP support — same requirement as the file browser).
pub async fn deploy(params: &ConnectParams, public_key: &str) -> Result<DeployResult> {
    let line = public_key.trim();
    if line.is_empty() {
        bail!("公钥内容为空");
    }
    // allow pasting multiple lines but only keep non-empty, non-comment ones
    let key_lines: Vec<String> = line
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_string())
        .collect();
    if key_lines.is_empty() {
        bail!("公钥内容为空");
    }
    for l in &key_lines {
        validate_pubkey(l).with_context(|| format!("校验失败：{}", &l[..l.len().min(40)]))?;
    }

    let conn = ssh_session::connect(params).await?;
    let result = deploy_via_sftp(&conn, &key_lines).await;
    conn.shutdown().await;
    result
}

async fn deploy_via_sftp(
    conn: &ssh_session::SshConnection,
    key_lines: &[String],
) -> Result<DeployResult> {
    let sftp = conn.sftp().await?;

    let home = sftp
        .canonicalize(".")
        .await
        .context("无法解析远程主目录")?
        .trim_end_matches('/')
        .to_string();

    let ssh_dir = format!("{}/.ssh", home);
    if !sftp.try_exists(&ssh_dir).await.unwrap_or(false) {
        sftp.create_dir(&ssh_dir).await.context("创建远程 .ssh 目录失败")?;
    }
    // sshd's StrictModes requires a non-group-writable .ssh
    set_permissions(&sftp, &ssh_dir, 0o700).await;

    let ak_path = format!("{}/authorized_keys", ssh_dir);
    let existing = if sftp.try_exists(&ak_path).await.unwrap_or(false) {
        String::from_utf8_lossy(&sftp.read(&ak_path).await.context("读取 authorized_keys 失败")?)
            .into_owned()
    } else {
        String::new()
    };

    let mut existing_identities: Vec<String> = existing
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(key_identity)
        .collect();

    let mut added_any = false;
    let mut content = existing.clone();
    for line in key_lines {
        let id = key_identity(line);
        if existing_identities.iter().any(|x| *x == id) {
            continue;
        }
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(line);
        content.push('\n');
        added_any = true;
        existing_identities.push(id);
    }

    let total = existing_identities.len();

    if added_any {
        // russh-sftp's `write` helper opens without CREATE, so create the file
        // explicitly (it may not exist yet)
        let mut f = sftp
            .open_with_flags(
                &ak_path,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            )
            .await
            .context("创建/打开 authorized_keys 失败")?;
        f.write_all(content.as_bytes())
            .await
            .context("写入 authorized_keys 失败")?;
    }
    // sshd requires 600 on authorized_keys under StrictModes
    set_permissions(&sftp, &ak_path, 0o600).await;

    Ok(DeployResult {
        added: added_any,
        authorized_keys_path: ak_path,
        total_keys: total,
    })
}

/// Best-effort chmod; failures are non-fatal (some servers restrict setstat).
async fn set_permissions(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    mode: u32,
) {
    let attrs = FileAttributes {
        permissions: Some(mode),
        ..Default::default()
    };
    let _ = sftp.set_metadata(path, attrs).await;
}

/// Resolves ~ / ~/sub paths for file pickers on any platform.
pub fn expand_home(path: &str) -> Option<PathBuf> {
    if path == "~" {
        return dirs::home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir().map(|h| h.join(rest));
    }
    Some(PathBuf::from(path))
}

/// Reads a small local text file (public keys are tiny; capped defensively).
pub fn read_small_text_file(path: &str) -> Result<LocalPubKey> {
    const MAX: u64 = 64 * 1024;
    let expanded = expand_home(path).context("无法解析文件路径")?;
    let md = std::fs::metadata(&expanded).context("文件不存在或不可读")?;
    if md.len() > MAX {
        bail!("文件过大（{} KB），看起来不像公钥文件", md.len() / 1024);
    }
    let content = std::fs::read_to_string(&expanded).context("读取文件失败")?;
    Ok(LocalPubKey {
        path: expanded.to_string_lossy().into_owned(),
        content: content.trim().to_string(),
    })
}
