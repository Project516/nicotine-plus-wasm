# SPDX-FileCopyrightText: 2026 Project516
# SPDX-License-Identifier: AGPL-3.0-only

from struct import Struct

from pynicotine.slskmessages import FileSearch
from pynicotine.slskmessages import GetPeerAddress
from pynicotine.slskmessages import Login
from pynicotine.slskmessages import SERVER_MESSAGE_CODES

HEADER = Struct("<II")


def _encode(message):
    payload = message.make_network_message()
    return HEADER.pack(len(payload) + 4, SERVER_MESSAGE_CODES[type(message)]) + payload


def _decode(message, frame):
    frame = frame.to_py()
    if len(frame) < HEADER.size:
        raise ValueError("Incomplete Soulseek server header")

    size, code = HEADER.unpack_from(frame)
    if size != len(frame) - 4 or code != SERVER_MESSAGE_CODES[type(message)]:
        raise ValueError("Unexpected Soulseek server message size or code")

    message.parse_network_message(memoryview(frame)[HEADER.size:])
    return message


def encode_login(username, password, major_version, minor_version):
    return _encode(Login(username, password, major_version, minor_version))


def decode_login(frame):
    login = _decode(Login(), frame)
    if login.success:
        return {
            "success": True,
            "banner": login.banner,
            "ipAddress": login.ip_address,
            "isSupporter": login.is_supporter,
        }
    return {"success": False, "reason": login.reason}


def encode_file_search(token, query):
    return _encode(FileSearch(token, query))


def encode_get_peer_address(username):
    return _encode(GetPeerAddress(username))


def decode_get_peer_address(frame):
    peer = _decode(GetPeerAddress(), frame)
    return {
        "username": peer.user,
        "ipAddress": peer.ip_address,
        "port": peer.port,
        "obfuscatedPort": peer.obfuscated_port,
    }
