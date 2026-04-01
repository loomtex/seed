# Derive the k8s namespace from .seed-identity (IPNS CID).
#
# Algorithm (must match src/shared/kube.ts deriveNamespaceFromIdentity):
#   1. sha256(ipns_cid) → hex string
#   2. Take first 20 hex chars as ASCII text
#   3. RFC 4648 base32-encode those bytes
#   4. Lowercase, take first 12 chars
#   5. Prefix with "s-"
#
# Returns null if .seed-identity doesn't exist in the source tree.
{ self }:

let
  identityFile = "${self}/.seed-identity";
  hasIdentity = builtins.pathExists identityFile;

  ipnsCid = if hasIdentity
    then builtins.replaceStrings [ "\n" "\r" " " ] [ "" "" "" ]
      (builtins.readFile identityFile)
    else null;

  # RFC 4648 base32 alphabet
  alphabet = builtins.genList (i:
    if i < 26 then builtins.substring (65 + i) 1 "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    else builtins.substring (24 + i - 26) 1 "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  ) 32;

  # Actually, nix doesn't have character code arithmetic. Let's use a lookup string.
  b32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  b32char = i: builtins.substring i 1 b32chars;

  # Convert a string to a list of byte values (ASCII)
  charToInt = c: let
    chars = "0123456789abcdef";
    hexChars = builtins.genList (i: builtins.substring i 1 chars) 16;
    idx = builtins.head (builtins.filter (i: builtins.elemAt hexChars i == c) (builtins.genList (i: i) 16));
  in idx;

  # We need base32 of ASCII bytes of the first 20 hex chars.
  # ASCII codes: '0'=48 '1'=49 ... '9'=57 'a'=97 'b'=98 ... 'f'=102
  hexCharToAscii = c:
    let
      digits = { "0"=48; "1"=49; "2"=50; "3"=51; "4"=52; "5"=53; "6"=54; "7"=55; "8"=56; "9"=57; };
      letters = { "a"=97; "b"=98; "c"=99; "d"=100; "e"=101; "f"=102; };
      all = digits // letters;
    in all.${c};

  # Get the hex SHA256 of the CID
  hash = builtins.hashString "sha256" ipnsCid;
  hex20 = builtins.substring 0 20 hash;

  # Convert hex20 to list of ASCII byte values
  bytes = builtins.genList (i: hexCharToAscii (builtins.substring i 1 hex20)) 20;

  # Base32 encode: process 5 bytes at a time → 8 base32 chars
  # For 20 bytes → exactly 32 base32 chars (no padding needed)
  encodeGroup = offset: let
    b0 = builtins.elemAt bytes (offset + 0);
    b1 = builtins.elemAt bytes (offset + 1);
    b2 = builtins.elemAt bytes (offset + 2);
    b3 = builtins.elemAt bytes (offset + 3);
    b4 = builtins.elemAt bytes (offset + 4);
  in [
    (b32char (b0 / 8))
    (b32char (((b0 - (b0 / 8) * 8) * 4) + (b1 / 64)))
    (b32char ((b1 / 2) - ((b1 / 64) * 32)))
    (b32char (((b1 - (b1 / 2) * 2) * 16) + (b2 / 16)))
    (b32char (((b2 - (b2 / 16) * 16) * 2) + (b3 / 128)))
    (b32char ((b3 / 4) - ((b3 / 128) * 32)))
    (b32char (((b3 - (b3 / 4) * 4) * 8) + (b4 / 32)))
    (b32char (b4 - (b4 / 32) * 32))
  ];

  allChars = builtins.concatLists (builtins.genList (g: encodeGroup (g * 5)) 4);
  base32 = builtins.concatStringsSep "" allChars;

  namespace = "s-" + builtins.substring 0 12 (builtins.replaceStrings
    ["A" "B" "C" "D" "E" "F" "G" "H" "I" "J" "K" "L" "M" "N" "O" "P" "Q" "R" "S" "T" "U" "V" "W" "X" "Y" "Z"]
    ["a" "b" "c" "d" "e" "f" "g" "h" "i" "j" "k" "l" "m" "n" "o" "p" "q" "r" "s" "t" "u" "v" "w" "x" "y" "z"]
    base32);

in if hasIdentity then namespace else null
