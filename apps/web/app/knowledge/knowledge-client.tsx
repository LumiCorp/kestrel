"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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

type KnowledgeAnswer = {
  answer: string;
  grounded: boolean;
  sources: Array<{
    citationNumber: number;
    documentId: string;
    label: string;
    url: string;
    locations: string[];
    excerpts: Array<{ text: string }>;
  }>;
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
  const [knowledgeQuestion, setKnowledgeQuestion] = useState("");
  const [knowledgeAnswer, setKnowledgeAnswer] =
    useState<KnowledgeAnswer | null>(null);
  const [askingKnowledge, setAskingKnowledge] = useState(false);
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
    const body = (await response.json().catch(() => ({}))) as DocumentsPayload & {
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

  async function askKnowledge() {
    const question = knowledgeQuestion.trim();
    if (question.length < 3) return;
    setAskingKnowledge(true);
    setKnowledgeAnswer(null);
    try {
      const response = await fetch("/api/knowledge/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const body = (await response.json().catch(() => ({}))) as KnowledgeAnswer & {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || "Knowledge answer failed");
      setKnowledgeAnswer(body);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Knowledge answer failed"
      );
    } finally {
      setAskingKnowledge(false);
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        actions={
          <Button
            disabled={busyDocumentId === "upload"}
            onClick={() => setUploadDialogOpen(true)}
          >
            Upload document
          </Button>
        }
        description="Shared material available across your organization. Add Project-only material from that Project’s context."
        eyebrow="Workspace"
        title="Organization Knowledge"
      />

      {status ? (
        <AdminStatusBanner
          description="Changes appear here as document ingestion progresses."
          title={status}
          variant={statusVariant}
        />
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle>Ask your knowledge</CardTitle>
              <CardDescription>
                Search organization documents only. Project Threads use their own approved context.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Badge variant="outline">{documentsData.readyCount} ready</Badge>
              {documentsData.processingCount > 0 ? (
                <Badge variant="outline">{documentsData.processingCount} processing</Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void askKnowledge();
            }}
          >
            <Textarea
              aria-label="Ask a question about organization knowledge"
              disabled={askingKnowledge || documentsData.readyCount === 0}
              onChange={(event) => setKnowledgeQuestion(event.target.value)}
              placeholder="What does our incident playbook require before escalation?"
              rows={3}
              value={knowledgeQuestion}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">
                Answers cite the documents used as evidence.
              </p>
              <Button
                disabled={
                  askingKnowledge ||
                  knowledgeQuestion.trim().length < 3 ||
                  documentsData.readyCount === 0
                }
                type="submit"
              >
                {askingKnowledge ? "Searching…" : "Ask"}
              </Button>
            </div>
          </form>

          {documentsData.readyCount === 0 ? (
            <AdminStatusBanner
              description="Upload a document and wait for indexing before asking grounded questions."
              title="No indexed documents are ready"
              variant="info"
            />
          ) : null}

          {knowledgeAnswer ? (
            <div className="space-y-4 border-t pt-4">
              <Badge variant={knowledgeAnswer.grounded ? "default" : "outline"}>
                {knowledgeAnswer.grounded ? "Grounded answer" : "Evidence insufficient"}
              </Badge>
              <p className="whitespace-pre-wrap text-sm leading-6">
                {knowledgeAnswer.answer}
              </p>
              {knowledgeAnswer.sources.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="font-medium text-sm">Citations</h3>
                  <div className="grid gap-2 md:grid-cols-2">
                    {knowledgeAnswer.sources.map((source) => (
                      <a
                        className="space-y-1 rounded-md border p-3 transition-colors hover:bg-muted/50"
                        href={source.url}
                        key={source.documentId}
                      >
                        <div className="font-medium text-sm">
                          [{source.citationNumber}] {source.label}
                        </div>
                        <div className="line-clamp-2 text-muted-foreground text-xs">
                          {source.excerpts[0]?.text}
                        </div>
                        {source.locations[0] ? (
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {source.locations[0]}
                          </div>
                        ) : null}
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            {documentsData.total} shared document{documentsData.total === 1 ? "" : "s"} in this organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {documentsData.documents.length === 0 ? (
            <div className="p-6">
              <AdminEmptyState
                action={<Button onClick={() => setUploadDialogOpen(true)}>Upload document</Button>}
                description="Upload a shared file here, or add private material from a Project’s context."
                title="No organization documents yet"
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Used in your Projects</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documentsData.documents.map((document) => (
                    <TableRow key={document.id}>
                      <TableCell>
                        <div className="max-w-sm space-y-1">
                          <a
                            className="font-medium text-sm hover:underline"
                            href={`/api/knowledge/documents/${document.id}/download`}
                          >
                            {document.title || document.filename}
                          </a>
                          <div className="text-muted-foreground text-xs">
                            {formatFileSize(document.sizeBytes)} · uploaded by {document.uploaderName || document.uploaderEmail || "a member"}
                          </div>
                          {document.status === "failed" && document.error ? (
                            <div className="text-destructive text-xs">{document.error}</div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={document.status === "failed" ? "destructive" : "outline"}>
                          {statusLabel(document.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {document.visibleProjectUsage.length > 0 ? (
                          <div className="flex max-w-xs flex-wrap gap-x-2 gap-y-1 text-sm">
                            {document.visibleProjectUsage.map((project) => (
                              <Link className="underline-offset-4 hover:underline" href={`/projects/${project.id}`} key={project.id}>
                                {project.name}
                              </Link>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">Not in your current Project context</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        <TimeText mode="datetime" value={document.latestRun?.updatedAt || document.updatedAt} />
                      </TableCell>
                      <TableCell>
                        {canManage(document) ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              disabled={busyDocumentId === document.id}
                              onClick={() => void reindexDocument(document.id)}
                              size="sm"
                              variant="outline"
                            >
                              Reindex
                            </Button>
                            <Button
                              disabled={busyDocumentId === document.id}
                              onClick={() => setDeleteDocument(document)}
                              size="sm"
                              variant="destructive"
                            >
                              Delete
                            </Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog onOpenChange={setUploadDialogOpen} open={uploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload organization knowledge</DialogTitle>
            <DialogDescription>
              Uploaded files become shared organization Knowledge when indexing completes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor={uploadInputId}>Files</Label>
            <Input
              accept=".pdf,.docx,.txt,.md,.csv,.xlsx,.pptx"
              id={uploadInputId}
              multiple
              onChange={(event) => setPendingFiles(Array.from(event.target.files || []))}
              type="file"
            />
            {pendingFiles.length > 0 ? (
              <p className="text-muted-foreground text-sm">
                {pendingFiles.map((file) => file.name).join(", ")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => void uploadDocuments()} disabled={pendingFiles.length === 0 || busyDocumentId === "upload"}>
              {busyDocumentId === "upload" ? "Uploading…" : "Upload and index"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={(open) => !open && setDeleteDocument(null)} open={Boolean(deleteDocument)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the stored file, extracted chunks, and ingestion history. Project contexts that reference it will no longer retrieve it.
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
