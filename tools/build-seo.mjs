#!/usr/bin/env node
/**
 * Regenerates sitemap.xml and feed.xml from the pages that actually exist.
 *
 * Run it locally with `node tools/build-seo.mjs`. CI runs it before every
 * deploy, so a new page is in the sitemap and the feed the moment it ships
 * and nobody has to remember to add it.
 *
 * Why lastmod is computed the way it is
 * -------------------------------------
 * Google only honours <lastmod> if it is "consistently and verifiably
 * accurate" — if it looks padded, the whole field gets ignored sitewide and
 * we lose the one crawl signal we have. So:
 *
 *   1. Blog posts carry their own "dateModified" in JSON-LD. That is the
 *      author's declared date and it is what the page already tells Google,
 *      so the sitemap repeats it rather than inventing a second answer.
 *   2. Other pages fall back to git: the newest commit that touched the file
 *      WITHOUT being a sitewide sweep. A commit that rewrites the nav across
 *      twenty files is a template change, not a content change, and letting
 *      it bump every lastmod at once is exactly the pattern that makes Google
 *      stop trusting the field.
 *   3. Failing all that, the first commit that added the file.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://chrisgarin.com';

/** Pages that exist but should not be in the sitemap or the feed. */
const EXCLUDE = new Set(['privacy-policy', 'terms-of-service']);

/**
 * Redirect stubs are real index.html files (GitHub Pages has no server-side
 * redirect config), so this scanner would otherwise announce every deleted
 * post to Google as a brand new page. They carry `data-redirect-stub` on the
 * <html> tag; anything with that marker is skipped here. Add the attribute to
 * any future stub and it stays out of the sitemap and the feed automatically.
 */
const REDIRECT_STUB = /<html[^>]*\sdata-redirect-stub/i;

/** A commit touching more than this many files is a template sweep. */
const SWEEP_THRESHOLD = 5;

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

/* ---------- discover pages ---------- */

function findPages(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'tools' || name === 'node_modules') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) findPages(abs, out);
    else if (name === 'index.html') out.push(abs);
  }
  return out;
}

/** "/blog/imax/index.html" -> "/blog/imax/" ; root -> "/" */
const toUrlPath = (abs) => {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  const p = rel.replace(/index\.html$/, '');
  return '/' + p;
};

/* ---------- dates ---------- */

const meta = (html, re) => (html.match(re) || [])[1] || null;

const jsonLdDate = (html, field) =>
  meta(html, new RegExp(`"${field}"\\s*:\\s*"(\\d{4}-\\d{2}-\\d{2})`));

/** Newest commit that touched this file without being a sitewide sweep. */
function lastContentCommitDate(abs) {
  const rel = relative(ROOT, abs);
  const log = git('log', '--format=%H %ad', '--date=short', '--', rel);
  if (!log) return null;
  for (const line of log.split('\n')) {
    const [sha, date] = line.split(' ');
    if (!sha) continue;
    const files = git('show', '--name-only', '--format=', sha)
      .split('\n')
      .filter(Boolean).length;
    if (files > 0 && files <= SWEEP_THRESHOLD) return date;
  }
  return null;
}

function firstCommitDate(abs) {
  const rel = relative(ROOT, abs);
  const log = git('log', '--diff-filter=A', '--format=%ad', '--date=short', '--', rel);
  if (!log) return null;
  const lines = log.split('\n').filter(Boolean);
  return lines[lines.length - 1] || null;
}

/* ---------- collect ---------- */

const pages = findPages()
  .map((abs) => {
    const urlPath = toUrlPath(abs);
    const seg = urlPath.split('/').filter(Boolean);
    if (seg.some((s) => EXCLUDE.has(s))) return null;

    const html = readFileSync(abs, 'utf8');
    if (REDIRECT_STUB.test(html)) return null;

    const declared = jsonLdDate(html, 'dateModified');
    const lastmod =
      declared ||
      lastContentCommitDate(abs) ||
      firstCommitDate(abs) ||
      new Date(statSync(abs).mtime).toISOString().slice(0, 10);

    return {
      abs,
      urlPath,
      loc: ORIGIN + urlPath,
      lastmod,
      source: declared ? 'json-ld' : 'git',
      isPost: /^\/blog\/.+\//.test(urlPath),
      title: meta(html, /<title>([^<]*)<\/title>/),
      description: meta(html, /<meta name="description" content="([^"]*)"/),
      published: jsonLdDate(html, 'datePublished'),
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.loc.localeCompare(b.loc));

/* ---------- write sitemap ---------- */

const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map((p) => `  <url>\n    <loc>${p.loc}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`)
  .join('\n')}
</urlset>
`;
writeFileSync(join(ROOT, 'sitemap.xml'), sitemap);

/* ---------- write RSS feed ---------- */
/* Google's replacement for the dead sitemap ping is lastmod plus, for feeds,
   WebSub. A feed also gives Google a second, dated discovery path into new
   posts that does not depend on it recrawling /blog/. */

const posts = pages
  .filter((p) => p.isPost)
  .sort((a, b) => (b.published || b.lastmod).localeCompare(a.published || a.lastmod));

const rfc822 = (d) => new Date(`${d}T09:00:00Z`).toUTCString();

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Field Notes | Chris Garin</title>
  <link>${ORIGIN}/blog/</link>
  <description>Brand histories and field notes from Chris Garin.</description>
  <language>en</language>
  <lastBuildDate>${rfc822(posts[0]?.lastmod || pages[0].lastmod)}</lastBuildDate>
  <atom:link href="${ORIGIN}/feed.xml" rel="self" type="application/rss+xml"/>
  <atom:link href="https://pubsubhubbub.appspot.com/" rel="hub"/>
${posts
  .map(
    (p) => `  <item>
    <title>${xmlEscape(p.title || '')}</title>
    <link>${p.loc}</link>
    <guid isPermaLink="true">${p.loc}</guid>
    <description>${xmlEscape(p.description || '')}</description>
    <pubDate>${rfc822(p.published || p.lastmod)}</pubDate>
  </item>`
  )
  .join('\n')}
</channel>
</rss>
`;
writeFileSync(join(ROOT, 'feed.xml'), feed);

/* ---------- report ---------- */

console.log(`sitemap.xml  ${pages.length} urls`);
console.log(`feed.xml     ${posts.length} posts`);
for (const p of pages) {
  console.log(`  ${p.lastmod}  ${p.source.padEnd(7)}  ${p.urlPath}`);
}
