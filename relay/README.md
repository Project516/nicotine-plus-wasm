<!--
SPDX-FileCopyrightText: 2026 Project516
SPDX-License-Identifier: AGPL-3.0-only
-->

# Private Soulseek relay

The relay opens outbound Soulseek TCP connections for a browser client. It
binds to loopback on port 8791. Use a private HTTPS reverse proxy with WebSocket
support to reach it from an HTTPS page.

## Run the relay

Use Python 3.11 or later. From the repository root, install the pinned dependency
in a virtual environment.

```sh
python3 -m venv venv
venv/bin/python -m pip install --require-hashes -r relay/requirements.txt
```

Set `SOULSEEK_RELAY_ORIGIN` to the exact origin of your browser app, including
the scheme and any port. Generate a random token with
`python3 -c 'import secrets; print(secrets.token_urlsafe(32))'` and set
`SOULSEEK_RELAY_TOKEN` to that value. Enter the token in the client at
runtime. Keep it out of bundled JavaScript and URLs.

Run `venv/bin/python relay/server.py`. An HTTP request to `/healthz` returns `ok`
when the relay is listening.

## WebSocket protocol

- Open `/relay` for the Soulseek server or `/relay?ip=<ipv4>&port=<port>` for
  a peer. Peer connections accept public IPv4 literals.
- Send the token as the first text message. Wait for the text message
  `ready`, which confirms the TCP connection opened.
- Send and receive raw TCP bytes in binary WebSocket messages of up to
  64 KiB each. WebSocket message boundaries do not match Soulseek protocol
  message boundaries.

The token grants outbound TCP access to public IPv4 destinations. Give it
only to users you trust with that access.
