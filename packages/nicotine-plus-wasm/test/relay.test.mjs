// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { connectRelay, login } from '../src/relay.mjs';

class TestSocket extends EventTarget {
  static instance;
  binaryType;
  bufferedAmount = 0;
  sent = [];

  constructor() {
    super();
    TestSocket.instance = this;
  }

  send(message) {
    this.sent.push(message);
    this.dispatchEvent(new Event('sent'));
  }

  close() {
    this.dispatchEvent(new Event('close'));
  }

  message(data) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

globalThis.WebSocket = TestSocket;

test('authenticates before framing a fragmented login reply and the next reply', async () => {
  const connection = connectRelay('wss://example.test/relay', 'token');
  const socket = TestSocket.instance;
  socket.dispatchEvent(new Event('open'));
  assert.deepEqual(socket.sent, ['token']);
  socket.message('ready');
  const relay = await connection;

  const first = Uint8Array.of(5, 0, 0, 0, 1, 0, 0, 0, 1);
  const second = Uint8Array.of(4, 0, 0, 0, 3, 0, 0, 0);
  const protocol = {
    async encodeLogin(...args) {
      assert.deepEqual(args, ['user', 'pass', 177, 1]);
      return first;
    },
    async decodeLogin(frame) {
      assert.deepEqual(frame, first);
      return { success: true };
    },
  };
  const sent = once(socket, 'sent');
  const result = login(protocol, relay, { username: 'user', password: 'pass' });
  await sent;
  assert.deepEqual(socket.sent[1], first);
  socket.message(first.slice(0, 2).buffer);
  socket.message(first.slice(2, 7).buffer);
  socket.message(Uint8Array.of(...first.slice(7), ...second).buffer);
  assert.deepEqual(await result, { success: true });
  assert.deepEqual(await relay.receive(), second);

  relay.send(new Uint8Array(65537));
  assert.deepEqual(socket.sent.slice(2).map(chunk => chunk.length), [65536, 1]);
  relay.close();
});

test('rejects a pending read when the relay sends an invalid frame length', async () => {
  const connection = connectRelay('wss://example.test/relay', 'token');
  const socket = TestSocket.instance;
  socket.message('ready');
  const relay = await connection;
  const receive = relay.receive();
  socket.message(Uint8Array.of(255, 255, 255, 255).buffer);
  await assert.rejects(receive, /Invalid Soulseek frame length/);
});

test('closes the connection when a reply times out', async () => {
  const connection = connectRelay('wss://example.test/relay', 'token');
  TestSocket.instance.message('ready');
  const relay = await connection;
  await assert.rejects(relay.receive({ timeout: 5 }), /Timed out waiting for a Soulseek reply/);
  await assert.rejects(relay.receive(), /Timed out waiting for a Soulseek reply/);
});
