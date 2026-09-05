/**
 * Thin wrappers around every Tauri command exposed by the Rust backend.
 * Command args use camelCase keys — serde maps them to the Rust structs.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  ArchiveEntryContent,
  ConnectInfo,
  ConnectParams,
  DeployResult,
  EditableFile,
  FileEntry,
  LocalPubKey,
  PreviewResult,
  SavedSession,
} from "../types";

export const api = {
  // ---- SSH / PTY ----
  sshConnect: (params: ConnectParams) =>
    invoke<ConnectInfo>("ssh_connect", { params }),

  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),

  ptyOpen: (sessionId: string, cols: number, rows: number) =>
    invoke<number>("pty_open", { sessionId, cols, rows }),

  ptyWrite: (sessionId: string, channelId: number, data: number[]) =>
    invoke<void>("pty_write", { sessionId, channelId, data }),

  ptyResize: (sessionId: string, channelId: number, cols: number, rows: number) =>
    invoke<void>("pty_resize", { sessionId, channelId, cols, rows }),

  ptyClose: (sessionId: string, channelId: number) =>
    invoke<void>("pty_close", { sessionId, channelId }),

  // ---- SFTP ----
  sftpList: (sessionId: string, path: string) =>
    invoke<FileEntry[]>("sftp_list", { sessionId, path }),

  sftpHome: (sessionId: string) => invoke<string>("sftp_home", { sessionId }),

  sftpMkdir: (sessionId: string, path: string) =>
    invoke<void>("sftp_mkdir", { sessionId, path }),

  sftpTouch: (sessionId: string, path: string) =>
    invoke<void>("sftp_touch", { sessionId, path }),

  sftpRemove: (sessionId: string, paths: string[]) =>
    invoke<void>("sftp_remove", { sessionId, paths }),

  sftpRename: (sessionId: string, oldPath: string, newPath: string) =>
    invoke<void>("sftp_rename", { sessionId, oldPath, newPath }),

  // ---- edit ----
  sftpReadForEdit: (sessionId: string, path: string) =>
    invoke<EditableFile>("sftp_read_for_edit", { sessionId, path }),

  sftpSaveFile: (sessionId: string, path: string, content: string) =>
    invoke<void>("sftp_save_file", { sessionId, path, content }),

  // ---- preview ----
  sftpPreviewFile: (sessionId: string, path: string) =>
    invoke<PreviewResult>("sftp_preview_file", { sessionId, path }),

  sftpReadArchiveEntry: (sessionId: string, archivePath: string, entryPath: string) =>
    invoke<ArchiveEntryContent>("sftp_read_archive_entry", { sessionId, archivePath, entryPath }),

  // ---- transfers ----
  transferDownload: (sessionId: string, remotePaths: string[], localDir: string) =>
    invoke<string>("transfer_download", { sessionId, remotePaths, localDir }),

  transferUpload: (sessionId: string, localPaths: string[], remoteDir: string) =>
    invoke<string>("transfer_upload", { sessionId, localPaths, remoteDir }),

  transferCancel: (transferId: string) => invoke<void>("transfer_cancel", { transferId }),

  ping: () => invoke<string>("ping"),

  // ---- saved sessions ----
  sessionsLoad: () => invoke<SavedSession[]>("sessions_load"),

  sessionsSave: (sessions: SavedSession[]) =>
    invoke<void>("sessions_save", { sessionsList: sessions }),

  // ---- key deployment ----
  listLocalPubkeys: () => invoke<LocalPubKey[]>("list_local_pubkeys"),

  readPubkeyFile: (path: string) => invoke<LocalPubKey>("read_pubkey_file", { path }),

  deployPublicKey: (params: ConnectParams, publicKey: string) =>
    invoke<DeployResult>("deploy_public_key", { params, publicKey }),
};

/** Joins a remote directory with a name the SFTP way. */
export function joinRemote(dir: string, name: string): string {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}

/** Parent of a remote path ("/" has no parent). */
export function parentRemote(path: string): string | null {
  if (path === "/" || path === "") return null;
  const p = path.replace(/\/+$/, "");
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(t?: number): string {
  if (!t) return "—";
  const d = new Date(t * 1000);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function permissionsToRwx(perms: number): string {
  const chars = "rwx";
  let out = "";
  // type char
  out += (perms & 0o170000) === 0o040000 ? "d" : "-";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (perms >> shift) & 7;
    for (let i = 0; i < 3; i++) {
      out += bits & (4 >> i) ? chars[i] : "-";
    }
  }
  return out;
}

export function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function textToBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
