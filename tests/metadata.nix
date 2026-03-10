# Test Vultr metadata API parsing (jq expressions used by seed-derive-node-ip).
# No network access needed — uses canned JSON payloads.
# Run: nix build .#checks.x86_64-linux.metadata
{ pkgs }:

pkgs.runCommand "seed-metadata-test" {
  nativeBuildInputs = [ pkgs.jq ];
} ''
  set -euo pipefail
  pass=0
  fail=0

  check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
      echo "  PASS: $name"
      pass=$((pass + 1))
    else
      echo "  FAIL: $name — expected '$expected', got '$actual'"
      fail=$((fail + 1))
    fi
  }

  # The jq expressions from module.nix seed-derive-node-ip:
  IPV4_EXPR='first(.interfaces[] | select(.["network-type"] == "public") | .ipv4.address) // empty'
  IPV6_EXPR='first(.interfaces[] | select(.["network-type"] == "public") | .ipv6.address) // empty'

  echo "=== Test: standard dual-stack Vultr response ==="
  META='{"interfaces":[{"ipv4":{"address":"155.138.198.207","gateway":"155.138.198.1","netmask":"255.255.254.0"},"ipv6":{"address":"2001:19f0:5400:1c2a:3eec:efff:feb9:f2a8","network":"2001:19f0:5400:1c2a::","prefix":"64"},"mac":"3c:ec:ef:b9:f2:a8","network-type":"public"},{"ipv4":{"address":"10.0.0.3","gateway":"","netmask":"255.255.255.0"},"ipv6":{"address":"","network":"","prefix":""},"mac":"3c:ec:ef:b9:f2:a9","network-type":"private"}]}'
  IPV4=$(echo "$META" | jq -r "$IPV4_EXPR")
  IPV6=$(echo "$META" | jq -r "$IPV6_EXPR")
  check "ipv4 extracted" "155.138.198.207" "$IPV4"
  check "ipv6 extracted" "2001:19f0:5400:1c2a:3eec:efff:feb9:f2a8" "$IPV6"

  echo "=== Test: IPv4-only (no IPv6 on public interface) ==="
  META='{"interfaces":[{"ipv4":{"address":"45.76.1.2","gateway":"45.76.1.1","netmask":"255.255.254.0"},"ipv6":{"address":"","network":"","prefix":""},"mac":"aa:bb:cc:dd:ee:ff","network-type":"public"}]}'
  IPV4=$(echo "$META" | jq -r "$IPV4_EXPR")
  IPV6=$(echo "$META" | jq -r "$IPV6_EXPR")
  check "ipv4 extracted" "45.76.1.2" "$IPV4"
  check "ipv6 is empty" "" "$IPV6"

  echo "=== Test: no public interface ==="
  META='{"interfaces":[{"ipv4":{"address":"10.0.0.5","gateway":"","netmask":"255.255.255.0"},"ipv6":{"address":"","network":"","prefix":""},"mac":"aa:bb:cc:dd:ee:ff","network-type":"private"}]}'
  IPV4=$(echo "$META" | jq -r "$IPV4_EXPR")
  IPV6=$(echo "$META" | jq -r "$IPV6_EXPR")
  check "ipv4 is empty" "" "$IPV4"
  check "ipv6 is empty" "" "$IPV6"

  echo "=== Test: multiple public interfaces (picks first) ==="
  META='{"interfaces":[{"ipv4":{"address":"1.2.3.4","gateway":"1.2.3.1","netmask":"255.255.255.0"},"ipv6":{"address":"2001:db8::1","network":"2001:db8::","prefix":"64"},"mac":"aa:aa:aa:aa:aa:aa","network-type":"public"},{"ipv4":{"address":"5.6.7.8","gateway":"5.6.7.1","netmask":"255.255.255.0"},"ipv6":{"address":"2001:db8::2","network":"2001:db8::","prefix":"64"},"mac":"bb:bb:bb:bb:bb:bb","network-type":"public"}]}'
  IPV4=$(echo "$META" | jq -r "$IPV4_EXPR")
  IPV6=$(echo "$META" | jq -r "$IPV6_EXPR")
  check "ipv4 picks first public" "1.2.3.4" "$IPV4"
  check "ipv6 picks first public" "2001:db8::1" "$IPV6"

  echo "=== Test: node-config.yaml generation ==="
  # Simulate the full script logic
  META='{"interfaces":[{"ipv4":{"address":"10.20.30.40","gateway":"10.20.30.1","netmask":"255.255.254.0"},"ipv6":{"address":"fd00::1","network":"fd00::","prefix":"64"},"mac":"cc:cc:cc:cc:cc:cc","network-type":"public"}]}'
  IPV4=$(echo "$META" | jq -r "$IPV4_EXPR")
  IPV6=$(echo "$META" | jq -r "$IPV6_EXPR")
  if [ -n "$IPV6" ]; then
    LINE="node-ip: \"$IPV4,$IPV6\""
  else
    LINE="node-ip: \"$IPV4\""
  fi
  check "dual-stack config line" 'node-ip: "10.20.30.40,fd00::1"' "$LINE"

  # IPv4-only config line
  META='{"interfaces":[{"ipv4":{"address":"192.168.1.1","gateway":"192.168.1.1","netmask":"255.255.255.0"},"ipv6":{"address":"","network":"","prefix":""},"mac":"dd:dd:dd:dd:dd:dd","network-type":"public"}]}'
  IPV4=$(echo "$META" | jq -r "$IPV4_EXPR")
  IPV6=$(echo "$META" | jq -r "$IPV6_EXPR")
  if [ -n "$IPV6" ]; then
    LINE="node-ip: \"$IPV4,$IPV6\""
  else
    LINE="node-ip: \"$IPV4\""
  fi
  check "ipv4-only config line" 'node-ip: "192.168.1.1"' "$LINE"

  echo ""
  echo "=== Results: $pass passed, $fail failed ==="
  [ "$fail" -eq 0 ] || { echo "FAILED"; exit 1; }
  mkdir -p $out
  echo "ok" > $out/result
''
