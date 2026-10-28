# VM test: the silo behaviors loom's enrollment relies on (seed half of
# `silo-enrollment`), on the silo-standalone stand-in. No real silo, no
# real keys: every key is generated inside the test, and sk keys come
# from OpenSSH's software authenticator (sk-dummy).
#
#   nix build .#checks.x86_64-linux.silo-enrollment
#
# Each case names the silo behavior it pins (F1–F6, U15, S4) as recorded
# in omanix docs/design/DESIGN.md §a.4. Cases marked RECORD document
# current behavior rather than desired behavior; if one fails, silo
# changed and the design's assumptions need revisiting.
{ self, pkgs }:

let
  skDummy = import ./sk-dummy.nix { inherit pkgs; };
in
pkgs.testers.runNixOSTest {
  name = "silo-enrollment";

  nodes.silo = { ... }: {
    imports = [ self.nixosModules.silo-standalone ];
  };

  nodes.client = { pkgs, nodes, ... }: {
    environment.systemPackages = [ pkgs.git pkgs.openssh ];
    networking.hosts.${nodes.silo.networking.primaryIPAddress} = [ "silo.test" ];
  };

  testScript = ''
    import shlex

    SKD = "${skDummy}/lib/sk-dummy.so"
    REPOS = "/var/lib/silo/repos"
    ZERO = "0" * 40

    start_all()
    silo.wait_for_unit("sshd.service")
    silo.wait_for_unit("nginx.service")
    silo.wait_for_unit("fcgiwrap.service")
    silo.wait_for_open_port(22)
    client.wait_for_unit("multi-user.target")

    # ── keys (throwaway, generated here) ──────────────────────────────
    client.succeed("mkdir -p /root/k")
    for name in ["human", "enroll", "host", "agent", "attacker"]:
        client.succeed(f"ssh-keygen -q -t ed25519 -N ''' -f /root/k/{name}")
    for name in ["humansk", "ska", "skb"]:
        client.succeed(f"ssh-keygen -q -t ed25519-sk -w {SKD} -N ''' -f /root/k/{name}")

    def pub(name):
        """'type blob' of a test key."""
        return client.succeed(f"cut -d' ' -f1,2 /root/k/{name}.pub").strip()

    def keyfile(names):
        return "".join(f"{pub(n)} {n}\n" for n in names)

    def ssh_cmd(key):
        cmd = (f"ssh -i /root/k/{key} -o IdentitiesOnly=yes -o BatchMode=yes"
               " -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
               " -o LogLevel=ERROR")
        if key in ("humansk", "ska", "skb"):
            cmd += f" -o SecurityKeyProvider={SKD}"
        return cmd

    def url(repo):
        return f"ssh://git@silo/{repo}.git"

    def git(work, args, key=None):
        env = f"GIT_SSH_COMMAND={shlex.quote(ssh_cmd(key))} " if key else ""
        return client.execute(
            f"cd {work} && {env}git -c user.name=t -c user.email=t@test {args} 2>&1")

    def commit(work, files, msg):
        """Write files ({path: content | None to delete}) and commit."""
        for path, content in files.items():
            if content is None:
                client.succeed(f"rm -f {work}/{path}")
            else:
                client.succeed(f"cat > {work}/{path} <<'EOF'\n{content}EOF")
        rc, out = git(work, f"add -A && git -c user.name=t -c user.email=t@test commit -q -m {shlex.quote(msg)}")
        assert rc == 0, out
        return client.succeed(f"git -C {work} rev-parse HEAD").strip()

    def push(work, repo, refspec, key, ok, expect=None):
        rc, out = git(work, f"push {url(repo)} {refspec}", key)
        assert (rc == 0) == ok, f"push {refspec} as {key}: expected {'ok' if ok else 'reject'}, rc={rc}\n{out}"
        if expect:
            assert expect in out, f"push {refspec} as {key}: expected {expect!r} in\n{out}"
        return out

    def new_work(name):
        work = f"/root/w/{name}"
        client.succeed(f"rm -rf {work} && mkdir -p {work} && git -C {work} init -q -b master")
        return work

    def bare(repo, path):
        return silo.succeed(f"cat {REPOS}/{repo}.git/{path}")

    # ── (1) mint: the human's first push makes the human the owner ────
    R = "omanix/3f9c2a7e5b1d4c08a6e2f71b9d0c5e43"
    W = new_work("r")
    with subtest("F1/F6: human first push => .owner_key = human, HEAD = master"):
        silo.fail(f"test -e {REPOS}/{R}.git")
        mint = commit(W, {
            "CODEOWNERS": "# owners\n" + keyfile(["human", "enroll"]),
            ".authorized_keys": keyfile(["human", "enroll"]),
        }, "mint")
        push(W, R, "HEAD:refs/heads/master", "human", ok=True)
        assert bare(R, ".owner_key") == f"{pub('human')} silo-user\n", bare(R, ".owner_key")
        out = client.succeed(f"GIT_SSH_COMMAND={shlex.quote(ssh_cmd('human'))} git ls-remote --symref {url(R)} HEAD")
        assert out.startswith("ref: refs/heads/master\tHEAD\n"), out
        assert f"{mint}\tHEAD" in out, out
        assert bare(R, ".authorized_keys") == keyfile(["human", "enroll"])

    with subtest("F7: public read over HTTP for a nested path, and missing repo"):
        out = client.succeed(f"git ls-remote http://silo.test/{R}.git refs/heads/master")
        assert out.startswith(mint), out
        rc, out = client.execute(f"GIT_SSH_COMMAND={shlex.quote(ssh_cmd('attacker'))} git ls-remote {url('omanix/does-not-exist')} 2>&1")
        assert rc != 0 and "repository not found" in out, out
        silo.fail(f"test -e {REPOS}/omanix/does-not-exist.git")

    # ── (2) install: the enroll key pushes the install commit ─────────
    with subtest("F4/F5: enroll key (in mint CODEOWNERS) pushes install commit, removing itself"):
        install = commit(W, {
            "CODEOWNERS": "# owners\n" + keyfile(["human", "host"]),
            ".authorized_keys": keyfile(["human", "host", "agent"]),
        }, "install")
        push(W, R, "HEAD:refs/heads/master", "enroll", ok=True)
        assert bare(R, ".authorized_keys") == keyfile(["human", "host", "agent"])
        assert silo.succeed(f"git -c safe.directory=* -C {REPOS}/{R}.git rev-parse master").strip() == install

    # ── (3) the enroll key is now locked out everywhere ───────────────
    with subtest("F2: enroll key rejected on master and on gate/*"):
        commit(W, {"note": "enroll again\n"}, "enroll retry")
        push(W, R, "HEAD:refs/heads/master", "enroll", ok=False, expect="silo: access denied")
        push(W, R, "HEAD:refs/heads/gate/enroll", "enroll", ok=False, expect="silo: access denied")
        push(W, R, "HEAD:refs/heads/gate/x", "attacker", ok=False, expect="silo: access denied")
        client.succeed(f"git -C {W} reset -q --hard {install}")

    # ── (4) U15: host pushes master; agent only gate/* and new dit refs
    with subtest("U15: host key (CODEOWNERS) pushes master"):
        host1 = commit(W, {"machine.nix": "{ }\n"}, "host change")
        push(W, R, "HEAD:refs/heads/master", "host", ok=True)

    with subtest("U15: agent key rejected on master"):
        commit(W, {"agent.txt": "1\n"}, "agent change")
        push(W, R, "HEAD:refs/heads/master", "agent", ok=False, expect="not in CODEOWNERS")
        push(W, R, "HEAD:refs/heads/other", "agent", ok=False, expect="not in CODEOWNERS")

    with subtest("U15: agent key pushes gate/* and a new refs/dit/*"):
        agent1 = client.succeed(f"git -C {W} rev-parse HEAD").strip()
        push(W, R, "HEAD:refs/heads/gate/agent-1", "agent", ok=True)
        push(W, R, "HEAD:refs/dit/issue-1", "agent", ok=True)
        # gate pushes never sync .authorized_keys (F5: default branch only)
        commit(W, {".authorized_keys": keyfile(["human", "host", "agent", "attacker"])}, "agent adds a key")
        push(W, R, "HEAD:refs/heads/gate/agent-2", "agent", ok=True)
        assert bare(R, ".authorized_keys") == keyfile(["human", "host", "agent"])

    with subtest("U15: dit refs must fast-forward"):
        client.succeed(f"git -C {W} reset -q --hard {host1}")
        commit(W, {"other.txt": "x\n"}, "diverge")
        push(W, R, "+HEAD:refs/dit/issue-1", "agent", ok=False, expect="dit refs must fast-forward")

    with subtest("U15 RECORD: agent may force-push and delete gate/* (no ff check)"):
        push(W, R, "+HEAD:refs/heads/gate/agent-1", "agent", ok=True)
        push(W, R, ":refs/heads/gate/agent-1", "agent", ok=True)
        silo.fail(f"git -c safe.directory=* -C {REPOS}/{R}.git rev-parse --verify -q refs/heads/gate/agent-1")

    with subtest("F4 RECORD: a CODEOWNERS key may force-push master (no ff check)"):
        before = silo.succeed(f"git -c safe.directory=* -C {REPOS}/{R}.git rev-parse master").strip()
        client.succeed(f"git -C {W} reset -q --hard {install}")
        side = commit(W, {"side.txt": "x\n"}, "rewrite")
        push(W, R, "+HEAD:refs/heads/master", "host", ok=True)
        assert silo.succeed(f"git -c safe.directory=* -C {REPOS}/{R}.git rev-parse master").strip() == side
        # restore
        client.succeed(f"git -C {W} reset -q --hard {before}")
        push(W, R, "+HEAD:refs/heads/master", "host", ok=True)

    # ── (6) S4: sk-ssh-ed25519 keys ───────────────────────────────────
    with subtest("S4: sk key passes AuthorizedKeysCommand and becomes owner (F1)"):
        R2 = "omanix/8d21c0b7f4e9a35612de7c0b94a1f6e2"
        W2 = new_work("r2")
        commit(W2, {
            "CODEOWNERS": "# owners\n" + keyfile(["host"]),
            ".authorized_keys": keyfile(["host"]),
        }, "mint by sk owner")
        push(W2, R2, "HEAD:refs/heads/master", "humansk", ok=True)
        assert pub("humansk").startswith("sk-ssh-ed25519@openssh.com ")
        assert bare(R2, ".owner_key") == f"{pub('humansk')} silo-user\n", bare(R2, ".owner_key")

    with subtest("S4/F3: sk owner bypasses CODEOWNERS (not listed there)"):
        commit(W2, {"owner.txt": "1\n"}, "owner push")
        push(W2, R2, "HEAD:refs/heads/master", "humansk", ok=True)

    with subtest("S4/F4/F2: sk keys in CODEOWNERS and .authorized_keys"):
        client.succeed(f"git -C {W} fetch -q http://silo.test/{R}.git master && git -C {W} reset -q --hard FETCH_HEAD")
        commit(W, {
            "CODEOWNERS": "# owners\n" + keyfile(["human", "host", "ska"]),
            ".authorized_keys": keyfile(["human", "host", "agent", "ska", "skb"]),
        }, "add sk keys")
        push(W, R, "HEAD:refs/heads/master", "host", ok=True)
        commit(W, {"sk.txt": "a\n"}, "sk a")
        push(W, R, "HEAD:refs/heads/master", "ska", ok=True)
        commit(W, {"sk.txt": "b\n"}, "sk b")
        push(W, R, "HEAD:refs/heads/master", "skb", ok=False, expect="not in CODEOWNERS")
        push(W, R, "HEAD:refs/heads/gate/skb", "skb", ok=True)

    # ── (7) F3: a second .owner_key line loses the owner bypass ───────
    with subtest("F3 RECORD: multi-line .owner_key fails closed for the owner (needs S1 fix)"):
        silo.succeed(f"echo '{pub('attacker')} silo-user' >> {REPOS}/{R2}.git/.owner_key")
        commit(W2, {"owner.txt": "2\n"}, "owner push after second line")
        # transport still admits the owner (shell.nix uses grep -qF) ...
        out = push(W2, R2, "HEAD:refs/heads/master", "humansk", ok=False, expect="not in CODEOWNERS")
        assert "access denied" not in out, out
        # ... and the second line grants nothing beyond transport
        push(W2, R2, "HEAD:refs/heads/master", "attacker", ok=False, expect="not in CODEOWNERS")

    # ── F4/F5 edges loom must avoid (it always keeps both files) ──────
    with subtest("F4 RECORD: no CODEOWNERS at HEAD => any transport key may push master"):
        R3 = "omanix/c7e0954a1b3d28f6e9a0d4c51b72f803"
        W3 = new_work("r3")
        commit(W3, {".authorized_keys": keyfile(["human", "agent"])}, "no codeowners")
        push(W3, R3, "HEAD:refs/heads/master", "human", ok=True)
        commit(W3, {"a.txt": "1\n"}, "agent on master")
        push(W3, R3, "HEAD:refs/heads/master", "agent", ok=True)

    with subtest("F5 RECORD: removing .authorized_keys from the tree keeps the stale bare copy"):
        commit(W3, {".authorized_keys": None}, "drop authorized_keys")
        push(W3, R3, "HEAD:refs/heads/master", "human", ok=True)
        assert bare(R3, ".authorized_keys") == keyfile(["human", "agent"])
        commit(W3, {"a.txt": "2\n"}, "agent still admitted")
        push(W3, R3, "HEAD:refs/heads/master", "agent", ok=True)
  '';
}
