use anyhow::{Context, Result};
use russh_sftp::client::SftpSession;
use serde::Serialize;

/// One row of the remote file listing shown in the SFTP panel.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub permissions: u32,
    pub mtime: Option<u64>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

pub async fn list_dir(sftp: &SftpSession, path: &str) -> Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    for entry in sftp.read_dir(path).await.context("failed to read directory")? {
        let md = entry.metadata();
        out.push(FileEntry {
            name: entry.file_name(),
            path: entry.path(),
            is_dir: md.is_dir(),
            is_symlink: md.is_symlink(),
            size: md.len(),
            permissions: md.permissions.unwrap_or(0),
            mtime: md.mtime.map(|t| t as u64),
            owner: md.user.clone(),
            group: md.group.clone(),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Deletes a remote path. Directories are removed recursively.
pub async fn remove_path(sftp: &SftpSession, path: &str) -> Result<()> {
    let md = sftp.symlink_metadata(path).await.context("failed to stat path")?;
    if !md.is_dir() || md.is_symlink() {
        sftp.remove_file(path).await.context("failed to delete file")?;
        return Ok(());
    }

    let mut files: Vec<String> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    let mut stack: Vec<String> = vec![path.to_string()];
    while let Some(p) = stack.pop() {
        for entry in sftp.read_dir(&p).await.context("failed to read directory")? {
            let md = entry.metadata();
            let ep = entry.path();
            if md.is_dir() && !md.is_symlink() {
                stack.push(ep);
            } else {
                files.push(ep);
            }
        }
        if p != path {
            dirs.push(p);
        }
    }
    for f in &files {
        sftp.remove_file(f).await.context("failed to delete file")?;
    }
    // remove deepest directories first
    dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    for d in &dirs {
        sftp.remove_dir(d).await.context("failed to delete directory")?;
    }
    sftp.remove_dir(path).await.context("failed to delete directory")?;
    Ok(())
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<()> {
    sftp.create_dir(path).await.context("failed to create directory")?;
    Ok(())
}

/// Creates an empty remote file (no-op if it already exists).
pub async fn touch(sftp: &SftpSession, path: &str) -> Result<()> {
    let exists = sftp.try_exists(path).await.unwrap_or(false);
    if !exists {
        // `write` opens without CREATE, so create explicitly
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::AsyncWriteExt;
        let mut f = sftp
            .open_with_flags(path, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
            .await
            .context("创建文件失败")?;
        f.flush().await.context("创建文件失败")?;
    }
    Ok(())
}

pub async fn rename(sftp: &SftpSession, old_path: &str, new_path: &str) -> Result<()> {
    sftp.rename(old_path, new_path).await.context("failed to rename")?;
    Ok(())
}

pub async fn canonicalize(sftp: &SftpSession, path: &str) -> Result<String> {
    sftp.canonicalize(path).await.context("failed to canonicalize path")
}

/// Checks whether a buffer looks binary (contains NUL bytes in the first part).
pub fn looks_binary(buf: &[u8]) -> bool {
    let n = buf.len().min(4096);
    buf[..n].contains(&0)
}
