// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

export const PYODIDE_VERSION = '314.0.7';
export const METHODS = {
  encodeLogin: 'encode_login',
  decodeLogin: 'decode_login',
  encodeFileSearch: 'encode_file_search',
  encodeGetPeerAddress: 'encode_get_peer_address',
  decodeGetPeerAddress: 'decode_get_peer_address',
};

export function protocolMethods(call) {
  return Object.fromEntries(Object.keys(METHODS).map((method) => [
    method,
    (...args) => call(method, args),
  ]));
}
