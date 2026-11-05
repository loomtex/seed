# footprint.nix: a bare Seed instance that logs its own footprint.
#
# It runs no workload, so it measures the platform baseline. Stats are written
# at 1 minute and 5 minutes after init starts, to show startup and settled use.
# Add `imports = [ ./footprint.nix ];` to another instance to measure that one.
{ pkgs, ... }:

{
  seed.size = "xs";

  systemd.timers.seed-footprint = {
    description = "Log guest footprint after startup";
    wantedBy = [ "timers.target" ];
    timerConfig.OnStartupSec = [ "1min" "5min" ];
  };

  systemd.services.seed-footprint = {
    description = "Log guest footprint";
    path = with pkgs; [ coreutils findutils gawk gnugrep systemd util-linux ];
    environment.SYSTEMD_COLORS = "0";
    serviceConfig.Type = "oneshot";

    script = ''
      set +e

      section() { echo; echo "=== $1 ==="; }

      section "uptime seconds"
      cut -d' ' -f1 /proc/uptime

      section "boot"
      systemd-analyze time
      systemd-analyze blame | head -n 30
      systemd-analyze critical-chain

      section "units"
      systemctl list-units --all --no-legend | wc -l
      systemctl list-units --type=service --state=running --no-legend --plain
      systemctl list-units --type=timer --no-legend --plain
      systemctl list-units --failed --no-legend --plain

      section "guest memory"
      cat /proc/meminfo

      section "filesystems"
      df -h / /run /tmp
      journalctl --disk-usage

      section "processes by pss (kB)"
      for p in /proc/[0-9]*; do
        name=$(cat "$p/comm" 2>/dev/null) || continue
        awk -v name="$name" -v pid="''${p#/proc/}" '
          /^Rss:/ { rss = $2 }
          /^Pss:/ { pss = $2 }
          END { if (rss > 0) printf "%d %d %s %s\n", pss, rss, pid, name }
        ' "$p/smaps_rollup" 2>/dev/null
      done | sort -n | awk '
        { print; total += $1 }
        END { printf "total_pss_kb %d\n", total }
      '

      section "cgroups by memory.current (bytes)"
      find /sys/fs/cgroup -maxdepth 4 -name memory.current 2>/dev/null |
        while read -r f; do
          printf '%s %s\n' "$(cat "$f" 2>/dev/null)" "$(dirname "$f")"
        done | sort -n | tail -n 30

      section "end"
    '';
  };
}
