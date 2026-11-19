// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

export type LoginResponse =
  | { success: true; banner: string; ipAddress: string; isSupporter: boolean }
  | { success: false; reason: string };

export interface PeerAddress {
  username: string;
  ipAddress: string;
  port: number;
  obfuscatedPort: number;
}

export interface PeerRequest {
  username: string;
  connType: string;
  ipAddress: string;
  port: number;
  token: number;
}

export interface FileSearchResponse {
  token: number;
  /** Missing when the token is not in the list passed to the decoder. */
  files?: { path: string; size: number; bitrate?: number; duration?: number }[];
  freeSlot?: boolean;
  uploadSpeed?: number;
  queueLength?: number;
}

export interface TransferRequest {
  direction: number;
  token: number;
  path: string;
  size: number;
}

export interface Protocol {
  encodeLogin(username: string, password: string, majorVersion: number, minorVersion: number): Promise<Uint8Array>;
  decodeLogin(frame: Uint8Array): Promise<LoginResponse>;
  encodeSetStatus(status: number): Promise<Uint8Array>;
  encodeSharedFoldersFiles(folders: number, files: number): Promise<Uint8Array>;
  encodeFileSearch(token: number, query: string): Promise<Uint8Array>;
  encodeGetPeerAddress(username: string): Promise<Uint8Array>;
  decodeGetPeerAddress(frame: Uint8Array): Promise<PeerAddress>;
  decodeConnectToPeer(frame: Uint8Array): Promise<PeerRequest>;
  encodeCantConnectToPeer(token: number, username: string): Promise<Uint8Array>;
  encodePierceFireWall(token: number): Promise<Uint8Array>;
  encodePeerInit(username: string, connType: string): Promise<Uint8Array>;
  decodeFileSearchResponse(frame: Uint8Array, tokens: number[]): Promise<FileSearchResponse>;
  /** `legacy` encodes the folder as latin-1, for old clients. */
  encodeFolderContentsRequest(token: number, folder: string, legacy?: boolean): Promise<Uint8Array>;
  /** `files` is undefined when the folder is not in `folders`. */
  decodeFolderContentsResponse(frame: Uint8Array, username: string, folders: string[]): Promise<{
    folder: string;
    files?: { path: string; size: number; bitrate?: number; duration?: number }[];
  }>;
  encodeQueueUpload(path: string): Promise<Uint8Array>;
  encodePlaceInQueueRequest(path: string): Promise<Uint8Array>;
  decodePlaceInQueueResponse(frame: Uint8Array): Promise<{ path: string; position: number }>;
  decodeTransferRequest(frame: Uint8Array): Promise<TransferRequest>;
  encodeTransferResponse(token: number, allowed: boolean, reason?: string): Promise<Uint8Array>;
  decodeUploadDenied(frame: Uint8Array): Promise<{ path: string; reason: string }>;
  decodeUploadFailed(frame: Uint8Array): Promise<{ path: string }>;
  /** Takes the 4 header-less bytes of a file connection. */
  decodeFileTransferInit(data: Uint8Array): Promise<{ token: number }>;
  encodeFileOffset(offset: number): Promise<Uint8Array>;
  terminate(): void;
}

export function createProtocol(options?: { pyodideIndexURL?: string }): Promise<Protocol>;

export class LoginError extends Error {
  /** The server's rejection reason, such as `INVALIDPASS`. */
  readonly reason: string;
}

export class DownloadError extends Error {
  /** The peer's or the client's reason for the failure. */
  readonly reason: string;
}

export interface SearchFile {
  path: string;
  name: string;
  size: number;
  extension: string;
  bitrate?: number;
  duration?: number;
}

export interface SearchResult {
  username: string;
  freeSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
  files: SearchFile[];
}

export type DownloadProgress =
  | { state: 'connecting' }
  | { state: 'queued'; position?: number }
  | { state: 'transferring'; received: number; total: number };

export interface Client {
  /** Resolves when the timeout ends. Rejects with the signal's reason when aborted. */
  search(query: string, options: {
    onResult: (result: SearchResult) => void;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<void>;
  download(username: string, path: string, options?: {
    signal?: AbortSignal;
    /** The search result size. Used when the peer reports size 0, as SoulseekQt does for files over 2 GiB. */
    size?: number;
    onProgress?: (progress: DownloadProgress) => void;
  }): Promise<Blob>;
  /**
   * Lists the files directly in one folder of a peer's shares, without subfolders.
   * `folder` is a search result path without the file name. Rejects with a
   * DownloadError when the peer is offline, unreachable, or does not answer in
   * `timeout` ms (default 30000).
   */
  browseFolder(username: string, folder: string, options?: {
    signal?: AbortSignal;
    timeout?: number;
  }): Promise<SearchFile[]>;
  close(): void;
  /** Settles when the server connection drops or `close()` is called. */
  readonly closed: Promise<Error>;
}

export function connectClient(options: {
  relayURL: string;
  relayToken: string;
  username: string;
  password: string;
  signal?: AbortSignal;
  pyodideIndexURL?: string;
}): Promise<Client>;
