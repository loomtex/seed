# silo CLI — git-native issue tracker
#
# Shell script wrapping git plumbing for refs/dit/ operations.
# Works in any git repo. No server dependency.
{ pkgs, ... }:

pkgs.writeShellApplication {
  name = "silo";
  runtimeInputs = with pkgs; [ git jq coreutils ];
  text = builtins.readFile ./silo;
}
