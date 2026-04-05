# silo-auth-verify — Ed25519 signature verifier for nginx auth_request.
#
# Tiny HTTP service: verifies SiloKey authorization header, returns
# identity via response header. nginx passes it to git-http-backend.
{ pkgs, ... }:

pkgs.buildGoModule {
  pname = "silo-auth-verify";
  version = "0.1.0";
  src = ./.;
  vendorHash = "sha256-+TACCNntEPB3do5qjBqWHNiCf4DF0mPNb5dekR9cut4=";
  env.CGO_ENABLED = 0;
}
