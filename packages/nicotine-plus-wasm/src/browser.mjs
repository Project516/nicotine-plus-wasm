// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import { protocolMethods, PYODIDE_VERSION } from './protocol.mjs';

export { connectRelay, login } from './relay.mjs';

export async function createProtocol({
  pyodideIndexURL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
} = {}) {
  const indexURL = new URL(pyodideIndexURL, globalThis.location.href);
  if (!indexURL.pathname.endsWith('/')) indexURL.pathname += '/';
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map();
  let nextId = 0;
  let closed = false;

  function terminate(error = new Error('The Nicotine+ protocol worker is closed')) {
    closed = true;
    worker.terminate();
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function request(method, args) {
    if (closed) return Promise.reject(new Error('The Nicotine+ protocol worker is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  worker.onmessage = ({ data: { id, result, error } }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (error) call.reject(new Error(error));
    else call.resolve(result);
  };
  worker.onerror = ({ message }) => terminate(new Error(message || 'The Nicotine+ protocol worker failed'));
  worker.onmessageerror = () => terminate(new Error('Could not read the Nicotine+ protocol worker response'));

  try {
    await request('init', [indexURL.href]);
  } catch (error) {
    terminate(error);
    throw error;
  }

  return { ...protocolMethods(request), terminate: () => terminate() };
}
