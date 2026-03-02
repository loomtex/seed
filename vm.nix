{ pkgs, modulesPath, ... }:

{
  imports = [
    # Import qemu-vm directly — this config is only ever used as a VM.
    # Using vmVariant would require fileSystems."/" and boot.loader.grub.device.
    (modulesPath + "/virtualisation/qemu-vm.nix")
  ];

  seed.enable = true;

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  users.users.root = {
    initialHashedPassword = null;
    password = "root";
  };

  security.sudo.wheelNeedsPassword = false;

  services.openssh = {
    enable = true;
    settings.PermitRootLogin = "yes";
    settings.PasswordAuthentication = true;
  };

  environment.systemPackages = with pkgs; [
    bat
    cri-tools
    git
    jq
    kubectl
    tree
    vim
  ];

  virtualisation = {
    memorySize = 4096;
    cores = 4;
    graphics = false;
    diskImage = null;
    forwardPorts = [
      { from = "host"; host.port = 2222; guest.port = 22; }
      { from = "host"; host.port = 16443; guest.port = 6443; }
    ];
    # Nested KVM for Kata VMs inside this VM
    qemu.options = [ "-cpu host" "-enable-kvm" ];
  };

  networking.firewall.allowedTCPPorts = [ 22 6443 ];

  system.stateVersion = "25.11";
}
