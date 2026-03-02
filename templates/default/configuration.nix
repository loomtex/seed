{ ... }: {
  seed.enable = true;
  # That's it. k3s + nix-snapshotter + Kata/CLH, single server node.

  # Uncomment to join an existing cluster as an agent:
  # seed.role = "agent";
  # seed.serverAddr = "https://server:6443";
  # seed.tokenFile = "/run/secrets/k3s-token";
}
