# SPDX-FileCopyrightText: 2026 Project516
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import socket
import unittest
from unittest.mock import patch

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosedError, InvalidStatus

from server import Relay, connect_tcp, target_from_path

ORIGIN = "https://example.com"
TOKEN = "test-token-abc_12345678901234567890"


async def echo(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


class RelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        server = await asyncio.start_server(echo, "127.0.0.1", 0)
        await self.enterAsyncContext(server)
        tcp_port = server.sockets[0].getsockname()[1]

        async def connect_to_echo(_host, _port):
            return await asyncio.open_connection("127.0.0.1", tcp_port)

        self.tcp_connect = self.enterContext(patch("server.connect_tcp", side_effect=connect_to_echo))
        relay = await self.enterAsyncContext(serve(Relay(TOKEN).handle, "127.0.0.1", 0, origins=[ORIGIN]))
        ws_port = relay.sockets[0].getsockname()[1]
        self.relay_url = f"ws://127.0.0.1:{ws_port}/relay"

    async def test_public_peer_binary_round_trip(self):
        async with connect(f"{self.relay_url}?ip=1.1.1.1&port=12345", origin=ORIGIN) as websocket:
            await websocket.send(TOKEN)
            self.assertEqual(await websocket.recv(), "ready")
            await websocket.send(b"\x00\xffhello")
            self.assertEqual(await websocket.recv(), b"\x00\xffhello")

        self.tcp_connect.assert_awaited_once_with("1.1.1.1", 12345)

    async def test_rejects_bad_origin(self):
        with self.assertRaises(InvalidStatus) as error:
            async with connect(self.relay_url, origin="https://example.net"):
                self.fail("WebSocket upgrade succeeded")
        self.assertEqual(error.exception.response.status_code, 403)
        self.tcp_connect.assert_not_awaited()

    async def test_rejects_bad_token_and_private_destination(self):
        cases = [
            (self.relay_url, "wrong token", "Invalid relay token"),
            (f"{self.relay_url}?ip=127.0.0.1&port=12345", TOKEN, "Invalid relay destination"),
        ]
        for url, token, reason in cases:
            with self.subTest(reason=reason):
                async with connect(url, origin=ORIGIN) as websocket:
                    await websocket.send(token)
                    with self.assertRaises(ConnectionClosedError) as error:
                        await websocket.recv()
                    self.assertEqual(error.exception.rcvd.code, 1008)
                    self.assertEqual(error.exception.rcvd.reason, reason)
        self.tcp_connect.assert_not_awaited()

    def test_parses_server_and_rejects_invalid_destinations(self):
        self.assertEqual(target_from_path("/relay"), ("server.slsknet.org", 2242))
        invalid_targets = [
            "ip=1.1.1.1&port=0",
            "ip=1.1.1.1&port=65536",
            "ip=1.1.1.1&port=80&port=89",
            "ip=1.1.1.1",
            "ip=010.0.0.1&port=80",
            "ip=localhost&port=80",
            "ip=%3A%3Affff%3A7f00%3A1&port=80",
            "ip=10.0.0.1&port=80",
            "ip=169.254.169.254&port=80",
            "ip=224.0.0.1&port=80",
        ]
        for query in invalid_targets:
            with self.subTest(query=query), self.assertRaises(ValueError):
                target_from_path(f"/relay?{query}")

    async def test_rejects_a_private_address_returned_by_server_dns(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 2242))]
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", return_value=records):
            with patch("asyncio.open_connection") as open_connection:
                with self.assertRaisesRegex(ValueError, "Expected a public IPv4 address"):
                    await connect_tcp("server.slsknet.org", 2242)
                open_connection.assert_not_awaited()

    async def test_reports_tcp_connection_failure(self):
        self.tcp_connect.side_effect = OSError("No route")
        async with connect(self.relay_url, origin=ORIGIN) as websocket:
            await websocket.send(TOKEN)
            with self.assertRaises(ConnectionClosedError) as error:
                await websocket.recv()
            self.assertEqual(error.exception.rcvd.code, 1011)
            self.assertEqual(error.exception.rcvd.reason, "TCP connection failed")
