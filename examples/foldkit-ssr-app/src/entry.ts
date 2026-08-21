import { Runtime } from "foldkit";

import { AppClient, AppClientHttp } from "./domain-client";
import { ChangedUrl, ClickedLink, Flags, type Message, Model, init, update, view } from "./main";

const application = Runtime.makeApplication<Model, Message, Flags, AppClient>({
  Model,
  Flags,
  init,
  update,
  view,
  // The browser's answer to the AppClient seam: the HTTP wire client,
  // constructed once and shared by every Command.
  resources: AppClientHttp,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => ClickedLink({ request }),
    onUrlChange: (url) => ChangedUrl({ url }),
  },
});

// Adopt the server-rendered DOM: decode the embedded Flags (the domain
// projection the server fetched), run the same `init`, and continue as a
// normal Foldkit application.
Runtime.hydrate(application, {
  buildId: import.meta.env.FOLDKIT_BUILD_ID ?? "development",
});
