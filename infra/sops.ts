import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Derive an age public key from an SSH ed25519 public key using ssh-to-age.
export function sshToAge(sshPubKey: string): string {
  const result = execFileSync("ssh-to-age", {
    input: sshPubKey,
    encoding: "utf-8",
  });
  return result.trim();
}

// Add a node's age key to .sops.yaml and create/update the per-node
// creation rule. Operates on the mynix repo's .sops.yaml.
export function addNodeToSops(
  sopsYamlPath: string,
  nodeName: string,
  ageKey: string
): void {
  let content = readFileSync(sopsYamlPath, "utf-8");

  // Anchor name: seed_dfw_1_age from seed-dfw-1
  const anchor = `&${nodeName.replace(/-/g, "_")}_age`;

  // Check if anchor already exists
  if (content.includes(anchor)) {
    // Update the existing key value
    const anchorRegex = new RegExp(
      `(${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+\\S+`
    );
    content = content.replace(anchorRegex, `${anchor} ${ageKey}`);
  } else {
    // Add new key entry after the last existing key in the keys section.
    // Find the last "  - &" line in the keys block and insert after it.
    const lines = content.split("\n");
    let lastKeyIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^\s+-\s+&\S+_age\s/)) {
        lastKeyIndex = i;
      }
    }
    if (lastKeyIndex >= 0) {
      lines.splice(lastKeyIndex + 1, 0, `  - ${anchor} ${ageKey}`);
      content = lines.join("\n");
    } else {
      throw new Error(
        `Could not find age key entries in ${sopsYamlPath} to insert after`
      );
    }
  }

  // Ensure a creation rule exists for this node's secrets file
  const secretsRegex = `secrets/${nodeName.replace(/-/g, "\\-")}\\.yaml\\$`;
  if (!content.includes(`path_regex: ${secretsRegex}`)) {
    // Find the "creation_rules:" section and add a rule
    const ruleRef = `*${nodeName.replace(/-/g, "_")}_age`;
    const newRule = [
      "",
      `  - path_regex: secrets/${nodeName}\\.yaml$`,
      "    key_groups:",
      "      - pgp:",
      "          - *admin_josh",
      "        age:",
      `          - ${ruleRef}`,
    ].join("\n");

    // Insert before the seed-system rule or at the end of creation_rules
    const systemRuleIndex = content.indexOf(
      "path_regex: secrets/seed-system"
    );
    if (systemRuleIndex >= 0) {
      // Find the start of this rule block (the "  - " before it)
      const beforeSystem = content.lastIndexOf("\n  - ", systemRuleIndex);
      if (beforeSystem >= 0) {
        content =
          content.slice(0, beforeSystem) + newRule + content.slice(beforeSystem);
      }
    } else {
      // Append at end
      content += newRule + "\n";
    }
  }

  // Also add the node to the seed-system.yaml creation rule
  const nodeRef = `*${nodeName.replace(/-/g, "_")}_age`;
  const systemRuleMatch = content.match(
    /path_regex: secrets\/seed-system\.yaml\$[\s\S]*?(?=\n\s+-\s+path_regex|\n\s+#|\n$)/
  );
  if (systemRuleMatch && !systemRuleMatch[0].includes(nodeRef)) {
    // Find the last age key reference in the seed-system rule and add after it
    const systemStart =
      content.indexOf("path_regex: secrets/seed-system") ?? -1;
    if (systemStart >= 0) {
      const systemBlock = content.slice(systemStart);
      const lastAgeRef = systemBlock.lastIndexOf("          - *seed_");
      if (lastAgeRef >= 0) {
        const insertPos = systemStart + lastAgeRef;
        const lineEnd = content.indexOf("\n", insertPos);
        content =
          content.slice(0, lineEnd) +
          `\n          - ${nodeRef}` +
          content.slice(lineEnd);
      }
    }
  }

  writeFileSync(sopsYamlPath, content);
}

// Encrypt a secrets file for a specific node using sops.
// The secrets object maps flat YAML keys to values.
export function encryptSecrets(
  sopsYamlDir: string,
  secretsFile: string,
  secrets: Record<string, string>
): void {
  // Build YAML content
  const yaml = Object.entries(secrets)
    .map(([key, value]) => {
      // Handle nested keys like "seed:\n  k3s-token:"
      const parts = key.split("/");
      if (parts.length === 1) {
        return `${key}: ${value}`;
      }
      // Nested: "seed/k3s-token" → "seed:\n    k3s-token: value"
      let result = "";
      for (let i = 0; i < parts.length - 1; i++) {
        result += "  ".repeat(i) + parts[i] + ":\n";
      }
      result +=
        "  ".repeat(parts.length - 1) + parts[parts.length - 1] + ": " + value;
      return result;
    })
    .join("\n");

  // Write plaintext, then encrypt in-place
  const fullPath = `${sopsYamlDir}/${secretsFile}`;
  writeFileSync(fullPath, yaml + "\n");

  execFileSync("sops", ["--encrypt", "--in-place", fullPath], {
    cwd: sopsYamlDir,
    stdio: "pipe",
  });
}

// Re-encrypt an existing secrets file (after adding a new key to .sops.yaml).
export function reencryptSecrets(
  sopsYamlDir: string,
  secretsFile: string
): void {
  const fullPath = `${sopsYamlDir}/${secretsFile}`;
  execFileSync("sops", ["updatekeys", "--yes", fullPath], {
    cwd: sopsYamlDir,
    stdio: "pipe",
  });
}

// Update the LUKS recovery sops file with a node's passphrase.
// The file is encrypted to josh's GPG key + ada's age key, so it's
// recoverable from either identity.
//
// Prerequisites:
//   - ada must have an age key at ~/.config/sops/age/keys.txt
//   - mynix .sops.yaml must have an &ada_age anchor referencing ada's public key
//
// If the file already exists, it's decrypted, updated, and re-encrypted.
// If it doesn't exist, it's created and encrypted.
export function updateLuksRecovery(
  mynixDir: string,
  nodeName: string,
  passphrase: string
): void {
  const recoveryFile = `${mynixDir}/secrets/luks-recovery.yaml`;
  const sopsYamlPath = `${mynixDir}/.sops.yaml`;

  // Ensure .sops.yaml has a creation rule for luks-recovery.yaml
  let sopsContent = readFileSync(sopsYamlPath, "utf-8");
  if (!sopsContent.includes("path_regex: secrets/luks-recovery\\.yaml")) {
    // Add rule encrypted to josh + ada's age key
    const newRule = [
      "",
      "  - path_regex: secrets/luks-recovery\\.yaml$",
      "    key_groups:",
      "      - pgp:",
      "          - *admin_josh",
      "        age:",
      "          - *ada_age",
    ].join("\n");

    // Insert before the fallback rule
    const fallbackIndex = sopsContent.indexOf("# Fallback");
    if (fallbackIndex >= 0) {
      const beforeFallback = sopsContent.lastIndexOf("\n  - ", fallbackIndex);
      if (beforeFallback >= 0) {
        sopsContent =
          sopsContent.slice(0, beforeFallback) +
          newRule +
          sopsContent.slice(beforeFallback);
      }
    } else {
      sopsContent += newRule + "\n";
    }
    writeFileSync(sopsYamlPath, sopsContent);
  }

  // Read existing secrets (if file exists and is encrypted)
  let secrets: Record<string, string> = {};
  if (existsSync(recoveryFile)) {
    try {
      const decrypted = execFileSync(
        "sops",
        ["--decrypt", recoveryFile],
        { encoding: "utf-8", cwd: mynixDir }
      );
      // Parse simple YAML key: value pairs
      for (const line of decrypted.split("\n")) {
        const match = line.match(/^(\S+):\s+(.+)$/);
        if (match) {
          secrets[match[1]] = match[2];
        }
      }
    } catch {
      // File exists but can't be decrypted — start fresh
    }
  }

  // Add/update the node's passphrase
  secrets[nodeName] = passphrase;

  // Write plaintext YAML
  const yaml = Object.entries(secrets)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  writeFileSync(recoveryFile, yaml + "\n");

  // Encrypt in-place
  execFileSync("sops", ["--encrypt", "--in-place", recoveryFile], {
    cwd: mynixDir,
    stdio: "pipe",
  });
}
