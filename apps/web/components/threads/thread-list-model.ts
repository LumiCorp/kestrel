export type ThreadListItem = {
  id: string;
  title: string;
  updatedAt: string;
  unreadCount: number;
};

export type ThreadSort = "recent" | "oldest" | "title" | "unread";

export function filterAndSortThreads(
  threads: ThreadListItem[],
  query: string,
  sort: ThreadSort
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? threads.filter((thread) =>
        thread.title.toLocaleLowerCase().includes(normalizedQuery)
      )
    : threads;

  return [...filtered].sort((left, right) => {
    if (sort === "title") {
      return left.title.localeCompare(right.title);
    }
    if (sort === "oldest") {
      return (
        new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()
      );
    }
    if (sort === "unread") {
      return (
        right.unreadCount - left.unreadCount ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    }
    return (
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
  });
}
