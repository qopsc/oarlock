/** Lifetime and eviction of programmatically declared font-feature faces. */
export const derivedNames = new Set<string>();
const MAX_UNUSED_FAMILIES = 32;
type FaceGroup = { faces: FontFace[]; fonts: FontFaceSet; evict: () => void };
const faceGroups = new Map<string, FaceGroup>();
const retained = new Map<string, number>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSweep(): void {
  if (sweepTimer !== undefined) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined;
    let unused = [...faceGroups.keys()].filter(
      (name) => !retained.has(name),
    ).length;
    for (const [name, group] of faceGroups) {
      if (unused <= MAX_UNUSED_FAMILIES) break;
      if (retained.has(name) || typeof group.fonts.delete !== "function")
        continue;
      for (const face of group.faces) group.fonts.delete(face);
      group.evict();
      faceGroups.delete(name);
      derivedNames.delete(name);
      unused -= 1;
    }
  }, 0);
}

export function touchFamily(name: string): void {
  const group = faceGroups.get(name);
  if (!group) return;
  faceGroups.delete(name);
  faceGroups.set(name, group);
}

export function trackFamily(name: string, faces: FontFace[], evict: () => void): void {
  derivedNames.add(name);
  faceGroups.set(name, { faces, fonts: document.fonts, evict });
  scheduleSweep();
}

export function retainFamilies(families: string[]): {
  release: () => void;
  missing: boolean;
} {
  const names = families.filter((name) =>
    derivedNames.has(name),
  );
  for (const name of names) retained.set(name, (retained.get(name) ?? 0) + 1);
  const missing = families.some(
    (name) =>
      / \(Oarlock features \d+\)$/.test(name) && !derivedNames.has(name),
  );
  const release = () => {
    for (const name of names) {
      const count = retained.get(name) ?? 0;
      if (count <= 1) retained.delete(name);
      else retained.set(name, count - 1);
    }
    scheduleSweep();
  };
  return { release, missing };
}

