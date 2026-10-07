// Export file names: <id>--<shelf-slug>--<title-slug>.png. "--" separates the parts: slugs never contain it
// (runs of non-alphanumerics collapse to one "-"), while ids and slugs do contain single hyphens (col-avesta).
export const slug = (s, fallback) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘ʻʼ`]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || fallback;
export const exportName = (book, shelfName, ext = 'png') => `${book.id}--${slug(shelfName, 'none')}--${slug(book.title, 'untitled')}.${ext}`;
export function parseExportName(name) {
  const [id, shelf, title] = String(name).replace(/\.[a-z0-9]+$/i, '').split('--');
  return { id, shelf, title };
}

// Library export: { bookId: url } of each book's current cut-out cover (full-size transparent PNG, served from R2 by
// the Worker's /img/). newOnly drops books still on the imported site cover — the importer only fetches what changed.
// The full-size original: the importer sizes it through /img?tr= on request.
export function coverUrls(project, origin, { newOnly = false } = {}) {
  const out = {};
  for (const b of project.books || []) {
    const v = (b.versions || []).find((x) => x.id === b.selected) || (b.versions || []).at(-1);
    if (!v?.cover || (newOnly && v.edit === 'current site cover')) continue;
    out[b.id] = `${origin}/img/${v.cover}`;
  }
  return out;
}
