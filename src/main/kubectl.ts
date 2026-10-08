// Same order as Freelens itself: the "Path to kubectl binary" preference, then
// the kubectl bundled with Freelens (<resources>/<arch>/kubectl, see its
// bundled-binary-path), then PATH. Users need no kubectl of their own.

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface KubectlLookup {
  preference?: string;
  resourcesPath?: string;
  platform: NodeJS.Platform;
  arch: string;
  exists: (path: string) => boolean;
}

export function resolveKubectl({ preference, resourcesPath, platform, arch, exists }: KubectlLookup): string {
  const binary = platform === "win32" ? "kubectl.exe" : "kubectl";
  if (preference) return preference;
  if (resourcesPath) {
    const bundled = join(resourcesPath, arch, binary);
    if (exists(bundled)) return bundled;
  }
  return binary;
}

export const kubectlPath = (preference?: string) =>
  resolveKubectl({
    preference,
    // Electron-only; undefined under plain Node (tests).
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
  });
