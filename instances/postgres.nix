# Seed postgres instance — shared PostgreSQL with SPIFFE mTLS
#
# Dedicated database server. Other seed instances connect over mTLS
# using their SPIFFE identity certificates. Access control via
# pg_ident.conf maps certificate DNs to PostgreSQL roles.
{ ... }:

{
  seed.size = "s";
  seed.storage.pgdata.size = "10Gi";

  seed.services.postgresql = {
    enable = true;
    databases.social = {
      clients.social = { role = "social_rw"; };
      clients.sandbox = { role = "social_rw"; };
    };
  };
}
