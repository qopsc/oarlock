/** A failed deletion preserves selection; a delayed one cannot reset a newer choice. */
export async function deleteThemeSelection(
  id: string,
  remove: (id: string) => Promise<void>,
  selected: () => string,
  reset: () => void,
): Promise<void> {
  await remove(id);
  if (selected() === id) reset();
}
