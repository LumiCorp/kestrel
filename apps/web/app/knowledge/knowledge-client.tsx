"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import {
  ResourceEmpty,
  ResourceList,
  ResourceRow,
} from "@/components/resource-list";
import {
  SettingsRowActionMenu,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TimeText } from "@/components/ui/time-text";
import type { Session } from "@/lib/auth-types";
import {
  deleteKnowledgeDocumentAction,
  reindexKnowledgeDocumentAction,
  uploadKnowledgeDocumentsAction,
} from "./actions";

type ProjectUsage = { id: string; name: string };

type KnowledgeDocument = {
  id: string;
  uploaderUserId: string;
  uploaderName: string | null;
  uploaderEmail: string | null;
  title: string | null;
  filename: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  status: "uploaded" | "processing" | "ready" | "partial" | "failed";
  chunkCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun: {
    id: string;
    stage: string;
    status: string;
    error: string | null;
    updatedAt: string;
  } | null;
  visibleProjectUsage: ProjectUsage[];
};

type DocumentsPayload = {
  total: number;
  readyCount: number;
  partialCount: number;
  failedCount: number;
  processingCount: number;
  documents: KnowledgeDocument[];
};

function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: KnowledgeDocument["status"]) {
  switch (status) {
    case "uploaded":
      return "Queued";
    case "processing":
      return "Processing";
    case "partial":
      return "Partially ready";
    case "failed":
      return "Needs attention";
    default:
      return "Ready";
  }
}

export function KnowledgeClient({
  session,
  initialDocuments,
}: {
  session: Session | null;
  initialDocuments: DocumentsPayload;
}) {
  const [documentsData, setDocumentsData] =
    useState<DocumentsPayload>(initialDocuments);
  const [status, setStatus] = useState("");
  const [statusVariant, setStatusVariant] = useState<
    "info" | "success" | "warning" | "error"
  >("info");
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteDocument, setDeleteDocument] =
    useState<KnowledgeDocument | null>(null);
  const uploadInputId = useId();
  const currentUserId =
    (session?.user as { id?: string | null } | undefined)?.id ?? null;
  const isAdmin =
    (session?.user as { role?: string | null } | undefined)?.role === "admin";

  useEffect(() => {
    setDocumentsData(initialDocuments);
  }, [initialDocuments]);

  const reloadDocuments = useCallback(async () => {
    const response = await fetch("/api/knowledge/documents", {
      cache: "no-store",
    });
    const body = (await response
      .json()
      .catch(() => ({}))) as DocumentsPayload & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error || "Failed to refresh organization knowledge");
    }
    setDocumentsData(body);
  }, []);

  function canManage(document: KnowledgeDocument) {
    return isAdmin || document.uploaderUserId === currentUserId;
  }

  async function uploadDocuments() {
    if (pendingFiles.length === 0) return;
    setBusyDocumentId("upload");
    const formData = new FormData();
    for (const file of pendingFiles) formData.append("files", file);
    const result = await uploadKnowledgeDocumentsAction(formData);
    setBusyDocumentId(null);
    if (!result.ok) {
      toast.error(result.error || "Upload failed");
      return;
    }
    await reloadDocuments();
    setPendingFiles([]);
    setUploadDialogOpen(false);
    setStatus(result.message || "Indexing has started.");
    setStatusVariant("success");
    toast.success(result.message || "Indexing has started.");
  }

  async function reindexDocument(documentId: string) {
    setBusyDocumentId(documentId);
    const result = await reindexKnowledgeDocumentAction({ documentId });
    setBusyDocumentId(null);
    if (!result.ok) {
      toast.error(result.error || "Could not reindex document");
      return;
    }
    await reloadDocuments();
    toast.success(result.message || "Reindexing has started.");
  }

  async function confirmDelete() {
    if (!deleteDocument) return;
    setBusyDocumentId(deleteDocument.id);
    const result = await deleteKnowledgeDocumentAction({
      documentId: deleteDocument.id,
    });
    setBusyDocumentId(null);
    if (!result.ok) {
      toast.error(result.error || "Could not delete document");
      return;
    }
    setDeleteDocument(null);
    await reloadDocuments();
    toast.success("Document deleted permanently.");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={busyDocumentId === "upload"}
            onClick={() => setUploadDialogOpen(true)}
          >
            Upload document
          </Button>
        }
        description="Shared material available across your organization. Add Project-only material from that Project’s context."
        status={
          <span className="text-muted-foreground text-xs">
            {documentsData.readyCount} ready ·{" "}
            {documentsData.failedCount + documentsData.partialCount} need
            attention
          </span>
        }
        title="Organization Knowledge"
      />

      {status ? (
        <SettingsStatusNotice
          description="Changes appear here as document ingestion progresses."
          title={status}
          tone={statusVariant}
        />
      ) : null}

      {documentsData.documents.length === 0 ? (
        <div className="border-y">
          <ResourceEmpty
            description="Upload shared material here, or add private material from a Project’s context."
            title="No organization documents yet"
          />
        </div>
      ) : (
        <ResourceList>
          {documentsData.documents.map((document) => {
            const needsAttention =
              document.status === "failed" || document.status === "partial";
            return (
              <ResourceRow
                actions={
                  canManage(document) ? (
                    <div className="flex items-center gap-1">
                      {needsAttention ? (
                        <Button
                          disabled={busyDocumentId === document.id}
                          onClick={() => void reindexDocument(document.id)}
                          size="sm"
                          variant="outline"
                        >
                          {busyDocumentId === document.id
                            ? "Starting…"
                            : "Reindex"}
                        </Button>
                      ) : null}
                      <SettingsRowActionMenu
                        label={`Actions for ${document.title || document.filename}`}
                      >
                        <DropdownMenuItem
                          onSelect={() => setDeleteDocument(document)}
                          variant="destructive"
                        >
                          Delete document
                        </DropdownMenuItem>
                      </SettingsRowActionMenu>
                    </div>
                  ) : undefined
                }
                description={
                  <div className="space-y-1">
                    <p>
                      {formatFileSize(document.sizeBytes)} · uploaded by{" "}
                      {document.uploaderName ||
                        document.uploaderEmail ||
                        "a member"}
                    </p>
                    {document.error ? (
                      <p className="text-destructive">{document.error}</p>
                    ) : null}
                    {document.latestRun ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer">
                          Technical details
                        </summary>
                        <p className="mt-1 font-mono">
                          {document.latestRun.stage} ·{" "}
                          {document.latestRun.status} · {document.latestRun.id}
                        </p>
                      </details>
                    ) : null}
                  </div>
                }
                key={document.id}
                metadata={
                  <>
                    {document.visibleProjectUsage.length > 0 ? (
                      <span>
                        Used in{" "}
                        {document.visibleProjectUsage.map((project, index) => (
                          <span key={project.id}>
                            {index > 0 ? ", " : null}
                            <Link
                              className="underline-offset-4 hover:underline"
                              href={`/projects/${project.id}`}
                            >
                              {project.name}
                            </Link>
                          </span>
                        ))}
                      </span>
                    ) : (
                      "Not used in your current Projects"
                    )}
                    <span aria-hidden="true"> · </span>
                    Updated{" "}
                    <TimeText
                      mode="relative"
                      value={
                        document.latestRun?.updatedAt || document.updatedAt
                      }
                    />
                  </>
                }
                status={
                  <Badge variant={needsAttention ? "destructive" : "outline"}>
                    {statusLabel(document.status)}
                  </Badge>
                }
                title={
                  <a
                    className="underline-offset-4 hover:underline"
                    href={`/api/knowledge/documents/${document.id}/download`}
                  >
                    {document.title || document.filename}
                  </a>
                }
              />
            );
          })}
        </ResourceList>
      )}

      <Dialog onOpenChange={setUploadDialogOpen} open={uploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload organization knowledge</DialogTitle>
            <DialogDescription>
              Uploaded files become shared organization Knowledge when indexing
              completes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor={uploadInputId}>Files</Label>
            <Input
              accept=".pdf,.docx,.txt,.md,.csv,.xlsx,.pptx"
              id={uploadInputId}
              multiple
              onChange={(event) =>
                setPendingFiles(Array.from(event.target.files || []))
              }
              type="file"
            />
            {pendingFiles.length > 0 ? (
              <p className="text-muted-foreground text-sm">
                {pendingFiles.map((file) => file.name).join(", ")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              onClick={() => void uploadDocuments()}
              disabled={
                pendingFiles.length === 0 || busyDocumentId === "upload"
              }
            >
              {busyDocumentId === "upload" ? "Uploading…" : "Upload and index"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => !open && setDeleteDocument(null)}
        open={Boolean(deleteDocument)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete this document permanently?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the stored file, extracted chunks, and ingestion
              history. Project contexts that reference it will no longer
              retrieve it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyDocumentId === deleteDocument?.id}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
