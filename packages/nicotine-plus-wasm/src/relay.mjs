// SPDX-FileCopyrightText: 2026 Project516
// SPDX-License-Identifier: AGPL-3.0-only

const maxBufferedBytes = 4 * 1024 * 1024;
const maxMessageBytes = 64 * 1024;

export async function connectRelay(url, token, { signal } = {}) {
  if (typeof token !== "string" || !token) {
    throw new TypeError("A relay token is required");
  }
  signal?.throwIfAborted();
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  const ready = Promise.withResolvers();
  const packets = [];
  const header = new Uint8Array(4);
  let packet;
  let offset = 0;
  let queuedBytes = 0;
  let reader;
  let connected = false;
  let failure;

  function fail(error) {
    if (failure) return;
    failure = error;
    ready.reject(error);
    reader?.reject(error);
    reader = undefined;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    socket.close();
  }

  const abort = () => fail(signal.reason);
  const timer = setTimeout(() => fail(new Error("Relay handshake timed out")), 15000);
  signal?.addEventListener("abort", abort, { once: true });
  socket.addEventListener("open", () => socket.send(token), { once: true });
  socket.addEventListener("error", () => fail(new Error("Relay connection failed")));
  socket.addEventListener("close", ({ code, reason }) => {
    fail(new Error(reason || `Relay closed (${code})`));
  });
  socket.addEventListener("message", ({ data }) => {
    if (failure) return;
    if (!connected) {
      if (data !== "ready") {
        fail(new Error("Unexpected relay handshake"));
        return;
      }
      connected = true;
      clearTimeout(timer);
      ready.resolve();
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      fail(new Error("Expected binary data from the relay"));
      return;
    }

    const chunk = new Uint8Array(data);
    let index = 0;
    while (index < chunk.length) {
      const destination = packet ?? header;
      const count = Math.min(destination.length - offset, chunk.length - index);
      destination.set(chunk.subarray(index, index + count), offset);
      offset += count;
      index += count;
      if (offset < destination.length) continue;

      if (!packet) {
        const length = new DataView(header.buffer).getUint32(0, true);
        if (length < 4 || queuedBytes + length + header.length > maxBufferedBytes) {
          fail(new Error("Invalid Soulseek frame length or receive buffer limit exceeded"));
          return;
        }
        packet = new Uint8Array(length + header.length);
        packet.set(header);
        continue;
      }

      if (reader) {
        reader.resolve(packet);
        reader = undefined;
      } else {
        packets.push(packet);
        queuedBytes += packet.length;
      }
      packet = undefined;
      offset = 0;
    }
  });

  await ready.promise;
  return {
    send(frame) {
      if (failure) throw failure;
      if (!(frame instanceof Uint8Array)) throw new TypeError("Expected a Uint8Array");
      if (socket.bufferedAmount + frame.length > maxBufferedBytes) {
        throw new Error("Relay send buffer limit exceeded");
      }
      for (let index = 0; index < frame.length; index += maxMessageBytes) {
        socket.send(frame.subarray(index, index + maxMessageBytes));
      }
    },
    async receive({ timeout } = {}) {
      if (packets.length) {
        const frame = packets.shift();
        queuedBytes -= frame.length;
        return frame;
      }
      if (failure) throw failure;
      if (reader) throw new Error("A receive is already pending");
      const pending = Promise.withResolvers();
      reader = pending;
      const deadline = timeout && setTimeout(
        () => fail(new Error("Timed out waiting for a Soulseek reply")), timeout,
      );
      try {
        return await pending.promise;
      } finally {
        clearTimeout(deadline);
      }
    },
    close() {
      fail(new Error("Relay closed by client"));
    },
  };
}

export async function login(protocol, relay, {
  username, password, majorVersion = 177, minorVersion = 1,
}) {
  const frame = await protocol.encodeLogin(username, password, majorVersion, minorVersion);
  relay.send(frame);
  return protocol.decodeLogin(await relay.receive({ timeout: 15000 }));
}
