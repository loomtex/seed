# Create a Clevis/Tang JWE for LUKS auto-unlock.
# Usage: seed-clevis-bind <tang-url> <passphrase-file> [output-file]
#
# Example:
#   seed-clevis-bind http://10.0.0.1:7654 /tmp/disk-password /tmp/clevis-cryptroot.jwe

TANG_URL="${1:?tang URL required (e.g. http://10.0.0.1:7654)}"
PASSPHRASE_FILE="${2:?passphrase file required}"
OUTPUT="${3:-/tmp/clevis-cryptroot.jwe}"

if [ ! -f "$PASSPHRASE_FILE" ]; then
  echo "error: passphrase file not found: $PASSPHRASE_FILE" >&2
  exit 1
fi

# Fetch Tang advertisement
echo "Fetching Tang advertisement from $TANG_URL..."
ADV=$(curl -sf "$TANG_URL/adv")
if [ -z "$ADV" ]; then
  echo "error: failed to fetch Tang advertisement" >&2
  exit 1
fi

echo "Tang advertisement received."

# Encrypt passphrase with Tang
cat "$PASSPHRASE_FILE" | clevis encrypt tang "{\"url\":\"$TANG_URL\"}" > "$OUTPUT"

echo "JWE written to: $OUTPUT"
echo ""
echo "Deploy to node:"
echo "  scp $OUTPUT <node>:/persist/secrets/clevis-cryptroot.jwe"
echo ""
echo "Then enable Clevis in the node's disks.nix:"
echo "  boot.initrd.clevis.enable = true;"
echo "  boot.initrd.clevis.devices.cryptroot.secretFile = \"/persist/secrets/clevis-cryptroot.jwe\";"
