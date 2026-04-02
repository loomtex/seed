# Zitadel v4 — OIDC identity provider (pre-built binary)
#
# nixpkgs only has v2.71.7. The v4 build system uses an nx monorepo with
# pnpm workspaces, making source builds complex. Use pre-built release
# binaries from GitHub instead.
{
  stdenv,
  fetchurl,
  lib,
  autoPatchelfHook,
}:

stdenv.mkDerivation rec {
  pname = "zitadel";
  version = "4.13.1";

  src = fetchurl {
    url = "https://github.com/zitadel/zitadel/releases/download/v${version}/zitadel-linux-amd64.tar.gz";
    hash = "sha256-/h9SMeXcvcpjrnetqw0iQdqv65cS59bN7TcT6e9Q8cs=";
  };

  sourceRoot = ".";

  nativeBuildInputs = [ autoPatchelfHook ];

  installPhase = ''
    mkdir -p $out/bin
    install -Dm755 zitadel-linux-amd64/zitadel $out/bin/zitadel
  '';

  meta = {
    description = "Identity and access management platform";
    homepage = "https://zitadel.com/";
    downloadPage = "https://github.com/zitadel/zitadel/releases";
    platforms = [ "x86_64-linux" ];
    license = lib.licenses.agpl3Only;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
