// Per-OS process plumbing for the proxy manager. Pure parsers are exported for
// tests; nothing here imports @freelensapp, so vitest can load it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const tshBin = process.platform === "win32" ? "tsh.exe" : "tsh";

export function parseSs(stdout: string): number | undefined {
  const match = stdout.match(/users:\(\("[^"]*",pid=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

// `lsof -t` prints one pid per socket: IPv4 + IPv6 listeners give two lines.
export function parseLsof(stdout: string): number | undefined {
  const first = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first && /^\d+$/.test(first) ? Number(first) : undefined;
}

// Matches on addresses only: the state column ("LISTENING") is localised.
// A listener is the only TCP row whose foreign address is the wildcard.
export function parseNetstat(stdout: string, port: number): number | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols.length < 4) continue;
    const [, local, foreign] = cols;
    if (local.endsWith(`:${port}`) && (foreign === "0.0.0.0:0" || foreign === "[::]:0")) {
      return Number(cols[cols.length - 1]);
    }
  }
  return undefined;
}

const TSH_PROXY_KUBE = /(?:^|[\s\\/"])tsh(?:\.exe)?"?\s+proxy\s+kube\s/i;

// Only our own cluster's proxy is fair game: two names can hash to the same
// port, and the other cluster's proxy is then a collision, not an orphan.
export function isTshProxyKube(commandLine: string, kubeCluster: string): boolean {
  return TSH_PROXY_KUBE.test(commandLine) && commandLine.split(/\s+/).includes(kubeCluster);
}

export async function listenerPid(port: number): Promise<number | undefined> {
  try {
    switch (process.platform) {
      case "darwin":
        return parseLsof((await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).stdout);
      case "win32":
        // CBA: untested on Windows
        return parseNetstat((await run("netstat", ["-ano"], { windowsHide: true })).stdout, port);
      default:
        return parseSs((await run("ss", ["-lntpH", `sport = :${port}`])).stdout);
    }
  } catch {
    // lsof exits 1 when nothing listens; a missing tool also reads as "free",
    // and the proxy start then reports the port as taken.
    return undefined;
  }
}

export async function processCommandLine(pid: number): Promise<string> {
  try {
    if (process.platform === "win32") {
      // CBA: untested on Windows; switch to -EncodedCommand if Node's quoting mangles the filter
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { windowsHide: true },
      );
      return stdout.trim();
    }
    return (await run("ps", ["-p", String(pid), "-o", "args="])).stdout.trim();
  } catch {
    // process vanished in between
    return "";
  }
}
