// Tests for shared/labels.ts — label/annotation constants and helpers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LABEL_DOMAIN,
  LABELS,
  MANAGED_BY_VALUE,
  ANNOTATIONS,
  seedLabels,
  MANAGED_SELECTOR,
} from "../shared/labels.js";

describe("label constants", () => {
  it("uses seed.loom.farm domain", () => {
    assert.equal(LABEL_DOMAIN, "seed.loom.farm");
  });

  it("has correct label keys", () => {
    assert.equal(LABELS.MANAGED_BY, "seed.loom.farm/managed-by");
    assert.equal(LABELS.INSTANCE, "seed.loom.farm/instance");
    assert.equal(LABELS.GENERATION, "seed.loom.farm/generation");
    assert.equal(LABELS.SERVICE_TYPE, "seed.loom.farm/service-type");
  });

  it("managed-by value is 'seed'", () => {
    assert.equal(MANAGED_BY_VALUE, "seed");
  });
});

describe("annotation constants", () => {
  it("has correct MetalLB annotations", () => {
    assert.equal(ANNOTATIONS.ADDRESS_POOL, "metallb.io/address-pool");
    assert.equal(ANNOTATIONS.ALLOW_SHARED_IP, "metallb.io/allow-shared-ip");
  });

  it("has correct Kata annotations", () => {
    assert.equal(
      ANNOTATIONS.KATA_VCPUS,
      "io.katacontainers.config.hypervisor.default_vcpus",
    );
    assert.equal(
      ANNOTATIONS.KATA_MEMORY,
      "io.katacontainers.config.hypervisor.default_memory",
    );
    assert.equal(
      ANNOTATIONS.KATA_TPM_SOCKET,
      "io.katacontainers.config.hypervisor.tpm_socket",
    );
  });
});

describe("seedLabels", () => {
  it("returns managed-by, instance, and generation labels", () => {
    const labels = seedLabels("web", "abc123def456");
    assert.deepEqual(labels, {
      "seed.loom.farm/managed-by": "seed",
      "seed.loom.farm/instance": "web",
      "seed.loom.farm/generation": "abc123def456",
    });
  });

  it("works with different instance names", () => {
    const labels = seedLabels("dns", "gen1");
    assert.equal(labels["seed.loom.farm/instance"], "dns");
  });
});

describe("MANAGED_SELECTOR", () => {
  it("is a valid label selector string", () => {
    assert.equal(MANAGED_SELECTOR, "seed.loom.farm/managed-by=seed");
  });
});
