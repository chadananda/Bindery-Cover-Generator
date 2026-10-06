// Export file names: <id>--<shelf-slug>--<title-slug>.png. "--" separates the parts: slugs never contain it
// (runs of non-alphanumerics collapse to one "-"), while ids and slugs do contain single hyphens (col-avesta).
export const slug = (s, fallback) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘ʻʼ`]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || fallback;
export const exportName = (book, shelfName, ext = 'png') => `${book.id}--${slug(shelfName, 'none')}--${slug(book.title, 'untitled')}.${ext}`;
export function parseExportName(name) {
  const [id, shelf, title] = String(name).replace(/\.[a-z0-9]+$/i, '').split('--');
  return { id, shelf, title };
}
