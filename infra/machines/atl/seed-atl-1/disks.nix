{
  disko.devices = {
    disk = {
      sda = {
        type = "disk";
        device = "/dev/disk/by-path/pci-0000:00:17.0-ata-5";
        content = {
          type = "gpt";
          partitions = {
            # GRUB BIOS boot partition — required for GRUB on GPT disks.
            # Holds GRUB's core.img when booting via BIOS/CSM (iPXE netboot
            # installs in BIOS mode, so the firmware may try BIOS first).
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
    devices.cryptroot.secretFile = "/persist/secrets/clevis-cryptroot.jwe";
  };

  fileSystems."/persist".neededForBoot = true;
}
