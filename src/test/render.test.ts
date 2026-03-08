// Tests for controller/index.ts — renderDesiredState (the core reconciliation logic).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDesiredState } from "../controller/index.js";
import type { BuildResult, IPv4Config, IPv6Config, SeedMeta } from "../shared/types.js";

const DEFAULT_NAMESPACE = "s-gaydazldmnsg";
const DEFAULT_IPV4 = "216.128.141.222";

function makeMeta(name: string, overrides?: Partial<SeedMeta>): SeedMeta {
  return {
    name,
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

function makeBuildResults(
  entries: Record<string, { imagePath: string; meta: SeedMeta }>,
): Map<string, BuildResult> {
  return new Map(Object.entries(entries));
}

describe("renderDesiredState", () => {
  it("produces a generation hash from build results", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    assert.match(state.generation, /^[0-9a-f]{12}$/);
  });

  it("generation is content-addressed — same inputs produce same hash", () => {
    const results1 = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });
    const results2 = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });

    const state1 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results1, null, null, new Map());
    const state2 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results2, null, null, new Map());
    assert.equal(state1.generation, state2.generation);
  });

  it("different image paths produce different generations", () => {
    const results1 = makeBuildResults({
      web: { imagePath: "/nix/store/old-seed-web", meta: makeMeta("web") },
    });
    const results2 = makeBuildResults({
      web: { imagePath: "/nix/store/new-seed-web", meta: makeMeta("web") },
    });

    const state1 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results1, null, null, new Map());
    const state2 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results2, null, null, new Map());
    assert.notEqual(state1.generation, state2.generation);
  });

  it("creates an InstanceState per build result", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
      dns: { imagePath: "/nix/store/def-seed-dns", meta: makeMeta("dns") },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    assert.equal(state.instances.size, 2);
    assert.ok(state.instances.has("web"));
    assert.ok(state.instances.has("dns"));
  });

  it("generates deployment with nix:0 image ref", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc-seed-web",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    const webInstance = state.instances.get("web")!;
    assert.equal(
      webInstance.deployment.spec?.template?.spec?.containers[0].image,
      "nix:0/nix/store/abc-seed-web",
    );
  });

  it("generates Deployment with correct structure", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc-seed-web",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    const dep = state.instances.get("web")!.deployment;
    assert.equal(dep.apiVersion, "apps/v1");
    assert.equal(dep.kind, "Deployment");
    assert.equal(dep.spec?.replicas, 1);
    assert.equal(dep.spec?.strategy?.type, "Recreate");
    assert.deepEqual(dep.spec?.selector?.matchLabels, {
      "seed.loom.farm/instance": "web",
    });
  });

  it("generates ClusterIP service when ports are exposed", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web", {
          expose: { http: { port: 80, protocol: "tcp" } },
        }),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    const webInstance = state.instances.get("web")!;
    assert.equal(webInstance.services.length, 1);
    assert.equal(webInstance.services[0].metadata?.name, "seed-web");
  });

  it("generates no service when no ports exposed", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web", { expose: {} }),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    assert.equal(state.instances.get("web")!.services.length, 0);
  });

  it("generates PVCs for storage entries", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web", {
          storage: {
            data: { size: "1Gi", mountPoint: "/seed/storage/data" },
          },
        }),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    const pvcs = state.instances.get("web")!.pvcs;
    assert.equal(pvcs.length, 1);
    assert.equal(pvcs[0].metadata?.name, "seed-web-data");
  });

  it("generates TPM identity PVC when swtpm enabled", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, true, DEFAULT_IPV4, results, null, null, new Map());
    const pvcs = state.instances.get("web")!.pvcs;
    const tpmPvc = pvcs.find((p) => p.metadata?.name === "seed-web-tpm-identity");
    assert.ok(tpmPvc, "TPM identity PVC should exist");
    assert.equal(tpmPvc!.spec?.resources?.requests?.storage, "10Mi");
  });

  it("generates SeedHostTask when swtpm enabled", () => {
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, true, DEFAULT_IPV4, results, null, null, new Map());
    const hostTask = state.instances.get("dns")!.hostTask;
    assert.ok(hostTask, "host task should exist");
    assert.equal(hostTask!.spec.type, "swtpm");
    assert.equal(hostTask!.spec.instance, "dns");
  });

  it("no SeedHostTask when swtpm disabled", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    assert.equal(state.instances.get("web")!.hostTask, null);
  });

  it("uses TPM socket path from host task status", () => {
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });

    const hostTaskStatuses = new Map([
      ["dns", { ready: true, socketPath: "/run/swtpm/s-gaydazldmnsg-dns/swtpm-sock" }],
    ]);

    const state = renderDesiredState(DEFAULT_NAMESPACE, true, DEFAULT_IPV4, results, null, null, hostTaskStatuses);
    const dep = state.instances.get("dns")!.deployment;
    assert.equal(
      dep.spec?.template?.metadata?.annotations?.["io.katacontainers.config.hypervisor.tpm_socket"],
      "/run/swtpm/s-gaydazldmnsg-dns/swtpm-sock",
    );
  });

  it("does not set TPM socket when host task is not ready", () => {
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });

    const hostTaskStatuses = new Map([
      ["dns", { ready: false, socketPath: "" }],
    ]);

    const state = renderDesiredState(DEFAULT_NAMESPACE, true, DEFAULT_IPV4, results, null, null, hostTaskStatuses);
    const dep = state.instances.get("dns")!.deployment;
    assert.equal(
      dep.spec?.template?.metadata?.annotations?.["io.katacontainers.config.hypervisor.tpm_socket"],
      undefined,
    );
  });

  it("generates IPv4 route services", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const ipv4Config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 80, protocol: "tcp", instance: "web" },
      },
    };

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, "1.2.3.4", results, ipv4Config, null, new Map());
    assert.equal(state.routes.ipv4.length, 1);
    assert.equal(state.routes.ipv4[0].spec?.loadBalancerIP, "1.2.3.4");
  });

  it("generates IPv6 route services", () => {
    const results = makeBuildResults({
      dns: { imagePath: "/nix/store/abc", meta: makeMeta("dns") },
    });

    const ipv6Config: IPv6Config = {
      enable: true,
      block: "2001:db8::/64",
      routes: {
        dns: { host: "1", port: 53, protocol: "dns", instance: "dns" },
      },
    };

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, ipv6Config, new Map());
    assert.equal(state.routes.ipv6.length, 1);
    assert.equal(state.routes.ipv6[0].spec?.loadBalancerIP, "2001:db8::1");
  });

  it("handles no route configs", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, results, null, null, new Map());
    assert.deepEqual(state.routes.ipv4, []);
    assert.deepEqual(state.routes.ipv6, []);
  });

  it("uses provided namespace", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const state = renderDesiredState("s-custom", false, DEFAULT_IPV4, results, null, null, new Map());
    assert.equal(state.namespace, "s-custom");
    assert.equal(state.instances.get("web")!.deployment.metadata?.namespace, "s-custom");
  });
});
