#!/usr/bin/env npx tsx
//
// provision-cluster.ts — Event-driven cluster provisioning
//
// Runs on the stake VM. Watches for phone-home registrations from machines
// that iPXE-booted from stake's netboot endpoint. Matches registrations to
// the expected manifest (from Pulumi) and provisions in dependency order:
//   Phase 1: puncher (tang + DNS)
//   Phase 2: BM nodes (LUKS + k3s), clusterInit first
//
// Usage:
//   npx tsx provision-cluster.ts                          # Read manifest from Pulumi stack output
//   npx tsx provision-cluster.ts --manifest manifest.json # Read manifest from file
//   npx tsx provision-cluster.ts --puncher-only           # Only provision puncher
//   npx tsx provision-cluster.ts --nodes-only             # Only provision nodes (puncher already done)
//

import { watch, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { provisionNode } from "./orchestrate.ts";
import { provisionTang } from "./provision-tang.ts";
import type { ClusterManifest, NodeConfig } from "./types.ts";

const REGISTER_DIR = "/var/lib/seed-register";

interface Registration {
  mac: string;
  ip: string;
  serial: string;
  timestamp?: string;
}

// --- Manifest loading ---

function loadManifest(manifestPath?: string): ClusterManifest {
  if (manifestPath) {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  }
  // Read from Pulumi stack output
  const output = execSync("pulumi stack output manifest --json -s prod", {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return JSON.parse(output);
}

// --- Registration watching ---

function readRegistration(filePath: string): Registration | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function scanExistingRegistrations(): Registration[] {
  if (!existsSync(REGISTER_DIR)) return [];
  return readdirSync(REGISTER_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readRegistration(join(REGISTER_DIR, f)))
    .filter((r): r is Registration => r !== null);
}

// Match a registration to a manifest entry by IP address
function matchRegistration(
  reg: Registration,
  manifest: ClusterManifest
): { type: "puncher" } | { type: "node"; index: number } | null {
  if (reg.ip === manifest.puncher.ip) {
    return { type: "puncher" };
  }
  for (let i = 0; i < manifest.nodes.length; i++) {
    if (reg.ip === manifest.nodes[i].ip) {
      return { type: "node", index: i };
    }
  }
  return null;
}

// --- Provisioning ---

function provisionPuncher(manifest: ClusterManifest, vultrApiKeyFile?: string): void {
  const p = manifest.puncher;
  log(`Provisioning puncher ${p.name} at ${p.ip}`);
  provisionTang(p.ip, {
    name: p.name,
    flakeRef: p.flakeRef,
    mynixDir: manifest.mynixDir,
    vultrApiKeyFile,
  });
  log(`Puncher ${p.name} provisioned`);
}

function provisionBmNode(
  manifest: ClusterManifest,
  nodeIndex: number,
  initNodeIp?: string,
  vultrApiKey?: string,
): void {
  const n = manifest.nodes[nodeIndex];
  const tangUrl = `http://${manifest.puncher.ip}:${manifest.puncherPort}`;

  log(`Provisioning node ${n.name} at ${n.ip}`);

  const nodeConfig: NodeConfig = {
    name: n.name,
    region: "", // not needed post-Pulumi
    plan: "",
    flakeRef: n.flakeRef,
    tangUrl,
    sopsFile: manifest.sopsFile,
    mynixDir: manifest.mynixDir,
    clusterInit: n.clusterInit,
    initNodeIp,
    vultrBmId: n.bmId,
    reservedIpv4: manifest.reservedIpv4,
    reservedIpv6: manifest.reservedIpv6,
  };

  provisionNode(n.ip, nodeConfig, vultrApiKey);
  log(`Node ${n.name} provisioned`);
}

// --- Main ---

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let manifestPath: string | undefined;
  let puncherOnly = false;
  let nodesOnly = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest":
        manifestPath = args[++i];
        break;
      case "--puncher-only":
        puncherOnly = true;
        break;
      case "--nodes-only":
        nodesOnly = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  log("Loading manifest...");
  const manifest = loadManifest(manifestPath);
  log(`Manifest loaded: puncher=${manifest.puncher.name}, nodes=[${manifest.nodes.map((n) => n.name).join(", ")}]`);

  // Read Vultr API key (for BM reinstall fallback + puncher sops secrets).
  // Prefers VULTR_API_KEY env var, falls back to file.
  let vultrApiKey: string | undefined;
  const vultrApiKeyFile = "/tmp/workspace/vultr-api-key";
  vultrApiKey = process.env.VULTR_API_KEY;
  if (!vultrApiKey) {
    try {
      vultrApiKey = readFileSync(vultrApiKeyFile, "utf-8").trim();
    } catch {
      log("Warning: Vultr API key not available — BM reinstall fallback disabled");
    }
  }
  // Write key to file so provisionTang can read it for puncher's sops secrets
  if (vultrApiKey) {
    writeFileSync(vultrApiKeyFile, vultrApiKey, { mode: 0o600 });
  }

  // Track what's been provisioned
  let puncherDone = nodesOnly; // skip puncher if --nodes-only
  const nodesDone = new Set<number>();

  // Expected machines we need to see
  const expectedIps = new Set<string>();
  if (!puncherOnly && !nodesOnly) {
    expectedIps.add(manifest.puncher.ip);
    for (const n of manifest.nodes) expectedIps.add(n.ip);
  } else if (puncherOnly) {
    expectedIps.add(manifest.puncher.ip);
  } else {
    for (const n of manifest.nodes) expectedIps.add(n.ip);
  }

  const totalExpected = expectedIps.size;

  // Process a registration
  const processRegistration = (reg: Registration): void => {
    const match = matchRegistration(reg, manifest);
    if (!match) {
      log(`Unknown registration from ${reg.ip} (MAC: ${reg.mac}) — ignoring`);
      return;
    }

    if (match.type === "puncher") {
      if (puncherDone) return;
      provisionPuncher(manifest, vultrApiKey ? vultrApiKeyFile : undefined);
      puncherDone = true;
    } else {
      if (puncherOnly) return;
      if (nodesDone.has(match.index)) return;

      const node = manifest.nodes[match.index];

      // Ensure dependency order: clusterInit node must be done before joining nodes
      if (!node.clusterInit) {
        // Find the init node — it must be provisioned first
        const initIndex = manifest.nodes.findIndex((n) => n.clusterInit);
        if (initIndex >= 0 && !nodesDone.has(initIndex)) {
          log(`${node.name}: waiting for init node ${manifest.nodes[initIndex].name} to be provisioned first`);
          return; // Will be retried when init node completes
        }
      }

      // Wait for puncher to be done before provisioning nodes (Clevis needs Tang)
      if (!puncherDone) {
        log(`${node.name}: waiting for puncher to be provisioned first`);
        return;
      }

      // Find init node IP for joining nodes
      const initNode = manifest.nodes.find((n) => n.clusterInit);
      const initNodeIp = !node.clusterInit && initNode ? initNode.ip : undefined;

      provisionBmNode(manifest, match.index, initNodeIp, vultrApiKey);
      nodesDone.add(match.index);

      // After provisioning init node, retry any pending joining nodes
      if (node.clusterInit) {
        log("Init node done — retrying pending joining node registrations");
        for (const existing of scanExistingRegistrations()) {
          processRegistration(existing);
        }
      }
    }
  };

  // Scan existing registrations (machines that registered before we started)
  log(`Scanning existing registrations in ${REGISTER_DIR}...`);
  for (const reg of scanExistingRegistrations()) {
    processRegistration(reg);
  }

  // Check if we're already done
  const doneCount = (puncherDone ? 1 : 0) + nodesDone.size;
  if (doneCount >= totalExpected) {
    log("All machines provisioned");
    return;
  }

  log(`Waiting for ${totalExpected - doneCount} more machine(s) to register...`);

  // Watch for new registrations via inotify
  return new Promise<void>((resolve, reject) => {
    const watcher = watch(REGISTER_DIR, (eventType, filename) => {
      if (!filename?.endsWith(".json")) return;

      const reg = readRegistration(join(REGISTER_DIR, filename));
      if (!reg) return;

      log(`New registration: ${reg.ip} (MAC: ${reg.mac}, serial: ${reg.serial})`);

      try {
        processRegistration(reg);
      } catch (err) {
        log(`Error provisioning: ${err}`);
        watcher.close();
        reject(err);
        return;
      }

      // Check if we're done
      const done = (puncherDone ? 1 : 0) + nodesDone.size;
      if (done >= totalExpected) {
        log("All machines provisioned");
        watcher.close();
        resolve();
      }
    });

    // Safety timeout: 2 hours
    setTimeout(() => {
      const done = (puncherDone ? 1 : 0) + nodesDone.size;
      log(`Timeout: ${done}/${totalExpected} machines provisioned`);
      watcher.close();
      if (done >= totalExpected) {
        resolve();
      } else {
        reject(new Error(`Timed out waiting for machines: ${totalExpected - done} remaining`));
      }
    }, 2 * 60 * 60 * 1000);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
