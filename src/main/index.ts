import { createHash } from "node:crypto";
import { Common, Main } from "@freelensapp/extensions";
import { observable, runInAction } from "mobx";
import { contextName, ENTITY_SOURCE } from "../common/teleport";
import { kubectlPath } from "./kubectl";
import { ensure, kubeconfigPath, listKubeClusters, loginHint, readSession } from "./tsh";

const REFRESH_MS = 60_000;

// Freelens puts the cluster id in the frame's hostname (`<id>.renderer.freelens.app`)
// and reads back the last label only; a URL path with a dot is served as a static
// file. Kube cluster names like `acme.prod` break both: hash them into
// a single hex DNS label, like Freelens' own ids.
const entityId = (kubeCluster: string) => createHash("md5").update(`teleport:${kubeCluster}`).digest("hex");

export class TeleportMainIpc extends Main.Ipc {}

export default class TeleportMain extends Main.LensExtension {
  private readonly clusters = observable.array<Common.Catalog.KubernetesCluster>([], { deep: false });
  private timer?: ReturnType<typeof setInterval>;

  async onActivate() {
    const ipc = TeleportMainIpc.createInstance(this);
    // Freelens 1.10.3 can drop an instance before enabling it; `disable()` then
    // skips the disposers and our handlers outlive it. Re-registering throws and
    // fails activation in a loop that freezes the UI. The leftover handlers are
    // stateless, so keeping them is fine.
    const handle = (channel: string, handler: Parameters<typeof ipc.handle>[1]) => {
      try {
        ipc.handle(channel, handler);
      } catch (error) {
        console.warn(`[teleport] IPC handler "${channel}" already registered, keeping it`, error);
      }
    };
    // Resolved per call: a change to the kubectl preference applies without restart.
    handle("ensure", (_event, kubeCluster: string) =>
      ensure(kubeCluster, kubectlPath(Common.App.Preferences.getKubectlPath())),
    );
    handle("session-problem", async () => {
      const session = await readSession();
      return !session || session.expired ? loginHint(session) : undefined;
    });

    this.addCatalogSource(ENTITY_SOURCE, this.clusters);
    // Never await the network in onActivate: a slow activation is what let
    // Freelens drop the instance mid-way.
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  onDeactivate() {
    clearInterval(this.timer);
  }

  private refresh() {
    this.doRefresh().catch((error) => console.warn("[teleport] refresh failed", error));
  }

  private async doRefresh() {
    const session = await readSession();
    // Logged out: keep the last known clusters rather than emptying the catalog
    // under the user's eyes. Clicking one reports the login to do.
    if (!session || session.expired) return;

    let names: string[];
    try {
      names = (await listKubeClusters()).sort();
    } catch (error) {
      console.warn("[teleport] tsh kube ls failed", error);
      return;
    }

    // Recreating entities resets their status: only touch the catalog when the list changes.
    const current = this.clusters.map((c) => c.getName());
    if (names.join("\n") === current.join("\n")) return;

    const entities = names.map(
      (name) =>
        new Common.Catalog.KubernetesCluster({
          metadata: {
            uid: entityId(name),
            name,
            source: ENTITY_SOURCE,
            labels: { teleport: session.teleportCluster },
          },
          spec: {
            kubeconfigPath: kubeconfigPath(session, name),
            kubeconfigContext: contextName(session.teleportCluster, name),
          },
          status: { phase: "disconnected" },
        }),
    );
    runInAction(() => this.clusters.replace(entities));
  }
}
