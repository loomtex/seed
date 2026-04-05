# silo-tui — interactive terminal interface for silo over SSH
#
# bubbletea TUI for browsing repos, managing issues (refs/dit/),
# and viewing activity. Runs directly against bare repos on disk.
{ pkgs, ... }:

pkgs.buildGoModule {
  pname = "silo-tui";
  version = "0.1.0";
  src = ./.;
  vendorHash = "sha256-uwBJAqN4sIepiiJf9lCDumLqfKJEowQO2tOiSWD3Fig=";
  env.CGO_ENABLED = 0;
}
