/** A failed deletion preserves selection; a delayed one cannot reset a newer choice.
 * The theme's file goes before the selection moves, so a failure in between leaves no
 * file that would recreate the theme on its next save beside a selection already reset. */
export async function deleteThemeSelection(
  id: string,
  remove: (id: string) => Promise<void>,
  selected: () => string,
  reset: () => void,
  removeFile: (id: string) => Promise<void> = async () => {},
): Promise<void> {
  await remove(id);
  try {
    await removeFile(id);
  } finally {
    if (selected() === id) reset();
  }
}
