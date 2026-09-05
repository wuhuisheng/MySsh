/** Shared frontend types mirroring the Rust payload structs. */

export interface ConnectParams {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "auto";
  password?: string;
  privateKeyPath?: string;
  keyPassphrase?: string;
  /** accept any server host key without known_hosts verification */
  skipHostCheck?: boolean;
}

export interface ConnectInfo {
  sessionId: string;
  home: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  permissions: number;
  mtime?: number;
  owner?: string;
  group?: string;
}

export interface EditableFile {
  content: string;
  language: string;
  size: number;
}

export interface ArchiveEntry {
  path: string;
  name: string;
  size: number;
  isDir: boolean;
}

export interface ArchiveEntryContent {
  content: string;
  truncated: boolean;
}

export type PreviewResult =
  | { kind: "text"; language: string; content: string; truncated: boolean; size: number }
  | { kind: "image"; mime: string; dataB64: string; size: number }
  | { kind: "archive"; entries: ArchiveEntry[]; size: number }
  | { kind: "unsupported"; reason: string };

export interface TransferProgress {
  transferId: string;
  path: string;
  name: string;
  transferred: number;
  total: number;
  status: "active" | "done" | "error" | "cancelled";
  error?: string;
  direction: "download" | "upload";
}

export interface TransferFinished {
  transferId: string;
}

export interface PtyOutputEvent {
  channelId: number;
  data: string; // base64
}

export interface PtyExitEvent {
  channelId: number;
}

export interface TerminalTab {
  channelId: number;
  title: string;
  closed?: boolean;
}

/** A persisted connection entry managed on the home screen. */
export interface SavedSession {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "auto";
  password?: string;
  privateKeyPath?: string;
  keyPassphrase?: string;
  skipHostCheck?: boolean;
  /** epoch ms */
  createdAt: number;
  lastConnectedAt?: number;
}

/** What the session form submits: connection params plus save intent. */
export interface SessionSubmit {
  params: ConnectParams;
  /** "create" = add new entry, "update" = overwrite entry with this id, "none" = connect without saving */
  saveMode: "create" | "update" | "none";
  sessionId?: string;
  name: string;
}

/** A local ~/.ssh/*.pub file detected on this machine. */
export interface LocalPubKey {
  path: string;
  content: string;
}

/** Outcome of deploying a public key to a remote server. */
export interface DeployResult {
  added: boolean;
  authorizedKeysPath: string;
  totalKeys: number;
}
