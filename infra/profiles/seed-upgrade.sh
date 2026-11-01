# seed-upgrade.service — build this node's system from the infra flake and
# apply it: `switch` if no reboot is needed, `boot` (profile + bootloader,
# nothing activated) if the kernel/initrd/modules changed. Never reboots.
# Started by the upgrade agent (src/host-agent/upgrade.ts), which reads the
# outcome from /run/seed-upgrade/state:
#   { "outcome": "switched" | "reboot-required" | "failed",
#     "system": <store path>, "time": <iso>, "invocation": <id>, "error"?: <msg> }
#
# Env (from infra/profiles/seed-upgrade.nix):
#   SEED_UPGRADE_REPO  github owner/repo   (loomtex/seed)
#   SEED_UPGRADE_DIR   flake subdirectory  (infra)
#   SEED_UPGRADE_HOST  nixosConfigurations attribute (this host)

state_dir=/run/seed-upgrade
state="$state_dir/state"
mkdir -p "$state_dir"
rm -f "$state" "$state.tmp"

stage="init"
system=""

write_state() {
  local outcome="$1" error="${2:-}"
  jq -n \
    --arg outcome "$outcome" \
    --arg system "$system" \
    --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg invocation "${INVOCATION_ID:-}" \
    --arg error "$error" \
    '{outcome: $outcome, system: $system, time: $time, invocation: $invocation}
     + (if $error != "" then {error: $error} else {} end)' > "$state.tmp"
  mv "$state.tmp" "$state"
}

work="$(mktemp -d)"
on_exit() {
  local rc=$?
  if [ ! -e "$state" ]; then
    write_state failed "$stage failed (exit $rc)"
    echo "seed-upgrade: $stage failed (exit $rc)" >&2
  fi
  rm -rf "$work"
}
trap on_exit EXIT
cd "$work"

# Pin the revision once so build, classification and boot/switch all use the
# same commit even if the branch moves mid-run.
stage="resolve flake"
rev="$(nix flake metadata --json --refresh "github:$SEED_UPGRADE_REPO?dir=$SEED_UPGRADE_DIR" | jq -r '.locked.rev // empty')"
if [ -z "$rev" ]; then
  echo "could not resolve a locked revision for github:$SEED_UPGRADE_REPO" >&2
  exit 1
fi
ref="github:$SEED_UPGRADE_REPO/$rev?dir=$SEED_UPGRADE_DIR#$SEED_UPGRADE_HOST"
echo "seed-upgrade: building $ref"

stage="build"
nixos-rebuild build --flake "$ref" --refresh --option eval-cache false
system="$(readlink -f result)"
echo "seed-upgrade: built $system"

# Same rule as system.autoUpgrade.allowReboot.
stage="classify"
reboot=false
for f in kernel initrd kernel-modules; do
  if [ "$(readlink "/run/booted-system/$f")" != "$(readlink "$system/$f")" ]; then
    echo "seed-upgrade: $f differs from the booted system"
    reboot=true
  fi
done

# Reboot requested by the agent (seed.loom.farm/upgrade-reboot), e.g. for
# maintenance or to exercise the reboot path: install with `boot` and report
# reboot-required even though the kernel didn't change.
if [ -e "$state_dir/force-reboot" ]; then
  echo "seed-upgrade: reboot requested ($state_dir/force-reboot)"
  rm -f "$state_dir/force-reboot"
  reboot=true
fi

# Informational: would an in-place switch restart k3s?
if dry="$("$system/bin/switch-to-configuration" dry-activate 2>&1)"; then
  if grep -E '^would (stop|restart) .*k3s\.service' <<<"$dry" >/dev/null; then
    echo "seed-upgrade: dry-activate: k3s.service would be restarted/stopped"
  else
    echo "seed-upgrade: dry-activate: k3s.service would not be restarted"
  fi
else
  echo "seed-upgrade: dry-activate failed (informational only):"
  echo "$dry"
fi

if [ "$reboot" = true ]; then
  stage="nixos-rebuild boot"
  nixos-rebuild boot --flake "$ref" --option eval-cache false
  if [ "$(readlink -f /nix/var/nix/profiles/system)" != "$system" ]; then
    echo "system profile is $(readlink -f /nix/var/nix/profiles/system), expected $system" >&2
    exit 1
  fi
  write_state reboot-required
  echo "seed-upgrade: $system set as boot default, reboot required"
elif [ "$(readlink -f /run/current-system)" = "$system" ]; then
  write_state switched
  echo "seed-upgrade: already running $system"
else
  stage="nixos-rebuild switch"
  nixos-rebuild switch --flake "$ref" --option eval-cache false
  if [ "$(readlink -f /run/current-system)" != "$system" ]; then
    echo "current system is $(readlink -f /run/current-system), expected $system" >&2
    exit 1
  fi
  write_state switched
  echo "seed-upgrade: switched to $system"
fi
