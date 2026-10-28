// Generates the per-language HTML pages (launcher, video, music, imprint), the root redirect, sitemap and robots.txt.
// Run with `npm run pages`; the output is committed so `vite dev` and `vite build` see plain HTML files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPRINT, LANGS, LANG_NAMES, SITE, T } from './pages-content.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const pathOf = (l, page) => `/${l}/${page ? page + '/' : ''}`;
const alternates = (page) =>
  [...LANGS.map((l) => `  <link rel="alternate" hreflang="${l}" href="${SITE}${pathOf(l, page)}">`), `  <link rel="alternate" hreflang="x-default" href="${SITE}${pathOf('en', page)}">`].join('\n');

const head = (l, page, title, desc) => `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${SITE}${pathOf(l, page)}">
${alternates(page)}
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${SITE}${pathOf(l, page)}">
  <meta name="theme-color" content="#0f1115">
  <meta name="color-scheme" content="dark light">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/png" href="/icons/icon-192.png">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`;

const ICONS = {
  video: '<path d="M4 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM17 10l5-3v10l-5-3"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  games: '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-3.9 3.1L1.5 15a3 3 0 0 0 5.2 2.2L8 16h8l1.3 1.2A3 3 0 0 0 22.5 15l-1.3-6.9A4 4 0 0 0 17.3 5z"/>',
  docs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/>',
};

const LOGO = '<svg class="logo" viewBox="0 0 192 192" aria-hidden="true"><rect width="192" height="192" rx="42" fill="var(--panel-2)"/><path d="M57 46v100l85-50z" fill="var(--accent)"/></svg>';
const INFO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>';

const footer = (l, t) => `<footer>
    <span>© Player-Online.com · ${esc(t.local)}</span>
    <a href="${pathOf(l, 'imprint')}">${esc(t.imprint)}</a>
    <nav class="langs" aria-label="${esc(t.language)}">${LANGS.map((x) => `<a href="${pathOf(x)}" hreflang="${x}" lang="${x}"${x === l ? ' aria-current="page"' : ''}>${LANG_NAMES[x]}</a>`).join('')}</nav>
  </footer>`;

const top = (l, t) => `<header class="top">
    <a class="brand" href="${pathOf(l)}">${LOGO}<span>Player Online</span></a>
    <div class="menuwrap">
      <button class="iconbtn" id="btn-about" type="button" aria-haspopup="menu" aria-expanded="false" title="${esc(t.about_menu)}" aria-label="${esc(t.about_menu)}">${INFO_ICON}</button>
      <div class="menu topmenu" id="menu-about" role="menu" hidden></div>
    </div>
  </header>`;

function launcher(l) {
  const t = T[l];
  const cat = (key, href, ext) =>
    `<a class="cat" href="${href}"${ext ? ' rel="noopener"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>${esc(t.cats[key][0])}<small>${esc(t.cats[key][1])}</small></a>`;
  return `<!doctype html>
<html lang="${l}" data-theme="oled">
<head>
  ${head(l, '', t.title, t.desc)}
</head>
<body>
<div class="page">
  ${top(l, t)}
  <main>
    <h1>${esc(t.h1)}</h1>
    <p class="lead">${esc(t.lead)}</p>
    <nav class="cats" aria-label="${esc(t.brandTag)}">
      ${cat('video', pathOf(l, 'video'))}
      ${cat('music', pathOf(l, 'music'))}
      ${cat('games', 'https://biuno.com', true)}
      ${cat('docs', 'https://open-online.com', true)}
    </nav>
    <section class="drop" id="drop">
      <p class="big">${esc(t.dropBig)}</p>
      <p>${esc(t.dropSmall)}</p>
      <div class="actions">
        <button class="btn btn--primary" id="open-file" type="button">${esc(t.openFile)}</button>
        <button class="btn" id="open-folder" type="button">${esc(t.openFolder)}</button>
      </div>
    </section>
    <div class="msg" id="msg" role="status" hidden></div>
    <section class="about"><h2>${esc(t.aboutH)}</h2><p>${esc(t.about)}</p></section>
  </main>
  ${footer(l, t)}
</div>
<div id="texts" hidden data-doc="${esc(t.msgDoc)}" data-doc-link="${esc(t.msgDocLink)}" data-game="${esc(t.msgGame)}" data-game-link="${esc(t.msgGameLink)}" data-other="${esc(t.msgOther)}"></div>
<input type="file" id="file-input" multiple hidden>
<input type="file" id="dir-input" hidden webkitdirectory>
<script type="module" src="/src/launcher.ts"></script>
</body>
</html>
`;
}

function imprint(l) {
  const t = T[l];
  const c = IMPRINT[l];
  return `<!doctype html>
<html lang="${l}" data-theme="oled">
<head>
  ${head(l, 'imprint', c.title, t.desc)}
  <meta name="robots" content="noindex, follow">
</head>
<body>
<div class="page">
  ${top(l, t)}
  <main class="legal">
    <h1>${esc(c.h1)}</h1>${c.body()}
  </main>
  ${footer(l, t)}
</div>
<script type="module" src="/src/page.ts"></script>
</body>
</html>
`;
}

const player = readFileSync(join(root, 'templates/player.html'), 'utf8');
function playerPage(l, kind) {
  const t = T[l];
  const p = t[kind];
  const alts = alternates(kind);
  return player
    .replaceAll('{{LOGO}}', LOGO)
    .replaceAll('{{LANG}}', l)
    .replaceAll('{{TITLE}}', esc(p.title))
    .replaceAll('{{DESC}}', esc(p.desc))
    .replaceAll('{{CANONICAL}}', `${SITE}${pathOf(l, kind)}`)
    .replace('{{ALTERNATES}}', alts)
    .replace('{{HOME}}', pathOf(l))
    .replace('{{H1}}', esc(p.h1))
    .replace('{{INTRO}}', esc(p.intro))
    .replace('{{SEO}}', esc(p.seo));
}

for (const l of LANGS) {
  out(`${l}/index.html`, launcher(l));
  out(`${l}/imprint/index.html`, imprint(l));
  out(`${l}/video/index.html`, playerPage(l, 'video'));
  out(`${l}/music/index.html`, playerPage(l, 'music'));
}

out('index.html', `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Player Online</title>
  <meta name="description" content="Play video, music, games and documents online.">
  <meta http-equiv="refresh" content="3; url=/en/">
  <link rel="canonical" href="${SITE}/en/">
${alternates('')}
</head>
<body>
<p><a href="/en/">English</a> · <a href="/de/">Deutsch</a> · <a href="/pl/">Polski</a> · <a href="/cs/">Čeština</a></p>
<script src="/redirect.js"></script>
</body>
</html>
`);

out('public/redirect.js', `// Sends visitors to the page in their language (/en/, /de/, /pl/, /cs/).
(function () {
  var supported = ['en', 'de', 'pl', 'cs'];
  var pick = 'en';
  var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  for (var i = 0; i < list.length; i++) {
    var code = String(list[i]).slice(0, 2).toLowerCase();
    if (supported.indexOf(code) >= 0) { pick = code; break; }
  }
  location.replace('/' + pick + '/' + location.search + location.hash);
})();
`);
out('public/CNAME', 'player-online.com\n');
out('public/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = LANGS.flatMap((l) => ['', 'video', 'music', 'imprint'].map((p) => ({ l, p })));
out('public/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls
  .map(({ l, p }) => `  <url><loc>${SITE}${pathOf(l, p)}</loc>${LANGS.map((x) => `<xhtml:link rel="alternate" hreflang="${x}" href="${SITE}${pathOf(x, p)}"/>`).join('')}</url>`)
  .join('\n')}
</urlset>
`);
console.log('pages written');
