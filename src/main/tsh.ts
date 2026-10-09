// Brings up `tsh proxy kube` for a cluster on demand: reuse a live proxy, reclaim
// an orphaned one, start a detached one. Ports are deterministic (see proxyPort),
// so proxies are shared with any shell helper using the same formula.

import { execFile, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { contextName, proxyPort } from "../common/teleport";
import { isTshProxyKube, listenerPid, processCommandLine, tshBin } from "./platform";

import type { EnsureResult } from "../common/teleport";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Mandatory behind TLS-intercepting corporate proxies (raw ALPN gets mangled), harmless elsewhere.
const tshEnv = () => ({
  ...process.env,
  TELEPORT_TLS_ROUTING_CONN_UPGRADE: process.env.TELEPORT_TLS_ROUTING_CONN_UPGRADE || "yes",
});

const tshHome = () => process.env.TSH_HOME || join(homedir(), ".tsh");

export interface Session {
  teleportCluster: string;
  proxyHost: string; // host:port, as `tsh login --proxy` wants it
  user: string;
  expired: boolean;
}

// `tsh status` reads the local profile only: no network, so it tells "logged out"
// apart from "network down", which an empty `tsh kube ls` cannot.
export async function readSession(): Promise<Session | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await run(tshBin, ["status", "--format=json"], { env: tshEnv(), windowsHide: true }));
  } catch (error: any) {
    // tsh not found on PATH is not a logout: let the caller report it.
    if (error?.code === "ENOENT") throw error;
    // An expired profile may still be printed with a non-zero exit.
    stdout = error?.stdout ?? "";
  }
  try {
    const active = JSON.parse(stdout).active;
    if (!active?.cluster) return undefined;
    return {
      teleportCluster: active.cluster,
      proxyHost: new URL(active.profile_url).host,
      user: active.username,
      expired: new Date(active.valid_until) <= new Date(),
    };
  } catch {
    return undefined;
  }
}

export const loginHint = (session?: Session) =>
  `tsh login --proxy=${session?.proxyHost ?? "<proxy>:443"} --user=${session?.user ?? "<user>"}`;

export async function listKubeClusters(): Promise<string[]> {
  const { stdout } = await run(tshBin, ["kube", "ls", "--format=json"], {
    env: tshEnv(),
    timeout: 30_000,
    windowsHide: true,
  });
  return (JSON.parse(stdout) as { kube_cluster_name: string }[]).map((c) => c.kube_cluster_name);
}

// Where `tsh proxy kube -p <port>` writes its kubeconfig. Deterministic, so the
// catalog entity can point at it before the proxy exists. A relogin purges it;
// `ensure` then recreates the proxy, which rewrites it at the same path.
export const kubeconfigPath = (session: Session, kubeCluster: string) =>
  join(
    tshHome(),
    "keys",
    new URL(`https://${session.proxyHost}`).hostname,
    `${session.user}-kube`,
    session.teleportCluster,
    `localproxy-${proxyPort(kubeCluster)}-kubeconfig`,
  );

const logFile = (kubeCluster: string) => join(tshHome(), `freelens-teleport-${kubeCluster}.log`);

async function apiServerAnswers(
  kubectl: string,
  kubeconfig: string,
  timeoutSeconds: number,
): Promise<string | undefined> {
  if (!existsSync(kubeconfig)) return "kubeconfig missing";
  try {
    await run(
      kubectl,
      ["--kubeconfig", kubeconfig, "get", "--raw", "/version", `--request-timeout=${timeoutSeconds}s`],
      {
        windowsHide: true,
      },
    );
    return undefined;
  } catch (error: any) {
    return (error?.stderr || error?.message || String(error)).trim();
  }
}

const kubeconfigServes = (kubeconfig: string, session: Session, kubeCluster: string) => {
  try {
    return readFileSync(kubeconfig, "utf8").includes(contextName(session.teleportCluster, kubeCluster));
  } catch {
    return false;
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Frees the port only if this cluster's own `tsh proxy kube` holds it (orphan
// whose kubeconfig got purged). Anything else is a real collision: never kill
// what we did not identify.
async function reclaimPort(port: number, kubeCluster: string): Promise<string | undefined> {
  const pid = await listenerPid(port);
  if (pid === undefined) return undefined;

  const commandLine = await processCommandLine(pid);
  if (!isTshProxyKube(commandLine, kubeCluster)) {
    return `Port ${port} is held by something other than the ${kubeCluster} proxy (pid ${pid}): ${commandLine || "<unknown>"}`;
  }

  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  if (alive(pid)) {
    process.kill(pid, "SIGKILL");
    await sleep(500);
  }
  return (await listenerPid(port)) === undefined ? undefined : `Port ${port} still in use after stopping pid ${pid}`;
}

async function startProxy(kubeCluster: string, port: number, kubeconfig: string): Promise<string | undefined> {
  const log = logFile(kubeCluster);
  rmSync(log, { force: true });
  const fd = openSync(log, "w");
  // Detached like a shell `nohup`: the proxy outlives Freelens and shell helpers reuse it.
  const child = spawn(tshBin, ["proxy", "kube", kubeCluster, "-p", String(port)], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: tshEnv(),
    windowsHide: true,
  });
  // Spawn errors surface through the polling loop's "did not start" message below;
  // without a listener they would crash the main process.
  child.on("error", () => {});
  child.unref();

  const readLog = () => {
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  };
  for (let i = 0; i < 60; i++) {
    if (readLog().includes("Started local proxy") && existsSync(kubeconfig)) return undefined;
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  const head = readLog().split("\n").slice(0, 10).join("\n");
  return head.includes("address already in use")
    ? `Port ${port} was taken while the proxy was starting`
    : `The proxy did not start (log: ${log})\n${head}`;
}

// One ensure per cluster at a time: a double click used to start two proxies on
// the same port, the loser rewriting the winner's kubeconfig under it.
const inFlight = new Map<string, Promise<EnsureResult>>();

export function ensure(kubeCluster: string, kubectl: string): Promise<EnsureResult> {
  let pending = inFlight.get(kubeCluster);
  if (!pending) {
    pending = doEnsure(kubeCluster, kubectl).finally(() => inFlight.delete(kubeCluster));
    inFlight.set(kubeCluster, pending);
  }
  return pending;
}

async function doEnsure(kubeCluster: string, kubectl: string): Promise<EnsureResult> {
  const session = await readSession();
  if (!session || session.expired) {
    return {
      ok: false,
      needsLogin: true,
      message: `Teleport session missing or expired. In a terminal, run: ${loginHint(session)}`,
    };
  }

  const port = proxyPort(kubeCluster);
  const kubeconfig = kubeconfigPath(session, kubeCluster);

  // Nominal path: a live proxy answers /version, nothing to do. The kubeconfig path
  // only depends on the port, so a colliding cluster may own this file: require our context.
  if (
    kubeconfigServes(kubeconfig, session, kubeCluster) &&
    (await apiServerAnswers(kubectl, kubeconfig, 5)) === undefined
  ) {
    return { ok: true, restarted: false };
  }

  const fail = (message: string): EnsureResult => ({ ok: false, needsLogin: false, message });
  const reclaimError = await reclaimPort(port, kubeCluster);
  if (reclaimError) return fail(reclaimError);
  const startError = await startProxy(kubeCluster, port, kubeconfig);
  if (startError) return fail(startError);

  const apiError = await apiServerAnswers(kubectl, kubeconfig, 10);
  return apiError
    ? fail(`Proxy started but the API server does not answer: ${apiError}`)
    : { ok: true, restarted: true };
}
