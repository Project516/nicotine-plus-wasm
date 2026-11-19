// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const files = new Map([
  ['/', ['text/html', '<!doctype html><title>Nicotine+ Wasm test</title>']],
]);
for (const [directory, names] of Object.entries({
  src: ['browser.mjs', 'worker.mjs', 'protocol.mjs', 'engine.mjs', 'relay.mjs', 'client.mjs'],
  dist: ['python.mjs'],
  'node_modules/pyodide': [
    'pyodide.mjs',
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'pyodide-lock.json',
    'python_stdlib.zip',
  ],
})) {
  for (const name of names) {
    const path = `${directory}/${name}`;
    const contentType = name.endsWith('.wasm') ? 'application/wasm'
      : name.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
    files.set(`/${path}`, [contentType, new URL(`../${path}`, import.meta.url)]);
  }
}

async function openPage(t) {
  const server = createServer(async (request, response) => {
    const file = files.get(request.url);
    if (!file) return response.writeHead(404).end();
    const [contentType, source] = file;
    try {
      const content = source instanceof URL ? await readFile(source) : source;
      response.writeHead(200, { 'content-type': contentType }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const address = `127.0.0.1:${server.address().port}`;
  const relayURL = `ws://${address}/relay`;
  const { promise: loginRequest, resolve: recordLogin } = Promise.withResolvers();
  await page.routeWebSocket(relayURL, (socket) => {
    socket.onMessage((message) => {
      if (message === 'test-token') {
        socket.send('ready');
        return;
      }
      recordLogin(message);
      socket.send(Buffer.from([10, 0, 0, 0]));
      socket.send(Buffer.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 88]));
    });
  });
  await page.goto(`http://${address}`);
  return { page, relayURL, loginRequest };
}

test('the browser worker encodes a search and logs in through the relay', { timeout: 30_000 }, async (t) => {
  const { page, relayURL, loginRequest } = await openPage(t);
  const result = await page.evaluate(async (url) => {
    const { connectRelay, createProtocol, login } = await import('/src/browser.mjs');
    const protocol = await createProtocol({ pyodideIndexURL: '/node_modules/pyodide/' });
    let relay;
    try {
      const search = await protocol.encodeFileSearch(42, 'artist');
      relay = await connectRelay(url, 'test-token', { signal: AbortSignal.timeout(5000) });
      const response = await login(protocol, relay, { username: 'test-user', password: 'test-password' });
      return { search: Array.from(search), login: response };
    } finally {
      relay?.close();
      protocol.terminate();
    }
  }, relayURL);
  assert.deepEqual(result.search, [18, 0, 0, 0, 26, 0, 0, 0, 42, 0, 0, 0, 6, 0, 0, 0, 97, 114, 116, 105, 115, 116]);
  assert.deepEqual(result.login, { success: false, reason: 'X' });
  const frame = await loginRequest;
  assert.equal(frame.readUInt32LE(4), 1);
  assert.equal(frame.readUInt32LE(8), 'test-user'.length);
  assert.equal(frame.toString('utf8', 12, 21), 'test-user');
});

test('connectClient rejects a failed login with a LoginError', { timeout: 30_000 }, async (t) => {
  const { page, relayURL } = await openPage(t);
  const result = await page.evaluate(async (url) => {
    const { connectClient, LoginError } = await import('/src/browser.mjs');
    try {
      await connectClient({
        relayURL: url,
        relayToken: 'test-token',
        username: 'test-user',
        password: 'test-password',
        signal: AbortSignal.timeout(10_000),
        pyodideIndexURL: '/node_modules/pyodide/',
      });
    } catch (error) {
      return { login: error instanceof LoginError, reason: error.reason };
    }
    return { login: false };
  }, relayURL);
  assert.deepEqual(result, { login: true, reason: 'X' });
});
