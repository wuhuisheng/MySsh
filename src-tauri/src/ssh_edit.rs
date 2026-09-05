use anyhow::{bail, Context, Result};
use russh_sftp::client::SftpSession;
use serde::Serialize;

/// Files larger than this cannot be opened in the editor.
const EDIT_MAX: u64 = 5 * 1024 * 1024; // 5 MiB

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditableFile {
    pub content: String,
    pub language: String,
    pub size: u64,
}

/// Loads a remote file for editing. Refuses binary and oversized files so a
/// save can never silently corrupt content.
pub async fn read_for_edit(sftp: &SftpSession, path: &str) -> Result<EditableFile> {
    let md = sftp.metadata(path).await.context("读取文件信息失败")?;
    let size = md.len();
    if size > EDIT_MAX {
        bail!("文件大小 {} MiB，超过编辑器上限 {} MiB，请使用下载方式", size / 1024 / 1024, EDIT_MAX / 1024 / 1024);
    }
    let bytes = sftp.read(path).await.context("读取文件失败")?;
    if crate::ssh_sftp::looks_binary(&bytes) {
        bail!("这似乎是二进制文件，无法安全编辑");
    }
    Ok(EditableFile {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        language: crate::ssh_preview::detect_language(path),
        size,
    })
}

/// Saves editor content back to the remote path.
pub async fn save(sftp: &SftpSession, path: &str, content: &str) -> Result<()> {
    sftp.write(path, content.as_bytes())
        .await
        .with_context(|| format!("保存失败：{}", path))?;
    Ok(())
}
