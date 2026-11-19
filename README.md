<!--
SPDX-FileCopyrightText: 2026 Project516
SPDX-License-Identifier: AGPL-3.0-only
-->

# Nicotine+ Wasm

A fork of [Nicotine+](https://github.com/nicotine-plus/nicotine-plus) for
accessing the [Soulseek](https://www.slsknet.org/news/) network from web apps.
It runs upstream Python protocol code in [Pyodide](https://pyodide.org/) and
uses a self-hosted WebSocket relay for TCP connections.

## Use

- [npm package](packages/nicotine-plus-wasm/README.md) documents the protocol
  API. The initial API covers login, search requests, and peer address lookup.
  Receiving search results and downloading files are still in development.
- [Relay setup](relay/README.md) covers running a private relay.
- [Upstream releases](https://github.com/nicotine-plus/nicotine-plus/releases)
  provide the desktop client. This fork tracks upstream's latest stable release.

Soulseek traffic between the relay and the network is unencrypted. Use a relay
you trust and follow the Soulseek [rules](https://www.slsknet.org/news/node/681)
and [terms of service](https://www.slsknet.org/news/node/682).

## License

Fork code uses the [GNU AGPL v3](LICENSES/AGPL-3.0-only.txt).
Upstream Nicotine+ code remains [GPL v3 or later](COPYING).
See [AUTHORS.md](AUTHORS.md) for upstream credits.
