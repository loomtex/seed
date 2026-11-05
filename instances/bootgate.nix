# Seed bootgate instance — temporary boot-time measurement target
#
# Sized like the demo instances and deliberately unexposed (no Service, no
# DNS). Kata guests have no kubectl exec and the journal log streamer doesn't
# survive every boot, so metrics go to a per-boot file in the instance's guest
# TPM dir, readable from any node. Remove once the single-store-mount gate has
# been decided.
{ pkgs, ... }:

{
  seed.size = "xs";

  services.nginx.enable = true;

  # Type=simple on purpose: boot isn't finished until the job queue drains, so a
  # oneshot waiting on is-system-running would deadlock against itself.
  systemd.services.bootgate = {
    wantedBy = [ "multi-user.target" ];
    after = [ "multi-user.target" ];
    path = [ pkgs.coreutils pkgs.gawk pkgs.gnugrep pkgs.systemd ];
    script = ''
      exec >>"/seed/tpm/bootgate-$(cat /proc/sys/kernel/random/boot_id).log" 2>&1

      sample() {
        echo "BOOTGATE $1" \
          "wall=$(date +%s.%N)" \
          "uptime=$(cut -d' ' -f1 /proc/uptime)" \
          "mounts=$(wc -l < /proc/self/mountinfo)" \
          "spec_store_mounts=$(grep -c ' /nix/store/' /proc/self/mountinfo)" \
          "below_store=$(awk '$5 ~ "^/nix/store/"' /proc/self/mountinfo | wc -l)" \
          "at_store=$(awk '$5 == "/nix/store"' /proc/self/mountinfo | wc -l)" \
          "mount_units=$(systemctl list-units --type=mount --all --no-legend | wc -l)" \
          "units=$(systemctl list-units --all --no-legend | wc -l)"
      }

      state=$(systemctl is-system-running --wait)
      sample "finished state=$state"

      for unit in -.slice local-fs.target sysinit.target basic.target multi-user.target; do
        echo "BOOTGATE target unit=$unit" \
          "$(systemctl show -p ActiveEnterTimestampMonotonic -- "$unit")"
      done
      echo "BOOTGATE manager" \
        $(systemctl show -p UserspaceTimestampMonotonic -p FinishTimestampMonotonic)
      echo "BOOTGATE analyze $(systemd-analyze 2>&1 | head -1)"
      echo "BOOTGATE failed $(systemctl --failed --no-legend | awk '{print $2}' | tr '\n' ' ')"
      systemd-analyze blame --no-pager 2>&1 | head -12 | sed 's/^/BOOTGATE blame /'
      systemd-analyze critical-chain --no-pager 2>&1 | head -14 | sed 's/^/BOOTGATE chain /'

      # Submounts keep appearing after boot, so sample again once it settles.
      sleep 60
      sample settled
    '';
  };
}
