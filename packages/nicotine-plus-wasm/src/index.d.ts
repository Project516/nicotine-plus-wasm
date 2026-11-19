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

export interface Protocol {
  encodeLogin(username: string, password: string, majorVersion: number, minorVersion: number): Promise<Uint8Array>;
  decodeLogin(frame: Uint8Array): Promise<LoginResponse>;
  encodeFileSearch(token: number, query: string): Promise<Uint8Array>;
  encodeGetPeerAddress(username: string): Promise<Uint8Array>;
  decodeGetPeerAddress(frame: Uint8Array): Promise<PeerAddress>;
  terminate(): void;
}

export function createProtocol(options?: { pyodideIndexURL?: string }): Promise<Protocol>;
