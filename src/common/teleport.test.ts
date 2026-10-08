import { describe, expect, it } from "vitest";
import { posixCksum, proxyPort } from "./teleport";

// Reference values from `printf '%s' <name> | cksum`, port = 18000 + cksum % 1000.
const CASES: [string, number, number][] = [
  ["dev", 1783993059, 18059],
  ["staging", 2425137664, 18664],
  ["production", 1377037638, 18638],
  ["acme.prod", 2904608956, 18956],
];

describe("proxyPort", () => {
  it.each(CASES)("%s matches cksum", (name, cksum, port) => {
    expect(posixCksum(new TextEncoder().encode(name))).toBe(cksum);
    expect(proxyPort(name)).toBe(port);
  });

  it("handles the empty string like cksum", () => {
    // printf '' | cksum → 4294967295 0
    expect(posixCksum(new Uint8Array())).toBe(4294967295);
  });
});
