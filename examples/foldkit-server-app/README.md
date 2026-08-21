# foldkit-server-app

The [foldkit-app](../foldkit-app) example rebuilt as a **fully server-generated
app**: no client runtime, no `/rpc`, no JavaScript shipped at all. Every link
is a page load, the create form is a native HTML POST, and the server renders
each page with foldkit's `renderToString` ([foldkit#863](https://github.com/foldkit/foldkit/pull/863)).

This is the purest effect-domain demo in the repo. With the wire gone, the
data layer collapses to two things: the selections in `src/projection.ts` and
`domain.execute` in the server entry. `domain.responseSchema` turns those same
selections into the Model's schemas, so the page you receive is literally the
projection — serialized as HTML instead of JSON.

- `src/entry.server.ts` — the entire app boundary: GET → route →
  `domain.execute` → render (404s included); POST `/users` → `createUser` →
  303 redirect.
- `src/main.ts` — Model, `init`, `view`. No update, Messages, Commands,
  AsyncData, or loading states: there is no browser fold to feed.
- `server/main.ts` — a ~20-line bun host: stylesheet + `renderPage`. The same
  `renderPage` would sit unchanged behind a Cloudflare Worker's fetch handler.

## Running

```sh
vp install
vp run start    # http://localhost:3000
```
