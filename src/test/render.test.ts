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

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
    assert.match(state.generation, /^[0-9a-f]{12}$/);
  });

  it("generation is content-addressed — same inputs produce same hash", () => {
    const results1 = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });
    const results2 = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
    });

    const state1 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results1, null, null);
    const state2 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results2, null, null);
    assert.equal(state1.generation, state2.generation);
  });

  it("different image paths produce different generations", () => {
    const results1 = makeBuildResults({
      web: { imagePath: "/nix/store/old-seed-web", meta: makeMeta("web") },
    });
    const results2 = makeBuildResults({
      web: { imagePath: "/nix/store/new-seed-web", meta: makeMeta("web") },
    });

    const state1 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results1, null, null);
    const state2 = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results2, null, null);
    assert.notEqual(state1.generation, state2.generation);
  });

  it("creates an InstanceState per build result", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc-seed-web", meta: makeMeta("web") },
      dns: { imagePath: "/nix/store/def-seed-dns", meta: makeMeta("dns") },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
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

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
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

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
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

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
    const webInstance = state.instances.get("web")!;
    assert.equal(webInstance.services.length, 1);
    assert.equal(webInstance.services[0].metadata?.name, "web");
  });

  it("generates no service when no ports exposed", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web", { expose: {} }),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
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

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
    const pvcs = state.instances.get("web")!.pvcs;
    assert.equal(pvcs.length, 1);
    assert.equal(pvcs[0].metadata?.name, "seed-web-data");
  });

  it("does not generate TPM identity PVC (TPM state on CephFS hostPath)", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, true, DEFAULT_IPV4, "", results, null, null);
    const pvcs = state.instances.get("web")!.pvcs;
    const tpmPvc = pvcs.find((p) => p.metadata?.name === "seed-web-tpm-identity");
    assert.equal(tpmPvc, undefined, "TPM identity PVC should not exist");
  });

  it("swtpm enabled: unrecorded instances render in create mode, no tpm_socket", () => {
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, true, DEFAULT_IPV4, "", results, null, null);
    const inst = state.instances.get("dns")!;
    assert.deepEqual(inst.shimTpm, { mode: "create" });
    const ann = inst.deployment.spec?.template?.metadata?.annotations ?? {};
    assert.equal(ann["seed.loom.farm/tpm-mode"], "create");
    assert.equal(ann["io.katacontainers.config.hypervisor.tpm_socket"], undefined);
  });

  it("no TPM when swtpm disabled", () => {
    const results = makeBuildResults({
      web: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("web"),
      },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
    const inst = state.instances.get("web")!;
    assert.equal(inst.shimTpm, undefined);
    assert.equal(inst.deployment.spec?.template?.metadata?.annotations?.["seed.loom.farm/tpm-mode"], undefined);
  });

  it("recorded fingerprint renders verify mode", () => {
    const results = makeBuildResults({
      dns: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("dns"),
      },
    });
    const fp = "ab".repeat(32);

    const state = renderDesiredState(DEFAULT_NAMESPACE, true, DEFAULT_IPV4, "", results, null, null,
      undefined, undefined, undefined, { records: new Map([["dns", fp]]) });
    const ann = state.instances.get("dns")!.deployment.spec?.template?.metadata?.annotations ?? {};
    assert.equal(ann["seed.loom.farm/tpm-mode"], "verify");
    assert.equal(ann["seed.loom.farm/tpm-fingerprint"], fp);
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

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, "1.2.3.4", "", results, ipv4Config, null);
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

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, ipv6Config);
    assert.equal(state.routes.ipv6.length, 1);
    assert.equal(state.routes.ipv6[0].spec?.loadBalancerIP, "2001:db8::1");
  });

  it("handles no route configs", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, "", results, null, null);
    assert.deepEqual(state.routes.ipv4, []);
    assert.deepEqual(state.routes.ipv6, []);
  });

  it("uses provided namespace", () => {
    const results = makeBuildResults({
      web: { imagePath: "/nix/store/abc", meta: makeMeta("web") },
    });

    const state = renderDesiredState("s-custom", false, DEFAULT_IPV4, "", results, null, null);
    assert.equal(state.namespace, "s-custom");
    assert.equal(state.instances.get("web")!.deployment.metadata?.namespace, "s-custom");
  });

  it("injects SEED_SHOOT_URL when shoot enabled and poolManagerUrl set", () => {
    const results = makeBuildResults({
      app: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("app", { shoot: { enable: true } }),
      },
    });

    const pmUrl = "http://seed-pool-manager.seed-system.svc.cluster.local:9877";
    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, pmUrl, results, null, null);
    const env = state.instances.get("app")!.deployment.spec?.template?.spec?.containers[0].env;
    const shootEnv = env?.find((e) => e.name === "SEED_SHOOT_URL");
    assert.ok(shootEnv, "SEED_SHOOT_URL should be set");
    assert.equal(shootEnv!.value, pmUrl);
  });

  it("does not inject SEED_SHOOT_URL when shoot not enabled", () => {
    const results = makeBuildResults({
      app: {
        imagePath: "/nix/store/abc",
        meta: makeMeta("app"),
      },
    });

    const pmUrl = "http://seed-pool-manager.seed-system.svc.cluster.local:9877";
    const state = renderDesiredState(DEFAULT_NAMESPACE, false, DEFAULT_IPV4, pmUrl, results, null, null);
    const env = state.instances.get("app")!.deployment.spec?.template?.spec?.containers[0].env;
    const shootEnv = env?.find((e) => e.name === "SEED_SHOOT_URL");
    assert.equal(shootEnv, undefined, "SEED_SHOOT_URL should not be set");
  });
});
