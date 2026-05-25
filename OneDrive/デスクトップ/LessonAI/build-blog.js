'use strict';

const { readFileSync, writeFileSync, mkdirSync, readdirSync } = require('fs');
const { join } = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const POSTS_DIR = join(__dirname, 'blog', 'posts');
const OUT_DIR   = join(__dirname, 'blog');

const GA_ID      = 'G-P60FCMBP1W';
const ADSENSE_ID = 'ca-pub-6369944794094649';
const SITE_URL   = 'https://lessonai.jp';
const SITE_NAME  = 'LessonAI';

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function head({ title, description, slug, date }) {
  const url       = slug ? `${SITE_URL}/blog/${slug}/` : `${SITE_URL}/blog/`;
  const fullTitle = slug ? `${title} | ${SITE_NAME}ブログ` : `ブログ | ${SITE_NAME}`;
  const cssRoot   = slug ? '../../' : '../';
  return `  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${url}" />
  <meta property="og:type"        content="${slug ? 'article' : 'website'}" />
  <meta property="og:title"       content="${esc(fullTitle)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url"         content="${url}" />
  <meta property="og:site_name"   content="${SITE_NAME}" />
  ${date ? `<meta property="article:published_time" content="${date}" />` : ''}
  <meta name="twitter:card"        content="summary" />
  <meta name="twitter:title"       content="${esc(fullTitle)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');</script>
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_ID}" crossorigin="anonymous"></script>
  <link rel="stylesheet" href="${cssRoot}styles.css" />
  <link rel="stylesheet" href="${cssRoot}blog/blog.css" />`;
}

function nav(active) {
  return `<nav class="blog-nav">
  <a class="brand-link" href="/"><span class="brand-mark">L</span> ${SITE_NAME}</a>
  <a href="/blog/" ${active === 'list' ? 'aria-current="page"' : ''}>ブログ</a>
  <a href="/" ${active === 'home' ? 'aria-current="page"' : ''}>教材を作る</a>
</nav>`;
}

function siteFooter() {
  return `<footer class="site-footer">
  <a href="/terms.html">利用規約</a>
  <a href="/privacy.html">プライバシーポリシー</a>
  <a href="/blog/">ブログ</a>
</footer>`;
}

// ── 記事ページ生成 ─────────────────────────────────────────
function buildPost(meta, htmlContent) {
  const outDir = join(OUT_DIR, meta.slug);
  mkdirSync(outDir, { recursive: true });

  const html = `<!doctype html>
<html lang="ja">
<head>
${head(meta)}
</head>
<body>
${nav('list')}
<main class="blog-main">
  <article class="blog-article">
    <header class="article-header">
      <p class="article-date"><time datetime="${meta.date}">${formatDate(meta.date)}</time></p>
      <h1>${esc(meta.title)}</h1>
      <p class="article-desc">${esc(meta.description)}</p>
    </header>
    <div class="markdown-output article-body">
${htmlContent}
    </div>
    <footer class="article-footer">
      <a href="/blog/" class="back-link">← 記事一覧へ</a>
    </footer>
  </article>
</main>
${siteFooter()}
</body>
</html>`;

  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
  console.log(`  ✓ /blog/${meta.slug}/index.html`);
}

// ── 一覧ページ生成 ─────────────────────────────────────────
function buildIndex(posts) {
  const cards = posts.map(p => `
    <a class="post-card" href="/blog/${p.slug}/">
      <p class="post-date"><time datetime="${p.date}">${formatDate(p.date)}</time></p>
      <h2>${esc(p.title)}</h2>
      <p class="post-desc">${esc(p.description)}</p>
    </a>`).join('\n');

  const html = `<!doctype html>
<html lang="ja">
<head>
${head({ title: 'ブログ', description: `${SITE_NAME}の学習・教材作成に関するブログ記事一覧です。`, slug: '', date: '' })}
</head>
<body>
${nav('list')}
<main class="blog-main">
  <div class="blog-index">
    <header class="index-header">
      <h1>ブログ</h1>
      <p>学習・教材作成に役立つ情報をお届けします</p>
    </header>
    <div class="post-list">
${cards}
    </div>
  </div>
</main>
${siteFooter()}
</body>
</html>`;

  writeFileSync(join(OUT_DIR, 'index.html'), html, 'utf8');
  console.log('  ✓ /blog/index.html');
}

// ── メイン ────────────────────────────────────────────────
const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));

if (files.length === 0) {
  console.log('記事が見つかりません: blog/posts/*.md');
  process.exit(0);
}

const posts = files.map(file => {
  const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
  const { data, content } = matter(raw);
  const { title, description, date, slug } = data;

  if (!title || !description || !date || !slug) {
    throw new Error(`${file}: frontmatter に title / description / date / slug が必要です`);
  }

  return { title, description, date, slug, content };
}).sort((a, b) => new Date(b.date) - new Date(a.date));

console.log(`\nBuilding ${posts.length} post(s)...\n`);

for (const post of posts) {
  buildPost(post, marked.parse(post.content));
}

buildIndex(posts);
console.log('\nDone.');
