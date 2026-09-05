// Prevents an extra console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deploy_key;
mod local_pty;
mod ssh_edit;
mod ssh_preview;
mod ssh_session;
mod ssh_sftp;
mod ssh_sftp_parallel;
mod sessions;
mod state;

use std::sync::Arc;

use anyhow::Result;
use tauri::{AppHandle, State};

use ssh_edit::EditableFile;
use ssh_session::{ConnectInfo, ConnectParams, PtyCommand, SshConnection};
use ssh_preview::PreviewResult;
use ssh_sftp::FileEntry;
use state::{AppState, TransferHandle};
use sessions::SavedSession;

fn err_str(e: anyhow::Error) -> String {
    format!("{:?}", e)
}

fn get_conn(state: &State<'_, AppState>, session_id: &str) -> Result<Arc<SshConnection>, String> {
    state
        .connections
        .lock()
        .unwrap()
        .get(session_id)
        .cloned()
        .ok_or_else(|| "session not found (disconnected?)".to_string())
}

// ------------------------------------------------------------------ SSH / PTY

#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    params: ConnectParams,
) -> Result<ConnectInfo, String> {
    let conn = Arc::new(ssh_session::connect(&params).await.map_err(err_str)?);

    // resolve the remote home directory through SFTP (best effort, bounded)
    let home = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        async {
            let sftp = conn.sftp().await?;
            let dir: String = sftp.canonicalize(".").await?;
            Ok::<String, anyhow::Error>(dir)
        },
    )
    .await
    {
        Ok(Ok(dir)) => dir,
        Ok(Err(_)) | Err(_) => ".".to_string(),
    };

    let info = ConnectInfo {
        session_id: conn.id.clone(),
        home,
        host: conn.host.clone(),
        port: conn.port,
        username: conn.username.clone(),
        auth_method: conn.auth_method.clone(),
    };
    state
        .connections
        .lock()
        .unwrap()
        .insert(conn.id.clone(), conn);
    Ok(info)
}

#[tauri::command]
async fn ssh_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    if session_id == "local" {
        local_pty::close_all(&state);
        return Ok(());
    }
    let conn = state
        .connections
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    // cancel any transfers that belong to this session
    let mut to_cancel = Vec::new();
    {
        let mut transfers = state.transfers.lock().unwrap();
        transfers.retain(|_, handle| {
            if handle.session_id == session_id {
                to_cancel.push(handle.token.clone());
                false
            } else {
                true
            }
        });
    }
    for token in to_cancel {
        token.cancel();
    }

    conn.shutdown().await;
    ssh_preview::clear_archive_cache();
    Ok(())
}

#[tauri::command]
async fn pty_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<u32, String> {
    if session_id == "local" {
        return local_pty::open(&app, &state, cols, rows).map_err(err_str);
    }
    let conn = get_conn(&state, &session_id)?;
    ssh_session::open_pty(&app, &conn, cols, rows)
        .await
        .map_err(err_str)
}

#[tauri::command]
async fn pty_write(
    state: State<'_, AppState>,
    session_id: String,
    channel_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    if session_id == "local" {
        return local_pty::write(&state, channel_id, &data).map_err(err_str);
    }
    let conn = get_conn(&state, &session_id)?;
    let tx = conn
        .pty_sender(channel_id)
        .ok_or_else(|| "terminal is closed".to_string())?;
    tx.send(PtyCommand::Write(data))
        .map_err(|_| "terminal is closed".to_string())
}

#[tauri::command]
async fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    channel_id: u32,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if session_id == "local" {
        return local_pty::resize(&state, channel_id, cols, rows).map_err(err_str);
    }
    let conn = get_conn(&state, &session_id)?;
    if let Some(tx) = conn.pty_sender(channel_id) {
        let _ = tx.send(PtyCommand::Resize { cols, rows });
    }
    Ok(())
}

#[tauri::command]
async fn pty_close(
    state: State<'_, AppState>,
    session_id: String,
    channel_id: u32,
) -> Result<(), String> {
    if session_id == "local" {
        local_pty::close(&state, channel_id);
        return Ok(());
    }
    let conn = get_conn(&state, &session_id)?;
    conn.close_pty(channel_id);
    Ok(())
}

// ------------------------------------------------------------------ SFTP ops

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_sftp::list_dir(&sftp, &path).await.map_err(err_str)
}

#[tauri::command]
async fn sftp_home(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_sftp::canonicalize(&sftp, ".").await.map_err(err_str)
}

#[tauri::command]
async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_sftp::mkdir(&sftp, &path).await.map_err(err_str)
}

#[tauri::command]
async fn sftp_touch(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_sftp::touch(&sftp, &path).await.map_err(err_str)
}

#[tauri::command]
async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    for p in &paths {
        ssh_sftp::remove_path(&sftp, p).await.map_err(err_str)?;
    }
    Ok(())
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_sftp::rename(&sftp, &old_path, &new_path).await.map_err(err_str)
}

// --------------------------------------------------------------- edit / save

#[tauri::command]
async fn sftp_read_for_edit(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<EditableFile, String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_edit::read_for_edit(&sftp, &path).await.map_err(err_str)
}

#[tauri::command]
async fn sftp_save_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_edit::save(&sftp, &path, &content).await.map_err(err_str)
}

// ------------------------------------------------------------------- preview

#[tauri::command]
async fn sftp_preview_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<PreviewResult, String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_preview::preview_file(&sftp, &path).await.map_err(err_str)
}

#[tauri::command]
async fn sftp_read_archive_entry(
    state: State<'_, AppState>,
    session_id: String,
    archive_path: String,
    entry_path: String,
) -> Result<ssh_preview::ArchiveEntryContent, String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    ssh_preview::read_archive_entry(&sftp, &archive_path, &entry_path)
        .await
        .map_err(err_str)
}

// ----------------------------------------------------------------- transfers

#[tauri::command]
async fn transfer_download(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
) -> Result<String, String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = tokio_util::sync::CancellationToken::new();
    state.transfers.lock().unwrap().insert(
        transfer_id.clone(),
        TransferHandle {
            token: token.clone(),
            session_id: session_id.clone(),
        },
    );
    tokio::spawn(ssh_sftp_parallel::run_download(
        app,
        sftp,
        token,
        state.transfers.clone(),
        transfer_id.clone(),
        remote_paths,
        local_dir,
    ));
    Ok(transfer_id)
}

#[tauri::command]
async fn transfer_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<String, String> {
    let conn = get_conn(&state, &session_id)?;
    let sftp = conn.sftp().await.map_err(err_str)?;
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = tokio_util::sync::CancellationToken::new();
    state.transfers.lock().unwrap().insert(
        transfer_id.clone(),
        TransferHandle {
            token: token.clone(),
            session_id: session_id.clone(),
        },
    );
    tokio::spawn(ssh_sftp_parallel::run_upload(
        app,
        sftp,
        token,
        state.transfers.clone(),
        transfer_id.clone(),
        local_paths,
        remote_dir,
    ));
    Ok(transfer_id)
}

#[tauri::command]
async fn transfer_cancel(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    if let Some(handle) = state.transfers.lock().unwrap().get(&transfer_id) {
        handle.token.cancel();
    }
    Ok(())
}

/// Minimal smoke-test command for the frontend.
#[tauri::command]
async fn ping() -> Result<String, String> {
    Ok("pong".to_string())
}

// --------------------------------------------------------- saved sessions

#[tauri::command]
fn sessions_load(app: AppHandle) -> Result<Vec<SavedSession>, String> {
    sessions::load(&app).map_err(err_str)
}

#[tauri::command]
fn sessions_save(app: AppHandle, sessions_list: Vec<SavedSession>) -> Result<(), String> {
    sessions::save(&app, &sessions_list).map_err(err_str)
}

// ------------------------------------------------------------ key deployment

#[tauri::command]
async fn deploy_public_key(
    params: ConnectParams,
    public_key: String,
) -> Result<deploy_key::DeployResult, String> {
    deploy_key::deploy(&params, &public_key).await.map_err(err_str)
}

#[tauri::command]
fn list_local_pubkeys() -> Result<Vec<deploy_key::LocalPubKey>, String> {
    deploy_key::list_local_pubkeys().map_err(err_str)
}

#[tauri::command]
fn read_pubkey_file(path: String) -> Result<deploy_key::LocalPubKey, String> {
    deploy_key::read_small_text_file(&path).map_err(err_str)
}

fn main() {
    // panic=abort kills the process instantly on any panic; persist the panic
    // message so a black-screen report can be diagnosed after the fact
    std::panic::set_hook(Box::new(|info| {
        let msg = format!(
            "[{}] MySsh panic: {}\nlocation: {:?}\n\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            info,
            info.location(),
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("myssh-panic.log"))
        {
            use std::io::Write as _;
            let _ = f.write_all(msg.as_bytes());
        }
        eprint!("{}", msg);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // drop stale archive-preview temp files from previous runs
            if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with("sshdesk-") {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            ping,
            ssh_connect,
            ssh_disconnect,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            sftp_list,
            sftp_home,
            sftp_mkdir,
            sftp_touch,
            sftp_remove,
            sftp_rename,
            sftp_read_for_edit,
            sftp_save_file,
            sftp_preview_file,
            sftp_read_archive_entry,
            transfer_download,
            transfer_upload,
            transfer_cancel,
            sessions_load,
            sessions_save,
            deploy_public_key,
            list_local_pubkeys,
            read_pubkey_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MySsh");
}
