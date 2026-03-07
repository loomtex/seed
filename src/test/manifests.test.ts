// Tests for controller/manifests.ts — pod, PVC, service, host task generation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generatePod,
  generatePVC,
  generateService,
  generateHostTask,
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
    ...overrides,
  };
}

describe("generatePod", () => {
  const gen = "aabbccddee12";
  const ns = "s-gaydazldmnsg";

  it("generates a valid Pod manifest", () => {
    const meta = makeMeta();
    const pod = generatePod("web", "nix:0/nix/store/abc-seed-web", gen, ns, meta);

    assert.equal(pod.apiVersion, "v1");
    assert.equal(pod.kind, "Pod");
    assert.equal(pod.metadata?.name, "seed-web");
    assert.equal(pod.metadata?.namespace, ns);
    assert.equal(pod.spec?.runtimeClassName, "kata");
    assert.equal(pod.spec?.restartPolicy, "Always");
  });

  it("includes seed labels", () => {
    const meta = makeMeta();
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta);

    assert.equal(pod.metadata?.labels?.["seed.loom.farm/managed-by"], "seed");
    assert.equal(pod.metadata?.labels?.["seed.loom.farm/instance"], "web");
    assert.equal(pod.metadata?.labels?.["seed.loom.farm/generation"], gen);
  });

  it("includes Kata annotations for VM sizing", () => {
    const meta = makeMeta({ resources: { vcpus: 4, memory: 4096 } });
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta);

    assert.equal(
      pod.metadata?.annotations?.[
        "io.katacontainers.config.hypervisor.default_vcpus"
      ],
      "4",
    );
    assert.equal(
      pod.metadata?.annotations?.[
        "io.katacontainers.config.hypervisor.default_memory"
      ],
      "4096",
    );
  });

  it("sets SEED_NODE_IP env from downward API", () => {
    const meta = makeMeta();
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta);
    const env = pod.spec?.containers[0]?.env;
    const nodeIpEnv = env?.find((e) => e.name === "SEED_NODE_IP");

    assert.ok(nodeIpEnv, "SEED_NODE_IP env should exist");
    assert.equal(nodeIpEnv?.valueFrom?.fieldRef?.fieldPath, "status.hostIP");
  });

  it("has no volumes when no storage", () => {
    const meta = makeMeta({ storage: {} });
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta);

    assert.equal(pod.spec?.volumes, undefined);
    assert.equal(pod.spec?.containers[0].volumeMounts, undefined);
  });

  it("adds storage volumes and mounts", () => {
    const meta = makeMeta({
      storage: {
        data: { size: "1Gi", mountPoint: "/seed/storage/data" },
        logs: { size: "500Mi", mountPoint: "/seed/storage/logs" },
      },
    });
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta);

    assert.equal(pod.spec?.volumes?.length, 2);
    assert.equal(pod.spec?.containers[0].volumeMounts?.length, 2);

    const dataVol = pod.spec?.volumes?.find((v) => v.name === "data");
    assert.ok(dataVol, "data volume should exist");
    assert.equal(dataVol?.persistentVolumeClaim?.claimName, "seed-web-data");

    const dataMount = pod.spec?.containers[0].volumeMounts?.find(
      (m) => m.name === "data",
    );
    assert.ok(dataMount, "data mount should exist");
    assert.equal(dataMount?.mountPath, "/seed/storage/data");
  });

  it("adds TPM socket annotation when provided", () => {
    const meta = makeMeta();
    const socketPath = "/run/swtpm/s-gaydazldmnsg-web/swtpm-sock";
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta, socketPath);

    assert.equal(
      pod.metadata?.annotations?.[
        "io.katacontainers.config.hypervisor.tpm_socket"
      ],
      socketPath,
    );
  });

  it("adds TPM identity volume when TPM socket provided", () => {
    const meta = makeMeta();
    const socketPath = "/run/swtpm/s-gaydazldmnsg-web/swtpm-sock";
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta, socketPath);

    const tpmVol = pod.spec?.volumes?.find((v) => v.name === "tpm-identity");
    assert.ok(tpmVol, "tpm-identity volume should exist");
    assert.equal(tpmVol?.persistentVolumeClaim?.claimName, "seed-web-tpm-identity");

    const tpmMount = pod.spec?.containers[0].volumeMounts?.find(
      (m) => m.name === "tpm-identity",
    );
    assert.ok(tpmMount, "tpm-identity mount should exist");
    assert.equal(tpmMount?.mountPath, "/seed/tpm");
  });

  it("combines storage and TPM volumes", () => {
    const meta = makeMeta({
      storage: { data: { size: "1Gi", mountPoint: "/seed/storage/data" } },
    });
    const socketPath = "/run/swtpm/ns-web/swtpm-sock";
    const pod = generatePod("web", "nix:0/nix/store/abc", gen, ns, meta, socketPath);

    assert.equal(pod.spec?.volumes?.length, 2);
    assert.equal(pod.spec?.containers[0].volumeMounts?.length, 2);

    const volNames = pod.spec?.volumes?.map((v) => v.name).sort();
    assert.deepEqual(volNames, ["data", "tpm-identity"]);
  });
});

describe("generatePVC", () => {
  it("generates a valid PVC manifest", () => {
    const pvc = generatePVC("web", "data", "1Gi", "gen123", "s-test");

    assert.equal(pvc.apiVersion, "v1");
    assert.equal(pvc.kind, "PersistentVolumeClaim");
    assert.equal(pvc.metadata?.name, "seed-web-data");
    assert.equal(pvc.metadata?.namespace, "s-test");
    assert.deepEqual(pvc.spec?.accessModes, ["ReadWriteOnce"]);
    assert.equal(pvc.spec?.resources?.requests?.storage, "1Gi");
  });

  it("includes seed labels", () => {
    const pvc = generatePVC("dns", "state", "500Mi", "gen456", "s-test");

    assert.equal(pvc.metadata?.labels?.["seed.loom.farm/managed-by"], "seed");
    assert.equal(pvc.metadata?.labels?.["seed.loom.farm/instance"], "dns");
    assert.equal(pvc.metadata?.labels?.["seed.loom.farm/generation"], "gen456");
  });
});

describe("generateService", () => {
  it("returns null when no ports exposed", () => {
    const meta = makeMeta({ expose: {} });
    const svc = generateService("web", "gen1", "s-test", meta);
    assert.equal(svc, null);
  });

  it("generates a ClusterIP service for TCP ports", () => {
    const meta = makeMeta({
      expose: {
        http: { port: 8080, protocol: "tcp" },
      },
    });
    const svc = generateService("web", "gen1", "s-test", meta);

    assert.ok(svc, "service should be generated");
    assert.equal(svc.metadata?.name, "seed-web");
    assert.equal(svc.spec?.selector?.["seed.loom.farm/instance"], "web");

    const ports = svc.spec?.ports;
    assert.equal(ports?.length, 1);
    assert.equal(ports?.[0].name, "http");
    assert.equal(ports?.[0].port, 8080);
    assert.equal(ports?.[0].protocol, "TCP");
  });

  it("generates both TCP and UDP ports for DNS protocol", () => {
    const meta = makeMeta({
      expose: {
        dns: { port: 53, protocol: "dns" },
      },
    });
    const svc = generateService("dns", "gen1", "s-test", meta);

    assert.ok(svc);
    const ports = svc.spec?.ports;
    assert.equal(ports?.length, 2);

    const tcpPort = ports?.find((p) => p.protocol === "TCP");
    const udpPort = ports?.find((p) => p.protocol === "UDP");
    assert.ok(tcpPort, "should have TCP port");
    assert.ok(udpPort, "should have UDP port");
    assert.equal(tcpPort?.name, "dns-tcp");
    assert.equal(udpPort?.name, "dns-udp");
    assert.equal(tcpPort?.port, 53);
    assert.equal(udpPort?.port, 53);
  });

  it("generates UDP-only port for udp protocol", () => {
    const meta = makeMeta({
      expose: {
        game: { port: 27015, protocol: "udp" },
      },
    });
    const svc = generateService("game", "gen1", "s-test", meta);

    assert.ok(svc);
    const ports = svc.spec?.ports;
    assert.equal(ports?.length, 1);
    assert.equal(ports?.[0].protocol, "UDP");
    assert.equal(ports?.[0].name, "game");
  });

  it("handles http and grpc as TCP", () => {
    const meta = makeMeta({
      expose: {
        web: { port: 80, protocol: "http" },
        api: { port: 50051, protocol: "grpc" },
      },
    });
    const svc = generateService("web", "gen1", "s-test", meta);

    assert.ok(svc);
    const ports = svc.spec?.ports;
    assert.equal(ports?.length, 2);
    assert.ok(ports?.every((p) => p.protocol === "TCP"));
  });

  it("handles multiple expose entries", () => {
    const meta = makeMeta({
      expose: {
        dns: { port: 53, protocol: "dns" },
        http: { port: 80, protocol: "tcp" },
      },
    });
    const svc = generateService("multi", "gen1", "s-test", meta);

    assert.ok(svc);
    // dns produces 2 ports (TCP + UDP), http produces 1
    assert.equal(svc.spec?.ports?.length, 3);
  });
});

describe("generateHostTask", () => {
  it("generates a valid SeedHostTask CRD manifest", () => {
    const ht = generateHostTask("dns", "s-gaydazldmnsg", "gen123");

    assert.equal(ht.apiVersion, "seed.loom.farm/v1alpha1");
    assert.equal(ht.kind, "SeedHostTask");
    assert.equal(ht.metadata.name, "swtpm-dns");
    assert.equal(ht.metadata.namespace, "s-gaydazldmnsg");
    assert.equal(ht.spec.type, "swtpm");
    assert.equal(ht.spec.instance, "dns");
    assert.equal(ht.spec.namespace, "s-gaydazldmnsg");
  });

  it("includes seed labels", () => {
    const ht = generateHostTask("web", "s-test", "gen456");

    assert.equal(ht.metadata.labels?.["seed.loom.farm/managed-by"], "seed");
    assert.equal(ht.metadata.labels?.["seed.loom.farm/instance"], "web");
    assert.equal(ht.metadata.labels?.["seed.loom.farm/generation"], "gen456");
  });
});
