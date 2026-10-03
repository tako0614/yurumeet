/** Restore one optimistically removed row in canonical message order. */
export function restoreDeletedMessage<
  T extends { id: string; created_at: string },
>(current: T[], snapshot: readonly T[], messageId: string): T[] {
  if (current.some((message) => message.id === messageId)) return current;
  const snapshotIndex = snapshot.findIndex(
    (message) => message.id === messageId,
  );
  if (snapshotIndex < 0) return current;

  const restored = snapshot[snapshotIndex];
  const precedes = (left: T, right: T) =>
    left.created_at < right.created_at ||
    (left.created_at === right.created_at && left.id < right.id);
  const insertAt = current.findIndex((message) => precedes(restored, message));
  const fallbackIndex = insertAt < 0 ? current.length : insertAt;
  return [
    ...current.slice(0, fallbackIndex),
    restored,
    ...current.slice(fallbackIndex),
  ];
}
