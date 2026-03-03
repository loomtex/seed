{ pkgs, ... }:

{
  seed.size = "s";
  seed.expose.http = 8080;
  seed.storage.data = "1Gi";

  services.nginx.enable = true;
  services.nginx.virtualHosts.default = {
    listen = [{ addr = "0.0.0.0"; port = 8080; }];
    root = "/seed/storage/data/www";
  };
}
