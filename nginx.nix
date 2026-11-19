# nginx with the HTTP/2 RCE fixes (CVE-2026-123633 use-after-free,
# CVE-2026-123007 send_window underflow). Affected through 1.31.8 / 1.30.6,
# fixed in 1.31.9 / 1.30.7. The locked nixos-25.11 only has 1.29.x mainline
# and 1.28.x stable, so override nginxMainline's src to 1.31.9 until the
# channel catches up. mkDefault so a module can still pick its own package.
{ config, lib, pkgs, ... }:

{
  services.nginx.package = lib.mkDefault (pkgs.nginxMainline.overrideAttrs (old: rec {
    version = "1.31.9";
    src = pkgs.fetchurl {
      url = "https://nginx.org/download/nginx-${version}.tar.gz";
      hash = "sha256-oRxe7uLiV/RHjw5kn4SwBAeH0nfS0+UjOVKqa23LgK0=";
    };
  }));

  warnings = lib.optional config.services.nginx.enable
    "TEMP PIN: nginx is nginxMainline overridden to 1.31.9 (CVE-2026-123633, CVE-2026-123007); drop seed's nginx.nix once the locked nixpkgs ships >= 1.31.9";
}
