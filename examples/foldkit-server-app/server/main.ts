// The delivery host, kept deliberately tiny: read the template, serve the
// stylesheet, hand every other request to the application's server entry.
// This is the whole deployment — the same renderPage would sit unchanged
// behind a Cloudflare Worker's fetch handler or any host that speaks Web
// Request/Response.
//
// Run with: bun run start
import { toResponse } from "foldkit/experimental/server";

import { renderPage } from "../src/entry.server.ts";

const template = await Bun.file(new URL("../index.html", import.meta.url)).text();
const styles = Bun.file(new URL("../src/styles.css", import.meta.url));
const PORT = Number(process.env["PORT"] ?? 3000);

Bun.serve({
  port: PORT,
  fetch: async (request) => {
    if (new URL(request.url).pathname === "/styles.css") {
      return new Response(styles, { headers: { "content-type": "text/css" } });
    }
    return toResponse(template, await renderPage(request));
  },
});

console.log(`server app on http://localhost:${PORT}`);
