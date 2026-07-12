import { DocsShell } from "@/components/DocsShell";
import { SearchClient } from "@/components/SearchClient";
import { getNavigation } from "@/lib/content";
import { buildSerializedSearchIndex } from "@/lib/search";

export default async function SearchPage(props: { searchParams: Promise<{ q?: string }> }) {
  const searchParams = await props.searchParams;
  const [navigation, searchIndex] = await Promise.all([getNavigation(), buildSerializedSearchIndex()]);

  return (
    <DocsShell currentUrl="/search" navigation={navigation}>
      <div className="search-page-intro">
        <h1>Search the Kestrel docs</h1>
        <p>Search public guides, tutorials, CLI documentation, deployment help, and package references.</p>
      </div>
      <SearchClient
        initialResults={searchIndex.initialResults}
        serializedIndex={searchIndex.serializedIndex}
        initialQuery={searchParams.q ?? ""}
      />
    </DocsShell>
  );
}
