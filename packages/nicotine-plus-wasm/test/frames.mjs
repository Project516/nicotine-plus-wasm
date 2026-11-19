// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import { deflateSync } from 'node:zlib';

export function uint8(value) {
  return Buffer.of(value);
}

export function uint32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

export function uint64(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(BigInt(value));
  return result;
}

export function string(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

export function ip(address) {
  return Buffer.from(address.split('.').map(Number).reverse());
}

// Server and peer frames: length, uint32 code, payload
export function frame(code, ...fields) {
  const payload = Buffer.concat([uint32(code), ...fields]);
  return Buffer.concat([uint32(payload.length), payload]);
}

// Peer init frames: length, uint8 code, payload
export function initFrame(code, ...fields) {
  const payload = Buffer.concat([uint8(code), ...fields]);
  return Buffer.concat([uint32(payload.length), payload]);
}

export function fileEntry({ path, size, attributes = [] }) {
  return Buffer.concat([
    uint8(1),
    string(path),
    uint64(size),
    uint32(0),
    uint32(attributes.length),
    ...attributes.flatMap(([id, value]) => [uint32(id), uint32(value)]),
  ]);
}

// Peer code 9, with the payload zlib-compressed
export function searchResponse({ username, token, files, freeSlot = true, uploadSpeed = 0, queueLength = 0 }) {
  const payload = Buffer.concat([
    string(username),
    uint32(token),
    uint32(files.length),
    ...files.map(fileEntry),
    uint8(freeSlot ? 1 : 0),
    uint32(uploadSpeed),
    uint32(queueLength),
    uint32(0),
  ]);
  return frame(9, deflateSync(payload));
}

// Peer code 37: a folder and its subfolders, zlib-compressed
export function folderContents({ token, folder, folders }) {
  const payload = Buffer.concat([
    uint32(token),
    string(folder),
    uint32(Object.keys(folders).length),
    ...Object.entries(folders).flatMap(([name, files]) => [string(name), uint32(files.length), ...files.map(fileEntry)]),
  ]);
  return frame(37, deflateSync(payload));
}

export function connectToPeer({ username, type, address, port, token }) {
  return frame(
    18, string(username), string(type), ip(address), uint32(port), uint32(token),
    uint8(0), uint32(0), uint32(0),
  );
}
