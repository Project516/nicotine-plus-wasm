// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { connectClient, createProtocol, DownloadError, LoginError } from '@project516/nicotine-plus-wasm';
import { createClientConnector } from '../src/client.mjs';
import {
  connectToPeer, frame, initFrame, ip, searchResponse, string, uint8, uint32, uint64,
} from './frames.mjs';

const RELAY = 'wss://relay.test/relay';
const PATH = '@@a\\Music\\Song.MP3';
const LOGIN_OK = frame(1, uint8(1), string('Welcome'), ip('1.2.3.4'), string('checksum'), uint8(0));
const BOB_ADDRESS = frame(3, string('bob'), ip('5.6.7.8'), uint32(2234), uint32(0), Buffer.of(0, 0));

class Endpoint {
  sockets = [];
  #frames = [];
  #waiters = [];

  receive(buffer) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(buffer);
    else this.#frames.push(buffer);
  }

  next() {
    if (this.#frames.length) return Promise.resolve(this.#frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a client frame')), 5000);
      this.#waiters.push((buffer) => {
        clearTimeout(timer);
        resolve(buffer);
      });
    });
  }

  send(buffer) {
    this.sockets.at(-1).message(buffer);
  }

  get socket() {
    return this.sockets.at(-1);
  }
}

let network;

class FakeNetwork {
  endpoints = new Map();
  refused = new Set();

  endpoint(target) {
    if (!this.endpoints.has(target)) this.endpoints.set(target, new Endpoint());
    return this.endpoints.get(target);
  }
}

class FakeSocket extends EventTarget {
  binaryType = '';
  bufferedAmount = 0;
  closed = false;

  constructor(url) {
    super();
    const { searchParams } = new URL(url);
    this.target = searchParams.has('ip') ? `${searchParams.get('ip')}:${searchParams.get('port')}` : 'server';
    this.endpoint = network.endpoint(this.target);
    this.endpoint.sockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(data) {
    if (typeof data !== 'string') {
      this.endpoint.receive(Buffer.from(data));
    } else if (network.refused.has(this.target)) {
      queueMicrotask(() => this.drop(1011, 'TCP connection failed'));
    } else {
      queueMicrotask(() => this.message('ready'));
    }
  }

  message(data) {
    if (this.closed) return;
    this.dispatchEvent(new MessageEvent('message', {
      data: typeof data === 'string' ? data : Uint8Array.from(data).buffer,
    }));
  }

  drop(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }

  close() {
    this.drop(1000, '');
  }
}

async function until(condition) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Condition not met in time');
}

let protocol;
let connect;
before(async () => {
  globalThis.WebSocket = FakeSocket;
  // One shared Pyodide instance keeps the suite fast
  protocol = await createProtocol();
  connect = createClientConnector(async () => ({ ...protocol, terminate() {} }));
});
after(() => protocol?.terminate());
beforeEach(() => { network = new FakeNetwork(); });

async function startClient(t) {
  const server = network.endpoint('server');
  const connecting = connect({ relayURL: RELAY, relayToken: 'token', username: 'alice', password: 'secret' });
  const login = await server.next();
  assert.equal(login.readUInt32LE(4), 1);
  server.send(LOGIN_OK);
  const client = await connecting;
  t.after(() => client.close());
  assert.deepEqual(await server.next(), frame(28, uint32(2)));
  assert.deepEqual(await server.next(), frame(35, uint32(0), uint32(0)));
  return { client, server };
}

async function beginDownload(client, server, options) {
  const result = client.download('bob', PATH, options);
  result.catch(() => {});
  assert.deepEqual(await server.next(), frame(3, string('bob')));
  server.send(BOB_ADDRESS);
  const peer = network.endpoint('5.6.7.8:2234');
  assert.deepEqual(await peer.next(), initFrame(1, string('alice'), string('P'), uint32(0)));
  assert.deepEqual(await peer.next(), frame(43, string(PATH)));
  assert.deepEqual(await peer.next(), frame(51, string(PATH)));
  return { result, peer };
}

test('pings the server once a minute', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { server } = await startClient(t);
  t.mock.timers.tick(60000);
  assert.deepEqual(await server.next(), frame(32));
});

test('connectClient from the package rejects a failed login with a LoginError', async () => {
  const server = network.endpoint('server');
  const connecting = connectClient({ relayURL: RELAY, relayToken: 'token', username: 'alice', password: 'bad' });
  const login = await server.next();
  assert.equal(login.readUInt32LE(4), 1);
  server.send(frame(1, uint8(0), string('INVALIDPASS')));
  await assert.rejects(connecting, (error) => {
    assert.ok(error instanceof LoginError);
    assert.equal(error.reason, 'INVALIDPASS');
    return true;
  });
  assert.ok(server.socket.closed);
});

test('searches and reports a result from a pierced peer connection', async (t) => {
  const { client, server } = await startClient(t);
  const results = [];
  const search = client.search('artist', { onResult: (result) => results.push(result), timeout: 1000 });

  const request = await server.next();
  assert.equal(request.readUInt32LE(4), 26);
  const token = request.readUInt32LE(8);

  server.send(connectToPeer({ username: 'bob', type: 'P', address: '9.9.9.9', port: 3000, token: 555 }));
  const peer = network.endpoint('9.9.9.9:3000');
  assert.deepEqual(await peer.next(), initFrame(0, uint32(555)));
  peer.send(searchResponse({
    username: 'ignored',
    token,
    files: [{ path: PATH, size: 1234, attributes: [[0, 320], [1, 200]] }, { path: 'no-extension', size: 1 }],
    freeSlot: false,
    uploadSpeed: 5000,
    queueLength: 3,
  }));
  await until(() => results.length);
  assert.deepEqual(results, [{
    username: 'bob',
    freeSlot: false,
    queueLength: 3,
    uploadSpeed: 5000,
    files: [
      { path: PATH, name: 'Song.MP3', size: 1234, extension: 'mp3', bitrate: 320, duration: 200 },
      { path: 'no-extension', name: 'no-extension', size: 1, extension: '' },
    ],
  }]);
  await until(() => peer.socket.closed);

  // A response for a token we did not send is dropped
  server.send(connectToPeer({ username: 'carol', type: 'P', address: '9.9.9.8', port: 3001, token: 556 }));
  const stale = network.endpoint('9.9.9.8:3001');
  assert.deepEqual(await stale.next(), initFrame(0, uint32(556)));
  stale.send(searchResponse({ username: 'carol', token: token + 1, files: [{ path: PATH, size: 1 }] }));
  await until(() => stale.socket.closed || results.length > 1);
  assert.equal(results.length, 1);

  await search;
});

test('answers CantConnectToPeer when a peer cannot be reached or the type is unknown', async (t) => {
  const { server } = await startClient(t);
  network.refused.add('7.7.7.7:1');
  server.send(connectToPeer({ username: 'dave', type: 'P', address: '7.7.7.7', port: 1, token: 600 }));
  assert.deepEqual(await server.next(), frame(1001, uint32(600), string('dave')));
  server.send(connectToPeer({ username: 'dave', type: 'D', address: '7.7.7.6', port: 1, token: 601 }));
  assert.deepEqual(await server.next(), frame(1001, uint32(601), string('dave')));
});

test('stops a search when its signal aborts', async (t) => {
  const { client, server } = await startClient(t);
  const controller = new AbortController();
  const search = client.search('artist', { onResult() {}, signal: controller.signal });
  await server.next();
  controller.abort();
  await assert.rejects(search, { name: 'AbortError' });
});

test('downloads a file through the queue, transfer request and file connection', async (t) => {
  const { client, server } = await startClient(t);
  const progress = [];
  const { result, peer } = await beginDownload(client, server, { onProgress: (state) => progress.push(state) });

  peer.send(frame(44, string(PATH), uint32(3)));
  await until(() => progress.length === 3);
  peer.send(frame(40, uint32(1), uint32(9), string(PATH), uint64(10)));
  assert.deepEqual(await peer.next(), frame(41, uint32(9), uint8(1)));

  server.send(connectToPeer({ username: 'bob', type: 'F', address: '5.6.7.8', port: 2235, token: 321 }));
  const file = network.endpoint('5.6.7.8:2235');
  assert.deepEqual(await file.next(), initFrame(0, uint32(321)));
  // The token header and the first bytes can share one chunk
  file.send(Buffer.concat([uint32(9), Buffer.from('hello')]));
  assert.deepEqual(await file.next(), uint64(0));
  file.send(Buffer.from('world'));

  const blob = await result;
  assert.equal(await blob.text(), 'helloworld');
  assert.deepEqual(progress, [
    { state: 'connecting' },
    { state: 'queued' },
    { state: 'queued', position: 3 },
    { state: 'transferring', received: 0, total: 10 },
    { state: 'transferring', received: 5, total: 10 },
    { state: 'transferring', received: 10, total: 10 },
  ]);
  await until(() => file.socket.closed && peer.socket.closed);
});

test('accepts a transfer request on the peer connection that the peer opened', async (t) => {
  const { client, server } = await startClient(t);
  const { result, peer } = await beginDownload(client, server);

  peer.socket.drop(1000, '');
  server.send(connectToPeer({ username: 'bob', type: 'P', address: '5.6.7.8', port: 2300, token: 700 }));
  const indirect = network.endpoint('5.6.7.8:2300');
  assert.deepEqual(await indirect.next(), initFrame(0, uint32(700)));
  indirect.send(frame(40, uint32(1), uint32(4), string(PATH), uint64(2)));
  assert.deepEqual(await indirect.next(), frame(41, uint32(4), uint8(1)));

  server.send(connectToPeer({ username: 'bob', type: 'F', address: '5.6.7.8', port: 2235, token: 322 }));
  const file = network.endpoint('5.6.7.8:2235');
  assert.deepEqual(await file.next(), initFrame(0, uint32(322)));
  file.send(uint32(4));
  assert.deepEqual(await file.next(), uint64(0));
  file.send(Buffer.from('ok'));
  assert.equal(await (await result).text(), 'ok');
});

test('rejects transfer requests for files that were not queued', async (t) => {
  const { client, server } = await startClient(t);
  const { peer } = await beginDownload(client, server);
  peer.send(frame(40, uint32(1), uint32(5), string('@@a\\other.mp3'), uint64(2)));
  assert.deepEqual(await peer.next(), frame(41, uint32(5), uint8(0), string('Cancelled')));
});

test('rejects with the reason when the peer denies the upload', async (t) => {
  const { client, server } = await startClient(t);
  const { result, peer } = await beginDownload(client, server);
  peer.send(frame(50, string(PATH), string('File not shared.')));
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof DownloadError);
    assert.equal(error.reason, 'File not shared.');
    return true;
  });
  await until(() => peer.socket.closed);
});

test('rejects when the peer reports a failed upload', async (t) => {
  const { client, server } = await startClient(t);
  const { result, peer } = await beginDownload(client, server);
  peer.send(frame(46, string(PATH)));
  await assert.rejects(result, DownloadError);
});

test('rejects when the user is offline or its port is closed', async (t) => {
  const { client, server } = await startClient(t);
  const offline = client.download('bob', PATH);
  await server.next();
  server.send(frame(3, string('bob'), ip('0.0.0.0'), uint32(0), uint32(0), Buffer.of(0, 0)));
  await assert.rejects(offline, { reason: 'The user is offline' });

  const closedPort = client.download('bob', PATH);
  await server.next();
  server.send(frame(3, string('bob'), ip('5.6.7.8'), uint32(0), uint32(0), Buffer.of(0, 0)));
  await assert.rejects(closedPort, /no open listening port/);

  network.refused.add('5.6.7.8:2234');
  const refused = client.download('bob', PATH);
  await server.next();
  server.send(BOB_ADDRESS);
  await assert.rejects(refused, (error) => error instanceof DownloadError && /Could not connect/.test(error.reason));
});

test('aborting a download closes its sockets', async (t) => {
  const { client, server } = await startClient(t);
  const controller = new AbortController();
  const { result, peer } = await beginDownload(client, server, { signal: controller.signal });

  peer.send(frame(40, uint32(1), uint32(9), string(PATH), uint64(10)));
  assert.deepEqual(await peer.next(), frame(41, uint32(9), uint8(1)));
  server.send(connectToPeer({ username: 'bob', type: 'F', address: '5.6.7.8', port: 2235, token: 321 }));
  const file = network.endpoint('5.6.7.8:2235');
  await file.next();
  file.send(uint32(9));
  await file.next();
  file.send(Buffer.from('he'));

  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  await until(() => file.socket.closed && peer.socket.closed);
  await assert.rejects(client.download('bob', PATH, { signal: controller.signal }), { name: 'AbortError' });
});

test('fails the download when the file connection closes early', async (t) => {
  const { client, server } = await startClient(t);
  const { result, peer } = await beginDownload(client, server);
  peer.send(frame(40, uint32(1), uint32(9), string(PATH), uint64(10)));
  await peer.next();
  server.send(connectToPeer({ username: 'bob', type: 'F', address: '5.6.7.8', port: 2235, token: 321 }));
  const file = network.endpoint('5.6.7.8:2235');
  await file.next();
  file.send(Buffer.concat([uint32(9), Buffer.from('he')]));
  await file.next();
  file.socket.drop(1000, '');
  await assert.rejects(result, DownloadError);
});

test('closed settles with the error when the server connection drops', async (t) => {
  const { client, server } = await startClient(t);
  const pending = client.download('bob', PATH);
  pending.catch(() => {});
  await server.next();
  server.socket.drop(1006, 'gone');
  const error = await client.closed;
  assert.ok(error instanceof Error);
  assert.match(error.message, /gone/);
  await assert.rejects(pending, /gone/);
  await assert.rejects(client.search('x', { onResult() {} }), /gone/);
});

test('close ends the client and its sockets', async (t) => {
  const { client, server } = await startClient(t);
  client.close();
  assert.match((await client.closed).message, /closed/);
  assert.ok(server.socket.closed);
  await assert.rejects(client.download('bob', PATH), /closed/);
});
