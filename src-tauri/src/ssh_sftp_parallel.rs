use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::state::TransferHandle;

/// Maximum number of concurrent file transfers (download or upload).
pub const MAX_CONCURRENT: usize = 10;
const CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Payload of the `transfer-progress` event, one per file.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    /// remote path when downloading, local path when uploading
    pub path: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
    /// "active" | "done" | "error" | "cancelled"
    pub status: String,
    pub error: Option<String>,
    /// "download" | "upload"
    pub direction: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferFinished {
    pub transfer_id: String,
}

struct RemoteFile {
    remote: String,
    rel: String,
    size: u64,
}

struct LocalFile {
    local: String,
    rel: String,
    size: u64,
}

fn file_name_of(path: &str) -> String {
    path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path).to_string()
}

fn parent_rel(rel: &str) -> &str {
    // "a/b/c.txt" -> "a/b"
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

// ---------------------------------------------------------------- downloads

async fn collect_remote_files(
    sftp: &SftpSession,
    remote: &str,
    rel_root: &str,
    out: &mut Vec<RemoteFile>,
) -> Result<()> {
    let md = sftp.symlink_metadata(remote).await?;
    if !md.is_dir() || md.is_symlink() {
        let name = file_name_of(remote);
        let rel = if rel_root.is_empty() { name } else { format!("{}/{}", rel_root, name) };
        out.push(RemoteFile { remote: remote.to_string(), rel, size: md.len() });
        return Ok(());
    }
    let name = file_name_of(remote);
    let child_root = if rel_root.is_empty() { name } else { format!("{}/{}", rel_root, name) };
    for entry in sftp.read_dir(remote).await? {
        let md = entry.metadata();
        let p = entry.path();
        if md.is_dir() && !md.is_symlink() {
            Box::pin(collect_remote_files(sftp, &p, &child_root, out)).await?;
        } else {
            out.push(RemoteFile {
                remote: p,
                rel: format!("{}/{}", child_root, entry.file_name()),
                size: md.len(),
            });
        }
    }
    Ok(())
}

/// Runs one parallel download batch. Emits per-file progress events and a final
/// `transfer-finished` event; also removes the transfer from the registry.
pub async fn run_download(
    app: AppHandle,
    sftp: Arc<SftpSession>,
    token: CancellationToken,
    transfers: Arc<std::sync::Mutex<std::collections::HashMap<String, TransferHandle>>>,
    transfer_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
) {
    let mut files: Vec<RemoteFile> = Vec::new();
    for p in &remote_paths {
        if token.is_cancelled() {
            break;
        }
        if let Err(e) = collect_remote_files(&sftp, p, "", &mut files).await {
            emit_progress(
                &app,
                &transfer_id,
                p,
                &file_name_of(p),
                0,
                0,
                "error",
                Some(format!("{:?}", e)),
                "download",
            );
        }
    }

    // create the local directory structure up front
    for f in &files {
        let lp = Path::new(&local_dir).join(&f.rel);
        if let Some(parent) = lp.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    run_parallel(
        app.clone(),
        sftp,
        token,
        transfers,
        transfer_id,
        files.into_iter().map(|f| (f.remote, f.rel, f.size)).collect(),
        local_dir,
        "download",
    )
    .await;
}

// ------------------------------------------------------------------ uploads

fn collect_local_files(local: &str, rel_root: &str, out: &mut Vec<LocalFile>) -> Result<()> {
    let md = std::fs::symlink_metadata(local)?;
    if !md.is_dir() {
        // includes regular files; symlinks to files are followed by content read
        let name = file_name_of(local);
        let rel = if rel_root.is_empty() { name } else { format!("{}/{}", rel_root, name) };
        out.push(LocalFile { local: local.to_string(), rel, size: md.len() });
        return Ok(());
    }
    let name = file_name_of(local);
    let child_root = if rel_root.is_empty() { name } else { format!("{}/{}", rel_root, name) };
    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in std::fs::read_dir(local)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        entries.push((entry.path().to_string_lossy().into_owned(), ft.is_dir()));
    }
    for (ep, isd) in entries {
        if isd {
            collect_local_files(&ep, &child_root, out)?;
        } else {
            let fname = file_name_of(&ep);
            let size = std::fs::symlink_metadata(&ep).map(|m| m.len()).unwrap_or(0);
            out.push(LocalFile {
                local: ep,
                rel: format!("{}/{}", child_root, fname),
                size,
            });
        }
    }
    Ok(())
}

/// Runs one parallel upload batch.
#[allow(clippy::too_many_arguments)]
pub async fn run_upload(
    app: AppHandle,
    sftp: Arc<SftpSession>,
    token: CancellationToken,
    transfers: Arc<std::sync::Mutex<std::collections::HashMap<String, TransferHandle>>>,
    transfer_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) {
    let mut files: Vec<LocalFile> = Vec::new();
    for p in &local_paths {
        if token.is_cancelled() {
            break;
        }
        if let Err(e) = collect_local_files(p, "", &mut files) {
            emit_progress(
                &app,
                &transfer_id,
                p,
                &file_name_of(p),
                0,
                0,
                "error",
                Some(format!("{:?}", e)),
                "upload",
            );
        }
    }

    // create remote directories lazily via a memo set as we upload
    run_parallel(
        app.clone(),
        sftp,
        token,
        transfers,
        transfer_id,
        files.into_iter().map(|f| (f.local, f.rel, f.size)).collect(),
        remote_dir,
        "upload",
    )
    .await;
}

// ------------------------------------------------------------ shared engine

/// Spawns up to MAX_CONCURRENT tasks, each transferring one file.
/// `src_dst` items are (source_path, relative_path, size); `dst_dir` is the
/// destination root (local dir for downloads, remote dir for uploads).
async fn run_parallel(
    app: AppHandle,
    sftp: Arc<SftpSession>,
    token: CancellationToken,
    transfers: Arc<std::sync::Mutex<std::collections::HashMap<String, TransferHandle>>>,
    transfer_id: String,
    src_dst: Vec<(String, String, u64)>,
    dst_dir: String,
    direction: &str,
) {
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut handles = Vec::new();

    for (src, rel, size) in src_dst {
        let permit = semaphore.clone().acquire_owned().await;
        let sftp = sftp.clone();
        let token = token.clone();
        let app = app.clone();
        let tid = transfer_id.clone();
        let dst_dir = dst_dir.clone();
        let direction = direction.to_string();
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            transfer_one(&app, &sftp, &token, &tid, src, rel, size, &dst_dir, &direction).await;
        }));
    }

    for h in handles {
        let _ = h.await;
    }
    transfers.lock().unwrap().remove(&transfer_id);
    let _ = app.emit(
        "transfer-finished",
        TransferFinished { transfer_id: transfer_id.clone() },
    );
}

#[allow(clippy::too_many_arguments)]
async fn transfer_one(
    app: &AppHandle,
    sftp: &SftpSession,
    token: &CancellationToken,
    transfer_id: &str,
    src: String,
    rel: String,
    total: u64,
    dst_dir: &str,
    direction: &str,
) {
    let name = file_name_of(&rel);
    let dst = Path::new(dst_dir).join(&rel).to_string_lossy().into_owned();

    let result = if direction == "download" {
        download_one(sftp, token, &src, &dst, total, app, transfer_id, &name).await
    } else {
        upload_one(sftp, token, &src, &dst, total, app, transfer_id, &name, rel).await
    };

    match result {
        Ok(()) => emit_progress(app, transfer_id, &src, &name, total, total, "done", None, direction),
        Err(TransferError::Cancelled) => {
            if direction == "download" {
                let _ = tokio::fs::remove_file(&dst).await;
            }
            emit_progress(app, transfer_id, &src, &name, 0, total, "cancelled", None, direction);
        }
        Err(TransferError::Failed(e)) => {
            emit_progress(app, transfer_id, &src, &name, 0, total, "error", Some(e), direction)
        }
    }
}

enum TransferError {
    Cancelled,
    Failed(String),
}

impl From<anyhow::Error> for TransferError {
    fn from(e: anyhow::Error) -> Self {
        TransferError::Failed(format!("{:?}", e))
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_one(
    sftp: &SftpSession,
    token: &CancellationToken,
    remote: &str,
    local: &str,
    total: u64,
    app: &AppHandle,
    transfer_id: &str,
    name: &str,
) -> Result<(), TransferError> {
    let mut remote_file = sftp.open(remote).await.context("failed to open remote file")?;
    let mut local_file = tokio::fs::File::create(local)
        .await
        .with_context(|| format!("failed to create local file {}", local))?;

    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    loop {
        if token.is_cancelled() {
            return Err(TransferError::Cancelled);
        }
        let n = remote_file.read(&mut buf).await.context("read failed")?;
        if n == 0 {
            break;
        }
        local_file.write_all(&buf[..n]).await.context("write failed")?;
        done += n as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL && done < total {
            last_emit = Instant::now();
            emit_progress(app, transfer_id, remote, name, done, total, "active", None, "download");
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upload_one(
    sftp: &SftpSession,
    token: &CancellationToken,
    local: &str,
    remote: &str,
    total: u64,
    app: &AppHandle,
    transfer_id: &str,
    name: &str,
    rel: String,
) -> Result<(), TransferError> {
    // ensure the remote parent directory exists
    let parent = parent_rel(&rel);
    if !parent.is_empty() {
        ensure_remote_dir(sftp, &Path::new(remote)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default())
        .await?;
    }

    let mut local_file = tokio::fs::File::open(local)
        .await
        .with_context(|| format!("failed to open local file {}", local))?;
    let mut remote_file = sftp.create(remote).await.context("failed to create remote file")?;

    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    loop {
        if token.is_cancelled() {
            return Err(TransferError::Cancelled);
        }
        let n = local_file.read(&mut buf).await.context("read failed")?;
        if n == 0 {
            break;
        }
        remote_file.write_all(&buf[..n]).await.context("write failed")?;
        done += n as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL && done < total {
            last_emit = Instant::now();
            emit_progress(app, transfer_id, local, name, done, total, "active", None, "upload");
        }
    }
    remote_file.flush().await.context("flush failed")?;
    Ok(())
}

/// Recursively creates a remote directory path (mkdir -p).
async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<()> {
    if path.is_empty() || path == "/" || path == "." {
        return Ok(());
    }
    if sftp.try_exists(path).await.unwrap_or(false) {
        return Ok(());
    }
    if let Some(parent) = Path::new(path).parent() {
        let ps = parent.to_string_lossy().into_owned();
        Box::pin(ensure_remote_dir(sftp, &ps)).await?;
    }
    let _ = sftp.create_dir(path).await; // may race with concurrent uploads
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    transfer_id: &str,
    path: &str,
    name: &str,
    transferred: u64,
    total: u64,
    status: &str,
    error: Option<String>,
    direction: &str,
) {
    let _ = app.emit(
        "transfer-progress",
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            path: path.to_string(),
            name: name.to_string(),
            transferred,
            total,
            status: status.to_string(),
            error,
            direction: direction.to_string(),
        },
    );
}
