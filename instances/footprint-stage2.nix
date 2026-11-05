# footprint-stage2.nix: stage 1 plus udevd and logind disabled.
{ lib, ... }:

{
  imports = [ ./footprint-stage1.nix ];

  systemd.services = lib.genAttrs [
    "systemd-udevd"
    "systemd-logind" # breaks login sessions
  ] (_: { enable = lib.mkForce false; });
}
