# SPDX-FileCopyrightText: 2026 Project516
# SPDX-License-Identifier: AGPL-3.0-only

from struct import Struct

from pynicotine.slskmessages import CantConnectToPeer
from pynicotine.slskmessages import ConnectToPeer
from pynicotine.slskmessages import FileListMessage
from pynicotine.slskmessages import FileOffset
from pynicotine.slskmessages import FileSearch
from pynicotine.slskmessages import FileSearchResponse
from pynicotine.slskmessages import FileTransferInit
from pynicotine.slskmessages import GetPeerAddress
from pynicotine.slskmessages import Login
from pynicotine.slskmessages import PEER_INIT_MESSAGE_CODES
from pynicotine.slskmessages import PEER_MESSAGE_CODES
from pynicotine.slskmessages import PeerInit
from pynicotine.slskmessages import PierceFireWall
from pynicotine.slskmessages import PlaceInQueueRequest
from pynicotine.slskmessages import PlaceInQueueResponse
from pynicotine.slskmessages import QueueUpload
from pynicotine.slskmessages import SERVER_MESSAGE_CODES
from pynicotine.slskmessages import SetStatus
from pynicotine.slskmessages import SharedFoldersFiles
from pynicotine.slskmessages import TransferRequest
from pynicotine.slskmessages import TransferResponse
from pynicotine.slskmessages import UploadDenied
from pynicotine.slskmessages import UploadFailed

# Frame header, message codes and name of each framed message family
SERVER = (Struct("<II"), SERVER_MESSAGE_CODES, "server")
PEER = (Struct("<II"), PEER_MESSAGE_CODES, "peer")
PEER_INIT = (Struct("<IB"), PEER_INIT_MESSAGE_CODES, "peer init")


def _encode(message, family=SERVER):
    header, codes, _name = family
    payload = message.make_network_message()
    return header.pack(len(payload) + header.size - 4, codes[type(message)]) + payload


def _decode(message, frame, family=SERVER):
    header, codes, name = family
    frame = frame.to_py()
    if len(frame) < header.size:
        raise ValueError(f"Incomplete Soulseek {name} header")

    size, code = header.unpack_from(frame)
    if size != len(frame) - 4 or code != codes[type(message)]:
        raise ValueError(f"Unexpected Soulseek {name} message size or code")

    message.parse_network_message(memoryview(frame)[header.size:])
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


def encode_set_status(status):
    return _encode(SetStatus(status))


def encode_shared_folders_files(folders, files):
    return _encode(SharedFoldersFiles(folders, files))


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


def decode_connect_to_peer(frame):
    request = _decode(ConnectToPeer(), frame)
    return {
        "username": request.user,
        "connType": request.conn_type,
        "ipAddress": request.ip_address,
        "port": request.port,
        "token": request.token,
    }


def encode_cant_connect_to_peer(token, username):
    return _encode(CantConnectToPeer(token, username))


def encode_pierce_fire_wall(token):
    return _encode(PierceFireWall(token=token), PEER_INIT)


def encode_peer_init(username, conn_type):
    return _encode(PeerInit(init_user=username, conn_type=conn_type), PEER_INIT)


def decode_file_search_response(frame, tokens):
    response = FileSearchResponse()
    response.allowed_responses = set(tokens.to_py())
    _decode(response, frame, PEER)

    # Upstream leaves the list empty when the token is not one of ours
    if response.list is None:
        return {"token": response.token, "files": None}

    files = []
    for _code, path, size, _ext, attributes in response.list + (response.privatelist or []):
        bitrate, duration, *_rest = FileListMessage.parse_file_attributes(attributes)
        file = {"path": path, "size": size}
        if bitrate is not None:
            file["bitrate"] = bitrate
        if duration is not None:
            file["duration"] = duration
        files.append(file)

    return {
        "token": response.token,
        "files": files,
        "freeSlot": response.freeulslots,
        "uploadSpeed": response.ulspeed,
        "queueLength": response.inqueue,
    }


def encode_queue_upload(path):
    return _encode(QueueUpload(path), PEER)


def encode_place_in_queue_request(path):
    return _encode(PlaceInQueueRequest(path), PEER)


def decode_place_in_queue_response(frame):
    response = _decode(PlaceInQueueResponse(), frame, PEER)
    return {"path": response.filename, "position": response.place}


def decode_transfer_request(frame):
    request = _decode(TransferRequest(), frame, PEER)
    return {
        "direction": request.direction,
        "token": request.token,
        "path": request.file,
        "size": request.filesize,
    }


def encode_transfer_response(token, allowed, reason=None):
    return _encode(TransferResponse(allowed=allowed, reason=reason, token=token), PEER)


def decode_upload_denied(frame):
    denied = _decode(UploadDenied(), frame, PEER)
    return {"path": denied.file, "reason": denied.reason}


def decode_upload_failed(frame):
    failed = _decode(UploadFailed(), frame, PEER)
    return {"path": failed.file}


# File connections carry no frame header
def decode_file_transfer_init(data):
    init = FileTransferInit()
    init.parse_network_message(memoryview(data.to_py()))
    return {"token": init.token}


def encode_file_offset(offset):
    return bytes(FileOffset(offset=offset).make_network_message())
