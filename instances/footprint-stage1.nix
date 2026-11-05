# footprint-stage1.nix: footprint.nix with the first round of unit trimming.
{ lib, ... }:

{
  imports = [ ./footprint.nix ];

  services.logrotate.enable = false;

  systemd.services = lib.genAttrs [
    "systemd-journal-catalog-update"
    "systemd-update-done"
    "lastlog2-import"
  ] (_: { enable = lib.mkForce false; });

  systemd.sockets = lib.genAttrs [
    "systemd-udevd-control"
    "systemd-udevd-kernel"
  ] (_: { enable = false; });
}
