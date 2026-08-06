# foldkit-ssr-app

The [foldkit-app](../foldkit-app) example, server-rendered and hydrated. Two
points of interest:

**The hydration payload is a domain projection.** `Flags` is built from
`domain.responseSchema` values, so the server encodes what it fetched with
the domain's own wire codec, and the hydrating browser decodes it with the
same cached schema object and runs the same `init`. Server HTML, hydration
payload, and browser state are all projections of one selection.

**The client is a service.** `src/domain-client.ts` puts the typed client
behind an `AppClient` tag; Commands `yield*` the tag instead of importing a
baked-in transport. The browser fills the seam with the HTTP wire client
through foldkit's `resources` Layer; the server entry runs the same calls
through the in-process `Domain.client(domain)` — same typed surface, same
wire-codec round-trip, no HTTP hop. Tests can fill it with a stub.

- `src/entry.server.ts` — the server boundary: route → in-process
  `Domain.client(domain)` (same selections and decode path as the browser's
  Commands) → Flags → `Server.renderToString`.
- `server/main.ts` — one bun process owning the repo: `POST /rpc` via
  `handleDispatch`, static assets, SSR for everything else. One process on
  purpose: the in-memory repo must be shared between renders and the wire.
- `src/main.ts` — `init(flags, url)` starts in `Success` when the server
  preloaded the route's data, otherwise takes the normal Loading → fetch path.

## Running

Foldkit's server rendering is unreleased ([foldkit#863](https://github.com/foldkit/foldkit/pull/863)),
so the foldkit packages are installed from local tarballs built off that PR
branch (not committed). To produce them:

```sh
cd <foldkit checkout> && git checkout ssr-863   # PR #863 branch
pnpm install && pnpm --filter foldkit --filter @foldkit/vite-plugin build
pnpm --filter foldkit exec pnpm pack --out <this dir>/vendor/foldkit.tgz
pnpm --filter @foldkit/vite-plugin exec pnpm pack --out <this dir>/vendor/foldkit-vite-plugin.tgz
```

Then:

```sh
bun install
bun run build    # client bundle -> dist/client
bun run start    # http://localhost:3000
```
