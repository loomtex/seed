# tpm-backfill — record the TPM fingerprint of an existing (host-agent era)
# instance TPM state, after proving the instance's age identity still
# decrypts against it. Migration step before opting an instance in to
# shim-owned swtpm (seed.controller.shimSwtpm).
#
# Packaged by flake.nix as `tpm-backfill` (writeShellApplication supplies
# PATH and `set -euo pipefail`). Run as root on a seed node:
#
#   nix run .#tpm-backfill -- <namespace> <instance>                 # check + print
#   nix run .#tpm-backfill -- --write-status <namespace> <instance>  # + record SeedTPM
#
# What it does, never touching the live state:
#   1. copies <state-dir>/tpm2-00.permall into a private scratch dir;
#   2. starts a scratch swtpm on the copy (dir backend) exposed through
#      tpm_vtpm_proxy as a kernel TPM device;
#   3. computes the fingerprint: CreatePrimary(owner, ECC P-256 SRK template,
#      unique = 2x32 zero bytes), sha256 of the marshaled TPMT_PUBLIC (the
#      TPM2B_PUBLIC from tpm2_readpublic -f tss minus its 2-byte size), and
#      cross-checks it against the object Name (0x000b || sha256);
#   4. in a private mount namespace binds the scratch device over
#      /dev/tpmrm0 (age-plugin-tpm hard-codes that path), encrypts a test
#      message to the identity's recipient and decrypts it with the identity;
#   5. prints "<ns>/<instance> OK <fingerprint>" only if that round trip
#      succeeds, else "<ns>/<instance> BROKEN <reason>" (exit 2).
#
# --fingerprint-only skips steps 2/4's kernel device (scratch swtpm on a unix
# socket instead, no root needed) and the identity check; its output is
# marked UNVERIFIED and can't be combined with --write-status.
#
# Exit codes: 0 OK, 1 usage/environment error, 2 instance BROKEN,
#             3 SeedTPM already records a different fingerprint.

STATE_BASE=/var/lib/seed-controller/tpm
SRK_ATTRS='fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda|restricted|decrypt'

usage() {
  cat >&2 <<'EOF'
usage: tpm-backfill [--write-status] [--fingerprint-only] [--state-dir DIR] [--keep-scratch]
                    <namespace> <instance>

Computes the TPM fingerprint of an instance's existing TPM state (on a scratch
copy) and verifies the instance's age identity decrypts against it.

  --write-status      record the fingerprint in SeedTPM <instance> (kubectl);
                      refuses to change an already recorded, different value
  --fingerprint-only  no root, no identity check; output is UNVERIFIED
  --state-dir DIR     default /var/lib/seed-controller/tpm/<namespace>-<instance>
  --keep-scratch      keep the scratch dir (for debugging)
EOF
  exit 1
}

die() { echo "tpm-backfill: $*" >&2; exit 1; }
log() { echo "tpm-backfill: $*" >&2; }

write_status=0
fingerprint_only=0
keep_scratch=0
state_dir=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --write-status) write_status=1 ;;
    --fingerprint-only) fingerprint_only=1 ;;
    --keep-scratch) keep_scratch=1 ;;
    --state-dir) [ $# -ge 2 ] || usage; state_dir="$2"; shift ;;
    -h|--help) usage ;;
    -*) die "unknown option $1" ;;
    *) args+=("$1") ;;
  esac
  shift
done
[ "${#args[@]}" -eq 2 ] || usage
ns="${args[0]}"
inst="${args[1]}"
name_re='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
[[ "$ns" =~ $name_re ]] || die "invalid namespace: $ns"
[[ "$inst" =~ $name_re ]] || die "invalid instance: $inst"
key="$ns/$inst"
canonical_dir="$STATE_BASE/$ns-$inst"
[ -n "$state_dir" ] || state_dir="$canonical_dir"
if [ "$fingerprint_only" = 1 ] && [ "$write_status" = 1 ]; then
  die "--write-status requires the identity check (drop --fingerprint-only)"
fi
if [ "$write_status" = 1 ] && [ "$state_dir" != "$canonical_dir" ]; then
  die "--write-status only records the live state dir $canonical_dir (not $state_dir)"
fi

broken() {
  echo "$key BROKEN $*"
  exit 2
}

[ -d "$state_dir" ] || die "no state dir $state_dir"
[ -f "$state_dir/tpm2-00.permall" ] || die "no $state_dir/tpm2-00.permall"
if [ "$fingerprint_only" = 0 ]; then
  [ "$(id -u)" = 0 ] || die "must run as root (tpm_vtpm_proxy + mount namespace); or use --fingerprint-only"
  # Shim-path instances keep it in guest/ (the only part their VM sees);
  # host-agent instances still have it at the state dir root.
  if [ -f "$state_dir/guest/age-identity" ]; then
    identity="$state_dir/guest/age-identity"
  elif [ -f "$state_dir/age-identity" ]; then
    identity="$state_dir/age-identity"
  else
    broken "no age-identity in $state_dir or $state_dir/guest"
  fi
fi

scratch="$(mktemp -d /tmp/tpm-backfill.XXXXXXXX)"
chmod 700 "$scratch"
swtpm_pid=""
cleanup() {
  if [ -n "$swtpm_pid" ]; then
    kill "$swtpm_pid" 2>/dev/null || true
    wait "$swtpm_pid" 2>/dev/null || true
  fi
  if [ "$keep_scratch" = 1 ]; then log "scratch kept at $scratch"; else rm -rf "$scratch"; fi
}
trap cleanup EXIT

# --- 1. copy the state (never written back) ---
# The seed backend replaces permall atomically (temp file + rename), but take
# the copy twice-checked anyway so a concurrent write can't give a torn copy.
mkdir "$scratch/state"
for _ in 1 2 3; do
  before="$(sha256sum < "$state_dir/tpm2-00.permall")"
  cp "$state_dir/tpm2-00.permall" "$scratch/state/tpm2-00.permall"
  copied="$(sha256sum < "$scratch/state/tpm2-00.permall")"
  after="$(sha256sum < "$state_dir/tpm2-00.permall")"
  [ "$before" = "$copied" ] && [ "$copied" = "$after" ] && break
  copied=""
  sleep 1
done
[ -n "$copied" ] || die "permall kept changing while copying; is something writing it?"
if [ "$fingerprint_only" = 0 ]; then
  cp "$identity" "$scratch/age-identity"
fi

# --- 2. scratch swtpm ---
if [ "$fingerprint_only" = 1 ]; then
  swtpm socket --tpm2 --tpmstate dir="$scratch/state" \
    --server type=unixio,path="$scratch/tpm.sock" \
    --ctrl type=unixio,path="$scratch/tpm.sock.ctrl" \
    --flags not-need-init,startup-clear \
    --log file="$scratch/swtpm.log",level=1 > "$scratch/swtpm.out" 2>&1 &
  swtpm_pid=$!
  for _ in $(seq 50); do [ -S "$scratch/tpm.sock" ] && break; sleep 0.1; done
  [ -S "$scratch/tpm.sock" ] || die "scratch swtpm did not start (see $scratch/swtpm.log with --keep-scratch)"
  tcti="swtpm:path=$scratch/tpm.sock"
else
  modprobe tpm_vtpm_proxy
  swtpm chardev --vtpm-proxy --tpm2 --tpmstate dir="$scratch/state" \
    --ctrl type=unixio,path="$scratch/ctrl.sock" \
    --log file="$scratch/swtpm.log",level=1 > "$scratch/swtpm.out" 2>&1 &
  swtpm_pid=$!
  dev=""
  for _ in $(seq 100); do
    dev="$(sed -n 's|^New TPM device: /dev/tpm\([0-9][0-9]*\) .*|\1|p' "$scratch/swtpm.out")"
    [ -n "$dev" ] && break
    kill -0 "$swtpm_pid" 2>/dev/null || break
    sleep 0.1
  done
  [ -n "$dev" ] || die "scratch swtpm (vtpm-proxy) did not create a device: $(cat "$scratch/swtpm.out")"
  rmdev="/dev/tpmrm$dev"
  for _ in $(seq 50); do [ -c "$rmdev" ] && break; sleep 0.1; done
  [ -c "$rmdev" ] || die "$rmdev did not appear"
  log "scratch TPM at $rmdev"
  tcti="device:$rmdev"
fi

# --- 3. fingerprint ---
log "computing SRK fingerprint ($tcti)"
unset TPM2TOOLS_TCTI TCTI
head -c 64 /dev/zero | timeout 60 tpm2_createprimary -T "$tcti" -Q -C o -g sha256 -G ecc256:aes128cfb \
  -a "$SRK_ATTRS" -u - -c "$scratch/srk.ctx" \
  || broken "CreatePrimary(SRK) failed on the scratch TPM"
timeout 60 tpm2_readpublic -T "$tcti" -c "$scratch/srk.ctx" -f tss -o "$scratch/srk.pub" -n "$scratch/srk.name" > /dev/null \
  || broken "ReadPublic(SRK) failed"
timeout 60 tpm2_flushcontext -T "$tcti" -t > /dev/null 2>&1 || true

pub_size="$(stat -c %s "$scratch/srk.pub")"
prefix="$(od -An -tu1 -N2 "$scratch/srk.pub" | awk '{print $1 * 256 + $2}')"
[ "$prefix" -eq $((pub_size - 2)) ] || die "unexpected TPM2B_PUBLIC encoding (size $prefix, file $pub_size)"
fingerprint="$(tail -c +3 "$scratch/srk.pub" | sha256sum | cut -d' ' -f1)"
name_hex="$(od -An -v -tx1 "$scratch/srk.name" | tr -d ' \n')"
[ "$name_hex" = "000b$fingerprint" ] || die "fingerprint/Name cross-check failed: $fingerprint vs $name_hex"
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || die "bad fingerprint $fingerprint"

if [ "$fingerprint_only" = 1 ]; then
  echo "$key UNVERIFIED $fingerprint"
  exit 0
fi

# --- 4. identity round trip against the same scratch TPM ---
recipient="$(sed -n 's/^# Recipient: *\(age1[0-9a-z]*\) *$/\1/p' "$scratch/age-identity" | head -n1)"
nonce="$(date -u +%s%N)-$$"
printf 'seed tpm-backfill %s %s\n' "$key" "$nonce" > "$scratch/plain"

# Runs in a private mount namespace: the bind over /dev/tpmrm0 is invisible
# to the rest of the node.
cat > "$scratch/check.sh" <<'EOS'
set -eu
exec < /dev/null
rmdev="$1"; scratch="$2"; recipient="$3"
if [ "$rmdev" != /dev/tpmrm0 ]; then
  [ -e /dev/tpmrm0 ] || { echo "no /dev/tpmrm0 to bind over (scratch device is $rmdev)" >&2; exit 10; }
  mount --bind "$rmdev" /dev/tpmrm0
fi
if [ -z "$recipient" ]; then
  recipient="$(timeout 60 age-plugin-tpm -y "$scratch/age-identity")" || exit 11
fi
timeout 60 age -r "$recipient" -o "$scratch/test.age" "$scratch/plain" || exit 12
echo "decrypting test message" >&2
timeout -k 5 60 age -d -i "$scratch/age-identity" -o "$scratch/decrypted" "$scratch/test.age" || exit 13
EOS
# No controlling tty, no stdin, output to files only: when the identity
# doesn't match the TPM, age-plugin-tpm can fall back to asking for a PIN,
# and age would wait on a terminal forever. Each step also has a timeout,
# and nothing in here may keep the caller's stdout/stderr open.
log "checking age identity against the scratch TPM"
set +e
timeout -k 5 180 setsid --wait unshare --mount --propagation private -- \
  bash "$scratch/check.sh" "$rmdev" "$scratch" "$recipient" \
  < /dev/null > "$scratch/check.out" 2> "$scratch/check.err"
rc=$?
set -e
case "$rc" in
  0) ;;
  124|137) broken "identity check timed out: $(tr '\n' ' ' < "$scratch/check.err")" ;;
  10) die "$(cat "$scratch/check.err")" ;;
  11) broken "could not derive a recipient from age-identity: $(tr '\n' ' ' < "$scratch/check.err")" ;;
  12) broken "could not encrypt to the identity's recipient: $(tr '\n' ' ' < "$scratch/check.err")" ;;
  13) broken "age-identity does not decrypt against this TPM state: $(tr '\n' ' ' < "$scratch/check.err")" ;;
  *) die "identity check failed (rc=$rc): $(cat "$scratch/check.err")" ;;
esac
cmp -s "$scratch/plain" "$scratch/decrypted" || broken "decrypted test message does not match"

echo "$key OK $fingerprint"

# --- 5. optional: record in SeedTPM ---
[ "$write_status" = 1 ] || exit 0

# --- 5a. prepare the guest dir for the shim path ---
# On the shim path the VM mounts only <state-dir>/guest at /seed/tpm, never the
# state dir (which holds the TPM's unencrypted state). Copy the verified
# identity there so seed-tpm-init finds it instead of generating a new one; the
# original stays at the root for rollback and for EST's fallback lookup.
if [ ! -f "$state_dir/guest/age-identity" ]; then
  install -d -m 0755 "$state_dir/guest"
  cp -p "$state_dir/age-identity" "$state_dir/guest/age-identity"
  log "copied age-identity into $state_dir/guest/ for the shim path"
fi

if [ -z "${KUBECONFIG:-}" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi
existing="$(kubectl get seedtpm -n "$ns" "$inst" -o 'jsonpath={.status.fingerprint}' 2>/dev/null || true)"
if [ -n "$existing" ]; then
  if [ "$existing" = "$fingerprint" ]; then
    log "SeedTPM $key already records $fingerprint"
    exit 0
  fi
  log "SeedTPM $key already records a DIFFERENT fingerprint $existing; not changing it"
  exit 3
fi
if ! kubectl get seedtpm -n "$ns" "$inst" > /dev/null 2>&1; then
  kubectl create -f - > /dev/null <<EOF
apiVersion: seed.loom.farm/v1alpha1
kind: SeedTPM
metadata:
  name: $inst
  namespace: $ns
  labels:
    seed.loom.farm/managed-by: seed
    seed.loom.farm/instance: $inst
spec: {}
EOF
fi
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kubectl patch seedtpm -n "$ns" "$inst" --subresource=status --type=merge -p \
  "{\"status\":{\"fingerprint\":\"$fingerprint\",\"createdAt\":\"$created_at\",\"stateDir\":\"$state_dir\",\"source\":\"backfill\"}}" > /dev/null
log "recorded SeedTPM $key = $fingerprint"
