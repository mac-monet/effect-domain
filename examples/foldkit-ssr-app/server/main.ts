// The delivery host: one bun process owning the repo, the wire, and the HTML.
//   POST /rpc   -> domain.handleDispatch (the same gateway as the plain example)
//   GET  *      -> static client asset if one matches, else SSR via renderPage
//
// Run with: bun run build && bun run start
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toResponse } from "foldkit/experimental/server";

import { domain } from "../../domain.ts";
import { renderPage } from "../src/entry.server.ts";
import { runtime } from "../src/server-runtime.ts";

const CLIENT_DIR = resolve(fileURLToPath(new URL("../dist/client", import.meta.url)));
const template = await Bun.file(resolve(CLIENT_DIR, "index.html")).text();
const PORT = Number(process.env["PORT"] ?? 3000);

Bun.serve({
  port: PORT,
  fetch: async (request) => {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/rpc") {
      // Same shape-only widening as the plain example's gateway:
      // `handleDispatch` is the real boundary and rejects bad requests as
      // typed GatewayErrors inside the envelope.
      const body = ((await request.json().catch(() => ({}))) ?? {}) as {
        readonly name?: string;
        readonly args?: unknown;
        readonly select?: unknown;
      };
      const encoded = await runtime.runPromise(
        domain.handleDispatch({
          name: body.name ?? "",
          args: body.args,
          select: body.select,
        }),
      );
      return Response.json(encoded);
    }

    if (url.pathname !== "/") {
      const assetPath = resolve(CLIENT_DIR, `.${url.pathname}`);
      const asset = Bun.file(assetPath);
      if (assetPath.startsWith(`${CLIENT_DIR}/`) && (await asset.exists())) {
        return new Response(asset);
      }
    }

    return toResponse(template, await renderPage(request));
  },
});

console.log(`ssr app on http://localhost:${PORT}`);
