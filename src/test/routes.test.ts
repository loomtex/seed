// Tests for controller/routes.ts — IPv4/IPv6 LoadBalancer service generation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateIPv4Services, generateIPv6Services } from "../controller/routes.js";
import type { IPv4Config, IPv6Config } from "../shared/types.js";

describe("generateIPv4Services", () => {
  const gen = "aabbccddee12";
  const ns = "s-test";
  const ip = "216.128.141.222";

  it("returns empty array when disabled", () => {
    const config: IPv4Config = { enable: false, routes: {} };
    const services = generateIPv4Services(config, ip, gen, ns);
    assert.deepEqual(services, []);
  });

  it("returns empty array when no IP address", () => {
    const config: IPv4Config = {
      enable: true,
      routes: { http: { port: 80, protocol: "tcp", instance: "web" } },
    };
    const services = generateIPv4Services(config, "", gen, ns);
    assert.deepEqual(services, []);
  });

  it("returns empty array when no routes", () => {
    const config: IPv4Config = { enable: true, routes: {} };
    const services = generateIPv4Services(config, ip, gen, ns);
    assert.deepEqual(services, []);
  });

  it("groups routes by instance into one LB service", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 80, protocol: "tcp", instance: "web" },
        https: { port: 443, protocol: "tcp", instance: "web" },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);

    assert.equal(services.length, 1);
    assert.equal(services[0].metadata?.name, "seed-web-ipv4");
    assert.equal(services[0].spec?.type, "LoadBalancer");
    assert.equal(services[0].spec?.loadBalancerIP, ip);
    assert.equal(services[0].spec?.ports?.length, 2);
  });

  it("creates separate services for different instances", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        dns: { port: 53, protocol: "dns", instance: "dns" },
        http: { port: 80, protocol: "tcp", instance: "web" },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);

    assert.equal(services.length, 2);
    const names = services.map((s) => s.metadata?.name).sort();
    assert.deepEqual(names, ["seed-dns-ipv4", "seed-web-ipv4"]);
  });

  it("handles DNS protocol with both TCP and UDP ports", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        dns: { port: 53, protocol: "dns", instance: "dns" },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);

    assert.equal(services.length, 1);
    const ports = services[0].spec?.ports;
    assert.equal(ports?.length, 2);

    const tcp = ports?.find((p) => p.protocol === "TCP");
    const udp = ports?.find((p) => p.protocol === "UDP");
    assert.ok(tcp);
    assert.ok(udp);
    assert.equal(tcp?.port, 53);
    assert.equal(udp?.port, 53);
  });

  it("uses targetPort when specified", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 80, protocol: "tcp", instance: "web", targetPort: 8080 },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);

    assert.equal(services[0].spec?.ports?.[0].port, 80);
    assert.equal(services[0].spec?.ports?.[0].targetPort, 8080);
  });

  it("defaults targetPort to port", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 443, protocol: "tcp", instance: "web" },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);

    assert.equal(services[0].spec?.ports?.[0].targetPort, 443);
  });

  it("sets correct MetalLB annotations", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 80, protocol: "tcp", instance: "web" },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);
    const svc = services[0];

    assert.equal(svc.metadata?.annotations?.["metallb.io/address-pool"], "seed-pool");
    assert.equal(svc.metadata?.annotations?.["metallb.io/allow-shared-ip"], "seed-ipv4");
  });

  it("uses IPv4 ipFamily and SingleStack policy", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 80, protocol: "tcp", instance: "web" },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);
    const svc = services[0];

    assert.deepEqual(svc.spec?.ipFamilies, ["IPv4"]);
    assert.equal(svc.spec?.ipFamilyPolicy, "SingleStack");
    assert.equal(svc.spec?.externalTrafficPolicy, "Cluster");
  });

  it("includes service-type label", () => {
    const config: IPv4Config = {
      enable: true,
      routes: {
        http: { port: 80, protocol: "tcp", instance: "web" },
      },
    };
    const services = generateIPv4Services(config, ip, gen, ns);

    assert.equal(
      services[0].metadata?.labels?.["seed.loom.farm/service-type"],
      "ipv4",
    );
  });
});

describe("generateIPv6Services", () => {
  const gen = "aabbccddee12";
  const ns = "s-test";

  const config: IPv6Config = {
    enable: true,
    block: "2001:19f0:6402:7eb::/64",
    routes: {
      dns: { host: "1", port: 53, protocol: "dns", instance: "dns" },
      http: { host: "3", port: 80, protocol: "tcp", instance: "web" },
    },
  };

  it("returns empty array when disabled", () => {
    const disabled: IPv6Config = { enable: false, block: "", routes: {} };
    const services = generateIPv6Services(disabled, gen, ns);
    assert.deepEqual(services, []);
  });

  it("returns empty array when no block", () => {
    const noBlock: IPv6Config = {
      enable: true,
      block: "",
      routes: { dns: { host: "1", port: 53, protocol: "dns", instance: "dns" } },
    };
    const services = generateIPv6Services(noBlock, gen, ns);
    assert.deepEqual(services, []);
  });

  it("creates one service per route (not per instance)", () => {
    const services = generateIPv6Services(config, gen, ns);
    assert.equal(services.length, 2);
  });

  it("names services with route key", () => {
    const services = generateIPv6Services(config, gen, ns);
    const names = services.map((s) => s.metadata?.name).sort();
    assert.deepEqual(names, ["seed-dns-ipv6", "seed-http-ipv6"]);
  });

  it("constructs loadBalancerIP from block + host", () => {
    const services = generateIPv6Services(config, gen, ns);

    const dnsSvc = services.find((s) => s.metadata?.name === "seed-dns-ipv6");
    assert.equal(dnsSvc?.spec?.loadBalancerIP, "2001:19f0:6402:7eb::1");

    const httpSvc = services.find((s) => s.metadata?.name === "seed-http-ipv6");
    assert.equal(httpSvc?.spec?.loadBalancerIP, "2001:19f0:6402:7eb::3");
  });

  it("uses IPv6 ipFamily and SingleStack policy", () => {
    const services = generateIPv6Services(config, gen, ns);

    for (const svc of services) {
      assert.deepEqual(svc.spec?.ipFamilies, ["IPv6"]);
      assert.equal(svc.spec?.ipFamilyPolicy, "SingleStack");
    }
  });

  it("handles DNS protocol with TCP+UDP ports", () => {
    const services = generateIPv6Services(config, gen, ns);
    const dnsSvc = services.find((s) => s.metadata?.name === "seed-dns-ipv6");

    assert.equal(dnsSvc?.spec?.ports?.length, 2);
    assert.ok(dnsSvc?.spec?.ports?.find((p) => p.protocol === "TCP"));
    assert.ok(dnsSvc?.spec?.ports?.find((p) => p.protocol === "UDP"));
  });

  it("includes service-type label", () => {
    const services = generateIPv6Services(config, gen, ns);
    for (const svc of services) {
      assert.equal(
        svc.metadata?.labels?.["seed.loom.farm/service-type"],
        "ipv6",
      );
    }
  });

  it("uses targetPort when specified", () => {
    const withTarget: IPv6Config = {
      enable: true,
      block: "2001:db8::/64",
      routes: {
        http: { host: "1", port: 80, protocol: "tcp", instance: "web", targetPort: 8080 },
      },
    };
    const services = generateIPv6Services(withTarget, gen, ns);
    assert.equal(services[0].spec?.ports?.[0].port, 80);
    assert.equal(services[0].spec?.ports?.[0].targetPort, 8080);
  });
});
