// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

export const PYODIDE_VERSION = '314.0.7';
export const METHODS = {
  encodeLogin: 'encode_login',
  decodeLogin: 'decode_login',
  encodeSetStatus: 'encode_set_status',
  encodeSharedFoldersFiles: 'encode_shared_folders_files',
  encodeFileSearch: 'encode_file_search',
  encodeGetPeerAddress: 'encode_get_peer_address',
  decodeGetPeerAddress: 'decode_get_peer_address',
  decodeConnectToPeer: 'decode_connect_to_peer',
  encodeCantConnectToPeer: 'encode_cant_connect_to_peer',
  encodePierceFireWall: 'encode_pierce_fire_wall',
  encodePeerInit: 'encode_peer_init',
  decodeFileSearchResponse: 'decode_file_search_response',
  encodeFolderContentsRequest: 'encode_folder_contents_request',
  decodeFolderContentsResponse: 'decode_folder_contents_response',
  encodeQueueUpload: 'encode_queue_upload',
  encodePlaceInQueueRequest: 'encode_place_in_queue_request',
  decodePlaceInQueueResponse: 'decode_place_in_queue_response',
  decodeTransferRequest: 'decode_transfer_request',
  encodeTransferResponse: 'encode_transfer_response',
  decodeUploadDenied: 'decode_upload_denied',
  decodeUploadFailed: 'decode_upload_failed',
  decodeFileTransferInit: 'decode_file_transfer_init',
  encodeFileOffset: 'encode_file_offset',
};

export function protocolMethods(call) {
  return Object.fromEntries(Object.keys(METHODS).map((method) => [
    method,
    (...args) => call(method, args),
  ]));
}
