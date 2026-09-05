use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};
use tokio_util::sync::CancellationToken;

use crate::ssh_session::SshConnection;

/// A cancellable transfer batch started by the frontend.
pub struct TransferHandle {
    pub token: CancellationToken,
    pub session_id: String,
}

pub type TransferMap = Arc<Mutex<HashMap<String, TransferHandle>>>;

/// One spawned local terminal: its stdin writer, resize handle and child.
pub struct LocalPtyHandle {
    pub writer: Mutex<Box<dyn std::io::Write + Send>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub child: Mutex<Box<dyn Child + Send + Sync>>,
}

pub type LocalPtyMap = Arc<Mutex<HashMap<u32, Arc<LocalPtyHandle>>>>;

/// Global application state managed by Tauri.
pub struct AppState {
    pub connections: Mutex<HashMap<String, Arc<SshConnection>>>,
    pub transfers: TransferMap,
    pub local_ptys: LocalPtyMap,
    pub next_local_channel: AtomicU32,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            transfers: Arc::new(Mutex::new(HashMap::new())),
            local_ptys: Arc::new(Mutex::new(HashMap::new())),
            next_local_channel: AtomicU32::new(1),
        }
    }
}
