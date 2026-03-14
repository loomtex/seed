# Vultr bare metal hardware: AHCI SATA, GRUB (BIOS+EFI), LUKS+btrfs, Clevis/Tang
{
  boot.initrd.availableKernelModules = [ "ahci" "xhci_pci" "sd_mod" "sr_mod" ];
  boot.kernelModules = [ "kvm-intel" ];

  nixpkgs.hostPlatform = "x86_64-linux";

  # GRUB: works from both BIOS and EFI installs (iPXE netboot is BIOS-only
  # on Vultr bare metal, so systemd-boot's bootctl install gets skipped).
  boot.loader.grub = {
    enable = true;
    efiSupport = true;
    efiInstallAsRemovable = true;
    device = "/dev/disk/by-path/pci-0000:00:17.0-ata-5";
  };
  boot.loader.efi.canTouchEfiVariables = false;
  boot.loader.timeout = 5;

  boot.kernelParams = [
    "console=tty0" "console=ttyS0,115200n8"
  ];

  disko.devices = {
    disk = {
      sda = {
        type = "disk";
        device = "/dev/disk/by-path/pci-0000:00:17.0-ata-5";
        content = {
          type = "gpt";
          partitions = {
            # GRUB BIOS boot partition — required for GRUB on GPT disks.
            bios = {
              size = "1M";
              type = "EF02";
            };

            ESP = {
              label = "boot";
              name = "ESP";
              size = "512M";
              type = "EF00";
              content = {
                type = "filesystem";
                format = "vfat";
                mountpoint = "/boot";
                mountOptions = [ "defaults" ];
              };
            };

            root = {
              size = "100%";
              content = {
                type = "luks";
                name = "cryptroot";
                passwordFile = "/tmp/disk-password";
                settings.allowDiscards = true;
                content = {
                  type = "btrfs";
                  extraArgs = [ "-L" "nixos" "-f" ];
                  subvolumes = {
                    "/rootfs" = {
                      mountpoint = "/";
                      mountOptions = [ "subvol=rootfs" "compress=zstd" "noatime" ];
                    };
                    "/nix" = {
                      mountpoint = "/nix";
                      mountOptions = [ "subvol=nix" "compress=zstd" "noatime" ];
                    };
                    "/persist" = {
                      mountpoint = "/persist";
                      mountOptions = [ "subvol=persist" "compress=zstd" "noatime" ];
                    };
                    "/swap" = {
                      mountpoint = "/swap";
                      swap.swapfile.size = "8G";
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  };

  # Clevis/Tang auto-unlock for LUKS
  boot.initrd.clevis = {
    enable = true;
    useTang = true;
    devices.cryptroot.secretFile = "/boot/secrets/clevis-cryptroot.jwe";
  };

  fileSystems."/persist".neededForBoot = true;
}
