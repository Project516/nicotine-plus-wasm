// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import { bridge, sources } from '../dist/python.mjs';
import { METHODS } from './protocol.mjs';

export function createEngine(py) {
  // Import the original protocol source without starting the desktop application.
  const path = `${py.FS.cwd()}/pynicotine`;
  py.FS.mkdir(path);
  for (const [name, source] of Object.entries(sources)) {
    py.FS.writeFile(`${path}/${name}`, source);
  }
  const scope = py.runPython('dict()');
  py.runPython(bridge, { globals: scope });
  return {
    call(method, args) {
      const name = METHODS[method];
      if (!Object.hasOwn(METHODS, method)) throw new Error(`Unknown protocol method ${method}`);
      const fn = scope.get(name);
      try {
        const result = fn(...args);
        try {
          return result.toJs({ dict_converter: Object.fromEntries });
        } finally {
          result.destroy();
        }
      } finally {
        fn.destroy();
      }
    },
    terminate() {
      scope.destroy();
    },
  };
}
