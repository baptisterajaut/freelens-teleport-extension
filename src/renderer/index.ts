import { Common, Renderer } from "@freelensapp/extensions";
import { ENTITY_SOURCE } from "../common/teleport";

import type { EnsureResult } from "../common/teleport";

export class TeleportRendererIpc extends Renderer.Ipc {}

export default class TeleportRenderer extends Renderer.LensExtension {
  private disposeHook?: () => void;

  async onActivate() {
    const ipc = TeleportRendererIpc.createInstance(this);

    // Runs before a catalog entity opens: bring the tsh proxy up, or cancel with
    // the reason instead of letting Freelens spin on a dead endpoint.
    this.disposeHook = Renderer.Catalog.catalogEntities.addOnBeforeRun(async (event) => {
      if (event.target.metadata.source !== ENTITY_SOURCE) return;

      // Freelens only logs a throwing before-run hook and opens the cluster anyway.
      let result: EnsureResult;
      try {
        result = await ipc.invoke("ensure", event.target.getName());
      } catch (error) {
        event.preventDefault();
        Renderer.Component.Notifications.error(`Teleport proxy failed: ${String(error)}`);
        return;
      }
      if (!result.ok) {
        event.preventDefault();
        Renderer.Component.Notifications.error(result.message);
        return;
      }
      // freelens-k8s-proxy reads the kubeconfig (and its CA) only when the cluster
      // connects: drop the stale connection, the open then reconnects on the new proxy.
      if (
        result.restarted &&
        event.target instanceof Common.Catalog.KubernetesCluster &&
        event.target.status.phase === "connected"
      ) {
        await event.target.disconnect();
      }
    });

    // Cluster frames load renderer extensions too: warn once, from the root frame.
    // On a hot install the renderer can activate before the main side has
    // registered its handlers: a rejected invoke must not fail activation.
    if (window.top === window) {
      try {
        const hint: string | undefined = await ipc.invoke("session-problem");
        if (hint) {
          Renderer.Component.Notifications.error(`Teleport session missing or expired. In a terminal, run: ${hint}`);
        }
      } catch (error) {
        console.warn("[teleport] session check unavailable", error);
      }
    }
  }

  onDeactivate() {
    this.disposeHook?.();
  }
}
