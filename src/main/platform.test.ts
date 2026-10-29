import { describe, expect, it } from "vitest";
import { isTshProxyKube, parseLsof, parseNetstat, parseSs } from "./platform";

describe("parseSs", () => {
  it("reads the pid of the listener", () => {
    const out = 'LISTEN 0 4096 127.0.0.1:18226 0.0.0.0:* users:(("tsh",pid=4242,fd=7))\n';
    expect(parseSs(out)).toBe(4242);
  });

  it("takes the first pid when several processes share the socket", () => {
    const out = 'LISTEN 0 4096 127.0.0.1:18226 0.0.0.0:* users:(("tsh",pid=11,fd=7),("tsh",pid=12,fd=7))\n';
    expect(parseSs(out)).toBe(11);
  });

  it("returns undefined when nothing listens", () => {
    expect(parseSs("")).toBeUndefined();
  });
});

describe("parseLsof", () => {
  it("reads a single pid", () => {
    expect(parseLsof("4242\n")).toBe(4242);
  });

  it("takes the first pid when IPv4 and IPv6 sockets are listed", () => {
    expect(parseLsof("4242\n4243\n")).toBe(4242);
  });

  it("returns undefined on empty or garbage output", () => {
    expect(parseLsof("")).toBeUndefined();
    expect(parseLsof("lsof: WARNING: something\n")).toBeUndefined();
  });
});

describe("parseNetstat", () => {
  const out = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000",
    "  TCP    127.0.0.1:18226        127.0.0.1:51000        ESTABLISHED     4242",
    "  TCP    127.0.0.1:51000        127.0.0.1:18226        ESTABLISHED     7777",
    "  TCP    127.0.0.1:18226        0.0.0.0:0              LISTENING       4242",
    "  TCP    [::1]:18687            [::]:0                 LISTENING       5151",
    "  TCP    127.0.0.1:118226       0.0.0.0:0              LISTENING       9999",
    "  UDP    0.0.0.0:18250          *:*                                    8888",
    "",
  ].join("\r\n");

  it("finds the IPv4 listener and ignores established rows on the same port", () => {
    expect(parseNetstat(out, 18226)).toBe(4242);
  });

  it("finds an IPv6 listener", () => {
    expect(parseNetstat(out, 18687)).toBe(5151);
  });

  it("ignores UDP rows and other ports", () => {
    expect(parseNetstat(out, 18250)).toBeUndefined();
    expect(parseNetstat(out, 8226)).toBeUndefined();
  });

  it("does not depend on the localised state column", () => {
    const fr = "  TCP    127.0.0.1:18226        0.0.0.0:0              ÉCOUTE          4242\r\n";
    expect(parseNetstat(fr, 18226)).toBe(4242);
  });
});

describe("isTshProxyKube", () => {
  it.each([
    "tsh proxy kube dev -p 18059",
    "/usr/local/bin/tsh proxy kube dev -p 18059",
    '"C:\\Program Files\\tsh\\tsh.exe" proxy kube dev -p 18059',
    "C:\\tools\\tsh.exe proxy kube dev -p 18059",
    "TSH.EXE proxy kube dev -p 18059",
  ])("recognises %s", (commandLine) => {
    expect(isTshProxyKube(commandLine, "dev")).toBe(true);
  });

  it.each(["kubectl proxy --port 18059", "mytsh proxy kube dev -p 18059", "tsh kube ls", ""])(
    "rejects %s",
    (commandLine) => {
      expect(isTshProxyKube(commandLine, "dev")).toBe(false);
    },
  );

  it("rejects a proxy serving another cluster on a colliding port", () => {
    expect(isTshProxyKube("tsh proxy kube staging -p 18059", "dev")).toBe(false);
  });

  it("does not match a cluster name that is only a prefix of the served one", () => {
    expect(isTshProxyKube("tsh proxy kube dev2 -p 18059", "dev")).toBe(false);
  });
});
