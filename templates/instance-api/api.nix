{ config, pkgs, ... }:

let
  app = pkgs.writeShellScript "api-server" ''
    # Read secret from sops-nix managed path
    API_KEY=$(cat ${config.sops.secrets.api-key.path})
    export API_KEY

    exec ${pkgs.nodejs}/bin/node ${server}
  '';

  server = pkgs.writeText "server.mjs" ''
    import { createServer } from "node:http";

    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    server.listen(3000, () => console.log("listening on :3000"));
  '';
in {
  seed.expose.api = { port = 3000; };
  seed.storage.data = "1Gi";

  # Encrypted secrets — see README "Secrets" section for provisioning flow.
  # 1. Deploy once without secrets (instance generates TPM identity)
  # 2. Get the age recipient: ssh seed.loom.farm keys api
  # 3. Encrypt: sops --age 'age1tpm1q...' secrets/api.yaml
  # 4. Redeploy — sops-nix decrypts automatically
  sops.defaultSopsFile = ./secrets/api.yaml;
  sops.secrets.api-key = {};

  systemd.services.api = {
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = app;
      Restart = "always";
    };
  };
}
