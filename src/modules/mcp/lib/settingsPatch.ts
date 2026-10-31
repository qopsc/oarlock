export type SettingsPatch = { path: string[]; value?: unknown; remove?: true };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owns(value: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

export function settingsPatches(
  before: unknown,
  after: unknown,
  path: string[] = [],
): SettingsPatch[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    object(before) &&
    object(after) &&
    (path[path.length - 1] !== "transport" || before.type === after.type)
  ) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) =>
      owns(after, key)
        ? settingsPatches(
            owns(before, key) ? before[key] : undefined,
            after[key],
            [...path, key],
          )
        : [{ path: [...path, key], remove: true as const }],
    );
  }
  return [{ path, value: after }];
}
