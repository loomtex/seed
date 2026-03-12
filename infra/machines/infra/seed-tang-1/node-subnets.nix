# CIDRs of seed cluster node subnets.
# Tang allows connections only from these ranges.
[
  "216.128.140.0/23"   # seed-dfw-1
  "104.238.146.0/23"   # seed-dfw-2
  "45.76.238.0/23"     # seed-dfw-3
  "45.76.254.0/23"     # seed-atl-1 (+ seed-atl-2, seed-atl-3 — same DC)
  "45.76.60.0/23"      # seed-atl-2
  "155.138.198.0/23"   # seed-atl-3
  "143.105.104.0/23"   # signi (provisioner host)
  "66.42.94.0/23"      # seed-atl-2
]
