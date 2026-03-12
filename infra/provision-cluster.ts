#!/usr/bin/env npx tsx
//
// provision-cluster.ts — Event-driven cluster provisioning
//
// Runs on the stake VM. Provisions machines in dependency order:
//   Phase 1: puncher (tang + DNS) — Debian VM, detected via SSH polling
//   Phase 2: BM nodes (LUKS + k3s) — iPXE-booted, detected via phone-home
//
// Usage:
//   npx tsx provision-cluster.ts                          # Read manifest from Pulumi stack output
//   npx tsx provision-cluster.ts --manifest manifest.json # Read manifest from file
//   npx tsx provision-cluster.ts --puncher-only           # Only provision puncher
//   npx tsx provision-cluster.ts --nodes-only             # Only provision nodes (puncher already done)
//

import { watch, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { provisionNode } from "./orchestrate.ts";
import { provisionTang } from "./provision-tang.ts";
import type { ClusterManifest, NodeConfig } from "./types.ts";

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "ConnectTimeout=5",
];

function waitForSSH(ip: string, timeout = 600, users = ["root"]): void {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    for (const user of users) {
      try {
        execFileSync("ssh", [...SSH_OPTS, `${user}@${ip}`, "true"], {
          stdio: "pipe",
          timeout: 15_000,
        });
        return;
      } catch {
        // try next user or sleep
      }
    }
    execFileSync("sleep", ["5"]);
  }
  throw new Error(`SSH to ${ip} not available after ${timeout}s`);
}

// Quick SSH probe — returns the user that succeeded, or null.
function probeSSH(ip: string, users: string[]): string | null {
  for (const user of users) {
    try {
      execFileSync("ssh", [...SSH_OPTS, `${user}@${ip}`, "true"], {
        stdio: "pipe",
        timeout: 10_000,
      });
      return user;
    } catch {
      // try next user
    }
  }
  return null;
}

function reinstallBareMetal(apiKey: string, bmId: string): void {
  log(`Triggering Vultr reinstall for bare metal ${bmId}`);
  execFileSync("curl", [
    "-sf", "-X", "POST",
    `https://api.vultr.com/v2/bare-metals/${bmId}/reinstall`,
    "-H", `Authorization: Bearer ${apiKey}`,
    "-H", "Content-Type: application/json",
  ], { stdio: "pipe", timeout: 30_000 });
}

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
  // Use VPC IP for Tang — BMs access it over the internal network
  const tangUrl = `http://${manifest.puncher.internalIp}:${manifest.puncherPort}`;

  log(`Provisioning node ${n.name} at ${n.ip}`);

  const nodeConfig: NodeConfig = {
    name: n.name,
    region: "", // not needed post-Pulumi
    plan: "",
    flakeRef: n.flakeRef,
    tangUrl,
    sshProxy: `ada@${manifest.puncher.ip}`, // Proxy Tang adv fetch through puncher (stake not in VPC)
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

  // --- Phase 1: Puncher (Debian VM — detected via SSH polling) ---

  let puncherDone = nodesOnly; // skip puncher if --nodes-only

  if (!puncherDone) {
    log(`Waiting for puncher SSH at ${manifest.puncher.ip}...`);
    waitForSSH(manifest.puncher.ip, 600, ["root", "ada"]);
    log(`Puncher SSH available — provisioning`);
    provisionPuncher(manifest, vultrApiKey ? vultrApiKeyFile : undefined);
    puncherDone = true;
  }

  if (puncherOnly || manifest.nodes.length === 0) {
    log("All machines provisioned");
    return;
  }

  // --- Phase 2: BM nodes (iPXE — detected via phone-home registrations) ---

  const nodesDone = new Set<number>();

  // Process a phone-home registration from an iPXE-booted BM
  const processRegistration = (reg: Registration): void => {
    const match = matchRegistration(reg, manifest);
    if (!match || match.type === "puncher") {
      if (!match) log(`Unknown registration from ${reg.ip} (MAC: ${reg.mac}) — ignoring`);
      return;
    }

    if (nodesDone.has(match.index)) return;

    const node = manifest.nodes[match.index];

    // Ensure dependency order: clusterInit node must be done before joining nodes
    if (!node.clusterInit) {
      const initIndex = manifest.nodes.findIndex((n) => n.clusterInit);
      if (initIndex >= 0 && !nodesDone.has(initIndex)) {
        log(`${node.name}: waiting for init node ${manifest.nodes[initIndex].name} to be provisioned first`);
        return; // Will be retried when init node completes
      }
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
  };

  // Scan existing registrations (machines that registered before we started)
  log(`Scanning existing registrations in ${REGISTER_DIR}...`);
  for (const reg of scanExistingRegistrations()) {
    processRegistration(reg);
  }

  if (nodesDone.size >= manifest.nodes.length) {
    log("All machines provisioned");
    return;
  }

  // Probe pending BM nodes via SSH to handle restarts after partial failures.
  // If the node is already provisioned (SSH as current user) or still in kexec
  // (SSH as root), we can proceed without waiting for a phone-home.
  const currentUser = userInfo().username;
  for (let i = 0; i < manifest.nodes.length; i++) {
    if (nodesDone.has(i)) continue;
    const n = manifest.nodes[i];
    log(`Probing ${n.name} at ${n.ip}...`);
    const user = probeSSH(n.ip, [currentUser, "root"]);
    if (user) {
      log(`${n.name}: SSH reachable as ${user} — proceeding`);
      // Create a synthetic registration so processRegistration handles dependency ordering
      processRegistration({ mac: "probe", ip: n.ip, serial: "probe" });
    } else if (n.bmId && vultrApiKey) {
      log(`${n.name}: unreachable — triggering Vultr reinstall`);
      try {
        reinstallBareMetal(vultrApiKey, n.bmId);
      } catch (err) {
        log(`${n.name}: reinstall failed (may already be in progress): ${err}`);
      }
    } else {
      log(`${n.name}: unreachable, waiting for phone-home`);
    }
  }

  if (nodesDone.size >= manifest.nodes.length) {
    log("All machines provisioned");
    return;
  }

  log(`Waiting for ${manifest.nodes.length - nodesDone.size} more node(s) to register...`);

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

      if (nodesDone.size >= manifest.nodes.length) {
        log("All machines provisioned");
        watcher.close();
        resolve();
      }
    });

    // Safety timeout: 2 hours
    setTimeout(() => {
      log(`Timeout: ${nodesDone.size}/${manifest.nodes.length} nodes provisioned`);
      watcher.close();
      if (nodesDone.size >= manifest.nodes.length) {
        resolve();
      } else {
        reject(new Error(`Timed out waiting for nodes: ${manifest.nodes.length - nodesDone.size} remaining`));
      }
    }, 2 * 60 * 60 * 1000);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
