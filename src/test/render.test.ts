// Tests for controller/index.ts — renderDesiredState (the core reconciliation logic).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDesiredState } from "../controller/index.js";
import type { ControllerConfig, BuildResult, IPv4Config, IPv6Config, SeedMeta } from "../shared/types.js";

function makeConfig(overrides?: Partial<ControllerConfig>): ControllerConfig {
  return {
    flakePath: "github:loomtex/seed",
    namespace: "s-gaydazldmnsg",
    interval: 30,
    ipv4Address: "216.128.141.222",
    ipv6Block: "2001:19f0:6402:7eb::/64",
    webhookSecretFile: "",
    builderImage: "",
    swtpmEnabled: false,
    ...overrides,
  };
}

function makeMeta(name: string, overrides?: Partial<SeedMeta>): SeedMeta {
  return {
    name,
    system: "x86_64-linux",
    size: "medium",
    resources: { vcpus: 2, memory: 2048 },
    expose: {},
    storage: {},
    connect: {},
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
    const config = makeConfig();
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    assert.match(state.generation, /^[0-9a-f]{12}$/);
  });

  it("generation is content-addressed — same inputs produce same hash", () => {
    const config = makeConfig();
    const results1 = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });
    const results2 = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });

    const state1 = renderDesiredState(config, results1, null, null, new Map());
    const state2 = renderDesiredState(config, results2, null, null, new Map());
    assert.equal(state1.generation, state2.generation);
  });

  it("different image paths produce different generations", () => {
    const config = makeConfig();
    const results1 = makeBuildResults({
      web: { imagePath: "/nix/store/old-seed-web", meta: makeMeta("web") },
    });
    const results2 = makeBuildResults({
      web: { imagePath: "/nix/store/new-seed-web", meta: makeMeta("web") },
    });

    const state1 = renderDesiredState(config, results1, null, null, new Map());
    const state2 = renderDesiredState(config, results2, null, null, new Map());
    assert.notEqual(state1.generation, state2.generation);
  });

  it("creates an InstanceState per build result", () => {
    const config = makeConfig();
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
      dns: { imagePath: "/nix/store/def-seed-dns", meta: makeMeta("dns") },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    assert.equal(state.instances.size, 2);
    assert.ok(state.instances.has("web"));
    assert.ok(state.instances.has("dns"));
  });

  it("generates pod with nix:0 image ref", () => {
    const config = makeConfig();
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc-seed-web",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    const webInstance = state.instances.get("web")!;
    assert.equal(
      webInstance.pod.spec?.containers[0].image,
      "nix:0/nix/store/abc-seed-web",
    );
  });

  it("generates ClusterIP service when ports are exposed", () => {
    const config = makeConfig();
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web", {
          expose: { http: { port: 80, protocol: "tcp" } },
        }),
      },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    const webInstance = state.instances.get("web")!;
    assert.equal(webInstance.services.length, 1);
    assert.equal(webInstance.services[0].metadata?.name, "seed-web");
  });

  it("generates no service when no ports exposed", () => {
    const config = makeConfig();
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web", { expose: {} }),
      },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    assert.equal(state.instances.get("web")!.services.length, 0);
  });

  it("generates PVCs for storage entries", () => {
    const config = makeConfig();
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

    const state = renderDesiredState(config, results, null, null, new Map());
    const pvcs = state.instances.get("web")!.pvcs;
    assert.equal(pvcs.length, 1);
    assert.equal(pvcs[0].metadata?.name, "seed-web-data");
  });

  it("generates TPM identity PVC when swtpm enabled", () => {
    const config = makeConfig({ swtpmEnabled: true });
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    const pvcs = state.instances.get("web")!.pvcs;
    const tpmPvc = pvcs.find((p) => p.metadata?.name === "seed-web-tpm-identity");
    assert.ok(tpmPvc, "TPM identity PVC should exist");
    assert.equal(tpmPvc!.spec?.resources?.requests?.storage, "10Mi");
  });

  it("generates SeedHostTask when swtpm enabled", () => {
    const config = makeConfig({ swtpmEnabled: true });
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    const hostTask = state.instances.get("dns")!.hostTask;
    assert.ok(hostTask, "host task should exist");
    assert.equal(hostTask!.spec.type, "swtpm");
    assert.equal(hostTask!.spec.instance, "dns");
  });

  it("no SeedHostTask when swtpm disabled", () => {
    const config = makeConfig({ swtpmEnabled: false });
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    assert.equal(state.instances.get("web")!.hostTask, null);
  });

  it("uses TPM socket path from host task status", () => {
    const config = makeConfig({ swtpmEnabled: true });
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });

    const hostTaskStatuses = new Map([
      ["dns", { ready: true, socketPath: "/run/swtpm/s-gaydazldmnsg-dns/swtpm-sock" }],
    ]);

    const state = renderDesiredState(config, results, null, null, hostTaskStatuses);
    const pod = state.instances.get("dns")!.pod;
    assert.equal(
      pod.metadata?.annotations?.["io.katacontainers.config.hypervisor.tpm_socket"],
      "/run/swtpm/s-gaydazldmnsg-dns/swtpm-sock",
    );
  });

  it("does not set TPM socket when host task is not ready", () => {
    const config = makeConfig({ swtpmEnabled: true });
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });

    const hostTaskStatuses = new Map([
      ["dns", { ready: false, socketPath: "" }],
    ]);

    const state = renderDesiredState(config, results, null, null, hostTaskStatuses);
    const pod = state.instances.get("dns")!.pod;
    assert.equal(
      pod.metadata?.annotations?.["io.katacontainers.config.hypervisor.tpm_socket"],
      undefined,
    );
  });

  it("generates IPv4 route services", () => {
    const config = makeConfig({ ipv4Address: "1.2.3.4" });
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const ipv4Config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 80, protocol: "tcp", instance: "web" },
      },
    };

    const state = renderDesiredState(config, results, ipv4Config, null, new Map());
    assert.equal(state.routes.ipv4.length, 1);
    assert.equal(state.routes.ipv4[0].spec?.loadBalancerIP, "1.2.3.4");
  });

  it("generates IPv6 route services", () => {
    const config = makeConfig();
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

    const state = renderDesiredState(config, results, null, ipv6Config, new Map());
    assert.equal(state.routes.ipv6.length, 1);
    assert.equal(state.routes.ipv6[0].spec?.loadBalancerIP, "2001:db8::1");
  });

  it("handles no route configs", () => {
    const config = makeConfig();
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    assert.deepEqual(state.routes.ipv4, []);
    assert.deepEqual(state.routes.ipv6, []);
  });

  it("uses config namespace", () => {
    const config = makeConfig({ namespace: "s-custom" });
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const state = renderDesiredState(config, results, null, null, new Map());
    assert.equal(state.namespace, "s-custom");
    assert.equal(state.instances.get("web")!.pod.metadata?.namespace, "s-custom");
  });
});
