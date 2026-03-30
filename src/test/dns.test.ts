// Tests for SeedDNSRecord CRD generation and DNS reconciler logic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateDNSRecord,
  generateInstanceDNSRecords,
} from "../controller/manifests.js";
import type { SeedMeta } from "../shared/types.js";

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
});
