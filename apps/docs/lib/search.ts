import MiniSearch from "minisearch";

import { getSearchDocuments } from "@/lib/content";
import { getDefaultSearchResults, SEARCH_FIELDS, SEARCH_STORE_FIELDS } from "@/lib/search-utils";
import type { SearchDocument } from "@/lib/types";

export async function buildSerializedSearchIndex() {
  const documents = await getSearchDocuments();
  const index = new MiniSearch<SearchDocument>({
    fields: [...SEARCH_FIELDS],
    storeFields: [...SEARCH_STORE_FIELDS],
  });
  index.addAll(documents);

  return {
    initialResults: getDefaultSearchResults(documents),
    serializedIndex: JSON.stringify(index.toJSON()),
  };
}
