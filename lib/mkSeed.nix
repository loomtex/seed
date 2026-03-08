# seed.lib.mkSeed — convenience wrapper for mkInstance + mkImage
#
# Returns everything mkInstance returns (toplevel, meta, config, module)
# plus the OCI image. This is the user-facing API — mkInstance and mkImage
# remain available for advanced use.
{ mkInstance, mkImage }:

args:

let
  instance = mkInstance args;
in instance // {
  image = mkImage { inherit (args) name; inherit (instance) toplevel; };
}
