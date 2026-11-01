// Tests for shim-owned swtpm: fingerprint validation, the create → verify
// flip decision, and Deployment rendering.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as k8s from "@kubernetes/client-node";
import {
  parseFingerprintFile, isValidFingerprint, shimTpmModeFor,
  decideTpmFlip, tpmStateDir, FINGERPRINT_MTIME_SLACK_MS,
  type TpmFlipInput,
} from "../shared/tpm.js";
import { generateDeployment, applyShimTpm, generateSeedTPM } from "../controller/manifests.js";
import { renderDesiredState } from "../controller/index.js";
import { currentInstancePod } from "../controller/tpm.js";
import { ANNOTATIONS, LABELS } from "../shared/labels.js";
import type { BuildResult, SeedMeta } from "../shared/types.js";

const NS = "s-gaydazldmnsg";
const FP = "a".repeat(64);
const FP2 = "0123456789abcdef".repeat(4);

function meta(name: string, overrides?: Partial<SeedMeta>): SeedMeta {
  return {
    name, system: "x86_64-linux", size: "m", resources: { vcpus: 2, memory: 2048 },
    expose: {}, storage: {}, connect: {}, rollout: "recreate", ...overrides,
  };
}

function podAnn(dep: k8s.V1Deployment): Record<string, string> {
  return dep.spec!.template.metadata!.annotations!;
}

function tpmVolume(dep: k8s.V1Deployment): k8s.V1Volume | undefined {
  return dep.spec!.template.spec!.volumes?.find((v) => v.name === "tpm");
}

function tpmMounts(dep: k8s.V1Deployment): k8s.V1VolumeMount[] {
  return dep.spec!.template.spec!.containers[0].volumeMounts?.filter((m) => m.name === "tpm") ?? [];
}

// --- fingerprints ---

describe("parseFingerprintFile", () => {
  it("accepts 64 lowercase hex with or without one trailing newline", () => {
    assert.deepEqual(parseFingerprintFile(FP), { ok: true, fingerprint: FP });
    assert.deepEqual(parseFingerprintFile(FP2 + "\n"), { ok: true, fingerprint: FP2 });
  });

  it("rejects everything else", () => {
    for (const bad of [
      "", "\n", FP.toUpperCase(), FP + "\n\n", " " + FP, FP + " ", FP + "\r\n",
      FP.slice(0, 63), FP + "a", "g".repeat(64), `${FP}\n${FP}`, "sha256:" + FP,
    ]) {
      const r = parseFingerprintFile(bad);
      assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("isValidFingerprint / shimTpmModeFor", () => {
    assert.equal(isValidFingerprint(FP), true);
    assert.equal(isValidFingerprint(FP + "\n"), false);
    assert.equal(isValidFingerprint(undefined), false);
    assert.deepEqual(shimTpmModeFor(undefined), { mode: "create" });
    assert.deepEqual(shimTpmModeFor("nope"), { mode: "create" });
    assert.deepEqual(shimTpmModeFor(FP), { mode: "verify", fingerprint: FP });
  });
});

// --- flip decision ---

describe("decideTpmFlip", () => {
  const start = Date.parse("2026-10-31T12:00:00Z");
  const base: TpmFlipInput = {
    recorded: null, podMode: "create", podReady: true, podStartedAtMs: start,
    file: { content: FP + "\n", mtimeMs: start + 10_000 },
  };

  it("records the fingerprint from a Ready create-mode pod", () => {
    assert.deepEqual(decideTpmFlip(base), { action: "record", fingerprint: FP, createdAtMs: start + 10_000 });
  });

  it("waits while the pod is not Ready or the file is missing", () => {
    assert.equal(decideTpmFlip({ ...base, podReady: false }).action, "wait");
    assert.equal(decideTpmFlip({ ...base, file: null }).action, "wait");
  });

  it("does nothing without a create-mode pod", () => {
    assert.equal(decideTpmFlip({ ...base, podMode: null }).action, "none");
    assert.equal(decideTpmFlip({ ...base, podMode: "verify" }).action, "none");
  });

  it("rejects malformed and stale files", () => {
    assert.equal(decideTpmFlip({ ...base, file: { content: "junk", mtimeMs: start } }).action, "invalid-file");
    const stale = decideTpmFlip({ ...base, file: { content: FP, mtimeMs: start - FINGERPRINT_MTIME_SLACK_MS - 1 } });
    assert.equal(stale.action, "invalid-file");
    // within clock-skew slack is fine
    const skewed = decideTpmFlip({ ...base, file: { content: FP, mtimeMs: start - 30_000 } });
    assert.equal(skewed.action, "record");
  });

  it("re-applies verify mode when already recorded but pod is still in create mode", () => {
    assert.deepEqual(decideTpmFlip({ ...base, recorded: FP }), { action: "apply-verify", fingerprint: FP });
  });

  it("is a no-op once recorded and verifying", () => {
    assert.deepEqual(decideTpmFlip({ ...base, recorded: FP, podMode: "verify" }), { action: "none" });
    assert.deepEqual(decideTpmFlip({ ...base, recorded: FP, podMode: "verify", file: null }), { action: "none" });
  });

  it("never replaces a record: a differing file is a mismatch, even in create mode", () => {
    for (const podMode of ["create", "verify", null] as const) {
      assert.deepEqual(
        decideTpmFlip({ ...base, recorded: FP2, podMode }),
        { action: "mismatch", recorded: FP2, file: FP },
      );
    }
  });
});

// --- rendering ---

describe("generateDeployment with shim-owned swtpm", () => {
  const gen = "abc123def456";

  it("create mode: mode + state dir annotations, no socket, no fingerprint", () => {
    const dep = generateDeployment("dns", "nix:0/nix/store/x", gen, NS, meta("dns"),
      { mode: "create" });
    const ann = podAnn(dep);
    assert.equal(ann[ANNOTATIONS.TPM_MODE], "create");
    assert.equal(ann[ANNOTATIONS.TPM_STATE_DIR], `/var/lib/seed-controller/tpm/${NS}-dns`);
    assert.equal(ann[ANNOTATIONS.TPM_FINGERPRINT], undefined);
    assert.equal(ann[ANNOTATIONS.KATA_TPM_SOCKET], undefined);
    assert.equal(tpmVolume(dep)?.hostPath?.path, tpmStateDir(NS, "dns"));
    assert.equal(tpmVolume(dep)?.hostPath?.type, "DirectoryOrCreate");
    assert.deepEqual(tpmMounts(dep), [{ name: "tpm", mountPath: "/seed/tpm" }]);
  });

  it("verify mode: fingerprint annotation, state dir must exist", () => {
    const dep = generateDeployment("dns", "nix:0/nix/store/x", gen, NS, meta("dns"),
      { mode: "verify", fingerprint: FP });
    const ann = podAnn(dep);
    assert.equal(ann[ANNOTATIONS.TPM_MODE], "verify");
    assert.equal(ann[ANNOTATIONS.TPM_FINGERPRINT], FP);
    assert.equal(ann[ANNOTATIONS.KATA_TPM_SOCKET], undefined);
    assert.equal(tpmVolume(dep)?.hostPath?.type, "Directory");
  });

  it("flip (applyShimTpm on the create deployment) equals rendering verify directly", () => {
    const m = meta("dns", { storage: { data: { size: "1Gi", mountPoint: "/data" } } });
    const create = generateDeployment("dns", "nix:0/nix/store/x", gen, NS, m,
      { mode: "create" });
    const verify = generateDeployment("dns", "nix:0/nix/store/x", gen, NS, m,
      { mode: "verify", fingerprint: FP });
    const flipped = applyShimTpm(create, NS, "dns", { mode: "verify", fingerprint: FP });
    assert.deepEqual(flipped, verify);
    // input untouched
    assert.equal(podAnn(create)[ANNOTATIONS.TPM_MODE], "create");
  });

  it("applyShimTpm migrates a legacy deployment and keeps one tpm volume/mount", () => {
    const legacy = generateDeployment("dns", "nix:0/nix/store/x", gen, NS, meta("dns"));
    legacy.spec!.template.metadata!.annotations![ANNOTATIONS.KATA_TPM_SOCKET] = "/run/swtpm/s/swtpm-sock";
    legacy.spec!.template.spec!.volumes!.push({ name: "tpm", hostPath: { path: tpmStateDir(NS, "dns"), type: "DirectoryOrCreate" } });
    legacy.spec!.template.spec!.containers[0].volumeMounts!.push({ name: "tpm", mountPath: "/seed/tpm" });
    const dep = applyShimTpm(legacy, NS, "dns", { mode: "create" });
    assert.equal(podAnn(dep)[ANNOTATIONS.KATA_TPM_SOCKET], undefined);
    assert.equal(dep.spec!.template.spec!.volumes!.filter((v) => v.name === "tpm").length, 1);
    assert.equal(tpmMounts(dep).length, 1);
    // back to create from verify drops the fingerprint
    const v = applyShimTpm(dep, NS, "dns", { mode: "verify", fingerprint: FP });
    assert.equal(podAnn(applyShimTpm(v, NS, "dns", { mode: "create" }))[ANNOTATIONS.TPM_FINGERPRINT], undefined);
  });

  it("only annotations/volume differ between modes (pod template labels stable)", () => {
    const a = generateDeployment("dns", "nix:0/nix/store/x", gen, NS, meta("dns"),
      { mode: "create" });
    const b = applyShimTpm(a, NS, "dns", { mode: "verify", fingerprint: FP });
    assert.deepEqual(b.spec!.template.metadata!.labels, a.spec!.template.metadata!.labels);
    assert.deepEqual(b.metadata, a.metadata);
    assert.deepEqual(b.spec!.selector, a.spec!.selector);
  });

  it("generateSeedTPM has no generation label (never reaped)", () => {
    const t = generateSeedTPM("dns", NS);
    assert.equal(t.metadata.name, "dns");
    assert.equal(t.metadata.labels?.[LABELS.INSTANCE], "dns");
    assert.equal(t.metadata.labels?.[LABELS.GENERATION], undefined);
  });
});

describe("renderDesiredState with shim-owned swtpm", () => {
  const results: Map<string, BuildResult> = new Map([
    ["dns", { imagePath: "/nix/store/a-seed-dns", meta: meta("dns") }],
    ["web", { imagePath: "/nix/store/b-seed-web", meta: meta("web") }],
  ]);
  const render = (records: Map<string, string>, swtpm = true) =>
    renderDesiredState(NS, swtpm, "", "", results, null, null,
      undefined, undefined, undefined, { records });

  it("no record → create; record → verify; never a tpm_socket", () => {
    const state = render(new Map([["web", FP]]));
    const dns = state.instances.get("dns")!;
    const web = state.instances.get("web")!;

    assert.deepEqual(dns.shimTpm, { mode: "create" });
    assert.equal(podAnn(dns.deployment)[ANNOTATIONS.TPM_MODE], "create");
    assert.equal(podAnn(dns.deployment)[ANNOTATIONS.KATA_TPM_SOCKET], undefined);

    assert.deepEqual(web.shimTpm, { mode: "verify", fingerprint: FP });
    assert.equal(podAnn(web.deployment)[ANNOTATIONS.TPM_FINGERPRINT], FP);
    assert.equal(podAnn(web.deployment)[ANNOTATIONS.KATA_TPM_SOCKET], undefined);
  });

  it("recording one instance changes only that instance's deployment, not the generation", () => {
    const before = render(new Map());
    const after = render(new Map([["dns", FP]]));
    assert.equal(after.generation, before.generation);
    assert.deepEqual(after.instances.get("web")!.deployment, before.instances.get("web")!.deployment);
    assert.notDeepEqual(after.instances.get("dns")!.deployment, before.instances.get("dns")!.deployment);
  });

  it("swtpm disabled → no TPM at all", () => {
    const state = render(new Map([["dns", FP]]), false);
    for (const inst of state.instances.values()) {
      assert.equal(inst.shimTpm, undefined);
      assert.equal(podAnn(inst.deployment)[ANNOTATIONS.TPM_MODE], undefined);
      assert.equal(tpmVolume(inst.deployment), undefined);
    }
  });
});

describe("currentInstancePod", () => {
  const pod = (name: string, created: string, mode?: string, extra?: Partial<k8s.V1Pod>): k8s.V1Pod => ({
    metadata: {
      name, creationTimestamp: new Date(created),
      annotations: mode ? { [ANNOTATIONS.TPM_MODE]: mode } : {},
    },
    status: { phase: "Running" },
    ...extra,
  });

  it("prefers a live create-mode pod, ignores terminating/finished pods", () => {
    const terminating = pod("t", "2026-10-31T12:05:00Z", "create");
    terminating.metadata!.deletionTimestamp = new Date();
    const pods = [
      pod("old", "2026-10-31T11:00:00Z", "verify"),
      pod("create", "2026-10-31T12:00:00Z", "create"),
      terminating,
      pod("done", "2026-10-31T12:10:00Z", "create", { status: { phase: "Failed" } }),
    ];
    assert.equal(currentInstancePod(pods)?.metadata?.name, "create");
    assert.equal(currentInstancePod([pods[0]])?.metadata?.name, "old");
    assert.equal(currentInstancePod([terminating]), null);
  });

  it("otherwise picks the newest live pod (chronologically, not by string)", () => {
    // "Wed ..." < "Fri ..." as strings, but Friday's pod is older here.
    const older = pod("older", "2026-10-30T12:00:00Z", "verify"); // Friday
    const newer = pod("newer", "2026-11-04T12:00:00Z", "verify"); // Wednesday
    assert.equal(currentInstancePod([older, newer])?.metadata?.name, "newer");
    assert.equal(currentInstancePod([newer, older])?.metadata?.name, "newer");
  });
});
