# VM test: tpm-backfill on throwaway TPM states (root, vtpm-proxy, KVM).
#
#   nix build .#checks.x86_64-linux.tpm-backfill
#
# Builds TPM states the way an instance does (age-plugin-tpm --generate
# against the TPM), then checks that tpm-backfill:
#   - reports OK + a fingerprint equal to the --fingerprint-only path,
#     also when /dev/tpm0 is taken and it has to bind over /dev/tpmrm0;
#   - reports BROKEN (exit 2) when the identity belongs to another TPM or
#     is missing;
#   - never modifies the live permall and leaves no mount or device behind.
{ self, pkgs }:

pkgs.testers.runNixOSTest {
  name = "tpm-backfill";

  nodes.machine = { pkgs, ... }: {
    environment.systemPackages = [
      self.packages.x86_64-linux.tpm-backfill
      pkgs.swtpm pkgs.age-plugin-tpm pkgs.util-linux
    ];
    boot.kernelModules = [ "tpm_vtpm_proxy" ];
    virtualisation.memorySize = 1024;
  };

  testScript = ''
    BASE = "/var/lib/seed-controller/tpm"

    def start_vtpm(unit, state):
        machine.succeed(f"mkdir -p {state}")
        machine.succeed(
            f"systemd-run --unit={unit} swtpm chardev --vtpm-proxy --tpm2 "
            f"--tpmstate dir={state} --ctrl type=unixio,path=/run/{unit}.ctrl"
        )

    def stop_vtpm(unit):
        machine.succeed(f"systemctl stop {unit}")

    def make_instance_tpm(name, identity=True):
        """Fresh TPM state in BASE/s-test-<name>, optionally with an age identity."""
        state = f"{BASE}/s-test-{name}"
        start_vtpm("mk-" + name, state)
        machine.wait_until_succeeds("test -c /dev/tpmrm0")
        if identity:
            machine.succeed(f"age-plugin-tpm --generate -o {state}/age-identity")
        stop_vtpm("mk-" + name)
        machine.wait_until_fails("test -e /dev/tpmrm0")
        machine.succeed(f"test -s {state}/tpm2-00.permall")
        return state

    def backfill(args, code):
        rc, out = machine.execute(f"timeout 300 tpm-backfill {args} 2>&1")
        print(out)
        assert rc == code, f"tpm-backfill {args}: want rc={code}, got {rc}: {out}"
        return out.strip().splitlines()

    machine.wait_for_unit("multi-user.target")
    machine.succeed("modprobe tpm_vtpm_proxy")

    good = make_instance_tpm("good")
    other = make_instance_tpm("other", identity=False)
    make_instance_tpm("noid", identity=False)
    machine.succeed(f"cp {good}/age-identity {other}/age-identity")
    before = machine.succeed(f"sha256sum < {good}/tpm2-00.permall")

    with subtest("good state: OK, fingerprint matches the unverified path"):
        line = backfill("s-test good", 0)[-1].split()
        assert line[:2] == ["s-test/good", "OK"], line
        fp = line[2]
        assert len(fp) == 64 and all(c in "0123456789abcdef" for c in fp), fp
        unverified = backfill("--fingerprint-only s-test good", 0)[-1].split()
        assert unverified == ["s-test/good", "UNVERIFIED", fp], unverified

    with subtest("tpm0 taken: binds the scratch device over /dev/tpmrm0"):
        start_vtpm("decoy", "/tmp/decoy")
        machine.wait_until_succeeds("test -c /dev/tpmrm0")
        line = backfill("s-test good", 0)[-1].split()
        assert line == ["s-test/good", "OK", fp], line
        machine.fail("findmnt /dev/tpmrm0")
        stop_vtpm("decoy")
        machine.wait_until_fails("test -e /dev/tpmrm0")

    with subtest("identity from another TPM: BROKEN"):
        line = backfill("s-test other", 2)[-1]
        assert line.startswith("s-test/other BROKEN"), line

    with subtest("no identity: BROKEN"):
        line = backfill("s-test noid", 2)[-1]
        assert line.startswith("s-test/noid BROKEN"), line

    with subtest("live state untouched, nothing left behind"):
        assert machine.succeed(f"sha256sum < {good}/tpm2-00.permall") == before
        machine.succeed(f"test ! -e {good}/tpm-fingerprint")
        machine.fail("ls /dev/tpm0 /dev/tpmrm0")
        machine.fail("ls -d /tmp/tpm-backfill.*")
        machine.fail("pgrep swtpm")
  '';
}
