use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::thread;

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

use crate::ssh_session::PtyOutputPayload;
use crate::state::AppState;

/// Spawns a local login shell attached to a pseudo terminal and registers it.
/// Output is forwarded on the same `pty-output` event used by remote PTYs,
/// keyed by a channel id from the local (separate) counter.
pub fn open(app: &AppHandle, state: &AppState, cols: u32, rows: u32) -> Result<u32> {
    let system = native_pty_system();
    let pair = system.openpty(PtySize {
        rows: rows.clamp(4, 500) as u16,
        cols: cols.clamp(10, 1000) as u16,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let child = pair
        .slave
        .spawn_command(CommandBuilder::new_default_prog())
        .context("启动本地 shell 失败")?;
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let master = pair.master;

    let channel_id = state.next_local_channel.fetch_add(1, Ordering::Relaxed);

    // reader thread: forward shell output to the frontend
    let app_out = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app_out.emit(
                        "pty-output",
                        PtyOutputPayload {
                            channel_id,
                            data: B64.encode(&buf[..n]),
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // exit watcher: poll the child (it lives in the registry) and notify the
    // frontend once the shell has exited or the tab was closed
    let app_exit = app.clone();
    let map = state.local_ptys.clone();
    thread::spawn(move || loop {
        thread::sleep(std::time::Duration::from_millis(400));
        let gone = {
            let m = map.lock().unwrap();
            match m.get(&channel_id) {
                Some(h) => h.child.lock().unwrap().try_wait().ok().flatten().is_some(),
                None => true,
            }
        };
        if gone {
            map.lock().unwrap().remove(&channel_id);
            let _ = app_exit.emit(
                "pty-exit",
                crate::ssh_session::PtyExitPayload { channel_id },
            );
            break;
        }
    });

    state.local_ptys.lock().unwrap().insert(
        channel_id,
        Arc::new(super::state::LocalPtyHandle {
            writer: Mutex::new(writer),
            master: Mutex::new(master),
            child: Mutex::new(child),
        }),
    );

    Ok(channel_id)
}

/// Writes user input into the local shell's terminal.
pub fn write(state: &AppState, channel_id: u32, data: &[u8]) -> Result<()> {
    let handle = state
        .local_ptys
        .lock()
        .unwrap()
        .get(&channel_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("本地终端已关闭"))?;
    let mut w = handle.writer.lock().unwrap();
    w.write_all(data).context("写入本地终端失败")?;
    w.flush().context("写入本地终端失败")?;
    Ok(())
}

/// Resizes the local terminal.
pub fn resize(state: &AppState, channel_id: u32, cols: u32, rows: u32) -> Result<()> {
    let handle = state
        .local_ptys
        .lock()
        .unwrap()
        .get(&channel_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("本地终端已关闭"))?;
    handle
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows: rows.clamp(2, 500) as u16,
            cols: cols.clamp(10, 1000) as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("调整本地终端尺寸失败")?;
    Ok(())
}

/// Kills one local terminal.
pub fn close(state: &AppState, channel_id: u32) {
    if let Some(handle) = state.local_ptys.lock().unwrap().remove(&channel_id) {
        let _ = handle.child.lock().unwrap().kill();
    }
}

/// Kills every local terminal (used when leaving the local workspace).
pub fn close_all(state: &AppState) {
    let mut map = state.local_ptys.lock().unwrap();
    for (_, handle) in map.drain() {
        let _ = handle.child.lock().unwrap().kill();
    }
}
