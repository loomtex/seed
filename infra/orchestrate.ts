import { execFileSync, execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import type { NodeConfig } from "./types.ts";
import {
  sshToAge,
  addNodeToSops,
  encryptSecrets,
  reencryptSecrets,
  updateLuksRecovery,
} from "./sops.ts";
import { createClevisJWE, generateLuksPassphrase } from "./clevis.ts";

interface SSHKeyPair {
  privateKey: string;
  publicKey: string;
}

interface ProvisionResult {
  luksPassphrase: string;
  agePublicKey: string;
}

// Generate an SSH key pair. Returns the key material as strings.
function generateSSHKeys(
  comment: string,
  type: "ed25519" | "rsa" = "ed25519"
): SSHKeyPair {
  const tmpDir = mkdtempSync(join(tmpdir(), "ssh-"));
  const keyPath = join(tmpDir, "key");

  const args = ["-t", type, "-C", comment, "-f", keyPath, "-N", ""];
  if (type === "rsa") {
    args.push("-b", "4096");
  }
  execFileSync("ssh-keygen", args, { stdio: "pipe" });

  const privateKey = execFileSync("cat", [keyPath], { encoding: "utf-8" });
  const publicKey = execFileSync("cat", [`${keyPath}.pub`], {
    encoding: "utf-8",
  });

  rmSync(tmpDir, { recursive: true });

  return { privateKey: privateKey.trim(), publicKey: publicKey.trim() };
}

// Wait for SSH to become available on a host.
// If sshProxy is set, tests connectivity through the proxy.
function waitForSSH(
  ip: string,
  { timeout = 600, port = 22, sshProxy, user = "root" }: { timeout?: number; port?: number; sshProxy?: string; user?: string } = {}
): void {
  const deadline = Date.now() + timeout * 1000;
  const baseOpts = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=5",
  ];

  const sshArgs = sshProxy
    ? [...baseOpts, sshProxy, `ssh ${baseOpts.join(" ")} -p ${port} ${user}@${ip} true`]
    : [...baseOpts, "-p", String(port), `${user}@${ip}`, "true"];

  while (Date.now() < deadline) {
    try {
      execFileSync("ssh", sshArgs, { stdio: "pipe", timeout: 15_000 });
      return;
    } catch {
      // Retry after a short delay
      execFileSync("sleep", ["5"]);
    }
  }
  throw new Error(`SSH to ${ip}:${port} not available after ${timeout}s`);
}

// Wait for SSH to go down (indicates reboot in progress).
function waitForSSHDown(
  ip: string,
  { timeout = 120 }: { timeout?: number } = {}
): void {
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    try {
      execFileSync(
        "ssh",
        [
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=3",
          `root@${ip}`,
          "true",
        ],
        { stdio: "pipe", timeout: 8_000 }
      );
      // Still up — wait and retry
      execFileSync("sleep", ["3"]);
    } catch {
      // SSH failed — host is going down
      return;
    }
  }
  pulumi.log.warn(`SSH to ${ip} did not go down within ${timeout}s`);
}

// Prepare the extra-files directory for nixos-anywhere.
// Layout matches mynix impermanence configuration:
//   /persist/etc/ssh/ssh_host_{ed25519,rsa}_key{,.pub}
//   /persist/secrets/initrd/ssh_host_ed25519_key{,.pub}
//   /persist/secrets/clevis-cryptroot.jwe
//   /persist/seed/server-addr  (joining nodes only)
function prepareExtraFiles(args: {
  hostEd25519: SSHKeyPair;
  hostRsa: SSHKeyPair;
  initrdKey: SSHKeyPair;
  clevisJWE: string;
  serverAddr?: string; // k3s server URL for joining nodes
}): string {
  const dir = mkdtempSync(join(tmpdir(), "extra-files-"));

  // Host SSH keys → /persist/etc/ssh/
  const sshDir = join(dir, "persist", "etc", "ssh");
  mkdirSync(sshDir, { recursive: true });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key"), args.hostEd25519.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key.pub"), args.hostEd25519.publicKey + "\n", { mode: 0o644 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key"), args.hostRsa.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key.pub"), args.hostRsa.publicKey + "\n", { mode: 0o644 });

  // Initrd SSH key → /persist/secrets/initrd/
  const initrdDir = join(dir, "persist", "secrets", "initrd");
  mkdirSync(initrdDir, { recursive: true });
  writeFileSync(join(initrdDir, "ssh_host_ed25519_key"), args.initrdKey.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(initrdDir, "ssh_host_ed25519_key.pub"), args.initrdKey.publicKey + "\n", { mode: 0o644 });

  // Clevis JWE → /persist/secrets/
  const secretsDir = join(dir, "persist", "secrets");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "clevis-cryptroot.jwe"), args.clevisJWE + "\n", { mode: 0o600 });

  // Server addr for joining nodes → /persist/seed/server-addr
  if (args.serverAddr) {
    const seedDir = join(dir, "persist", "seed");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, "server-addr"), args.serverAddr, { mode: 0o644 });
  }

  return dir;
}

// Verify node health after nixos-anywhere install + reboot.
// Uses current Unix user (not root) since nodes have PermitRootLogin=no.
function verifyNodeHealth(ip: string, label: string): void {
  const user = userInfo().username;
  const sshCmd = (cmd: string) =>
    execFileSync(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        cmd,
      ],
      { encoding: "utf-8", timeout: 30_000 }
    ).trim();

  // Check hostname
  const hostname = sshCmd("hostname");
  if (hostname !== label) {
    pulumi.log.warn(`Expected hostname ${label}, got ${hostname}`);
  }

  // Check LUKS is active
  const luks = sshCmd("sudo ls /dev/mapper/cryptroot 2>/dev/null && echo ok || echo missing");
  if (!luks.includes("ok")) {
    throw new Error(`LUKS device not active on ${label}`);
  }

  // Check SSH host key fingerprint
  const fingerprint = sshCmd(
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
  );
  pulumi.log.info(`${label} SSH fingerprint: ${fingerprint}`);
}

// Compute the /23 CIDR for an IPv4 address (Vultr bare metal subnets).
function ipToSubnet23(ip: string): string {
  const parts = ip.split(".").map(Number);
  // /23 means the third octet's LSB is masked out
  parts[2] = parts[2] & 0xfe;
  parts[3] = 0;
  return `${parts.join(".")}/23`;
}

// Add a node's subnet to the Tang allowlist (node-subnets.nix).
// Idempotent: skips if the subnet is already listed.
function addTangSubnet(mynixDir: string, ip: string, comment: string): void {
  const subnetsFile = join(mynixDir, "machines", "seed-tang-1", "node-subnets.nix");
  const content = readFileSync(subnetsFile, "utf-8");
  const subnet = ipToSubnet23(ip);

  if (content.includes(subnet)) {
    return; // Already listed
  }

  // Insert before the closing bracket
  const newLine = `  "${subnet}"   # ${comment}`;
  const updated = content.replace(/\n\]/, `\n${newLine}\n]`);
  writeFileSync(subnetsFile, updated);
}

// Update Tang's runtime IPAddressAllow to include a new subnet.
// SSHes to tang-1 and adds a systemd drop-in so the change takes effect
// immediately without rebuilding tang-1.
function updateTangRuntime(tangUrl: string, nodeIp: string, sshProxy?: string): void {
  const subnet = ipToSubnet23(nodeIp);
  const tangHost = new URL(tangUrl).hostname;
  const user = userInfo().username;

  // SSH to tang-1 to add a runtime drop-in.
  // If sshProxy is set, jump through it (tang may be firewalled from signi).
  const dropinDir = "/run/systemd/system/tangd.socket.d";
  const safeName = subnet.replace(/[./]/g, "-");
  const dropinContent = `[Socket]\\nIPAddressAllow=${subnet}`;

  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
  ];
  if (sshProxy) {
    sshBase.push("-J", sshProxy);
  }
  const sshTarget = `${user}@${tangHost}`;

  // Check if the subnet is already allowed (skip if so)
  try {
    const existing = execFileSync("ssh", [
      ...sshBase,
      sshTarget,
      `sudo systemctl show tangd.socket -p IPAddressAllow`,
    ], { encoding: "utf-8", timeout: 15_000 }).trim();

    if (existing.includes(subnet.split("/")[0])) {
      pulumi.log.info(`Tang already allows ${subnet}, skipping runtime update`);
      return;
    }
  } catch {
    // Can't check — proceed with the update anyway
  }

  execFileSync("ssh", [
    ...sshBase,
    sshTarget,
    `sudo mkdir -p ${dropinDir} && printf '${dropinContent}' | sudo tee ${dropinDir}/${safeName}.conf > /dev/null && sudo systemctl daemon-reload && sudo systemctl restart tangd.socket`,
  ], { stdio: "pipe", timeout: 30_000 });
  pulumi.log.info(`Tang updated: ${subnet} now allowed (runtime drop-in)`);
}

// Attempt LUKS unlock via initrd SSH (port 2222).
// Used as fallback when first-boot auto-unlock fails.
function unlockLuksViaInitrd(ip: string, passphrase: string): void {
  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-p", "2222",
  ];

  pulumi.log.info(`Attempting LUKS unlock via initrd SSH at ${ip}:2222`);

  // systemd-tty-ask-password-agent in --watch mode reads from stdin
  // We pipe the passphrase to it
  execSync(
    `echo -n ${shellQuote(passphrase)} | ssh ${sshBase.join(" ")} root@${ip} "systemd-tty-ask-password-agent"`,
    { stdio: "pipe", timeout: 30_000 }
  );
  pulumi.log.info(`LUKS passphrase sent via initrd SSH`);
}

// Wait for k3s API server to be ready on a node.
function waitForK3s(ip: string, timeout = 300): void {
  const user = userInfo().username;
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    try {
      execFileSync("ssh", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        "sudo k3s kubectl get nodes",
      ], { stdio: "pipe", timeout: 15_000 });
      return;
    } catch {
      execFileSync("sleep", ["5"]);
    }
  }
  throw new Error(`k3s not ready on ${ip} after ${timeout}s`);
}

// Fetch k3s token from a running cluster node.
function fetchK3sToken(ip: string): string {
  const user = userInfo().username;
  const token = execFileSync(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `${user}@${ip}`,
      "sudo cat /var/lib/rancher/k3s/server/token",
    ],
    { encoding: "utf-8", timeout: 15_000 }
  ).trim();
  if (!token.startsWith("K10")) {
    throw new Error(`Unexpected k3s token format from ${ip}: ${token.slice(0, 20)}...`);
  }
  return token;
}

// Generate a random k3s cluster token (for init node bootstrapping).
function generateK3sToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

// Configure the S3 binary cache on the iPXE installer so nixos-anywhere's
// --build-on-remote can pull pre-built derivations instead of compiling from source.
// Also sets up a post-build-hook to push newly-built paths, so the first node's
// builds are available for subsequent nodes.
function configureBinaryCache(ip: string, config: NodeConfig): void {
  if (!config.cacheBucket || !config.cacheEndpoint || !config.cachePublicKey) {
    pulumi.log.info(`${config.name}: no binary cache configured, skipping`);
    return;
  }

  pulumi.log.info(`${config.name}: configuring binary cache on installer`);

  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
  ];
  const ssh = (cmd: string) =>
    execFileSync("ssh", [...sshBase, `root@${ip}`, cmd], {
      stdio: "pipe",
      timeout: 30_000,
    });

  // Decrypt S3 credentials from sops
  const seedSystemFile = join(config.mynixDir, "secrets", "seed-system.yaml");
  const accessKey = execFileSync(
    "sops",
    ["--decrypt", "--extract", '["seed"]["s3-access-key"]', seedSystemFile],
    { encoding: "utf-8", cwd: config.mynixDir }
  ).trim();
  const secretKey = execFileSync(
    "sops",
    ["--decrypt", "--extract", '["seed"]["s3-secret-key"]', seedSystemFile],
    { encoding: "utf-8", cwd: config.mynixDir }
  ).trim();

  const cacheUrl = `s3://${config.cacheBucket}?endpoint=${config.cacheEndpoint}&region=us-east-1&profile=default`;

  // Decrypt signing key for push
  let signingKey: string | undefined;
  try {
    signingKey = execFileSync(
      "sops",
      ["--decrypt", "--extract", '["seed"]["cache-signing-key"]', seedSystemFile],
      { encoding: "utf-8", cwd: config.mynixDir }
    ).trim();
  } catch {
    pulumi.log.warn(`${config.name}: could not decrypt cache signing key, push disabled`);
  }

  // Write AWS credentials on remote
  ssh(
    `mkdir -p /root/.aws && cat > /root/.aws/credentials << 'CREDS'\n[default]\naws_access_key_id=${accessKey}\naws_secret_access_key=${secretKey}\nCREDS`
  );

  // NixOS netboot has /etc/nix/nix.conf as a read-only symlink into the nix store.
  // Replace it with a mutable copy so we can append substituter/hook config.
  ssh(`cp --remove-destination $(readlink -f /etc/nix/nix.conf) /etc/nix/nix.conf`);

  // Configure nix substituter on remote
  ssh(
    `cat >> /etc/nix/nix.conf << 'NIX'\nextra-substituters = ${cacheUrl}\nextra-trusted-public-keys = ${config.cachePublicKey}\nNIX`
  );

  // If we have a signing key, set up post-build-hook for push
  if (signingKey) {
    ssh(`cat > /root/.cache-signing-key << 'KEY'\n${signingKey}\nKEY\nchmod 600 /root/.cache-signing-key`);
    // Write the post-build-hook script
    ssh(
      `cat > /root/upload-to-cache << 'HOOK'\n#!/bin/sh\nset -eu\nset -f\nexport AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials\nexport AWS_EC2_METADATA_DISABLED=true\nnix store sign --key-file /root/.cache-signing-key $OUT_PATHS\nnix copy --to '${cacheUrl}' $OUT_PATHS\nHOOK\nchmod +x /root/upload-to-cache`
    );
    ssh(
      `cat >> /etc/nix/nix.conf << 'NIX'\npost-build-hook = /root/upload-to-cache\nNIX`
    );
  }

  // Set AWS env for nix-daemon and restart
  ssh(
    [
      `mkdir -p /run/systemd/system/nix-daemon.service.d`,
      `cat > /run/systemd/system/nix-daemon.service.d/cache.conf << 'DROPIN'\n[Service]\nEnvironment=AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials\nEnvironment=AWS_EC2_METADATA_DISABLED=true\nDROPIN`,
      `systemctl daemon-reload`,
      `systemctl restart nix-daemon`,
    ].join(" && ")
  );

  pulumi.log.info(`${config.name}: binary cache configured (pull + ${signingKey ? "push" : "pull-only"})`);
}

// Full provisioning workflow for a single node.
// Runs synchronously (called inside pulumi.output.apply).
export function provisionNode(
  ip: string,
  config: NodeConfig
): ProvisionResult {
  pulumi.log.info(`Provisioning ${config.name} at ${ip}...`);

  // Check if node is already provisioned and healthy — skip if so.
  // This makes the provisioner idempotent (safe to re-run after failures).
  try {
    verifyNodeHealth(ip, config.name);
    pulumi.log.info(`${config.name}: already provisioned and healthy, skipping`);
    const user = userInfo().username;
    const existingPubKey = execFileSync(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        "cat /etc/ssh/ssh_host_ed25519_key.pub",
      ],
      { encoding: "utf-8", timeout: 15_000 }
    ).trim();
    const agePublicKey = sshToAge(existingPubKey);
    return { luksPassphrase: "", agePublicKey };
  } catch {
    pulumi.log.info(`${config.name}: not yet provisioned, proceeding`);
  }

  // 0. Add node's subnet to Tang allowlist (permanent + runtime)
  pulumi.log.info(`${config.name}: updating Tang allowlist with ${ip}`);
  addTangSubnet(config.mynixDir, ip, config.name);
  updateTangRuntime(config.tangUrl, ip, config.sshProxy);

  // 1. Generate SSH host keys
  pulumi.log.info(`${config.name}: generating SSH host keys`);
  const hostEd25519 = generateSSHKeys(`root@${config.name}`, "ed25519");
  const hostRsa = generateSSHKeys(`root@${config.name}`, "rsa");
  const initrdKey = generateSSHKeys(`initrd@${config.name}`, "ed25519");

  // 2. Derive age public key from ed25519 host key
  const agePublicKey = sshToAge(hostEd25519.publicKey);
  pulumi.log.info(`${config.name}: age key = ${agePublicKey}`);

  // 3. Update .sops.yaml with node's age key
  pulumi.log.info(`${config.name}: updating sops configuration`);
  const sopsYamlPath = join(config.mynixDir, ".sops.yaml");
  addNodeToSops(sopsYamlPath, config.name, agePublicKey);

  // 4. Get or generate k3s token + create per-node secrets file
  pulumi.log.info(`${config.name}: creating node secrets`);
  let k3sToken: string;
  if (config.clusterInit) {
    k3sToken = generateK3sToken();
    pulumi.log.info(`${config.name}: generated new k3s cluster token`);
  } else if (config.initNodeIp) {
    k3sToken = fetchK3sToken(config.initNodeIp);
    pulumi.log.info(`${config.name}: fetched k3s token from init node ${config.initNodeIp}`);
  } else {
    throw new Error(`${config.name}: joining node requires initNodeIp to fetch k3s token`);
  }
  encryptSecrets(config.mynixDir, `secrets/${config.name}.yaml`, {
    "seed/k3s-token": k3sToken,
  });

  // 5. Re-encrypt seed-system.yaml so the new node can decrypt shared secrets
  pulumi.log.info(`${config.name}: re-encrypting seed-system.yaml`);
  reencryptSecrets(config.mynixDir, "secrets/seed-system.yaml");

  // 6. Generate LUKS passphrase + Clevis JWE
  pulumi.log.info(`${config.name}: creating LUKS passphrase + Clevis JWE`);
  const luksPassphrase = generateLuksPassphrase();
  const clevisJWE = createClevisJWE(luksPassphrase, config.tangUrl, config.sshProxy);

  // 7. Store LUKS passphrase in sops-encrypted recovery file + commit all secrets
  pulumi.log.info(`${config.name}: storing LUKS recovery passphrase`);
  updateLuksRecovery(config.mynixDir, config.name, luksPassphrase);
  execSync(
    `cd ${shellQuote(config.mynixDir)} && git add .sops.yaml secrets/ machines/seed-tang-1/node-subnets.nix && git commit -m "infra: add secrets + sops config for ${config.name}" && git push`,
    { stdio: "pipe", timeout: 30_000 }
  );

  // 8. Prepare extra-files
  pulumi.log.info(`${config.name}: preparing extra-files`);

  // Joining nodes: write server-addr so k3s knows which server to join.
  // Uses the reserved IPv4 if available (stable across reprovisioning),
  // otherwise falls back to the init node's ephemeral IP.
  let serverAddr: string | undefined;
  if (!config.clusterInit && (config.reservedIpv4 || config.initNodeIp)) {
    const joinIp = config.reservedIpv4 || config.initNodeIp!;
    serverAddr = `https://${joinIp}:6443`;
  }

  const extraDir = prepareExtraFiles({
    hostEd25519,
    hostRsa,
    initrdKey,
    clevisJWE,
    serverAddr,
  });

  // Write LUKS passphrase to temp file for nixos-anywhere
  const passFile = join(extraDir, ".luks-pass");
  writeFileSync(passFile, luksPassphrase, { mode: 0o600 });

  // 9. Wait for iPXE instance SSH
  pulumi.log.info(`${config.name}: waiting for iPXE instance SSH at ${ip}`);
  waitForSSH(ip, { timeout: 600 });

  // 9b. Configure binary cache on the installer (pull + push)
  configureBinaryCache(ip, config);

  // 10. Run nixos-anywhere
  pulumi.log.info(`${config.name}: running nixos-anywhere`);
  execSync(
    [
      "nixos-anywhere",
      "--flake",
      config.flakeRef,
      "--build-on-remote",
      "--disk-encryption-keys",
      "/tmp/disk-password",
      passFile,
      "--extra-files",
      extraDir,
      "--phases",
      "disko,install,reboot",
      `root@${ip}`,
    ].join(" "),
    {
      stdio: "inherit",
      timeout: 1800_000, // 30 minutes
      env: {
        ...process.env,
        // tarball-ttl=0 forces nix to re-fetch the flake from GitHub,
        // ensuring the just-pushed secrets/sops changes are included in the build.
        NIX_CONFIG: "experimental-features = nix-command flakes\ntarball-ttl = 0",
      },
    }
  );

  // 11. Wait for reboot + verify (with initrd LUKS fallback)
  pulumi.log.info(`${config.name}: waiting for reboot`);
  waitForSSHDown(ip, { timeout: 120 });
  pulumi.log.info(`${config.name}: waiting for post-install SSH`);
  try {
    // First, try waiting for normal SSH (port 22) — if Clevis auto-unlock
    // worked, the system boots fully and SSH comes up directly.
    waitForSSH(ip, { timeout: 180, user: userInfo().username });
  } catch {
    // Normal SSH didn't come up — likely stuck at LUKS prompt in initrd.
    // Fall back to unlocking via initrd SSH (port 2222).
    pulumi.log.info(`${config.name}: normal SSH timeout, trying initrd LUKS unlock`);
    try {
      waitForSSH(ip, { timeout: 120, port: 2222, user: "root" });
      unlockLuksViaInitrd(ip, luksPassphrase);
      pulumi.log.info(`${config.name}: LUKS unlocked via initrd, waiting for full boot`);
    } catch (e) {
      pulumi.log.warn(`${config.name}: initrd SSH also failed — may need manual LUKS unlock`);
    }
    waitForSSH(ip, { timeout: 300, user: userInfo().username });
  }

  pulumi.log.info(`${config.name}: verifying health`);
  verifyNodeHealth(ip, config.name);

  // 12. For init node: wait for k3s API and create seed-cluster-config ConfigMap
  //     with reserved IPs so the controller can configure MetalLB.
  if (config.clusterInit && (config.reservedIpv4 || config.reservedIpv6)) {
    pulumi.log.info(`${config.name}: waiting for k3s API`);
    waitForK3s(ip, 300);

    const user = userInfo().username;
    const sshCmd = (cmd: string) =>
      execFileSync("ssh", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        cmd,
      ], { stdio: "pipe", timeout: 30_000 });

    const literals: string[] = [];
    if (config.reservedIpv4) literals.push(`--from-literal=SEED_IPV4_ADDRESS=${config.reservedIpv4}`);
    if (config.reservedIpv6) literals.push(`--from-literal=SEED_IPV6_BLOCK=${config.reservedIpv6}`);

    sshCmd(`sudo k3s kubectl create namespace seed-system --dry-run=client -o yaml | sudo k3s kubectl apply -f -`);
    sshCmd(`sudo k3s kubectl create configmap seed-cluster-config -n seed-system ${literals.join(" ")} --dry-run=client -o yaml | sudo k3s kubectl apply -f -`);

    // Restart controller if it started before ConfigMap existed
    try {
      sshCmd(`sudo k3s kubectl rollout restart deployment/seed-controller -n seed-system 2>/dev/null`);
    } catch {
      // Controller deployment may not exist yet — that's fine, it'll pick up the ConfigMap on first start
    }
    pulumi.log.info(`${config.name}: seed-cluster-config ConfigMap created`);
  }

  // Cleanup
  rmSync(extraDir, { recursive: true });

  pulumi.log.info(`${config.name}: provisioning complete`);

  return { luksPassphrase, agePublicKey };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
