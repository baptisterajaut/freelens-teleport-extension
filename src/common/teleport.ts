// Pure helpers shared by main and renderer.

// Port derivation is a stable contract: `18000 + cksum % 1000`, computable from a
// shell with `printf '%s' <cluster> | cksum`. Shell helpers using the same formula
// and this extension reuse each other's proxies instead of fighting for ports.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

// POSIX `cksum` CRC: unreflected CRC-32, message then its length (LSB first,
// significant bytes only), inverted. Not zlib's crc32.
export function posixCksum(data: Uint8Array): number {
  let crc = 0;
  const feed = (byte: number) => {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  };
  for (const byte of data) feed(byte);
  for (let n = data.length; n > 0; n = Math.floor(n / 256)) feed(n & 0xff);
  return ~crc >>> 0;
}

export const proxyPort = (kubeCluster: string) => 18000 + (posixCksum(new TextEncoder().encode(kubeCluster)) % 1000);

// Context name written by `tsh proxy kube` in its kubeconfig.
export const contextName = (teleportCluster: string, kubeCluster: string) => `${teleportCluster}-${kubeCluster}`;

export const ENTITY_SOURCE = "teleport";

export type EnsureResult = { ok: true } | { ok: false; needsLogin: boolean; message: string };
