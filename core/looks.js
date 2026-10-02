// Looks: a snapshot of every style layer (library, each shelf, each collection). Each generation is
// stamped with the look it was made under, so design iterations can be compared and restored.

/** The project's current styles as a look snapshot. */
export const snapshotStyles = (project) => ({
  app: (project.app?.style || '').trim(),
  keyColor: project.app?.keyColor || 'magenta',
  shelves: Object.fromEntries((project.shelves || []).map((s) => [s.id, (s.style || '').trim()])),
  collections: Object.fromEntries((project.collections || []).map((c) => [c.id, (c.style || '').trim()])),
});

const canon = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().map((k) => `${k}:${canon(o[k])}`).join('|') : String(o));
export const sameStyles = (a, b) => !!a && !!b && canon(a) === canon(b);

/** Write a look's styles back onto the project. Returns what changed, so the caller can persist just that. */
export function applyStyles(project, look) {
  const changed = { app: false, shelves: [], collections: [] };
  if (project.app.style !== look.app || project.app.keyColor !== look.keyColor) {
    Object.assign(project.app, { style: look.app, keyColor: look.keyColor || project.app.keyColor });
    changed.app = true;
  }
  for (const [list, key] of [[project.shelves, 'shelves'], [project.collections, 'collections']]) {
    for (const item of list || []) {
      const s = look[key]?.[item.id];
      if (s !== undefined && s !== item.style) { item.style = s; changed[key].push(item.id); }
    }
  }
  return changed;
}

export const nextLookName = (looks) => `Look ${Math.max(0, ...looks.map((l) => +(/^Look (\d+)$/.exec(l.name)?.[1] || 0))) + 1}`;
