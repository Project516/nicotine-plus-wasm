// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

import { connectRelay, login } from './relay.mjs';

const SERVER_CODE = { getPeerAddress: 3, connectToPeer: 18, relogged: 41 };
// ServerPing has no payload: length 4, code 32
const SERVER_PING = Uint8Array.of(4, 0, 0, 0, 32, 0, 0, 0);
const PING_INTERVAL = 60000;
const PEER_CODE = {
  fileSearchResponse: 9,
  transferRequest: 40,
  placeInQueueResponse: 44,
  uploadFailed: 46,
  uploadDenied: 50,
  folderContentsResponse: 37,
};
const UPLOAD = 1;

const ADDRESS_TIMEOUT = 15000;
const SLOT_WAIT = 8000;
const SESSION_SLOT_WAIT = 30000;
const RESULT_IDLE = 10000;
const SESSION_IDLE = 60000;
const BROWSE_TIMEOUT = 30000;
const FILE_IDLE = 60000;
// How long a peer that dropped our connection has to answer a queued download
const ANSWER_TIMEOUT = 60000;
// Some clients wait about 30 seconds before they open the file connection
const FILE_CONNECT_TIMEOUT = 45000;

export class LoginError extends Error {
  constructor(reason) {
    super(`Soulseek login failed: ${reason}`);
    this.name = 'LoginError';
    this.reason = reason;
  }
}

export class DownloadError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'DownloadError';
    this.reason = reason;
  }
}

function createLimiter(limit) {
  let free = limit;
  const waiting = [];

  function release() {
    const next = waiting.shift();
    if (next) next();
    else free++;
  }

  return (timeout) => new Promise((resolve, reject) => {
    let timer;
    const grant = () => {
      clearTimeout(timer);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        release();
      });
    };
    if (free > 0) {
      free--;
      grant();
      return;
    }
    waiting.push(grant);
    timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(grant), 1);
      reject(new Error('No relay connection became free in time'));
    }, timeout);
  });
}

function frameCode(frame) {
  if (frame.length < 8) return -1;
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true);
}

function searchFile(file) {
  const name = file.path.slice(file.path.lastIndexOf('\\') + 1);
  const dot = name.lastIndexOf('.');
  return { ...file, name, extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
}

export function createClientConnector(createProtocol) {
  return async function connectClient({
    relayURL, relayToken, username, password, signal, pyodideIndexURL,
  }) {
    signal?.throwIfAborted();
    const protocol = await createProtocol({ pyodideIndexURL });
    // The caller's signal only covers connecting, not the lifetime of the client
    const connecting = new AbortController();
    const abort = () => connecting.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let server;
    try {
      signal?.throwIfAborted();
      server = await connectRelay(relayURL, relayToken, { signal: connecting.signal });
      const reply = await login(protocol, server, { username, password });
      if (!reply.success) throw new LoginError(reply.reason);
      server.send(await protocol.encodeSetStatus(2));
      server.send(await protocol.encodeSharedFoldersFiles(0, 0));
    } catch (error) {
      server?.close();
      protocol.terminate();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    return startClient({ protocol, server, relayURL, relayToken, username });
  };
}

function startClient({ protocol, server, relayURL, relayToken, username: self }) {
  const searches = new Map();
  // Folder listings in progress, keyed by user and folder
  const browses = new Map();
  const downloads = new Set();
  const transfers = new Map();
  const sessions = new Map();
  const peers = new Set();
  const addressWaiters = new Set();
  // The relay allows 64 connections. A search brings hundreds of peer requests,
  // so most slots go to search results. Leave room for a second client.
  const slots = { incidental: createLimiter(40), session: createLimiter(4), file: createLimiter(5) };
  const closed = Promise.withResolvers();
  let failure;
  let nextSearchToken = Math.floor(Math.random() * 1e6);
  let nextBrowseToken = Math.floor(Math.random() * 1e6);

  const ping = setInterval(() => {
    try {
      server.send(SERVER_PING);
    } catch {
      // The receive loop reports the failure
    }
  }, PING_INTERVAL);

  function shutdown(error) {
    if (failure) return;
    failure = error;
    clearInterval(ping);
    closed.resolve(error);
    for (const search of searches.values()) search.fail(error);
    for (const browse of [...browses.values()]) browse.fail(error);
    for (const download of [...downloads]) download.fail(error);
    for (const waiter of addressWaiters) waiter.reject(error);
    for (const peer of [...peers]) peer.close();
    server.close();
    protocol.terminate();
  }

  function peerURL({ ipAddress, port }) {
    const url = new URL(relayURL);
    url.searchParams.set('ip', ipAddress);
    url.searchParams.set('port', String(port));
    return url.href;
  }

  async function openPeer(slot, address, { raw = false, wait = SLOT_WAIT } = {}) {
    const release = await slot(wait);
    let relay;
    try {
      if (failure) throw failure;
      relay = await connectRelay(peerURL(address), relayToken, { raw });
    } catch (error) {
      release();
      throw error;
    }
    const peer = {
      relay,
      close() {
        relay.close();
        peers.delete(peer);
        release();
      },
    };
    peers.add(peer);
    if (failure) {
      peer.close();
      throw failure;
    }
    return peer;
  }

  async function cantConnect({ token, username }) {
    try {
      server.send(await protocol.encodeCantConnectToPeer(token, username));
    } catch {
      // The server connection is gone
    }
  }

  const hasDownload = (username) => [...downloads].some((download) => download.username === username);
  const findDownload = (username, path) => [...downloads].find(
    (download) => download.username === username && download.path === path,
  );
  const transferKey = (username, token) => `${username}\0${token}`;

  // Server messages

  async function handleServerFrame(frame) {
    switch (frameCode(frame)) {
      case SERVER_CODE.getPeerAddress: {
        const address = await protocol.decodeGetPeerAddress(frame);
        for (const waiter of addressWaiters) {
          if (waiter.username === address.username) waiter.resolve(address);
        }
        break;
      }
      case SERVER_CODE.connectToPeer: {
        const request = await protocol.decodeConnectToPeer(frame);
        if (request.connType === 'P') acceptPeer(request);
        else if (request.connType === 'F') acceptFile(request);
        else cantConnect(request);
        break;
      }
      case SERVER_CODE.relogged:
        shutdown(new Error('Another client logged in with this username'));
        break;
    }
  }

  async function serverLoop() {
    try {
      for (;;) {
        const frame = await server.receive();
        try {
          await handleServerFrame(frame);
        } catch {
          // Skip a malformed message and keep the connection, as upstream does
        }
      }
    } catch (error) {
      shutdown(error);
    }
  }

  // Peer connections the peer asked for through the server

  async function acceptPeer(request) {
    const slot = hasDownload(request.username) ? slots.session : slots.incidental;
    let peer;
    try {
      peer = await openPeer(slot, request);
    } catch {
      cantConnect(request);
      return;
    }
    try {
      peer.relay.send(await protocol.encodePierceFireWall(request.token));
      await servePeer(peer.relay, request.username, RESULT_IDLE, true);
    } catch {
      // The socket closed
    } finally {
      peer.close();
    }
  }

  async function servePeer(relay, username, idle, closeAfterResult) {
    try {
      for (;;) {
        const frame = await relay.receive({ timeout: idle });
        const isResult = await handlePeerFrame(frame, username, relay);
        if (isResult && closeAfterResult && !hasDownload(username)) return;
      }
    } catch {
      // The peer closed the socket, went idle or sent a malformed frame
    }
  }

  async function handlePeerFrame(frame, username, relay) {
    switch (frameCode(frame)) {
      case PEER_CODE.fileSearchResponse:
        if (searches.size) await handleSearchResponse(frame, username);
        return true;
      case PEER_CODE.folderContentsResponse:
        await handleFolderContents(frame, username);
        return true;
      case PEER_CODE.transferRequest:
        await handleTransferRequest(frame, username, relay);
        break;
      case PEER_CODE.placeInQueueResponse: {
        const { path, position } = await protocol.decodePlaceInQueueResponse(frame);
        const download = findDownload(username, path);
        if (download) download.confirmed = true;
        if (download && download.token === undefined) download.notify({ state: 'queued', position });
        break;
      }
      case PEER_CODE.uploadDenied: {
        const { path, reason } = await protocol.decodeUploadDenied(frame);
        findDownload(username, path)?.fail(new DownloadError(reason));
        break;
      }
      case PEER_CODE.uploadFailed: {
        const { path } = await protocol.decodeUploadFailed(frame);
        findDownload(username, path)?.fail(new DownloadError('The peer could not upload the file'));
        break;
      }
    }
    return false;
  }

  async function handleSearchResponse(frame, username) {
    const response = await protocol.decodeFileSearchResponse(frame, [...searches.keys()]);
    const search = searches.get(response.token);
    if (!search || !response.files?.length) return;
    try {
      search.onResult({
        username,
        freeSlot: response.freeSlot,
        queueLength: response.queueLength,
        uploadSpeed: response.uploadSpeed,
        files: response.files.map(searchFile),
      });
    } catch (error) {
      search.fail(error);
    }
  }

  async function handleFolderContents(frame, username) {
    const folders = [...browses.values()].filter((browse) => browse.username === username).map((browse) => browse.folder);
    if (!folders.length) return;
    const { folder, files } = await protocol.decodeFolderContentsResponse(frame, username, folders);
    const browse = browses.get(transferKey(username, folder));
    if (!browse || !files) return;
    // Legacy clients read paths as latin-1 and find no folder with a non-ASCII name
    if (!files.length && !browse.legacy && /[^\x00-\x7f]/.test(folder)) {
      browse.legacy = true;
      try {
        browse.relay.send(await protocol.encodeFolderContentsRequest(nextBrowseToken++, folder, true));
        return;
      } catch {
        // The connection closed, so the empty listing stands
      }
    }
    browse.finish(files.map(searchFile));
  }

  async function handleTransferRequest(frame, username, relay) {
    const request = await protocol.decodeTransferRequest(frame);
    if (request.direction !== UPLOAD) return;
    const download = findDownload(username, request.path);
    const accept = download && Number.isSafeInteger(request.size)
      && (download.token === undefined || download.token === request.token);
    if (accept && download.token === undefined) {
      download.token = request.token;
      download.confirmed = true;
      // SoulseekQt reports size 0 for files over 2 GiB
      download.size = request.size || download.size;
      transfers.set(transferKey(username, request.token), download);
      download.timer = setTimeout(
        () => download.fail(new DownloadError('The peer did not open a file connection')),
        FILE_CONNECT_TIMEOUT,
      );
    }
    relay.send(await protocol.encodeTransferResponse(
      request.token, Boolean(accept), accept ? undefined : 'Cancelled',
    ));
  }

  // File connections

  async function acceptFile(request) {
    const expected = [...downloads].some((download) => (
      download.username === request.username && download.token !== undefined && !download.fileSocket
    ));
    if (!expected) {
      cantConnect(request);
      return;
    }
    let peer;
    try {
      peer = await openPeer(slots.file, request, { raw: true });
    } catch {
      cantConnect(request);
      return;
    }
    try {
      peer.relay.send(await protocol.encodePierceFireWall(request.token));
      await receiveFile(peer, request.username);
    } catch {
      // The download fails through its own timeout or the transfer error below
    } finally {
      peer.close();
    }
  }

  async function receiveFile(peer, username) {
    const { relay } = peer;
    // The uploader starts with the 4 byte token of its TransferRequest
    const header = new Uint8Array(4);
    let filled = 0;
    let data = new Uint8Array(0);
    while (filled < header.length) {
      const chunk = await relay.receive({ timeout: FILE_IDLE });
      const count = Math.min(header.length - filled, chunk.length);
      header.set(chunk.subarray(0, count), filled);
      filled += count;
      data = chunk.subarray(count);
    }

    const { token } = await protocol.decodeFileTransferInit(header);
    const download = transfers.get(transferKey(username, token));
    if (!download || download.fileSocket) return;
    download.fileSocket = peer;
    clearTimeout(download.timer);

    try {
      relay.send(await protocol.encodeFileOffset(0));
      const chunks = [];
      let received = 0;
      download.notify({ state: 'transferring', received, total: download.size });
      for (;;) {
        const count = Math.min(data.length, download.size - received);
        if (count > 0) {
          chunks.push(count < data.length ? data.subarray(0, count) : data);
          received += count;
          download.notify({ state: 'transferring', received, total: download.size });
        }
        if (received >= download.size) break;
        data = await relay.receive({ timeout: FILE_IDLE });
      }
      download.finish(new Blob(chunks));
    } catch {
      download.fail(new DownloadError('The peer closed the file connection before the transfer finished'));
    }
  }

  // Downloads over one direct peer connection per user. A second PeerInit from
  // the same user makes the peer drop the first connection.

  async function peerAddress(username) {
    const frame = await protocol.encodeGetPeerAddress(username);
    const { promise, resolve, reject } = Promise.withResolvers();
    const waiter = { username, resolve, reject };
    addressWaiters.add(waiter);
    const timer = setTimeout(
      () => reject(new DownloadError('The server did not return the peer address')),
      ADDRESS_TIMEOUT,
    );
    try {
      server.send(frame);
      return await promise;
    } finally {
      clearTimeout(timer);
      addressWaiters.delete(waiter);
    }
  }

  async function connectSession(username, session) {
    const address = await peerAddress(username);
    if (address.ipAddress === '0.0.0.0') throw new DownloadError('The user is offline');
    // Without a listening port the peer is only reachable by connecting to us
    if (!address.port) throw new DownloadError('The peer has no open listening port');

    let peer;
    try {
      peer = await openPeer(slots.session, address, { wait: SESSION_SLOT_WAIT });
    } catch (error) {
      throw new DownloadError(`Could not connect to the peer: ${error.message}`);
    }
    if (!session.members.size) {
      peer.close();
      throw new DownloadError('The request was cancelled');
    }
    session.peer = peer;
    peer.relay.send(await protocol.encodePeerInit(self, 'P'));
    servePeer(peer.relay, username, SESSION_IDLE, false).finally(() => {
      peer.close();
      for (const download of session.members) {
        if (download.confirmed || download.answerTimer) continue;
        download.answerTimer = setTimeout(() => {
          if (!download.confirmed) {
            download.fail(new DownloadError('The peer closed the connection without answering the download request'));
          }
        }, ANSWER_TIMEOUT);
      }
      if (sessions.get(username) === session) sessions.delete(username);
    });
    return peer.relay;
  }

  // One peer connection per user, shared by downloads and folder listings
  function joinSession(member) {
    const { username } = member;
    let session = sessions.get(username);
    if (!session) {
      session = { members: new Set() };
      sessions.set(username, session);
      session.ready = connectSession(username, session);
      session.ready.catch(() => {
        if (sessions.get(username) === session) sessions.delete(username);
      });
    }
    session.members.add(member);
    member.session = session;
    return session.ready;
  }

  function leaveSession(member) {
    const { session, username } = member;
    if (!session) return;
    session.members.delete(member);
    if (session.members.size) return;
    if (sessions.get(username) === session) sessions.delete(username);
    session.peer?.close();
  }

  async function startDownload(download) {
    download.notify({ state: 'connecting' });
    if (download.settled) return;
    const relay = await joinSession(download);
    const frames = [
      await protocol.encodeQueueUpload(download.path),
      await protocol.encodePlaceInQueueRequest(download.path),
    ];
    if (download.settled) return;
    try {
      for (const frame of frames) relay.send(frame);
    } catch {
      throw new DownloadError('The peer connection closed before the download was queued');
    }
    download.notify({ state: 'queued' });
  }

  function download(username, path, { signal, onProgress, size = 0 } = {}) {
    if (failure) return Promise.reject(failure);
    if (signal?.aborted) return Promise.reject(signal.reason);

    const { promise, resolve, reject } = Promise.withResolvers();
    const state = { username, path, size, settled: false, confirmed: false };
    const onAbort = () => state.fail(signal.reason);
    const end = (settle, value) => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(state.timer);
      clearTimeout(state.answerTimer);
      signal?.removeEventListener('abort', onAbort);
      downloads.delete(state);
      if (state.token !== undefined) transfers.delete(transferKey(username, state.token));
      state.fileSocket?.close();
      leaveSession(state);
      settle(value);
    };
    state.finish = (blob) => end(resolve, blob);
    state.fail = (error) => end(reject, error);
    state.notify = (progress) => {
      if (state.settled) return;
      try {
        onProgress?.(progress);
      } catch (error) {
        state.fail(error);
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    downloads.add(state);
    startDownload(state).catch(state.fail);
    return promise;
  }

  async function search(query, { onResult, timeout = 20000, signal } = {}) {
    if (failure) throw failure;
    signal?.throwIfAborted();

    const token = nextSearchToken++;
    const { promise, resolve, reject } = Promise.withResolvers();
    promise.catch(() => {}); // A rejection can land before the await below
    const timer = setTimeout(resolve, timeout);
    const onAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    searches.set(token, { onResult, fail: reject });
    try {
      server.send(await protocol.encodeFileSearch(token, query));
      await promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      searches.delete(token);
    }
  }

  async function browseFolder(username, folder, { signal, timeout = BROWSE_TIMEOUT } = {}) {
    if (failure) throw failure;
    signal?.throwIfAborted();

    const key = transferKey(username, folder);
    if (browses.has(key)) throw new DownloadError('This folder is already being listed');
    const { promise, resolve, reject } = Promise.withResolvers();
    promise.catch(() => {}); // A rejection can land before the await below
    let settled = false;
    // Has its own timeout, so it needs no answer timer when the session drops
    const browse = {
      username,
      folder,
      confirmed: true,
      finish(files) { settled = true; resolve(files); },
      fail(error) { settled = true; reject(error); },
    };
    browses.set(key, browse);
    const timer = setTimeout(() => browse.fail(new DownloadError('The peer did not list the folder in time')), timeout);
    const onAbort = () => browse.fail(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // The listing can settle at any await, through abort, timeout, or a response
      const relay = await Promise.race([joinSession(browse), promise]);
      if (!settled) {
        browse.relay = relay;
        const frame = await Promise.race([protocol.encodeFolderContentsRequest(nextBrowseToken++, folder), promise]);
        if (!settled) {
          try {
            relay.send(frame);
          } catch {
            throw new DownloadError('The peer connection closed before the folder was requested');
          }
        }
      }
      return await promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      browses.delete(key);
      leaveSession(browse);
    }
  }

  serverLoop();
  return {
    search,
    download,
    browseFolder,
    close: () => shutdown(new Error('The client is closed')),
    closed: closed.promise,
  };
}
