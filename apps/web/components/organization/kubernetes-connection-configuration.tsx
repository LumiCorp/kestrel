"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type StorageAttestation = {
  encryption: "provider_verified" | "provider_attested" | "unknown";
  evidenceRef: string | null;
};

export type KubernetesConnectionConfigurationValue = {
  contract: "kubernetes-connection-config-v1";
  displayName: string;
  isDefault: boolean;
  runtimeTemplateAllowlist: string[];
  qualificationProbeImage: string;
  attestationEvidenceNote: string;
  profile: {
    contract: "kubernetes-byoc-profile-v1";
    selectedCertificationProfile: "gke-gateway-v1" | "eks-ingress-v1" | null;
    namespacePrefix: string;
    baseDomain: string;
    storageClassName: string;
    volumeSnapshotClassName: string;
    controllerNamespace: string;
    controllerPodSelector: Record<string, string>;
    pullSecretRef: string | null;
    encryptionAttestations: {
      persistentVolumes: StorageAttestation;
      kubernetesSecrets: StorageAttestation;
    };
    edge:
      | {
          mode: "gateway_api";
          parentNamespace: string;
          parentName: string;
          sectionName?: string | undefined;
        }
      | { mode: "ingress"; ingressClassName: string };
    platform: {
      distribution: "gke" | "eks" | "other";
      computeProfile: string;
      networkPolicyProvider: string;
      storageCsiDriver: string;
      snapshotCsiDriver: string;
      edgeController: string;
    };
  };
};

function selectorText(value: Record<string, string>) {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${key}=${child}`)
    .join(", ");
}

function parseList(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSelector(value: FormDataEntryValue | null) {
  return Object.fromEntries(
    parseList(value).map((item) => {
      const separator = item.indexOf("=");
      if (separator < 1 || separator === item.length - 1) {
        throw new Error("Controller selectors must use comma-separated key=value pairs.");
      }
      return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
    }),
  );
}

function text(data: FormData, key: string) {
  return String(data.get(key) ?? "").trim();
}

function optionalText(data: FormData, key: string) {
  return text(data, key) || null;
}

export function KubernetesConnectionConfiguration({
  connectionId,
  frozen,
  featureEnabled,
  value,
  onSaved,
}: {
  connectionId: string;
  frozen: boolean;
  featureEnabled: boolean;
  value: KubernetesConnectionConfigurationValue;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [edgeMode, setEdgeMode] = useState(value.profile.edge.mode);

  async function submit(form: HTMLFormElement) {
    setBusy(true);
    try {
      const data = new FormData(form);
      const storageAttestation = (prefix: string): StorageAttestation => {
        const encryption = text(data, `${prefix}Encryption`) as StorageAttestation["encryption"];
        return {
          encryption,
          evidenceRef:
            encryption === "unknown"
              ? null
              : optionalText(data, `${prefix}EvidenceRef`),
        };
      };
      const profile = frozen ? value.profile : {
        contract: "kubernetes-byoc-profile-v1" as const,
        selectedCertificationProfile:
          (optionalText(data, "selectedCertificationProfile") as
            | "gke-gateway-v1"
            | "eks-ingress-v1"
            | null),
        namespacePrefix: text(data, "namespacePrefix"),
        baseDomain: text(data, "baseDomain"),
        storageClassName: text(data, "storageClassName"),
        volumeSnapshotClassName: text(data, "volumeSnapshotClassName"),
        controllerNamespace: text(data, "controllerNamespace"),
        controllerPodSelector: parseSelector(data.get("controllerPodSelector")),
        pullSecretRef: optionalText(data, "pullSecretRef"),
        encryptionAttestations: {
          persistentVolumes: storageAttestation("persistentVolumes"),
          kubernetesSecrets: storageAttestation("kubernetesSecrets"),
        },
        edge:
          edgeMode === "gateway_api"
            ? {
                mode: "gateway_api" as const,
                parentNamespace: text(data, "parentNamespace"),
                parentName: text(data, "parentName"),
                ...(optionalText(data, "sectionName")
                  ? { sectionName: text(data, "sectionName") }
                  : {}),
              }
            : {
                mode: "ingress" as const,
                ingressClassName: text(data, "ingressClassName"),
              },
        platform: {
          distribution: text(data, "distribution") as "gke" | "eks" | "other",
          computeProfile: text(data, "computeProfile"),
          networkPolicyProvider: text(data, "networkPolicyProvider"),
          storageCsiDriver: text(data, "storageCsiDriver"),
          snapshotCsiDriver: text(data, "snapshotCsiDriver"),
          edgeController: text(data, "edgeController"),
        },
      };
      const response = await fetch(
        `/api/organization/infrastructure/kubernetes/connections/${connectionId}/configure`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contract: "kubernetes-connection-config-v1",
            displayName: text(data, "displayName"),
            isDefault: data.get("isDefault") === "on",
            profile,
            runtimeTemplateAllowlist: frozen
              ? value.runtimeTemplateAllowlist
              : parseList(data.get("runtimeTemplateAllowlist")),
            qualificationProbeImage: frozen
              ? value.qualificationProbeImage
              : text(data, "qualificationProbeImage"),
            attestationEvidenceNote: frozen
              ? value.attestationEvidenceNote
              : text(data, "attestationEvidenceNote"),
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Connection configuration failed.");
      toast.success("Kubernetes connection configuration saved.");
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connection configuration failed.");
    } finally {
      setBusy(false);
    }
  }

  const profile = value.profile;
  const field = "space-y-1";
  return (
    <details className="mt-4 rounded-md border p-4">
      <summary className="cursor-pointer font-medium text-sm">Connection configuration</summary>
      <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
        <div className={field}><Label htmlFor={`${connectionId}-display`}>Display name</Label><Input defaultValue={value.displayName} id={`${connectionId}-display`} name="displayName" /></div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input defaultChecked={value.isDefault} name="isDefault" type="checkbox" /> Default Kubernetes connection</label>
        <div className={field}><Label htmlFor={`${connectionId}-certification-profile`}>Certification profile</Label><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" defaultValue={profile.selectedCertificationProfile ?? ""} id={`${connectionId}-certification-profile`} name="selectedCertificationProfile"><option value="">Qualified non-reference</option><option value="gke-gateway-v1">GKE Gateway v1</option><option value="eks-ingress-v1">EKS Ingress v1</option></select></div>
        <div className={field}><Label htmlFor={`${connectionId}-distribution`}>Distribution</Label><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" defaultValue={profile.platform.distribution} id={`${connectionId}-distribution`} name="distribution"><option value="gke">GKE</option><option value="eks">EKS</option><option value="other">Other</option></select></div>
        {(
          [
          ["Namespace prefix", "namespacePrefix", profile.namespacePrefix],
          ["Qualified base domain", "baseDomain", profile.baseDomain],
          ["StorageClass", "storageClassName", profile.storageClassName],
          ["VolumeSnapshotClass", "volumeSnapshotClassName", profile.volumeSnapshotClassName],
          ["Controller namespace", "controllerNamespace", profile.controllerNamespace],
          ["Controller selector (key=value)", "controllerPodSelector", selectorText(profile.controllerPodSelector)],
          ["Pull Secret reference", "pullSecretRef", profile.pullSecretRef ?? ""],
          ["Compute profile", "computeProfile", profile.platform.computeProfile],
          ["NetworkPolicy provider", "networkPolicyProvider", profile.platform.networkPolicyProvider],
          ["Storage CSI driver", "storageCsiDriver", profile.platform.storageCsiDriver],
          ["Snapshot CSI driver", "snapshotCsiDriver", profile.platform.snapshotCsiDriver],
          ["Edge controller", "edgeController", profile.platform.edgeController],
          ["Runtime templates (comma-separated)", "runtimeTemplateAllowlist", value.runtimeTemplateAllowlist.join(", ")],
          ["Qualification image digest", "qualificationProbeImage", value.qualificationProbeImage],
          ["Attestation evidence note", "attestationEvidenceNote", value.attestationEvidenceNote],
          ] as const
        ).map(([label, name, initial]) => {
          const id = `${connectionId}-${name}`;
          return <div className={field} key={name}><Label htmlFor={id}>{label}</Label><Input defaultValue={initial} id={id} name={name} /></div>;
        })}
        <div className={field}><Label htmlFor={`${connectionId}-edge-mode`}>Edge mode</Label><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" id={`${connectionId}-edge-mode`} name="edgeMode" onChange={(event) => setEdgeMode(event.target.value as typeof edgeMode)} value={edgeMode}><option value="gateway_api">Gateway API</option><option value="ingress">Ingress</option></select></div>
        {edgeMode === "gateway_api" ? <>
          <div className={field}><Label htmlFor={`${connectionId}-parentNamespace`}>Gateway parent namespace</Label><Input defaultValue={profile.edge.mode === "gateway_api" ? profile.edge.parentNamespace : ""} id={`${connectionId}-parentNamespace`} name="parentNamespace" /></div>
          <div className={field}><Label htmlFor={`${connectionId}-parentName`}>Gateway parent name</Label><Input defaultValue={profile.edge.mode === "gateway_api" ? profile.edge.parentName : ""} id={`${connectionId}-parentName`} name="parentName" /></div>
          <div className={field}><Label htmlFor={`${connectionId}-sectionName`}>Gateway section name</Label><Input defaultValue={profile.edge.mode === "gateway_api" ? profile.edge.sectionName ?? "" : ""} id={`${connectionId}-sectionName`} name="sectionName" /></div>
        </> : <div className={field}><Label htmlFor={`${connectionId}-ingressClassName`}>Ingress class name</Label><Input defaultValue={profile.edge.mode === "ingress" ? profile.edge.ingressClassName : ""} id={`${connectionId}-ingressClassName`} name="ingressClassName" /></div>}
        {(["persistentVolumes", "kubernetesSecrets"] as const).map((kind) => {
          const attestation = profile.encryptionAttestations[kind];
          return <div className="grid gap-2 rounded-md border p-3" key={kind}><Label>{kind === "persistentVolumes" ? "Persistent Volume encryption" : "Kubernetes Secret encryption"}</Label><select className="h-9 rounded-md border bg-background px-3 text-sm" defaultValue={attestation.encryption} name={`${kind}Encryption`}><option value="provider_attested">Provider attested</option><option value="provider_verified">Provider verified</option><option value="unknown">Unknown</option></select><Input defaultValue={attestation.evidenceRef ?? ""} name={`${kind}EvidenceRef`} placeholder="Evidence reference" /></div>;
        })}
        <div className="md:col-span-2"><Button disabled={busy || !featureEnabled} type="submit" variant="outline">{busy ? "Saving…" : frozen ? "Save presentation fields" : "Save configuration"}</Button>{frozen ? <p className="mt-2 text-muted-foreground text-xs">Infrastructure fields are frozen while this connection owns an active Environment; display name and default selection remain editable.</p> : null}{featureEnabled ? null : <p className="mt-2 text-muted-foreground text-xs">Enable Kubernetes BYOC to change connection configuration.</p>}</div>
      </form>
    </details>
  );
}
