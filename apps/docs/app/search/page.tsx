import { DocsShell } from "@/components/DocsShell";
import { SearchClient } from "@/components/SearchClient";
import { getNavigation } from "@/lib/content";
import { buildSerializedSearchIndex } from "@/lib/search";

export default async function SearchPage() {
  const [navigation, searchIndex] = await Promise.all([getNavigation(), buildSerializedSearchIndex()]);

  return (
    <DocsShell currentUrl="/search" navigation={navigation}>
      <div className="search-page-intro">
        <h2>Search the Kestrel docs</h2>
        <p>
          Search spans the curated documentation set plus the archived plans and runbooks that remain part of the
          repository record.
        </p>
      </div>
      <SearchClient initialResults={searchIndex.initialResults} serializedIndex={searchIndex.serializedIndex} />
    </DocsShell>
  );
}
