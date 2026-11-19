# SPDX-FileCopyrightText: 2026 Project516
# SPDX-License-Identifier: AGPL-3.0-only

"""Private WebSocket-to-TCP relay for Soulseek."""

import asyncio
import hmac
import ipaddress
import os
import re
import socket
from contextlib import suppress
from http import HTTPStatus
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

SOULSEEK_HOST = "server.slsknet.org"
SOULSEEK_PORT = 2242
LISTEN_PORT = 8791
MAX_CONNECTIONS = 16
CHUNK_SIZE = 64 * 1024
PROTOCOL_ASSIGNMENTS = ipaddress.IPv4Network("192.0.0.0/24")


def public_ipv4(value):
    address = ipaddress.IPv4Address(value)
    if not address.is_global or address.is_multicast or address in PROTOCOL_ASSIGNMENTS:
        raise ValueError("Expected a public IPv4 address")
    return str(address)


def target_from_path(path):
    url = urlsplit(path)
    if url.path != "/relay" or url.scheme or url.netloc or url.fragment:
        raise ValueError("Unknown relay path")

    if not url.query:
        return SOULSEEK_HOST, SOULSEEK_PORT

    params = parse_qs(url.query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
    if set(params) != {"ip", "port"} or not re.fullmatch(r"[0-9]{1,5}", params["port"][0]):
        raise ValueError("Expected an IPv4 address and port")

    port = int(params["port"][0])
    if not 1 <= port <= 65535:
        raise ValueError("Invalid port")

    return public_ipv4(params["ip"][0]), port


async def connect_tcp(host, port):
    if host == SOULSEEK_HOST:
        records = await asyncio.get_running_loop().getaddrinfo(
            host, port, family=socket.AF_INET, type=socket.SOCK_STREAM
        )
        host = records[0][4][0]

    # Use the validated address directly so the TCP connection cannot resolve it again.
    return await asyncio.open_connection(
        public_ipv4(host), port, family=socket.AF_INET, flags=socket.AI_NUMERICHOST
    )


async def to_tcp(websocket, writer):
    async for message in websocket:
        if isinstance(message, str):
            await websocket.close(1003, "Expected binary data")
            return
        writer.write(message)
        await asyncio.wait_for(writer.drain(), timeout=30)


async def to_websocket(reader, websocket):
    while chunk := await reader.read(CHUNK_SIZE):
        await asyncio.wait_for(websocket.send(chunk), timeout=30)


async def pipe(websocket, reader, writer):
    tasks = (
        asyncio.create_task(to_tcp(websocket, writer)),
        asyncio.create_task(to_websocket(reader, websocket)),
    )
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class Relay:
    def __init__(self, token):
        self.token = token.encode("ascii")
        self.active_connections = 0

    async def handle(self, websocket):
        if self.active_connections >= MAX_CONNECTIONS:
            await websocket.close(1013, "Relay connection limit reached")
            return

        self.active_connections += 1
        try:
            try:
                token = await asyncio.wait_for(websocket.recv(), timeout=5)
            except TimeoutError:
                await websocket.close(1008, "Authentication timed out")
                return

            if not isinstance(token, str) or not hmac.compare_digest(token.encode(), self.token):
                await websocket.close(1008, "Invalid relay token")
                return

            try:
                host, port = target_from_path(websocket.request.path)
            except ValueError:
                await websocket.close(1008, "Invalid relay destination")
                return

            try:
                reader, writer = await asyncio.wait_for(connect_tcp(host, port), timeout=10)
            except (OSError, TimeoutError, ValueError):
                await websocket.close(1011, "TCP connection failed")
                return

            try:
                await websocket.send("ready")
                await pipe(websocket, reader, writer)
            except (OSError, TimeoutError):
                await websocket.close(1011, "TCP relay interrupted")
            finally:
                writer.close()
                with suppress(OSError):
                    try:
                        await asyncio.wait_for(writer.wait_closed(), timeout=2)
                    except TimeoutError:
                        writer.transport.abort()

        except ConnectionClosed:
            pass
        finally:
            self.active_connections -= 1


def health_check(connection, request):
    if request.path == "/healthz":
        return connection.respond(HTTPStatus.OK, "ok\n")
    return None


async def main():
    token = os.environ.get("SOULSEEK_RELAY_TOKEN", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise SystemExit("Set SOULSEEK_RELAY_TOKEN to a random URL-safe token of 32 to 128 characters")

    origin = os.environ.get("SOULSEEK_RELAY_ORIGIN", "")
    url = urlsplit(origin)
    if url.scheme not in {"https", "http"} or not url.hostname or origin != f"{url.scheme}://{url.netloc}":
        raise SystemExit("Set SOULSEEK_RELAY_ORIGIN to the exact origin of the web client")

    relay = Relay(token)
    async with serve(
        relay.handle,
        "127.0.0.1",
        LISTEN_PORT,
        origins=[origin],
        process_request=health_check,
        compression=None,
        open_timeout=5,
        close_timeout=3,
        max_size=CHUNK_SIZE,
        max_queue=4,
    ) as server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
