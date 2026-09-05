use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// A saved connection, persisted as JSON in the app config dir.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key" | "auto"
    pub auth_method: String,
    /// only persisted when the user opted into "remember password"
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub key_passphrase: Option<String>,
    /// accept any host key without known_hosts verification
    pub skip_host_check: bool,
    /// epoch milliseconds
    pub created_at: u64,
    pub last_connected_at: Option<u64>,
}

impl Default for SavedSession {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_method: "auto".to_string(),
            password: None,
            private_key_path: None,
            key_passphrase: None,
            skip_host_check: false,
            created_at: 0,
            last_connected_at: None,
        }
    }
}

fn store_file(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("failed to resolve app config dir")?;
    fs::create_dir_all(&dir).context("failed to create app config dir")?;
    Ok(dir.join("sessions.json"))
}

/// Loads all saved sessions; a missing file yields an empty list.
pub fn load(app: &AppHandle) -> Result<Vec<SavedSession>> {
    let path = store_file(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).context("failed to read sessions.json")?;
    let list: Vec<SavedSession> =
        serde_json::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(list)
}

/// Atomically rewrites the whole session list (write tmp, then rename).
pub fn save(app: &AppHandle, sessions: &[SavedSession]) -> Result<()> {
    let path = store_file(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(sessions).context("failed to serialize sessions")?;
    fs::write(&tmp, json).context("failed to write sessions file")?;
    fs::rename(&tmp, &path).context("failed to replace sessions file")?;
    Ok(())
}
