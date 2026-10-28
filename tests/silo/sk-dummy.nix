# OpenSSH's regress "sk-dummy" security-key middleware: a software FIDO
# authenticator that makes real sk-ssh-ed25519@openssh.com keys and
# signatures with no hardware. Test-only; used via SecurityKeyProvider.
{ pkgs }:

pkgs.stdenv.mkDerivation {
  pname = "openssh-sk-dummy";
  inherit (pkgs.openssh) version src;

  nativeBuildInputs = [ pkgs.pkg-config ];
  buildInputs = [ pkgs.openssl pkgs.zlib ];

  configureFlags = [ "--without-zlib-version-check" ];

  buildPhase = ''
    runHook preBuild
    make -j$NIX_BUILD_CORES openbsd-compat/libopenbsd-compat.a
    make -j$NIX_BUILD_CORES regress/misc/sk-dummy/sk-dummy.so
    runHook postBuild
  '';

  installPhase = ''
    install -Dm755 regress/misc/sk-dummy/sk-dummy.so $out/lib/sk-dummy.so
  '';
}
