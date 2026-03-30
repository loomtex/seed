// Tests for SeedDNSRecord CRD generation and DNS reconciler logic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateDNSRecord,
  generateInstanceDNSRecords,
  generateDomainCRD,
  resolveDNSName,
} from "../controller/manifests.js";
import type { SeedMeta, CombineDomainConfig } from "../shared/types.js";

function makeMeta(overrides?: Partial<SeedMeta>): SeedMeta {
  return {
    name: "web",
    system: "x86_64-linux",
    size: "medium",
    resources: { vcpus: 2, memory: 2048 },
    expose: {},
    storage: {},
    connect: {},
    rollout: "recreate",
    ...overrides,
  };
}

describe("generateDNSRecord", () => {
  it("generates a valid SeedDNSRecord with sourceRef", () => {
    const record = generateDNSRecord(
      "dns-web-auto",
      "s-test",
      "gen123",
      "web",
      {
        name: "web.s-test.seed.loom.farm.",
        type: "AAAA",
        ttl: 300,
        sourceRef: { kind: "Service", name: "web-ingress" },
      },
    );

    assert.equal(record.apiVersion, "seed.loom.farm/v1alpha1");
    assert.equal(record.kind, "SeedDNSRecord");
    assert.equal(record.metadata.name, "dns-web-auto");
    assert.equal(record.metadata.namespace, "s-test");
    assert.equal(record.spec.name, "web.s-test.seed.loom.farm.");
    assert.equal(record.spec.type, "AAAA");
    assert.equal(record.spec.ttl, 300);
    assert.equal(record.spec.sourceRef?.kind, "Service");
    assert.equal(record.spec.sourceRef?.name, "web-ingress");
  });

  it("generates a valid SeedDNSRecord with static records", () => {
    const record = generateDNSRecord(
      "dns-web-apex-a",
      "s-test",
      "gen123",
      "web",
      {
        name: "loom.farm.",
        type: "A",
        ttl: 300,
        records: [{ content: "96.30.193.227" }],
      },
    );

    assert.equal(record.spec.records?.length, 1);
    assert.equal(record.spec.records?.[0].content, "96.30.193.227");
    assert.equal(record.spec.sourceRef, undefined);
  });

  it("includes seed labels", () => {
    const record = generateDNSRecord(
      "dns-web-auto",
      "s-test",
      "gen456",
      "web",
      { name: "test.", type: "AAAA", ttl: 300 },
    );

    assert.equal(record.metadata.labels?.["seed.loom.farm/managed-by"], "seed");
    assert.equal(record.metadata.labels?.["seed.loom.farm/instance"], "web");
    assert.equal(record.metadata.labels?.["seed.loom.farm/generation"], "gen456");
  });
});

describe("generateInstanceDNSRecords", () => {
  const gen = "aabbccddee12";
  const ns = "s-gaydazldmnsg";
  const domain = "seed.loom.farm";

  it("returns empty array when no ports exposed", () => {
    const meta = makeMeta({ expose: {} });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain);
    assert.equal(records.length, 0);
  });

  it("generates auto AAAA record for instance with exposed ports", () => {
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
    });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain);

    assert.ok(records.length >= 1);
    const autoRecord = records.find((r) => r.metadata.name === "dns-web-auto");
    assert.ok(autoRecord, "should have auto record");
    assert.equal(autoRecord.spec.name, `web.${ns}.${domain}.`);
    assert.equal(autoRecord.spec.type, "AAAA");
    assert.equal(autoRecord.spec.sourceRef?.name, "web-ingress");
  });

  it("generates custom AAAA records from dns.names", () => {
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["id.loom.farm"] },
    });
    const records = generateInstanceDNSRecords("keycloak", gen, ns, meta, domain);

    const custom = records.find((r) => r.metadata.name === "dns-keycloak-id-loom-farm");
    assert.ok(custom, "should have custom record");
    assert.equal(custom.spec.name, "id.loom.farm.");
    assert.equal(custom.spec.type, "AAAA");
    assert.equal(custom.spec.sourceRef?.name, "keycloak-ingress");
  });

  it("does NOT generate A records (IPv4 handled by route block)", () => {
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["id.loom.farm"] },
    });
    const records = generateInstanceDNSRecords("keycloak", gen, ns, meta, domain);

    const aRecords = records.filter((r) => r.spec.type === "A");
    assert.equal(aRecords.length, 0, "should not generate any A records");
  });

  it("generates wildcard records for zone apex names", () => {
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["loom.farm"] },
    });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain);

    const wildcard = records.find((r) =>
      r.spec.name === "*.loom.farm.",
    );
    assert.ok(wildcard, "should have wildcard AAAA record");
    assert.equal(wildcard.spec.type, "AAAA");
    assert.equal(wildcard.spec.sourceRef?.name, "web-ingress");
  });

  it("does NOT generate wildcard for subdomain names", () => {
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["id.loom.farm"] },
    });
    const records = generateInstanceDNSRecords("keycloak", gen, ns, meta, domain);

    const wildcard = records.find((r) => r.spec.name.startsWith("*."));
    assert.equal(wildcard, undefined, "subdomain should not get wildcard");
  });

  it("generates multiple custom names", () => {
    const meta = makeMeta({
      expose: {
        http: { port: 80, protocol: "tcp" },
        https: { port: 443, protocol: "http" },
      },
      dns: { names: ["loom.farm", "www.loom.farm"] },
    });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain);

    // auto + loom.farm AAAA + *.loom.farm AAAA + www.loom.farm AAAA = 4 minimum
    assert.ok(records.length >= 4, `expected >= 4 records, got ${records.length}`);

    const names = records.map((r) => r.spec.name);
    assert.ok(names.includes("loom.farm."));
    assert.ok(names.includes("*.loom.farm."));
    assert.ok(names.includes("www.loom.farm."));
  });

  it("all records have unique k8s resource names", () => {
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["loom.farm", "www.loom.farm", "id.loom.farm"] },
    });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain);

    const resourceNames = records.map((r) => r.metadata.name);
    const unique = new Set(resourceNames);
    assert.equal(resourceNames.length, unique.size, "resource names should be unique");
  });

  it("adds domainRef when domains config provided", () => {
    const domains: Record<string, CombineDomainConfig> = {
      "loom.farm": { register: true, default: true },
    };
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["id.loom.farm"] },
    });
    const records = generateInstanceDNSRecords("keycloak", gen, ns, meta, domain, domains);

    const custom = records.find((r) => r.spec.name === "id.loom.farm.");
    assert.ok(custom, "should have custom record");
    assert.deepEqual(custom.spec.domainRef, { name: "loom.farm" });
  });

  it("auto records do NOT have domainRef", () => {
    const domains: Record<string, CombineDomainConfig> = {
      "loom.farm": { register: true, default: true },
    };
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
    });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain, domains);

    const auto = records.find((r) => r.metadata.name === "dns-web-auto");
    assert.ok(auto, "should have auto record");
    assert.equal(auto.spec.domainRef, undefined, "auto records should not have domainRef");
  });

  it("resolves non-FQDN names with default domain", () => {
    const domains: Record<string, CombineDomainConfig> = {
      "loom.farm": { register: true, default: true },
    };
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["www"] },
    });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain, domains);

    const www = records.find((r) => r.spec.name === "www.loom.farm.");
    assert.ok(www, "should resolve bare 'www' to 'www.loom.farm.'");
    assert.deepEqual(www.spec.domainRef, { name: "loom.farm" });
  });

  it("wildcard records also get domainRef", () => {
    const domains: Record<string, CombineDomainConfig> = {
      "loom.farm": { register: true, default: true },
    };
    const meta = makeMeta({
      expose: { https: { port: 443, protocol: "http" } },
      dns: { names: ["loom.farm"] },
    });
    const records = generateInstanceDNSRecords("web", gen, ns, meta, domain, domains);

    const wildcard = records.find((r) => r.spec.name === "*.loom.farm.");
    assert.ok(wildcard, "should have wildcard");
    assert.deepEqual(wildcard.spec.domainRef, { name: "loom.farm" });
  });
});

describe("resolveDNSName", () => {
  const domains: Record<string, CombineDomainConfig> = {
    "loom.farm": { register: true, default: true },
    "example.com": { register: false, default: false },
  };

  it("resolves bare name with default domain", () => {
    const result = resolveDNSName("www", domains);
    assert.ok(result);
    assert.equal(result.fqdn, "www.loom.farm.");
    assert.equal(result.domain, "loom.farm");
  });

  it("recognizes FQDN under declared domain", () => {
    const result = resolveDNSName("id.loom.farm", domains);
    assert.ok(result);
    assert.equal(result.fqdn, "id.loom.farm.");
    assert.equal(result.domain, "loom.farm");
  });

  it("recognizes FQDN under non-default domain", () => {
    const result = resolveDNSName("app.example.com", domains);
    assert.ok(result);
    assert.equal(result.fqdn, "app.example.com.");
    assert.equal(result.domain, "example.com");
  });

  it("recognizes zone apex as FQDN", () => {
    const result = resolveDNSName("loom.farm", domains);
    assert.ok(result);
    assert.equal(result.fqdn, "loom.farm.");
    assert.equal(result.domain, "loom.farm");
  });

  it("appends default domain to unrecognized multi-part name", () => {
    const result = resolveDNSName("foo.bar", domains);
    assert.ok(result);
    assert.equal(result.fqdn, "foo.bar.loom.farm.");
    assert.equal(result.domain, "loom.farm");
  });

  it("handles trailing dot in input", () => {
    const result = resolveDNSName("id.loom.farm.", domains);
    assert.ok(result);
    assert.equal(result.fqdn, "id.loom.farm.");
    assert.equal(result.domain, "loom.farm");
  });

  it("returns null when no domains configured", () => {
    const result = resolveDNSName("www", {});
    assert.equal(result, null);
  });
});

describe("generateDomainCRD", () => {
  it("generates a valid SeedDomain CRD", () => {
    const crd = generateDomainCRD(
      "loom.farm",
      { register: true, default: true },
      "gen123",
      "s-test",
    );

    assert.equal(crd.apiVersion, "seed.loom.farm/v1alpha1");
    assert.equal(crd.kind, "SeedDomain");
    assert.equal(crd.metadata.name, "domain-loom-farm");
    assert.equal(crd.metadata.namespace, "s-test");
    assert.equal(crd.spec.name, "loom.farm");
    assert.equal(crd.spec.register, true);
    assert.equal(crd.spec.registrar, "namesilo");
  });

  it("omits registrar for pre-owned domains", () => {
    const crd = generateDomainCRD(
      "example.com",
      { register: false, default: false },
      "gen123",
      "s-test",
    );

    assert.equal(crd.spec.register, false);
    assert.equal(crd.spec.registrar, undefined);
  });

  it("includes generation label", () => {
    const crd = generateDomainCRD(
      "loom.farm",
      { register: true, default: true },
      "gen456",
      "s-test",
    );

    assert.equal(crd.metadata.labels?.["seed.loom.farm/generation"], "gen456");
    assert.equal(crd.metadata.labels?.["seed.loom.farm/managed-by"], "seed");
  });
});
