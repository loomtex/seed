import * as pulumi from "@pulumi/pulumi";
import * as vultr from "@ediri/vultr";
import type {
  SeedProvider,
  BareMetalArgs,
  BareMetal,
  VMArgs,
  VM,
  VPCArgs,
  VPC,
  ReserveIPArgs,
  ReservedIPv4,
  ReserveIPv6Args,
  ReservedIPv6,
  StorageArgs,
  ObjectBucket,
  BootScriptArgs,
  BootScript,
  SSHKey,
} from "../types.ts";

// Map abstract plan names to Vultr plan IDs
const PLAN_MAP: Record<string, string> = {
  "bm-6c-32gb": "vbm-6c-32gb",
  "vm-1c-1gb": "vc2-1c-1gb",
  "vm-1c-2gb": "vc2-1c-2gb",
};

// Vultr OS IDs
const OS_NIXOS = 551; // NixOS (may vary — used as fallback)

export class VultrProvider implements SeedProvider {
  createBareMetal(name: string, args: BareMetalArgs): BareMetal {
    const plan = PLAN_MAP[args.plan] ?? args.plan;
    const server = new vultr.BareMetalServer(name, {
      region: args.region,
      plan,
      label: args.label,
      hostname: args.label,
      scriptId: args.bootScriptId,
      enableIpv6: args.enableIPv6,
      sshKeyIds: args.sshKeyIds,
      vpcId: args.vpcId,
      tags: args.tags,
      // os_id 159 = "Custom" (required for iPXE boot)
      osId: 159,
      // Don't persist PXE — boot from disk after first install
      persistentPxe: false,
      activationEmail: false,
    });

    return {
      id: server.id,
      ipv4: server.mainIp,
      ipv6: server.v6MainIp,
      label: server.label.apply((l) => l ?? args.label),
    };
  }

  createVM(name: string, args: VMArgs): VM {
    const plan = PLAN_MAP[args.plan] ?? args.plan;
    const instance = new vultr.Instance(name, {
      region: args.region,
      plan,
      label: args.label,
      hostname: args.label,
      osId: args.osId,
      enableIpv6: args.enableIPv6,
      sshKeyIds: args.sshKeyIds,
      tags: args.tags,
      activationEmail: false,
    });

    return {
      id: instance.id,
      ipv4: instance.mainIp,
      ipv6: instance.v6MainIp,
      label: instance.label.apply((l) => l ?? args.label),
    };
  }

  createVPC(name: string, args: VPCArgs): VPC {
    const vpc = new vultr.Vpc(name, {
      region: args.region,
      description: args.description ?? name,
      v4Subnet: args.subnet,
      v4SubnetMask: args.subnetMask,
    });

    return {
      id: vpc.id,
    };
  }

  reserveIPv4(name: string, args: ReserveIPArgs): ReservedIPv4 {
    const ip = new vultr.ReservedIp(name, {
      region: args.region,
      ipType: "v4",
      label: args.label,
    });

    return {
      id: ip.id,
      address: ip.subnet,
    };
  }

  reserveIPv6Block(name: string, args: ReserveIPv6Args): ReservedIPv6 {
    // Vultr doesn't have a direct "reserve IPv6 block" resource in the
    // Pulumi provider — IPv6 blocks are reserved via API and imported.
    // For now, this is a placeholder that expects import.
    throw new Error(
      "IPv6 block reservation must be imported from existing Vultr resources. " +
        "Use `pulumi import vultr:index/reservedIp:ReservedIp <name> <id>`"
    );
  }

  createObjectStorage(name: string, args: StorageArgs): ObjectBucket {
    const storage = new vultr.ObjectStorage(name, {
      clusterId: args.clusterId ?? 22, // ATL cluster (atl2.vultrobjects.com)
      label: args.label,
      tierId: args.tierId ?? 2, // Standard tier ($18/mo)
    });

    return {
      id: storage.id,
      label: storage.label.apply((l) => l ?? args.label),
      endpoint: storage.s3Hostname,
      s3Hostname: storage.s3Hostname,
      s3AccessKey: storage.s3AccessKey,
      s3SecretKey: storage.s3SecretKey,
    };
  }

  createBootScript(name: string, args: BootScriptArgs): BootScript {
    const encoded = pulumi.output(args.content).apply((c) =>
      Buffer.from(c).toString("base64")
    );

    const script = new vultr.StartupScript(name, {
      name,
      script: encoded,
      type: args.type,
    });

    return {
      id: script.id,
    };
  }

  uploadObject(
    _bucket: ObjectBucket,
    _key: string,
    _content: pulumi.Input<string>
  ): void {
    // Vultr Object Storage is S3-compatible. Uploads are done via AWS CLI
    // or nix post-build-hook, not via Pulumi resources. The netboot artifacts
    // are uploaded by the orchestration step using the AWS CLI.
    pulumi.log.info(
      "Object upload is handled externally via AWS CLI (S3-compatible)."
    );
  }

  createSSHKey(name: string, publicKey: pulumi.Input<string>): SSHKey {
    const key = new vultr.SSHKey(name, {
      name,
      sshKey: publicKey,
    });

    return {
      id: key.id,
    };
  }
}
