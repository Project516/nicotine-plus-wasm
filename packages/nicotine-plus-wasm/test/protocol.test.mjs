// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createProtocol } from '@project516/nicotine-plus-wasm';
import { PYODIDE_VERSION } from '../src/protocol.mjs';
import {
  connectToPeer, frame, initFrame, searchResponse, string, uint8, uint32, uint64,
} from './frames.mjs';

let protocol;
before(async () => { protocol = await createProtocol(); });
after(() => protocol?.terminate());

test('the npm and browser entries use the same Pyodide release', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PYODIDE_VERSION, pkg.dependencies.pyodide);
});

test('encodes a login request and decodes success and rejection replies', async () => {
  const checksum = createHash('md5').update('alicedummy').digest('hex');
  assert.deepEqual(
    Buffer.from(await protocol.encodeLogin('alice', 'dummy', 177, 1)),
    frame(1, string('alice'), string('dummy'), uint32(177), string(checksum), uint32(1)),
  );
  assert.deepEqual(
    await protocol.decodeLogin(new Uint8Array(
      frame(1, Buffer.of(1), string('Welcome'), Buffer.of(4, 3, 2, 1), string('checksum'), Buffer.of(1)),
    )),
    { success: true, banner: 'Welcome', ipAddress: '1.2.3.4', isSupporter: true },
  );
  assert.deepEqual(
    await protocol.decodeLogin(new Uint8Array(frame(1, Buffer.of(0), string('INVALIDPASS')))),
    { success: false, reason: 'INVALIDPASS' },
  );
});

test('encodes searches and looks up peer addresses', async () => {
  assert.deepEqual(Buffer.from(await protocol.encodeFileSearch(42, 'artist - album')), (
    frame(26, uint32(42), string('artist album'))
  ));
  assert.deepEqual(Buffer.from(await protocol.encodeGetPeerAddress('bob')), frame(3, string('bob')));
  assert.deepEqual(await protocol.decodeGetPeerAddress(new Uint8Array(
    frame(3, string('bob'), Buffer.of(8, 7, 6, 5), uint32(2242), uint32(0), Buffer.of(1, 0)),
  )), { username: 'bob', ipAddress: '5.6.7.8', port: 2242, obfuscatedPort: 1 });
});

test('rejects frames with a truncated header or mismatched server code or size', async () => {
  await assert.rejects(protocol.decodeLogin(new Uint8Array([0])), /Incomplete Soulseek server header/);
  await assert.rejects(
    protocol.decodeLogin(new Uint8Array(frame(3, string('bob')))),
    /Unexpected Soulseek server message size or code/,
  );
  await assert.rejects(
    protocol.decodeLogin(new Uint8Array(frame(1, Buffer.of(0), string('INVALIDPASS')).subarray(0, -1))),
    /Unexpected Soulseek server message size or code/,
  );
});

test('encodes status and shared folder messages', async () => {
  assert.deepEqual(Buffer.from(await protocol.encodeSetStatus(2)), frame(28, uint32(2)));
  assert.deepEqual(Buffer.from(await protocol.encodeSharedFoldersFiles(0, 0)), frame(35, uint32(0), uint32(0)));
});

test('decodes an indirect connection request and encodes the replies', async () => {
  const request = connectToPeer({ username: 'bob', type: 'P', address: '5.6.7.8', port: 2234, token: 77 });
  assert.deepEqual(await protocol.decodeConnectToPeer(new Uint8Array(request)), {
    username: 'bob', connType: 'P', ipAddress: '5.6.7.8', port: 2234, token: 77,
  });
  assert.deepEqual(
    Buffer.from(await protocol.encodeCantConnectToPeer(77, 'bob')),
    frame(1001, uint32(77), string('bob')),
  );
  assert.deepEqual(Buffer.from(await protocol.encodePierceFireWall(77)), initFrame(0, uint32(77)));
  assert.deepEqual(
    Buffer.from(await protocol.encodePeerInit('alice', 'P')),
    initFrame(1, string('alice'), string('P'), uint32(0)),
  );
});

test('decodes a search response and skips tokens that are not ours', async () => {
  const response = searchResponse({
    username: 'bob',
    token: 42,
    files: [
      { path: '@@a\\Music\\b.mp3', size: 1234, attributes: [[0, 320], [1, 200], [2, 0]] },
      { path: '@@a\\Music\\a.flac', size: 2 ** 33, attributes: [[1, 100], [4, 44100], [5, 16]] },
    ],
    freeSlot: false,
    uploadSpeed: 5000,
    queueLength: 3,
  });
  const decoded = await protocol.decodeFileSearchResponse(new Uint8Array(response), [41, 42]);
  assert.deepEqual(decoded, {
    token: 42,
    files: [
      { path: '@@a\\Music\\a.flac', size: 2 ** 33, duration: 100 },
      { path: '@@a\\Music\\b.mp3', size: 1234, bitrate: 320, duration: 200 },
    ],
    freeSlot: false,
    uploadSpeed: 5000,
    queueLength: 3,
  });
  assert.deepEqual(
    await protocol.decodeFileSearchResponse(new Uint8Array(response), [41]),
    { token: 42, files: undefined },
  );
});

test('encodes and decodes the queue and transfer messages', async () => {
  const path = '@@a\\Music\\b.mp3';
  assert.deepEqual(Buffer.from(await protocol.encodeQueueUpload(path)), frame(43, string(path)));
  assert.deepEqual(Buffer.from(await protocol.encodePlaceInQueueRequest(path)), frame(51, string(path)));
  assert.deepEqual(
    await protocol.decodePlaceInQueueResponse(new Uint8Array(frame(44, string(path), uint32(7)))),
    { path, position: 7 },
  );
  assert.deepEqual(
    await protocol.decodeTransferRequest(new Uint8Array(frame(40, uint32(1), uint32(9), string(path), uint64(4096)))),
    { direction: 1, token: 9, path, size: 4096 },
  );
  assert.deepEqual(
    Buffer.from(await protocol.encodeTransferResponse(9, true)),
    frame(41, uint32(9), uint8(1)),
  );
  assert.deepEqual(
    Buffer.from(await protocol.encodeTransferResponse(9, false, 'Cancelled')),
    frame(41, uint32(9), uint8(0), string('Cancelled')),
  );
  assert.deepEqual(
    await protocol.decodeUploadDenied(new Uint8Array(frame(50, string(path), string('File not shared.')))),
    { path, reason: 'File not shared.' },
  );
  assert.deepEqual(await protocol.decodeUploadFailed(new Uint8Array(frame(46, string(path)))), { path });
});

test('encodes and decodes the header-less file connection messages', async () => {
  assert.deepEqual(await protocol.decodeFileTransferInit(new Uint8Array(uint32(9))), { token: 9 });
  assert.deepEqual(Buffer.from(await protocol.encodeFileOffset(0)), uint64(0));
  assert.deepEqual(Buffer.from(await protocol.encodeFileOffset(5)), uint64(5));
});

test('rejects peer frames with a mismatched code or size', async () => {
  await assert.rejects(
    protocol.decodeUploadFailed(new Uint8Array(frame(50, string('x'), string('y')))),
    /Unexpected Soulseek peer message size or code/,
  );
  await assert.rejects(protocol.decodeUploadFailed(new Uint8Array([1, 0])), /Incomplete Soulseek peer header/);
});
