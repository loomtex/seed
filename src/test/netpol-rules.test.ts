// Tests for host-agent/netpol-rules.ts — per-namespace iptables rule building.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildNamespaceRules, EGRESS_CHAIN, type RulePod } from "../host-agent/netpol-rules.js";

const cfg = { serviceCidrs: ["10.43.0.0/16", "fd01::/108"], dnsIp: "10.43.0.10" };
const chain = "SEED-NS-abcd1234";
const web: RulePod = { ips: ["10.42.0.2", "fd00::2"], exposePorts: [{ port: 443, protocols: ["tcp"] }] };
const db: RulePod = { ips: ["10.42.0.3", "fd00::3"], exposePorts: [{ port: 5432, protocols: ["tcp"] }] };

const accepts = (rules: string[][]) => rules.filter((r) => r.at(-1) === "ACCEPT");
const firstMatch = (rules: string[][], pred: (r: string[]) => boolean) => rules.findIndex(pred);

describe("buildNamespaceRules", () => {
  const v4 = buildNamespaceRules("s-test", chain, [web, db], cfg, false);
  const v6 = buildNamespaceRules("s-test", chain, [web, db], cfg, true);

  it("never accepts pod-to-pod by destination IP from a source rule", () => {
    for (const r of accepts([...v4.rules, ...v6.rules])) {
      if (r.includes("-s")) assert.ok(!r.includes("-d"), `source rule names a destination: ${r.join(" ")}`);
    }
  });

  it("ends every source block in a DROP before any exposed-port rule", () => {
    for (const { rules } of [v4, v6]) {
      const firstIngress = firstMatch(rules, (r) => r[0] === "-d");
      for (const pod of [web, db]) {
        for (const ip of pod.ips) {
          const drop = firstMatch(rules, (r) => r[0] === "-s" && r[1] === ip && r.at(-1) === "DROP");
          if (!rules.some((r) => r[1] === ip)) continue; // other family
          assert.ok(drop >= 0, `no source DROP for ${ip}`);
          assert.ok(drop < firstIngress, `source DROP for ${ip} after an ingress rule`);
        }
      }
    }
  });

  it("allows services, DNS and internet from each source", () => {
    const src = v4.rules.filter((r) => r[1] === "10.42.0.2");
    assert.ok(src.some((r) => r.includes("--ctorigdst") && r.includes("10.43.0.0/16")));
    assert.ok(src.some((r) => r.includes("--ctorigdst") && r.includes("10.43.0.10") && r.includes("udp")));
    assert.ok(src.some((r) => r.at(-1) === EGRESS_CHAIN));
  });

  it("uses only the IP family's service CIDRs and DNS", () => {
    assert.ok(!v6.rules.some((r) => r.includes("10.43.0.0/16") || r.includes("10.43.0.10")));
    assert.ok(v6.rules.some((r) => r.includes("fd01::/108")));
    assert.ok(!v4.rules.some((r) => r.includes("fd01::/108")));
  });

  it("allows on-link NDP for IPv6 sources only", () => {
    const ndp = v6.rules.filter((r) => r.includes("--icmpv6-type"));
    assert.deepEqual(ndp.map((r) => [r[1], r[r.indexOf("--icmpv6-type") + 1]]),
      [["fd00::2", "135"], ["fd00::2", "136"], ["fd00::3", "135"], ["fd00::3", "136"]]);
    assert.ok(ndp.every((r) => r.includes("--hl-eq") && r.includes("255")));
    assert.ok(!v4.rules.some((r) => r.includes("--icmpv6-type")));
  });

  it("accepts exposed ports by destination", () => {
    assert.deepEqual(v4.rules.filter((r) => r[0] === "-d"), [
      ["-d", "10.42.0.2", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
      ["-d", "10.42.0.3", "-p", "tcp", "--dport", "5432", "-j", "ACCEPT"],
    ]);
  });

  it("ends in LOG + DROP", () => {
    assert.equal(v4.rules.at(-1)?.join(" "), "-j DROP");
    assert.equal(v4.rules.at(-2)?.[1], "LOG");
  });

  it("splits jumps into source and destination", () => {
    assert.deepEqual(v4.outJumps, [["-s", "10.42.0.2", "-j", chain], ["-s", "10.42.0.3", "-j", chain]]);
    assert.deepEqual(v4.inJumps, [["-d", "10.42.0.2", "-j", chain], ["-d", "10.42.0.3", "-j", chain]]);
    assert.deepEqual(v6.outJumps.map((j) => j[1]), ["fd00::2", "fd00::3"]);
  });

  it("returns no jumps for a family with no pod IPs", () => {
    const r = buildNamespaceRules("s-test", chain, [{ ips: ["10.42.0.9"], exposePorts: [] }], cfg, true);
    assert.deepEqual([r.outJumps, r.inJumps], [[], []]);
  });

  it("emits DNS rules for IPv6 when the DNS IP is IPv6", () => {
    const r = buildNamespaceRules("s-test", chain, [web], { ...cfg, dnsIp: "fd01::a" }, true);
    assert.ok(r.rules.some((x) => x.includes("fd01::a")));
  });
});
