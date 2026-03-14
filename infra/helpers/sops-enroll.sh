# Enroll a new node's SSH host key into .sops.yaml and create per-node secrets.
# Usage: seed-sops-enroll <hostname> <ssh-pubkey-file>
#
# Steps:
#   1. Convert SSH ed25519 pubkey to age recipient
#   2. Add age key anchor to .sops.yaml keys section
#   3. Add creation rule for secrets/<hostname>.yaml
#   4. Add the key to the seed-system-atl1.yaml creation rule
#   5. Create empty per-node secrets file (encrypted)

HOSTNAME="${1:?hostname required (e.g. seed-atl1-1)}"
PUBKEY_FILE="${2:?ssh pubkey file required}"
SOPS_YAML="${3:-.sops.yaml}"

if [ ! -f "$PUBKEY_FILE" ]; then
  echo "error: pubkey file not found: $PUBKEY_FILE" >&2
  exit 1
fi

# Convert SSH pubkey to age
AGE_KEY=$(ssh-to-age < "$PUBKEY_FILE")
echo "Age key for $HOSTNAME: $AGE_KEY"

# Generate anchor name: seed_atl1_1_age (replace - with _)
ANCHOR=$(echo "${HOSTNAME}_age" | tr '-' '_')

echo ""
echo "Add to .sops.yaml keys section:"
echo "  - &${ANCHOR} ${AGE_KEY}"
echo ""
echo "Add creation rule for secrets/${HOSTNAME}.yaml:"
echo "  - path_regex: secrets/${HOSTNAME}\\.yaml\$"
echo "    key_groups:"
echo "      - pgp:"
echo "          - *admin_josh"
echo "        age:"
echo "          - *${ANCHOR}"
echo ""
echo "Add *${ANCHOR} to the seed-system-atl1.yaml creation rule's age list."
echo ""
echo "Then create the per-node secrets file:"
echo "  sops secrets/${HOSTNAME}.yaml"
