# Nicotine+ Wasm

Use Nicotine+'s Soulseek protocol codecs in browsers and Node.js.
The package includes login, search request, and peer address messages.

```sh
npm install @project516/nicotine-plus-wasm
```

```js
import { createProtocol } from '@project516/nicotine-plus-wasm';

const protocol = await createProtocol();
try {
  const frame = await protocol.encodeFileSearch(42, 'artist album');
  console.log(frame);
} finally {
  protocol.terminate();
}
```

The encode methods return complete Soulseek server frames.
The decode methods take a complete frame, including the four-byte length field.
The browser entry runs Pyodide in a module worker and loads the runtime from jsDelivr.
The JavaScript API requires Chrome or Edge 119+, Firefox 121+, or Safari 17.4+.
Node.js requires version 22.14 or later.
To serve the runtime yourself, pass the URL of your Pyodide 314.0.7 distribution as `pyodideIndexURL`.

## Log in through a private relay

In the browser, use your relay's WebSocket URL and token. The relay must allow your application's origin.
Collect the Soulseek credentials and relay token at runtime. Keep them out of the application bundle.
Login closes the relay if the Soulseek server takes longer than 15 seconds to reply.

```js
import { connectRelay, createProtocol, login } from '@project516/nicotine-plus-wasm';

export async function checkLogin(relayURL, relayToken, username, password, signal) {
  const protocol = await createProtocol();
  let relay;
  try {
    relay = await connectRelay(relayURL, relayToken, { signal });
    return await login(protocol, relay, { username, password });
  } finally {
    relay?.close();
    protocol.terminate();
  }
}
```

## Search and download

`connectClient` connects to the relay, logs in, and returns a client. It rejects with a `LoginError` (see `error.reason`) or a relay error.
`search` calls `onResult` for each peer that answers and resolves when the timeout (20 seconds by default) ends.
`download` resolves with a `Blob`. It rejects with a `DownloadError` when the peer denies or fails the upload, or cannot be reached.
`browseFolder` resolves with the files directly in one folder of a peer's shares. Use it to get every track of an album, since search results list only the files that match the query. Pass a search result path without the file name.
All three reject with the signal's reason when you abort.

```js
import { connectClient } from '@project516/nicotine-plus-wasm';

const client = await connectClient({ relayURL, relayToken, username, password });
const results = [];
await client.search('artist album', { onResult: (result) => results.push(result) });

const { username: peer, files } = results[0];
const blob = await client.download(peer, files[0].path, {
  size: files[0].size,
  onProgress: (state) => console.log(state),
});

const folder = files[0].path.slice(0, files[0].path.lastIndexOf('\\'));
const album = await client.browseFolder(peer, folder);
client.close();
```

`client.closed` settles with an `Error` when the server connection drops or after `close()`.
The browser cannot accept connections, so every connection goes out through the relay.
Only peers reachable on their listening port can be downloaded from.
The relay allows 64 connections. Each client uses one for the server and at most 49 for peers.


## Build and test

Run `npm ci` and `npm test` in this directory.
The build bundles the protocol source from the checkout into the npm package.
Run `npm exec -- playwright-core install chromium` and `npm run test:browser` to check the module worker in Chromium.
Run `npm pack --dry-run` to inspect the files included in the package.
