"use client";

import { XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TimeText } from "@/components/ui/time-text";
import type { Session } from "@/lib/auth-types";
import {
  createKnowledgeSourceAction,
  deleteKnowledgeDocumentAction,
  deleteKnowledgeSourceAction,
  reindexKnowledgeDocumentAction,
  updateKnowledgeSourceAction,
} from "./actions";
import {
  buildKnowledgeExplorerItems,
  type DocumentRecord,
  type DocumentsResponse,
  type ExtractedSource,
  emptySourceForm,
  filterKnowledgeExplorerItems,
  getKnowledgeExplorerItemDetails,
  getKnowledgeExplorerItemName,
  getSourceForm,
  type KnowledgeExplorerFilters,
  type SourceForm,
  type SourceRecord,
  type SourcesResponse,
} from "./knowledge-explorer";

const defaultExplorerFilters: KnowledgeExplorerFilters = {
  type: "all",
  name: "",
  details: "",
  status: "all",
};

function formatFileSize(sizeBytes: number) {
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

type InitialDocumentsPayload = Omit<DocumentsResponse, "runtime">;

type KnowledgeAnswer = {
  answer: string;
  grounded: boolean;
  model: string | null;
  sources: Array<{
    citationNumber: number;
    documentId: string;
    label: string;
    url: string;
    locations: string[];
    excerpts: Array<{
      text: string;
      pageNumber: number | null;
      sectionTitle: string | null;
    }>;
  }>;
};

export function KnowledgeClient({
  session,
  initialSources,
  initialDocuments,
  initialRuntime,
}: {
  session: Session | null;
  initialSources: SourcesResponse;
  initialDocuments: InitialDocumentsPayload;
  initialRuntime: DocumentsResponse["runtime"];
}) {
  const [data, setData] = useState<SourcesResponse | null>(initialSources);
  const [documentsData, setDocumentsData] = useState<DocumentsResponse | null>({
    ...initialDocuments,
    runtime: initialRuntime,
  });
  const [status, setStatus] = useState("");
  const [statusVariant, setStatusVariant] = useState<
    "info" | "success" | "warning" | "error"
  >("info");
  const [form, setForm] = useState<SourceForm>(emptySourceForm);
  const [busy, setBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [filePickerKey, setFilePickerKey] = useState(0);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceDialogTab, setSourceDialogTab] = useState("manual");
  const [importInput, setImportInput] = useState("");
  const [extractedSources, setExtractedSources] = useState<ExtractedSource[]>(
    []
  );
  const [importStatus, setImportStatus] = useState("");
  const [importStatusVariant, setImportStatusVariant] = useState<
    "info" | "success" | "warning" | "error"
  >("info");
  const [explorerFilters, setExplorerFilters] =
    useState<KnowledgeExplorerFilters>(defaultExplorerFilters);
  const [knowledgeQuestion, setKnowledgeQuestion] = useState("");
  const [knowledgeAnswer, setKnowledgeAnswer] =
    useState<KnowledgeAnswer | null>(null);
  const [askingKnowledge, setAskingKnowledge] = useState(false);
  const uploadInputId = useId();

  const isAdmin =
    (session?.user as { role?: string | null } | undefined)?.role === "admin";
  const currentUserId =
    (session?.user as { id?: string | null } | undefined)?.id ?? null;
  const initialDocumentsData = useMemo<DocumentsResponse>(
    () => ({
      ...initialDocuments,
      runtime: initialRuntime,
    }),
    [initialDocuments, initialRuntime]
  );

  function runAsync(action: Promise<unknown>) {
    action.catch((error) => {
      console.error(error);
    });
  }

  const loadKnowledgeData = useCallback(async () => {
    setStatus("Loading knowledge...");
    setStatusVariant("info");

    const [sourcesResponse, documentsResponse] = await Promise.all([
      fetch("/api/sources", { cache: "no-store" }),
      fetch("/api/knowledge/documents", { cache: "no-store" }),
    ]);

    const [sourcesJson, documentsJson] = await Promise.all([
      sourcesResponse.json().catch(() => ({})),
      documentsResponse.json().catch(() => ({})),
    ]);

    if (!sourcesResponse.ok) {
      setStatus(sourcesJson.error || "Failed to load sources");
      setStatusVariant("error");
      return;
    }

    if (!documentsResponse.ok) {
      setStatus(documentsJson.error || "Failed to load knowledge documents");
      setStatusVariant("error");
      return;
    }

    setData(sourcesJson);
    setDocumentsData(documentsJson);
    setStatus("");
  }, []);

  useEffect(() => {
    setData(initialSources);
  }, [initialSources]);

  useEffect(() => {
    setDocumentsData(initialDocumentsData);
  }, [initialDocumentsData]);

  const sources = useMemo(
    () => [...(data?.github.sources ?? []), ...(data?.youtube.sources ?? [])],
    [data]
  );

  const explorerItems = useMemo(
    () =>
      buildKnowledgeExplorerItems({
        sources,
        documents: documentsData?.documents ?? [],
      }),
    [documentsData?.documents, sources]
  );

  const filteredExplorerItems = useMemo(
    () => filterKnowledgeExplorerItems(explorerItems, explorerFilters),
    [explorerFilters, explorerItems]
  );

  function resetUploadDialog() {
    setPendingFiles([]);
    setFilePickerKey((value) => value + 1);
  }

  function removePendingFile(index: number) {
    setPendingFiles((current) =>
      current.filter((_, itemIndex) => itemIndex !== index)
    );
    setFilePickerKey((value) => value + 1);
  }

  function resetExplorerFilters() {
    setExplorerFilters(defaultExplorerFilters);
  }

  function resetSourceDialog() {
    setForm(emptySourceForm);
    setSourceDialogTab("manual");
    setImportInput("");
    setExtractedSources([]);
    setImportStatus("");
    setImportStatusVariant("info");
  }

  function handleUploadDialogChange(open: boolean) {
    setUploadDialogOpen(open);
    if (!open) {
      resetUploadDialog();
    }
  }

  function handleSourceDialogChange(open: boolean) {
    setSourceDialogOpen(open);
    if (!open) {
      resetSourceDialog();
    }
  }

  function openCreateSourceDialog() {
    resetSourceDialog();
    setSourceDialogOpen(true);
  }

  function openEditSourceDialog(source: SourceRecord) {
    resetSourceDialog();
    setForm(getSourceForm(source));
    setSourceDialogOpen(true);
  }

  async function submitSource() {
    setBusy(true);

    const body: Parameters<typeof createKnowledgeSourceAction>[0] =
      form.type === "github"
        ? {
            type: "github",
            label: form.label,
            repo: form.repo,
            branch: form.branch,
          }
        : {
            type: "youtube",
            label: form.label,
            channelId: form.channelId,
            handle: form.handle,
          };

    const result = form.id
      ? await updateKnowledgeSourceAction({
          body,
          sourceId: form.id,
        })
      : await createKnowledgeSourceAction(body);
    setBusy(false);

    if (!result.ok) {
      setStatus(result.error || "Failed to save source");
      setStatusVariant("error");
      toast.error(result.error || "Failed to save source");
      return;
    }

    const nextStatus =
      result.message || (form.id ? "Source updated." : "Source created.");
    handleSourceDialogChange(false);
    await loadKnowledgeData();
    setStatus(nextStatus);
    setStatusVariant("success");
    toast.success(nextStatus);
  }

  async function deleteSource(id: string) {
    setBusy(true);
    const result = await deleteKnowledgeSourceAction({ sourceId: id });
    setBusy(false);

    if (!result.ok) {
      setStatus(result.error || "Failed to delete source");
      setStatusVariant("error");
      toast.error(result.error || "Failed to delete source");
      return;
    }

    await loadKnowledgeData();
    setStatus(result.message || "Source deleted.");
    setStatusVariant("success");
    toast.success(result.message || "Source deleted.");
  }

  async function syncSources(sourceId?: string) {
    setBusy(true);
    const response = await fetch(
      sourceId ? `/api/sync/${sourceId}` : "/api/sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    const json = await response.json().catch(() => ({}));
    setBusy(false);

    const nextStatus = response.ok
      ? json.message || "Sync started."
      : json.error || "Sync failed";

    setStatus(nextStatus);
    setStatusVariant(response.ok ? "success" : "error");

    if (response.ok) {
      toast.success(nextStatus);
      await loadKnowledgeData();
      return;
    }

    toast.error(nextStatus);
  }

  async function uploadDocuments() {
    if (pendingFiles.length === 0) {
      return;
    }

    setBusy(true);

    try {
      const uploadMessages: string[] = [];

      for (const file of pendingFiles) {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch("/api/knowledge/documents", {
          method: "POST",
          body: formData,
        });
        const json = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(json.error || `Failed to upload ${file.name}`);
        }

        if (json.message) {
          uploadMessages.push(String(json.message));
        }
      }

      handleUploadDialogChange(false);
      await loadKnowledgeData();
      setStatus(uploadMessages.at(-1) || "Document upload started.");
      setStatusVariant("success");
      toast.success(uploadMessages.at(-1) || "Document upload started.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setStatus(message);
      setStatusVariant("error");
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function reindexDocument(id: string) {
    setBusy(true);
    const result = await reindexKnowledgeDocumentAction({ documentId: id });
    setBusy(false);

    if (!result.ok) {
      setStatus(result.error || "Failed to reindex document");
      setStatusVariant("error");
      toast.error(result.error || "Failed to reindex document");
      return;
    }

    await loadKnowledgeData();
    setStatus(result.message || "Reindex started.");
    setStatusVariant("success");
    toast.success(result.message || "Reindex started.");
  }

  async function deleteDocument(id: string) {
    setBusy(true);
    const result = await deleteKnowledgeDocumentAction({ documentId: id });
    setBusy(false);

    if (!result.ok) {
      setStatus(result.error || "Failed to delete document");
      setStatusVariant("error");
      toast.error(result.error || "Failed to delete document");
      return;
    }

    await loadKnowledgeData();
    setStatus(result.message || "Document deleted.");
    setStatusVariant("success");
    toast.success(result.message || "Document deleted.");
  }

  async function extractSources() {
    setBusy(true);
    const response = await fetch("/api/sources/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        configs: [{ filename: "pasted-config.txt", content: importInput }],
      }),
    });
    const json = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      const message = json.error || "Failed to extract sources";
      setImportStatus(message);
      setImportStatusVariant("error");
      toast.error(message);
      return;
    }

    const nextSources = (json.sources || []) as ExtractedSource[];
    setExtractedSources(nextSources);
    setImportStatus(`Found ${nextSources.length} possible source(s).`);
    setImportStatusVariant(nextSources.length > 0 ? "success" : "warning");
  }

  async function addExtractedSource(source: ExtractedSource) {
    setBusy(true);
    const actionInput: Parameters<typeof createKnowledgeSourceAction>[0] =
      source.type === "github"
        ? {
            type: "github",
            label: source.label,
            repo: source.repo,
            branch: source.branch,
          }
        : {
            type: "youtube",
            label: source.label,
            channelId: source.channelId,
            handle: source.handle,
          };
    const result = await createKnowledgeSourceAction(actionInput);
    setBusy(false);

    if (!result.ok) {
      const message = result.error || "Failed to add source";
      setImportStatus(message);
      setImportStatusVariant("error");
      toast.error(message);
      return;
    }

    await loadKnowledgeData();
    setImportStatus(`Added ${source.label}.`);
    setImportStatusVariant("success");
    setStatus(`Added ${source.label}.`);
    setStatusVariant("success");
    toast.success(`Added ${source.label}.`);
  }

  async function askKnowledge() {
    const question = knowledgeQuestion.trim();
    if (question.length < 3) {
      return;
    }

    setAskingKnowledge(true);
    setKnowledgeAnswer(null);
    try {
      const response = await fetch("/api/knowledge/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const json = (await response.json().catch(() => ({}))) as Partial<
        KnowledgeAnswer & { error: string }
      >;

      if (!response.ok) {
        throw new Error(json.error || "Knowledge answer failed");
      }

      setKnowledgeAnswer(json as KnowledgeAnswer);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Knowledge answer failed";
      setStatus(message);
      setStatusVariant("error");
      toast.error(message);
    } finally {
      setAskingKnowledge(false);
    }
  }

  function canManageDocument(document: DocumentRecord) {
    return (
      isAdmin || (currentUserId && document.uploaderUserId === currentUserId)
    );
  }

  const sourceCount = data?.total ?? 0;
  const documentCount = documentsData?.total ?? 0;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        actions={
          <>
            <Button disabled={busy} onClick={() => setUploadDialogOpen(true)}>
              Upload
            </Button>
            {isAdmin ? (
              <Button
                disabled={busy}
                onClick={openCreateSourceDialog}
                variant="outline"
              >
                Add Source
              </Button>
            ) : null}
            {isAdmin ? (
              <Button
                disabled={busy}
                onClick={() => {
                  runAsync(syncSources());
                }}
                variant="outline"
              >
                Sync All
              </Button>
            ) : null}
          </>
        }
        eyebrow="Workspace"
        title="Knowledge"
      />

      {status ? (
        <AdminStatusBanner
          description={`${sourceCount} source(s), ${documentCount} uploaded document(s), and ${explorerItems.length} total explorer item(s) are available for the active organization.`}
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
                Get an answer grounded only in indexed organization documents.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">
                {documentsData?.readyCount ?? 0} ready
              </Badge>
              <Badge variant="outline">
                {documentsData?.runtime.retrievalStrategy === "semantic-first"
                  ? "Semantic + lexical"
                  : "Lexical"}
              </Badge>
              {documentsData?.runtime.embeddingModel ? (
                <Badge className="font-mono" variant="outline">
                  {documentsData.runtime.embeddingModel}
                </Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              runAsync(askKnowledge());
            }}
          >
            <Textarea
              aria-label="Ask a question about organization knowledge"
              disabled={askingKnowledge}
              onChange={(event) => setKnowledgeQuestion(event.target.value)}
              placeholder="What does our incident playbook require before escalation?"
              rows={3}
              value={knowledgeQuestion}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">
                Retrieved document text is treated as evidence, not as
                instructions.
              </p>
              <Button
                disabled={
                  askingKnowledge ||
                  knowledgeQuestion.trim().length < 3 ||
                  (documentsData?.readyCount ?? 0) === 0
                }
                type="submit"
              >
                {askingKnowledge ? "Searching and answering..." : "Ask"}
              </Button>
            </div>
          </form>

          {(documentsData?.readyCount ?? 0) === 0 ? (
            <AdminStatusBanner
              description="Upload a document and wait for ingestion to finish before asking grounded questions."
              title="No indexed documents are ready"
              variant="info"
            />
          ) : null}

          {knowledgeAnswer ? (
            <div className="space-y-4 border-t pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={knowledgeAnswer.grounded ? "default" : "outline"}
                >
                  {knowledgeAnswer.grounded
                    ? "Grounded answer"
                    : "Evidence insufficient"}
                </Badge>
                {knowledgeAnswer.model ? (
                  <span className="font-mono text-muted-foreground text-xs">
                    {knowledgeAnswer.model}
                  </span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6">
                {knowledgeAnswer.answer}
              </p>

              {knowledgeAnswer.sources.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="font-medium text-sm">Sources used</h3>
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
        <CardContent className="p-0">
          {explorerItems.length === 0 ? (
            <div className="p-6">
              <AdminEmptyState
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setUploadDialogOpen(true)}>
                      Upload
                    </Button>
                    {isAdmin ? (
                      <Button
                        onClick={openCreateSourceDialog}
                        variant="outline"
                      >
                        Add Source
                      </Button>
                    ) : null}
                  </div>
                }
                description="Bring in a GitHub or YouTube source, upload shared files, and everything will appear in this consolidated explorer."
                title="No knowledge items yet"
              />
            </div>
          ) : (
            <div className="overflow-hidden">
              <div className="border-b px-4 py-3">
                <div className="grid gap-2 md:grid-cols-[160px_minmax(180px,1fr)_minmax(220px,1.3fr)_160px_auto]">
                  <Select
                    onValueChange={(
                      value:
                        | "all"
                        | "source"
                        | "document"
                        | "github"
                        | "youtube"
                    ) =>
                      setExplorerFilters((current) => ({
                        ...current,
                        type: value,
                      }))
                    }
                    value={explorerFilters.type}
                  >
                    <SelectTrigger aria-label="Filter by type" className="h-8">
                      <SelectValue placeholder="All types" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      <SelectItem value="source">Sources</SelectItem>
                      <SelectItem value="document">Documents</SelectItem>
                      <SelectItem value="github">GitHub</SelectItem>
                      <SelectItem value="youtube">YouTube</SelectItem>
                    </SelectContent>
                  </Select>

                  <Input
                    aria-label="Filter by name"
                    className="h-8"
                    onChange={(event) =>
                      setExplorerFilters((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="Filter name"
                    value={explorerFilters.name}
                  />

                  <Input
                    aria-label="Filter by source or file"
                    className="h-8"
                    onChange={(event) =>
                      setExplorerFilters((current) => ({
                        ...current,
                        details: event.target.value,
                      }))
                    }
                    placeholder="Filter source or file"
                    value={explorerFilters.details}
                  />

                  <Select
                    onValueChange={(
                      value:
                        | "all"
                        | "uploaded"
                        | "processing"
                        | "ready"
                        | "partial"
                        | "failed"
                    ) =>
                      setExplorerFilters((current) => ({
                        ...current,
                        status: value,
                      }))
                    }
                    value={explorerFilters.status}
                  >
                    <SelectTrigger
                      aria-label="Filter by status"
                      className="h-8"
                    >
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="uploaded">Uploaded</SelectItem>
                      <SelectItem value="processing">Processing</SelectItem>
                      <SelectItem value="ready">Ready</SelectItem>
                      <SelectItem value="partial">Partial</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                    </SelectContent>
                  </Select>

                  <div className="flex items-center justify-end gap-2">
                    <div className="text-muted-foreground text-xs">
                      {filteredExplorerItems.length} rows
                    </div>
                    <Button
                      onClick={resetExplorerFilters}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              </div>

              {filteredExplorerItems.length === 0 ? (
                <div className="p-6">
                  <AdminEmptyState
                    action={
                      <Button onClick={resetExplorerFilters} variant="outline">
                        Clear filters
                      </Button>
                    }
                    description="No knowledge items match the current column filters."
                    title="No matching rows"
                  />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[160px]">Type</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Source / File</TableHead>
                      <TableHead className="w-[140px]">Status</TableHead>
                      <TableHead className="w-[170px]">Updated</TableHead>
                      <TableHead className="w-[220px] text-right">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredExplorerItems.map((entry) => (
                      <TableRow key={`${entry.kind}-${entry.item.id}`}>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">
                              {entry.kind === "source"
                                ? `${entry.item.type} source`
                                : "document"}
                            </Badge>
                            {entry.kind === "document" ? (
                              <Badge variant="outline">
                                {entry.item.retrievalMode === "semantic"
                                  ? "Semantic"
                                  : "Lexical"}
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="max-w-[240px] truncate font-medium">
                            {getKnowledgeExplorerItemName(entry)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="max-w-[360px] truncate text-muted-foreground text-sm">
                            {getKnowledgeExplorerItemDetails(entry)}
                          </div>
                        </TableCell>
                        <TableCell>
                          {entry.kind === "document" ? (
                            <Badge variant="outline">{entry.item.status}</Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">
                              -
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          <TimeText
                            mode="datetime"
                            value={
                              entry.kind === "source"
                                ? entry.item.updatedAt
                                : entry.item.latestRun?.updatedAt ||
                                  entry.item.updatedAt
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            {entry.kind === "source" ? (
                              isAdmin ? (
                                <>
                                  <Button
                                    disabled={busy}
                                    onClick={() =>
                                      openEditSourceDialog(entry.item)
                                    }
                                    size="sm"
                                    variant="outline"
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    disabled={busy}
                                    onClick={() => {
                                      runAsync(syncSources(entry.item.id));
                                    }}
                                    size="sm"
                                    variant="outline"
                                  >
                                    Sync
                                  </Button>
                                  <Button
                                    disabled={busy}
                                    onClick={() => {
                                      runAsync(deleteSource(entry.item.id));
                                    }}
                                    size="sm"
                                    variant="destructive"
                                  >
                                    Delete
                                  </Button>
                                </>
                              ) : null
                            ) : (
                              <>
                                <Button asChild size="sm" variant="outline">
                                  <a
                                    href={`/api/knowledge/documents/${entry.item.id}/download`}
                                  >
                                    Open
                                  </a>
                                </Button>
                                {canManageDocument(entry.item) ? (
                                  <>
                                    <Button
                                      disabled={busy}
                                      onClick={() => {
                                        runAsync(
                                          reindexDocument(entry.item.id)
                                        );
                                      }}
                                      size="sm"
                                      variant="outline"
                                    >
                                      Reindex
                                    </Button>
                                    <Button
                                      disabled={busy}
                                      onClick={() => {
                                        runAsync(deleteDocument(entry.item.id));
                                      }}
                                      size="sm"
                                      variant="destructive"
                                    >
                                      Delete
                                    </Button>
                                  </>
                                ) : null}
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog onOpenChange={handleUploadDialogChange} open={uploadDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader className="pr-8">
            <DialogTitle>Upload Documents</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <input
              accept=".pdf,.txt,.md,.csv,.json,.yaml,.yml,.html,.htm,.docx,.xlsx,.pptx,image/*"
              className="sr-only"
              id={uploadInputId}
              key={filePickerKey}
              multiple
              onChange={(event) =>
                setPendingFiles(Array.from(event.target.files ?? []))
              }
              type="file"
            />

            <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-3">
              <div className="min-w-0 text-muted-foreground text-sm">
                {pendingFiles.length > 0
                  ? `${pendingFiles.length} file${pendingFiles.length === 1 ? "" : "s"} selected`
                  : "No files selected"}
              </div>
              <Button asChild size="sm" variant="outline">
                <label
                  className="cursor-pointer whitespace-nowrap"
                  htmlFor={uploadInputId}
                >
                  Choose Files
                </label>
              </Button>
            </div>

            {pendingFiles.length > 0 ? (
              <div className="grid max-h-52 gap-2 overflow-y-auto">
                {pendingFiles.map((file, index) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
                    key={`${file.name}-${file.size}-${index}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-sm">
                        {file.name}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {formatFileSize(file.size)}
                      </div>
                    </div>
                    <Button
                      aria-label={`Remove ${file.name}`}
                      onClick={() => removePendingFile(index)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            {pendingFiles.length > 0 ? (
              <Button onClick={resetUploadDialog} variant="outline">
                Clear
              </Button>
            ) : null}
            <Button
              disabled={busy || pendingFiles.length === 0}
              onClick={() => {
                runAsync(uploadDocuments());
              }}
            >
              {busy ? "Uploading..." : "Upload To Knowledge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={handleSourceDialogChange} open={sourceDialogOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Source" : "Add Source"}</DialogTitle>
            <DialogDescription>
              {form.id
                ? "Update a source definition, then save the change back into the shared knowledge set."
                : "Create a source manually or paste copied config text to extract candidate GitHub and YouTube imports."}
            </DialogDescription>
          </DialogHeader>

          {form.id ? (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="knowledge-source-type">Type</Label>
                  <Select
                    onValueChange={(value: "github" | "youtube") =>
                      setForm((current) => ({ ...current, type: value }))
                    }
                    value={form.type}
                  >
                    <SelectTrigger id="knowledge-source-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="github">GitHub</SelectItem>
                      <SelectItem value="youtube">YouTube</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="knowledge-source-label">Label</Label>
                  <Input
                    id="knowledge-source-label"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        label: event.target.value,
                      }))
                    }
                    value={form.label}
                  />
                </div>
              </div>

              {form.type === "github" ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="knowledge-source-repo">Repository</Label>
                    <Input
                      id="knowledge-source-repo"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          repo: event.target.value,
                        }))
                      }
                      placeholder="owner/repo"
                      value={form.repo}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="knowledge-source-branch">Branch</Label>
                    <Input
                      id="knowledge-source-branch"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          branch: event.target.value,
                        }))
                      }
                      value={form.branch}
                    />
                  </div>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="knowledge-source-channel-id">
                      Channel ID
                    </Label>
                    <Input
                      id="knowledge-source-channel-id"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          channelId: event.target.value,
                        }))
                      }
                      value={form.channelId}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="knowledge-source-handle">Handle</Label>
                    <Input
                      id="knowledge-source-handle"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          handle: event.target.value,
                        }))
                      }
                      value={form.handle}
                    />
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button
                  onClick={() => handleSourceDialogChange(false)}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={!isAdmin || busy || !form.label}
                  onClick={() => {
                    runAsync(submitSource());
                  }}
                >
                  Save Source
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <Tabs onValueChange={setSourceDialogTab} value={sourceDialogTab}>
              <TabsList>
                <TabsTrigger value="manual">Manual</TabsTrigger>
                <TabsTrigger value="import">Import / OCR</TabsTrigger>
              </TabsList>

              <TabsContent value="manual">
                <div className="space-y-4 pt-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="knowledge-source-type">Type</Label>
                      <Select
                        onValueChange={(value: "github" | "youtube") =>
                          setForm((current) => ({ ...current, type: value }))
                        }
                        value={form.type}
                      >
                        <SelectTrigger id="knowledge-source-type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="github">GitHub</SelectItem>
                          <SelectItem value="youtube">YouTube</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="knowledge-source-label">Label</Label>
                      <Input
                        id="knowledge-source-label"
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            label: event.target.value,
                          }))
                        }
                        value={form.label}
                      />
                    </div>
                  </div>

                  {form.type === "github" ? (
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="knowledge-source-repo">
                          Repository
                        </Label>
                        <Input
                          id="knowledge-source-repo"
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              repo: event.target.value,
                            }))
                          }
                          placeholder="owner/repo"
                          value={form.repo}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="knowledge-source-branch">Branch</Label>
                        <Input
                          id="knowledge-source-branch"
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              branch: event.target.value,
                            }))
                          }
                          value={form.branch}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="knowledge-source-channel-id">
                          Channel ID
                        </Label>
                        <Input
                          id="knowledge-source-channel-id"
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              channelId: event.target.value,
                            }))
                          }
                          value={form.channelId}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="knowledge-source-handle">Handle</Label>
                        <Input
                          id="knowledge-source-handle"
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              handle: event.target.value,
                            }))
                          }
                          value={form.handle}
                        />
                      </div>
                    </div>
                  )}

                  <DialogFooter>
                    <Button
                      onClick={() => handleSourceDialogChange(false)}
                      variant="outline"
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={!isAdmin || busy || !form.label}
                      onClick={() => {
                        runAsync(submitSource());
                      }}
                    >
                      Create Source
                    </Button>
                  </DialogFooter>
                </div>
              </TabsContent>

              <TabsContent value="import">
                <div className="space-y-4 pt-4">
                  {importStatus ? (
                    <AdminStatusBanner
                      title={importStatus}
                      variant={importStatusVariant}
                    />
                  ) : null}

                  <div className="space-y-2">
                    <Label htmlFor="knowledge-import-input">
                      Paste configuration or source text
                    </Label>
                    <Textarea
                      className="min-h-56"
                      id="knowledge-import-input"
                      onChange={(event) => setImportInput(event.target.value)}
                      placeholder="Paste README content, config files, or raw source references..."
                      value={importInput}
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || !importInput.trim()}
                      onClick={() => {
                        runAsync(extractSources());
                      }}
                    >
                      Extract Sources
                    </Button>
                    <Button
                      onClick={() => {
                        setImportInput("");
                        setExtractedSources([]);
                        setImportStatus("");
                        setImportStatusVariant("info");
                      }}
                      variant="outline"
                    >
                      Clear
                    </Button>
                  </div>

                  {extractedSources.length === 0 ? (
                    <AdminEmptyState
                      description="Paste source material and run extraction to preview candidate imports here."
                      title="No extracted sources yet"
                    />
                  ) : (
                    <div className="grid gap-3">
                      {extractedSources.map((source, index) => (
                        <div
                          className="rounded-xl border p-4"
                          key={`${source.label}-${index}`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-medium">{source.label}</div>
                            <Badge variant="outline">{source.type}</Badge>
                          </div>
                          <div className="mt-2 text-muted-foreground text-sm">
                            {source.type === "github"
                              ? source.repo || "GitHub source"
                              : source.channelId ||
                                source.handle ||
                                "YouTube source"}
                          </div>
                          {source.unsupportedReason ? (
                            <div className="mt-2 text-amber-700 text-sm">
                              Unsupported: {source.unsupportedReason}
                            </div>
                          ) : null}
                          <div className="mt-3">
                            <Button
                              disabled={
                                busy || Boolean(source.unsupportedReason)
                              }
                              onClick={() => {
                                runAsync(addExtractedSource(source));
                              }}
                              size="sm"
                              variant="outline"
                            >
                              Add Source
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
