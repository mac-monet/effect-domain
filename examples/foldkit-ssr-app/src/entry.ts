import { Runtime } from "foldkit";

import { ChangedUrl, ClickedLink, Flags, Model, flags, init, update, view } from "./main";

const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init,
  update,
  view,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => ClickedLink({ request }),
    onUrlChange: (url) => ChangedUrl({ url }),
  },
});

// Adopt the server-rendered DOM: decode the embedded Flags (the domain
// projection the server fetched), run the same `init`, and continue as a
// normal Foldkit application.
Runtime.hydrate(application);
