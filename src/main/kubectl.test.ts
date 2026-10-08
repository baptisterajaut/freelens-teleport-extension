import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveKubectl } from "./kubectl";

const base = { resourcesPath: "/opt/Freelens/resources", platform: "linux" as NodeJS.Platform, arch: "x64" };

describe("resolveKubectl", () => {
  it("prefers the Freelens preference", () => {
    expect(resolveKubectl({ ...base, preference: "/usr/bin/kubectl", exists: () => true })).toBe("/usr/bin/kubectl");
  });

  it("treats an empty preference as unset", () => {
    expect(resolveKubectl({ ...base, preference: "", exists: () => true })).toBe(
      join("/opt/Freelens/resources", "x64", "kubectl"),
    );
  });

  it("uses the kubectl bundled with Freelens when present", () => {
    const seen: string[] = [];
    const result = resolveKubectl({
      ...base,
      arch: "arm64",
      exists: (path) => {
        seen.push(path);
        return true;
      },
    });
    expect(result).toBe(join("/opt/Freelens/resources", "arm64", "kubectl"));
    expect(seen).toEqual([result]);
  });

  it("uses kubectl.exe on Windows", () => {
    expect(resolveKubectl({ ...base, platform: "win32", exists: () => true })).toBe(
      join("/opt/Freelens/resources", "x64", "kubectl.exe"),
    );
    expect(resolveKubectl({ ...base, platform: "win32", exists: () => false })).toBe("kubectl.exe");
  });

  it("falls back to kubectl from PATH when nothing is bundled", () => {
    expect(resolveKubectl({ ...base, exists: () => false })).toBe("kubectl");
    expect(resolveKubectl({ ...base, resourcesPath: undefined, exists: () => true })).toBe("kubectl");
  });
});
