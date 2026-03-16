{ pkgs, ... }: {
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  environment.systemPackages = with pkgs; [
    curl
    dig
    ethtool
    gnupg
    htop
    jq
    lshw
    nvd
    openssl
    pciutils
    python3
    strace
    tcpdump
    tree
    usbutils
    wget
  ];
}
