use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh_sftp::looks_binary;

/// Preview caps
const TEXT_PREVIEW_MAX: u64 = 1024 * 1024; // 1 MiB
const IMAGE_MAX: u64 = 30 * 1024 * 1024; // 30 MiB
const ARCHIVE_MAX: u64 = 512 * 1024 * 1024; // 512 MiB
const ARCHIVE_ENTRY_MAX: usize = 2 * 1024 * 1024; // 2 MiB

/// Result of `preview_file`, tagged by kind for the frontend.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreviewResult {
    Text {
        language: String,
        content: String,
        truncated: bool,
        size: u64,
    },
    Image {
        mime: String,
        data_b64: String,
        size: u64,
    },
    Archive {
        entries: Vec<ArchiveEntry>,
        size: u64,
    },
    Unsupported {
        reason: String,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryContent {
    pub content: String,
    pub truncated: bool,
}

enum Kind {
    Image(&'static str),
    Archive(&'static str),
    MaybeText,
}

/// Cache of downloaded archives: remote path -> local temp path.
static ARCHIVE_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn classify(path: &str) -> Kind {
    let lower = path.to_lowercase();
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Kind::Archive("tar.gz");
    }
    if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
        return Kind::Archive("tar.bz2");
    }
    if lower.ends_with(".tar") {
        return Kind::Archive("tar");
    }
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "png" => Kind::Image("image/png"),
        "jpg" | "jpeg" => Kind::Image("image/jpeg"),
        "gif" => Kind::Image("image/gif"),
        "webp" => Kind::Image("image/webp"),
        "bmp" => Kind::Image("image/bmp"),
        "svg" => Kind::Image("image/svg+xml"),
        "zip" | "jar" | "apk" => Kind::Archive("zip"),
        _ => Kind::MaybeText,
    }
}

/// Maps a file extension to a Monaco language id.
pub fn detect_language(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with("dockerfile") || lower.ends_with("makefile") {
        return lower.rsplit('/').next().unwrap_or("").to_lowercase();
    }
    let ext = lower.rsplit('.').next().unwrap_or("");
    let lang = match ext {
        "py" | "pyw" => "python",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" => "typescript",
        "tsx" => "typescript",
        "json" => "json",
        "html" | "htm" | "vue" => "html",
        "css" | "scss" | "less" => "css",
        "md" | "markdown" => "markdown",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "php" => "php",
        "rb" => "ruby",
        "sh" | "bash" | "zsh" => "shell",
        "sql" => "sql",
        "yaml" | "yml" => "yaml",
        "toml" | "ini" | "conf" | "cfg" | "properties" => "ini",
        "xml" | "svg" | "plist" => "xml",
        "swift" => "swift",
        "dart" => "dart",
        "lua" => "lua",
        "pl" => "perl",
        _ => "plaintext",
    };
    lang.to_string()
}

/// Produces the preview payload for one remote file.
pub async fn preview_file(sftp: &SftpSession, path: &str) -> Result<PreviewResult> {
    let md = sftp.metadata(path).await.context("failed to stat file")?;
    let size = md.len();

    match classify(path) {
        Kind::Image(mime) => {
            if size > IMAGE_MAX {
                return Ok(PreviewResult::Unsupported {
                    reason: format!(
                        "图片大小 {} MiB，超过预览上限 {} MiB，请下载后查看",
                        size / 1024 / 1024,
                        IMAGE_MAX / 1024 / 1024
                    ),
                });
            }
            let bytes = sftp.read(path).await.context("failed to read image")?;
            Ok(PreviewResult::Image {
                mime: mime.to_string(),
                data_b64: B64.encode(bytes),
                size,
            })
        }
        Kind::Archive(kind) => {
            if size > ARCHIVE_MAX {
                return Ok(PreviewResult::Unsupported {
                    reason: format!(
                        "压缩包大小 {} MiB，超过预览上限 {} MiB，请下载后查看",
                        size / 1024 / 1024,
                        ARCHIVE_MAX / 1024 / 1024
                    ),
                });
            }
            let local = fetch_archive(sftp, path).await?;
            let entries =
                list_archive(&local, kind).with_context(|| format!("failed to read archive {}", path))?;
            Ok(PreviewResult::Archive { entries, size })
        }
        Kind::MaybeText => {
            // read up to TEXT_PREVIEW_MAX + 1 byte so we can tell truncation apart
            let mut file = sftp.open(path).await.context("failed to open file")?;
            let mut buf = Vec::with_capacity(TEXT_PREVIEW_MAX as usize);
            let limit = TEXT_PREVIEW_MAX + 1;
            let mut chunk = vec![0u8; 128 * 1024];
            while (buf.len() as u64) < limit {
                let n = file.read(&mut chunk).await.context("failed to read file")?;
                if n == 0 {
                    break;
                }
                let remain = (limit - buf.len() as u64) as usize;
                buf.extend_from_slice(&chunk[..n.min(remain)]);
            }
            let truncated = (buf.len() as u64) > TEXT_PREVIEW_MAX || (buf.len() as u64) < size;
            if looks_binary(&buf) {
                return Ok(PreviewResult::Unsupported {
                    reason: "二进制文件无法预览，请在 SFTP 面板中下载查看".to_string(),
                });
            }
            buf.truncate(TEXT_PREVIEW_MAX as usize);
            Ok(PreviewResult::Text {
                language: detect_language(path),
                content: String::from_utf8_lossy(&buf).into_owned(),
                truncated,
                size,
            })
        }
    }
}

/// Reads one entry out of a previously previewed archive (text entries only).
pub async fn read_archive_entry(
    sftp: &SftpSession,
    archive_path: &str,
    entry_path: &str,
) -> Result<ArchiveEntryContent> {
    let kind = match classify(archive_path) {
        Kind::Archive(k) => k,
        _ => bail!("not an archive"),
    };
    let local = fetch_archive(sftp, archive_path).await?;
    let wanted = entry_path.trim_start_matches("./");

    let content = tokio::task::block_in_place(|| {
        let mut out = Vec::new();
        match kind {
            "zip" => {
                let mut za =
                    zip::ZipArchive::new(std::fs::File::open(&local)?).context("failed to open zip")?;
                let mut f = za
                    .by_name(wanted)
                    .with_context(|| format!("entry {} not found", wanted))?;
                if f.is_dir() {
                    bail!("entry is a directory");
                }
                f.by_ref()
                    .take(ARCHIVE_ENTRY_MAX as u64 + 1)
                    .read_to_end(&mut out)?;
            }
            "tar" | "tar.gz" => {
                let file = std::fs::File::open(&local)?;
                let reader: Box<dyn Read> = if kind == "tar.gz" {
                    Box::new(flate2::read::GzDecoder::new(file))
                } else {
                    Box::new(file)
                };
                let mut tar = tar::Archive::new(reader);
                let mut found = false;
                for entry in tar.entries()? {
                    let mut entry = entry?;
                    let p = entry.path()?.to_string_lossy().trim_start_matches("./").to_string();
                    if p == wanted {
                        if entry.header().entry_type().is_dir() {
                            bail!("entry is a directory");
                        }
                        entry
                            .by_ref()
                            .take(ARCHIVE_ENTRY_MAX as u64 + 1)
                            .read_to_end(&mut out)?;
                        found = true;
                        break;
                    }
                }
                if !found {
                    bail!("entry {} not found", wanted);
                }
            }
            "tar.bz2" => bail!("bzip2 archives are not supported yet"),
            _ => bail!("unsupported archive kind"),
        }
        let truncated = out.len() > ARCHIVE_ENTRY_MAX;
        out.truncate(ARCHIVE_ENTRY_MAX);
        if looks_binary(&out) {
            bail!("entry is binary");
        }
        Ok(ArchiveEntryContent {
            content: String::from_utf8_lossy(&out).into_owned(),
            truncated,
        })
    })
    .context("failed to read archive entry")?;
    Ok(content)
}

/// Downloads the archive to a temp file (cached per remote path).
async fn fetch_archive(sftp: &SftpSession, remote: &str) -> Result<String> {
    {
        let guard = ARCHIVE_CACHE.lock().unwrap();
        if let Some(m) = guard.as_ref() {
            if let Some(local) = m.get(remote) {
                if Path::new(local).exists() {
                    return Ok(local.clone());
                }
            }
        }
    }

    let name = remote.rsplit('/').find(|s| !s.is_empty()).unwrap_or("archive");
    let local = std::env::temp_dir().join(format!("sshdesk-{}-{}", uuid::Uuid::new_v4(), name));
    let local_str = local.to_string_lossy().into_owned();

    let mut remote_file = sftp.open(remote).await.context("failed to open archive")?;
    let mut local_file = tokio::fs::File::create(&local).await?;
    let mut chunk = vec![0u8; 256 * 1024];
    loop {
        let n = remote_file.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        local_file.write_all(&chunk[..n]).await?;
    }
    local_file.flush().await?;

    ARCHIVE_CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(remote.to_string(), local_str.clone());
    Ok(local_str)
}

fn list_archive(local: &str, kind: &str) -> Result<Vec<ArchiveEntry>> {
    let mut entries = Vec::new();
    match kind {
        "zip" => {
            let mut za = zip::ZipArchive::new(std::fs::File::open(local)?)?;
            for i in 0..za.len() {
                let f = za.by_index(i)?;
                let path = f.name().trim_start_matches("./").to_string();
                entries.push(ArchiveEntry {
                    name: path.rsplit('/').next().unwrap_or(&path).to_string(),
                    path,
                    size: f.size(),
                    is_dir: f.is_dir(),
                });
            }
        }
        "tar" | "tar.gz" => {
            let f = std::fs::File::open(local)?;
            let reader: Box<dyn Read> = if kind == "tar.gz" {
                Box::new(flate2::read::GzDecoder::new(f))
            } else {
                Box::new(f)
            };
            let mut tar = tar::Archive::new(reader);
            for entry in tar.entries()? {
                let entry = entry?;
                let path = entry.path()?.to_string_lossy().trim_start_matches("./").to_string();
                entries.push(ArchiveEntry {
                    name: path.rsplit('/').next().unwrap_or(&path).to_string(),
                    path,
                    size: entry.size(),
                    is_dir: entry.header().entry_type().is_dir(),
                });
            }
        }
        "tar.bz2" => bail!("bzip2 archives are not supported yet"),
        _ => bail!("unsupported archive kind"),
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
    });
    Ok(entries)
}
