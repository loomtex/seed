{ pkgs, ... }:

let
  server = pkgs.writeText "server.mjs" ''
    import { createServer } from "node:http";

    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    server.listen(3000, () => console.log("listening on :3000"));
  '';
in {
  seed.expose.myapi = { port = 3000; };

  systemd.services.api = {
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.nodejs}/bin/node ${server}";
      Restart = "always";
    };
  };
}
