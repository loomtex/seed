{ modulesPath, ... }:

{
  boot.initrd.availableKernelModules = [ "ahci" "xhci_pci" "virtio_pci" "virtio_blk" "virtio_scsi" "virtio_net" "sd_mod" "sr_mod" ];
  boot.kernelModules = [ "virtio_net" "virtio_blk" ];

  nixpkgs.hostPlatform = "x86_64-linux";
}
