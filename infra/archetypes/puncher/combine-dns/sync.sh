#!/usr/bin/env bash
# combine-dns-sync: Poll Vultr API, update pdns records for combine.loom.farm
set -euo pipefail

VULTR_KEY=$(cat "$VULTR_API_KEY_FILE")
PDNS_KEY=$(cat "$PDNS_API_KEY_FILE")
PDNS_API="http://127.0.0.1:8081/api/v1/servers/localhost"
ZONE="combine.loom.farm."
ALIASES_FILE="${ALIASES_FILE:-/etc/combine-dns/aliases.json}"

# Fetch all hosts from Vultr
bm_json=$(curl -sf -H "Authorization: Bearer $VULTR_KEY" "https://api.vultr.com/v2/bare-metals?per_page=500")
vm_json=$(curl -sf -H "Authorization: Bearer $VULTR_KEY" "https://api.vultr.com/v2/instances?per_page=500")

# Transform Vultr hosts into DNS records.
# Naming: strip "seed-" prefix, split into <name>-<ordinal>.
# If name == region, hostname = seed-<ordinal>. Otherwise hostname = <name>-<ordinal>.
# Region becomes subdomain: <hostname>.<region>.combine.loom.farm
#
# IP selection: VPC IP if available, public IP as fallback.
records=$(echo "$bm_json" "$vm_json" | jq -s '
  def to_record:
    .label as $label |
    .region as $region |
    # Pick VPC/internal IP if available, else public
    (if .internal_ip != "" and .internal_ip != "0.0.0.0" then .internal_ip
     else .main_ip end) as $ip |
    # Strip "seed-" prefix
    ($label | ltrimstr("seed-")) as $stripped |
    # Split into name and ordinal: last segment after "-" that is a number
    ($stripped | split("-")) as $parts |
    (if ($parts | length) >= 2 and ($parts[-1] | test("^[0-9]+$"))
     then { name: ($parts[:-1] | join("-")), ordinal: $parts[-1] }
     else { name: $stripped, ordinal: "1" }
     end) as $parsed |
    # If name == region, use "seed" as hostname prefix
    (if $parsed.name == $region then "seed" else $parsed.name end) as $hostname_prefix |
    {
      fqdn: "\($hostname_prefix)-\($parsed.ordinal).\($region).\(env.ZONE)",
      ip: $ip,
      label: $label
    };
  # Exclude hosts being destroyed or suspended
  [
    (.[] | .bare_metals // [] | .[] | select(.status != "destroying" and .status != "suspended") | to_record),
    (.[] | .instances // [] | .[] | select(.status != "destroying" and .status != "suspended") | to_record)
  ] | map(select(.ip != null and .ip != ""))
  # Deduplicate by FQDN: prefer VPC/internal IPs (10.x) over public
  | group_by(.fqdn)
  | map(sort_by(if .ip | test("^10\\.") then 0 else 1 end) | first)
' --arg ZONE "$ZONE")

# Ensure zone exists (create if missing)
if ! curl -sf -H "X-API-Key: $PDNS_KEY" "$PDNS_API/zones/$ZONE" > /dev/null 2>&1; then
  echo "Creating zone $ZONE"
  curl -sf -X POST -H "X-API-Key: $PDNS_KEY" -H "Content-Type: application/json" \
    "$PDNS_API/zones" -d "{
      \"name\": \"$ZONE\",
      \"kind\": \"Native\",
      \"nameservers\": [\"ns1.$ZONE\"],
      \"rrsets\": [{
        \"name\": \"$ZONE\",
        \"type\": \"SOA\",
        \"ttl\": 3600,
        \"records\": [{\"content\": \"ns1.$ZONE hostmaster.$ZONE 1 10800 3600 604800 60\", \"disabled\": false}]
      }]
    }"
fi

# Build rrsets from Vultr records
rrsets=$(echo "$records" | jq '[.[] | {
  name: .fqdn,
  type: "A",
  ttl: 60,
  changetype: "REPLACE",
  records: [{ content: .ip, disabled: false }]
}]')

# Add static aliases (CNAMEs) from config file
if [ -f "$ALIASES_FILE" ]; then
  alias_rrsets=$(jq '[.[] | {
    name: (.name + "." + env.ZONE),
    type: "CNAME",
    ttl: 60,
    changetype: "REPLACE",
    records: [{ content: (.target + "." + env.ZONE), disabled: false }]
  }]' "$ALIASES_FILE")
  rrsets=$(echo "$rrsets" "$alias_rrsets" | jq -s 'add')
fi

# Collect all expected record names (A + CNAME)
expected_names=$(echo "$rrsets" | jq -r '.[].name' | sort -u)

# Fetch current zone records to find stale ones
current_records=$(curl -sf -H "X-API-Key: $PDNS_KEY" "$PDNS_API/zones/$ZONE" | \
  jq -r '.rrsets[] | select(.type == "A" or .type == "CNAME") | .name' | sort -u)

# Delete records that exist in pdns but not in our expected set
for name in $current_records; do
  if ! echo "$expected_names" | grep -qxF "$name"; then
    rrsets=$(echo "$rrsets" | jq --arg name "$name" '. + [
      { name: $name, type: "A", changetype: "DELETE" },
      { name: $name, type: "CNAME", changetype: "DELETE" }
    ]')
  fi
done

# Apply all changes in one PATCH
if [ "$(echo "$rrsets" | jq 'length')" -gt 0 ]; then
  curl -sf -X PATCH -H "X-API-Key: $PDNS_KEY" -H "Content-Type: application/json" \
    "$PDNS_API/zones/$ZONE" -d "{\"rrsets\": $rrsets}"
  echo "Updated $(echo "$rrsets" | jq 'length') rrsets"
else
  echo "No changes"
fi
