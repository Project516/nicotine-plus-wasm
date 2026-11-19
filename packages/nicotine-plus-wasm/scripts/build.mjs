// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const files = ['utils.py', 'slskmessages.py'];

const sources = Object.fromEntries(await Promise.all(files.map(async (name) => [
  name,
  await readFile(new URL(`pynicotine/${name}`, root), 'utf8'),
])));
const bridge = await readFile(new URL('../src/bridge.py', import.meta.url), 'utf8');

await mkdir(new URL('upstream/', dist), { recursive: true });
await Promise.all([
  writeFile(new URL('python.mjs', dist), `export const sources = ${JSON.stringify(sources)};\nexport const bridge = ${JSON.stringify(bridge)};\n`),
  copyFile(new URL('COPYING', root), new URL('upstream/COPYING', dist)),
  copyFile(new URL('AUTHORS.md', root), new URL('upstream/AUTHORS.md', dist)),
  copyFile(new URL('LICENSES/AGPL-3.0-only.txt', root), new URL('LICENSE', dist)),
  ...files.map((name) => writeFile(new URL(`upstream/${name}`, dist), sources[name])),
]);
