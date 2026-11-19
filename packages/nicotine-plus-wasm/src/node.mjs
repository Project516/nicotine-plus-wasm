// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import { loadPyodide } from 'pyodide';
import { createClientConnector } from './client.mjs';
import { createEngine } from './engine.mjs';
import { protocolMethods } from './protocol.mjs';

export { DownloadError, LoginError } from './client.mjs';

export async function createProtocol({ pyodideIndexURL } = {}) {
  let engine = createEngine(await loadPyodide({ indexURL: pyodideIndexURL }));
  return {
    ...protocolMethods(async (method, args) => {
      if (!engine) throw new Error('The Nicotine+ protocol instance is closed');
      return engine.call(method, args);
    }),
    terminate() {
      engine?.terminate();
      engine = null;
    },
  };
}

export const connectClient = createClientConnector(createProtocol);
