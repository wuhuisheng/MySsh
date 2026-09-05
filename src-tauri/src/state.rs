use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::ssh_session::SshConnection;

/// A cancellable transfer batch started by the frontend.
pub struct TransferHandle {
    pub token: CancellationToken,
    pub session_id: String,
}

pub type TransferMap = Arc<Mutex<HashMap<String, TransferHandle>>>;

/// Global application state managed by Tauri.
pub struct AppState {
    pub connections: Mutex<HashMap<String, Arc<SshConnection>>>,
    pub transfers: TransferMap,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            transfers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
