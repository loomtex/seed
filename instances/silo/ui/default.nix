# Silo UI — static client-side app built with vite
#
# Produces a derivation containing the built static files (dist/).
# Served by nginx at /ui/ in the silo instance.
{ pkgs, lib, ... }:

pkgs.buildNpmPackage {
  pname = "silo-ui";
  version = "0.1.0";
  src = ./.;
  npmDepsHash = "sha256-ZKbGlUdPZb9kkgR6uwNpfig6CKf+fkmuqRbTa+rsPSI=";
  nodejs = pkgs.nodejs_22;
  installPhase = ''
    runHook preInstall
    cp -r dist $out
    runHook postInstall
  '';
}
