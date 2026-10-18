export async function collectPages<T>(fetchPage: (cursor?: string) => Promise<{ entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }>): Promise<{ entries: T[] }> {
  const entries: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor); entries.push(...page.entries);
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) return { entries };
    if (seen.has(page.pageInfo.nextCursor)) throw new Error("Paseo returned a repeated page cursor. Refresh the list and try again.");
    cursor = page.pageInfo.nextCursor; seen.add(cursor);
  } while (true);
}
