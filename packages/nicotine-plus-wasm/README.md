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

The package can send a search request. Processing search results and downloading files still require a client.

## Build and test

Run `npm ci` and `npm test` in this directory.
The build bundles the protocol source from the checkout into the npm package.
Run `npm exec -- playwright-core install chromium` and `npm run test:browser` to check the module worker in Chromium.
Run `npm pack --dry-run` to inspect the files included in the package.
