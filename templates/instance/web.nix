{ pkgs, ... }:

{
  seed.size = "s";
  seed.expose.http.enable = true;
  seed.storage.data = "1Gi";

  services.nginx.enable = true;
  services.nginx.virtualHosts.default = {
    listen = [{ addr = "0.0.0.0"; port = 80; }];
    root = "/seed/storage/data/www";
  };
}
