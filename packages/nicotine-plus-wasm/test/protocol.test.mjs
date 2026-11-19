// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createProtocol } from '@project516/nicotine-plus-wasm';
import { PYODIDE_VERSION } from '../src/protocol.mjs';

function uint32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function string(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function frame(code, ...fields) {
  const payload = Buffer.concat([uint32(code), ...fields]);
  return Buffer.concat([uint32(payload.length), payload]);
}

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
