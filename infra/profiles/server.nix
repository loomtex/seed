{ pkgs, ... }: {
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  environment.systemPackages = with pkgs; [
    ethtool
    gnupg
    htop
    jq
    lshw
    nvd
    pciutils
    wget
    usbutils
  ];
}
