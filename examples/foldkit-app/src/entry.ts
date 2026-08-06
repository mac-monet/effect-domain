import { Runtime } from "foldkit";

import { AppClientHttp } from "./domain-client";
import { ChangedUrl, ClickedLink, Model, init, update, view } from "./main";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  // Fills the AppClient seam with the HTTP wire client, constructed once
  // and shared by every Command.
  resources: AppClientHttp,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => ClickedLink({ request }),
    onUrlChange: (url) => ChangedUrl({ url }),
  },
});

Runtime.run(application);
