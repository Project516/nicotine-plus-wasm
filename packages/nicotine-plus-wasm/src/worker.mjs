// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import { createEngine } from './engine.mjs';

let engine;
self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    if (method === 'init') {
      const [indexURL] = args;
      const moduleURL = new URL('pyodide.mjs', indexURL).href;
      const { loadPyodide } = await import(/* @vite-ignore */ moduleURL);
      engine = createEngine(await loadPyodide({ indexURL }));
      self.postMessage({ id });
      return;
    }
    const result = engine.call(method, args);
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
