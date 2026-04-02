# Seed sandbox instance — SSH shell with PostgreSQL client tools
#
# For iterating on inter-instance mTLS connections. Has its own
# SPIFFE identity cert (CN=sandbox) for testing client auth.
{ config, pkgs, ... }:

{
  seed.size = "xs";

  seed.expose.ssh = {};

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
      UsePAM = false;
    };
  };

  # Unlock root account (mutableUsers=false locks it by default)
  users.users.root.hashedPassword = "";

  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4wKwiX1fnwB/U4Mc7JT4ddMExopexk0DUSd7Du12Sp ada@signi"
  ];

  environment.systemPackages = with pkgs; [
    postgresql
    openssl
    curl
    tpm2-openssl
  ];
}
