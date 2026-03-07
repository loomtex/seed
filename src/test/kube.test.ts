// Tests for shared/kube.ts — namespace derivation, generation hashing, waitFor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveNamespace, computeGeneration, waitFor } from "../shared/kube.js";

describe("deriveNamespace", () => {
  it("matches bash implementation for github:loomtex/seed", () => {
    // Known test vector from production: verified on seed-dfw-1
    const ns = deriveNamespace("github:loomtex/seed");
    assert.equal(ns, "s-gaydazldmnsg");
  });

  it("produces valid k8s namespace names", () => {
    const ns = deriveNamespace("github:example/repo");
    // k8s namespace: lowercase alphanumeric + hyphens, max 63 chars
    assert.match(ns, /^s-[a-z2-7]{12}$/);
  });

  it("is deterministic", () => {
    const a = deriveNamespace("github:foo/bar");
    const b = deriveNamespace("github:foo/bar");
    assert.equal(a, b);
  });

  it("produces different namespaces for different URIs", () => {
    const a = deriveNamespace("github:foo/bar");
    const b = deriveNamespace("github:foo/baz");
    assert.notEqual(a, b);
  });

  it("handles URIs with paths", () => {
    const ns = deriveNamespace("github:org/repo/subdir");
    assert.match(ns, /^s-[a-z2-7]{12}$/);
  });

  it("handles empty string (edge case)", () => {
    const ns = deriveNamespace("");
    assert.match(ns, /^s-[a-z2-7]{12}$/);
  });
});

describe("computeGeneration", () => {
  it("produces a 12-char hex hash", () => {
    const gen = computeGeneration(
      new Map([["web", "/nix/store/abc-seed-web"]]),
    );
    assert.match(gen, /^[0-9a-f]{12}$/);
  });

  it("is deterministic", () => {
    const instances = new Map([
      ["dns", "/nix/store/dns-image"],
      ["web", "/nix/store/web-image"],
    ]);
    const a = computeGeneration(instances);
    const b = computeGeneration(instances);
    assert.equal(a, b);
  });

  it("sorts by instance name", () => {
    // Order of insertion shouldn't matter
    const a = computeGeneration(
      new Map([
        ["web", "/nix/store/web"],
        ["dns", "/nix/store/dns"],
      ]),
    );
    const b = computeGeneration(
      new Map([
        ["dns", "/nix/store/dns"],
        ["web", "/nix/store/web"],
      ]),
    );
    assert.equal(a, b);
  });

  it("changes when an image path changes", () => {
    const a = computeGeneration(
      new Map([["web", "/nix/store/old-image"]]),
    );
    const b = computeGeneration(
      new Map([["web", "/nix/store/new-image"]]),
    );
    assert.notEqual(a, b);
  });

  it("changes when an instance is added", () => {
    const a = computeGeneration(
      new Map([["web", "/nix/store/web"]]),
    );
    const b = computeGeneration(
      new Map([
        ["web", "/nix/store/web"],
        ["dns", "/nix/store/dns"],
      ]),
    );
    assert.notEqual(a, b);
  });

  it("handles empty map", () => {
    const gen = computeGeneration(new Map());
    assert.match(gen, /^[0-9a-f]{12}$/);
  });
});

describe("waitFor", () => {
  it("returns true when condition is immediately met", async () => {
    const result = await waitFor(async () => true, 10, 100);
    assert.equal(result, true);
  });

  it("returns false on timeout", async () => {
    const result = await waitFor(async () => false, 10, 50);
    assert.equal(result, false);
  });

  it("polls until condition is met", async () => {
    let count = 0;
    const result = await waitFor(
      async () => {
        count++;
        return count >= 3;
      },
      10,
      1000,
    );
    assert.equal(result, true);
    assert.ok(count >= 3, `expected at least 3 calls, got ${count}`);
  });

  it("respects timeout even with slow condition", async () => {
    const start = Date.now();
    const result = await waitFor(
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return false;
      },
      10,
      80,
    );
    const elapsed = Date.now() - start;
    assert.equal(result, false);
    assert.ok(elapsed < 500, `took too long: ${elapsed}ms`);
  });
});
