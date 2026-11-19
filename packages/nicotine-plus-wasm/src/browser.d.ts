// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

export * from './index.js';
import type { LoginResponse, Protocol } from './index.js';

export interface RelayConnection {
  send(frame: Uint8Array): void;
  receive(options?: { timeout?: number }): Promise<Uint8Array>;
  close(): void;
}

export function connectRelay(
  url: string | URL, token: string, options?: { signal?: AbortSignal },
): Promise<RelayConnection>;

export function login(
  protocol: Protocol,
  relay: RelayConnection,
  options: { username: string; password: string; majorVersion?: number; minorVersion?: number },
): Promise<LoginResponse>;
