# Test that seed instances evaluate and images build correctly
# No KVM required — this only tests the nix evaluation + build pipeline.
# Run: nix build .#checks.x86_64-linux.image
{ self, pkgs, nixpkgs }:

let
  mkInstance = self.lib.mkInstance;
  mkImage = self.lib.mkImage;

  instance = mkInstance {
    name = "test";
    module = { ... }: {
      seed.size = "m";
      seed.expose.http = 8080;
      seed.expose.grpc = { port = 9090; protocol = "grpc"; };
      seed.storage.data = "1Gi";
      seed.storage.cache = { size = "500Mi"; mountPoint = "/tmp/cache"; };
      seed.connect.redis = "my-redis";
      seed.connect.db = { service = "postgres"; port = 5432; };
    };
  };

  image = mkImage {
    name = "test";
    inherit (instance) toplevel;
  };
in pkgs.runCommand "seed-image-test" {
  nativeBuildInputs = [ pkgs.jq ];
  meta_json = builtins.toJSON instance.meta;
  image_path = "${image}";
} ''
  echo "=== Testing instance metadata ==="

  echo "$meta_json" | jq .

  # Verify size tier
  size=$(echo "$meta_json" | jq -r '.size')
  [ "$size" = "m" ] || { echo "FAIL: expected size=m, got $size"; exit 1; }

  # Verify resources
  vcpus=$(echo "$meta_json" | jq -r '.resources.vcpus')
  memory=$(echo "$meta_json" | jq -r '.resources.memory')
  [ "$vcpus" = "2" ] || { echo "FAIL: expected vcpus=2, got $vcpus"; exit 1; }
  [ "$memory" = "2048" ] || { echo "FAIL: expected memory=2048, got $memory"; exit 1; }

  # Verify expose
  http_port=$(echo "$meta_json" | jq -r '.expose.http.port')
  grpc_port=$(echo "$meta_json" | jq -r '.expose.grpc.port')
  grpc_proto=$(echo "$meta_json" | jq -r '.expose.grpc.protocol')
  [ "$http_port" = "8080" ] || { echo "FAIL: expected http port=8080, got $http_port"; exit 1; }
  [ "$grpc_port" = "9090" ] || { echo "FAIL: expected grpc port=9090, got $grpc_port"; exit 1; }
  [ "$grpc_proto" = "grpc" ] || { echo "FAIL: expected grpc protocol=grpc, got $grpc_proto"; exit 1; }

  # Verify storage
  data_size=$(echo "$meta_json" | jq -r '.storage.data.size')
  cache_mp=$(echo "$meta_json" | jq -r '.storage.cache.mountPoint')
  [ "$data_size" = "1Gi" ] || { echo "FAIL: expected data size=1Gi, got $data_size"; exit 1; }
  [ "$cache_mp" = "/tmp/cache" ] || { echo "FAIL: expected cache mountPoint=/tmp/cache, got $cache_mp"; exit 1; }

  # Verify connect
  redis_svc=$(echo "$meta_json" | jq -r '.connect.redis.service')
  db_port=$(echo "$meta_json" | jq -r '.connect.db.port')
  [ "$redis_svc" = "my-redis" ] || { echo "FAIL: expected redis service=my-redis, got $redis_svc"; exit 1; }
  [ "$db_port" = "5432" ] || { echo "FAIL: expected db port=5432, got $db_port"; exit 1; }

  echo "=== Testing image ==="

  # Image should be a tar file
  [ -f "$image_path" ] || { echo "FAIL: image not found at $image_path"; exit 1; }
  echo "Image built: $image_path"

  echo "=== All tests passed ==="
  mkdir -p $out
  echo "ok" > $out/result
''
