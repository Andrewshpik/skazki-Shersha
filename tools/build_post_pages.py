"""Генерация отдельных страниц историй и тегов плюс sitemap.

Зачем: лента живёт на одной странице с якорями (#post-4) — такие ссылки
поисковики не индексируют и они плохо выглядят при пересылке. Скрипт берёт
истории из API и создаёт статические страницы:
  post-<id>.html   — история с заголовком, описанием, OG и микроразметкой;
  tag-<slug>.html  — подборка историй по хештегу;
  tags.html        — все теги одним списком.

Запуск из корня репозитория:
    python tools/build_post_pages.py

Только стандартная библиотека: работает и локально, и в GitHub Actions.
"""
import datetime
import html
import json
import os
import re
import sys
import urllib.request

API = os.environ.get("SHERSH_API", "https://shersh-auth.de1.netrun.io")
SITE = os.environ.get("SHERSH_SITE", "https://andrewshpik.github.io/skazki-Shersha")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STYLE = """
:root { color-scheme: light dark; --fg: #2c3e50; --muted: #6b7a8c; --bg: #f4f6f8; --card: #fff; --line: #e1e8ed; --gold: #c9a227; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e6e6; --muted: #a3a3a3; --bg: #1a1a2e; --card: #1f2b4d; --line: #2a3b66; --gold: #ffd700; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6; }
main { max-width: 760px; margin: 0 auto; padding: 28px 18px 60px; }
a { color: var(--gold); }
h1 { font-size: clamp(1.5rem, 3.5vw, 2.1rem); line-height: 1.25; margin: 0 0 10px; }
.meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 18px; }
img.cover { width: 100%; border-radius: 14px; margin-bottom: 18px; }
.text { white-space: pre-wrap; font-size: 1.05rem; }
.nav { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 0.95rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; margin-bottom: 14px; }
.card h2 { font-size: 1.1rem; margin: 0 0 6px; line-height: 1.35; }
.card p { margin: 0 0 8px; font-size: 0.95rem; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; }
.tag { display: inline-block; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; font-size: 0.9rem; }
"""

PAGE = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="Сказки Шерша">
<meta property="og:title" content="{og_title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{image}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{og_title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{image}">
{jsonld}<style>{style}</style>
</head>
<body>
<main>
{body}
<nav class="nav">
<a href="index.html">← Все истории</a>
<a href="tags.html">🏷 Все теги</a>
</nav>
</main>
</body>
</html>
"""

TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def esc(value):
    return html.escape(str(value or ""), quote=True)


def slugify(tag):
    lowered = str(tag or "").strip().lower()
    latin = "".join(TRANSLIT.get(char, char) for char in lowered)
    slug = re.sub(r"[^a-z0-9]+", "-", latin).strip("-")
    return slug or "tag"


def extract_tags(text):
    """Повторяет клиентскую логику: #хештеги в заголовке и тексте, до шести штук."""
    matches = re.findall(r"#([\wа-яёА-ЯЁ]+)", str(text or ""))
    unique = []
    for match in matches:
        tag = match.lower()
        if tag not in unique:
            unique.append(tag)
    return unique[:6]


def fetch_posts():
    url = API.rstrip("/") + "/api/posts"
    request = urllib.request.Request(url, headers={"User-Agent": "shersh-post-pages/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def short(text, limit=180):
    clean = " ".join(str(text or "").split())
    if len(clean) <= limit:
        return clean
    return clean[:limit].rsplit(" ", 1)[0] + "…"


def reading_time(text):
    words = len(str(text or "").split())
    return f"{max(1, round(words / 180))} мин чтения"


def human_date(value):
    raw = str(value or "")[:10]
    try:
        year, month, day = (int(part) for part in raw.split("-"))
        months = ["января", "февраля", "марта", "апреля", "мая", "июня",
                  "июля", "августа", "сентября", "октября", "ноября", "декабря"]
        return f"{day} {months[month - 1]} {year}"
    except Exception:
        return raw


def render_page(title, description, url, image, body, jsonld=None, og_type="website"):
    jsonld_block = ""
    if jsonld:
        jsonld_block = ('<script type="application/ld+json">'
                        + json.dumps(jsonld, ensure_ascii=False).replace("</", "<\\/")
                        + "</script>\n")
    return PAGE.format(
        title=esc(title),
        description=esc(description),
        url=esc(url),
        image=esc(image),
        og_type=og_type,
        og_title=esc(title),
        jsonld=jsonld_block,
        style=STYLE,
        body=body,
    )


def build_post_page(post):
    post_id = post.get("id")
    title = post.get("title") or "История"
    text = post.get("text") or ""
    author = post.get("author") or "Автор"
    image = post.get("image") or (SITE.rstrip("/") + "/banner.jpg")
    url = f"{SITE.rstrip('/')}/post-{post_id}.html"
    description = short(text)

    cover = f'<img class="cover" src="{esc(image)}" alt="{esc(title)}" loading="lazy">' if post.get("image") else ""
    body = (
        "<article>"
        f"<h1>{esc(title)}</h1>"
        f'<div class="meta">{esc(author)} · {esc(human_date(post.get("date")))} · {esc(reading_time(text))}</div>'
        f"{cover}"
        f'<div class="text">{esc(text)}</div>'
        "</article>"
        '<nav class="nav">'
        f'<a href="index.html#post-{post_id}">💬 Читать с комментариями на сайте</a>'
        "</nav>"
    )
    jsonld = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title,
        "description": description,
        "datePublished": post.get("date"),
        "author": {"@type": "Person", "name": author},
        "image": [image],
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "publisher": {"@type": "Organization", "name": "Сказки Шерша"},
    }
    return render_page(f"{title} — Сказки Шерша", description, url, image, body, jsonld, "article")


def build_tag_page(tag, posts):
    slug = slugify(tag)
    url = f"{SITE.rstrip('/')}/tag-{slug}.html"
    cards = []
    for post in posts:
        excerpt = short(post.get("text"), 160)
        cards.append(
            '<div class="card">'
            f'<h2><a href="post-{post.get("id")}.html">{esc(post.get("title"))}</a></h2>'
            f'<div class="meta">{esc(post.get("author"))} · {esc(human_date(post.get("date")))}</div>'
            f"<p>{esc(excerpt)}</p>"
            "</div>"
        )
    body = (
        f"<h1>#{esc(tag)}</h1>"
        f'<div class="meta">Историй с этим тегом: {len(posts)}</div>'
        + "".join(cards)
    )
    description = f"Истории с тегом #{tag} на сайте «Сказки Шерша»"
    return slug, url, render_page(f"#{tag} — Сказки Шерша", description, url,
                                  SITE.rstrip("/") + "/banner.jpg", body)


def build_tags_index(tags):
    if tags:
        items = "".join(
            f'<a class="tag" href="tag-{slugify(tag)}.html">#{esc(tag)} <small>({count})</small></a>'
            for tag, count in tags
        )
        body = f"<h1>Все теги</h1><div class=\"tags\">{items}</div>"
    else:
        body = "<h1>Все теги</h1><p>Пока ни одного тега — добавьте #хештег в текст истории.</p>"
    url = SITE.rstrip("/") + "/tags.html"
    return render_page("Все теги — Сказки Шерша", "Истории «Сказок Шерша» по тегам",
                       url, SITE.rstrip("/") + "/banner.jpg", body)


def build_sitemap(posts, tag_urls):
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
             "  <url>",
             f"    <loc>{SITE.rstrip('/')}/</loc>",
             f"    <lastmod>{datetime.date.today().isoformat()}</lastmod>",
             "    <changefreq>daily</changefreq>",
             "    <priority>1.0</priority>",
             "  </url>"]
    for post in posts:
        lastmod = str(post.get("date") or "")[:10] or datetime.date.today().isoformat()
        lines += [
            "  <url>",
            f"    <loc>{SITE.rstrip('/')}/post-{post.get('id')}.html</loc>",
            f"    <lastmod>{lastmod}</lastmod>",
            "    <changefreq>monthly</changefreq>",
            "    <priority>0.8</priority>",
            "  </url>",
        ]
    for tag_url in tag_urls:
        lines += [
            "  <url>",
            f"    <loc>{tag_url}</loc>",
            "    <changefreq>weekly</changefreq>",
            "    <priority>0.6</priority>",
            "  </url>",
        ]
    lines += [
        "  <url>",
        f"    <loc>{SITE.rstrip('/')}/tags.html</loc>",
        "    <changefreq>weekly</changefreq>",
        "    <priority>0.5</priority>",
        "  </url>",
        "  <url>",
        f"    <loc>{SITE.rstrip('/')}/privacy.html</loc>",
        "    <changefreq>yearly</changefreq>",
        "    <priority>0.3</priority>",
        "  </url>",
    ]
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def main():
    try:
        posts = fetch_posts()
    except Exception as error:
        print(f"Не удалось получить истории: {error}", file=sys.stderr)
        return 1
    if not isinstance(posts, list):
        print("API вернул не список историй", file=sys.stderr)
        return 1

    written_posts = 0
    for post in posts:
        if not post.get("id"):
            continue
        path = os.path.join(ROOT, f"post-{post['id']}.html")
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(build_post_page(post))
        written_posts += 1

    by_tag = {}
    for post in posts:
        if not post.get("id"):
            continue
        for tag in extract_tags(f"{post.get('title') or ''} {post.get('text') or ''}"):
            by_tag.setdefault(tag, []).append(post)

    tag_urls = []
    for tag, tag_posts in sorted(by_tag.items()):
        _slug, url, page = build_tag_page(tag, tag_posts)
        path = os.path.join(ROOT, f"tag-{_slug}.html")
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(page)
        tag_urls.append(url)

    tags_ranked = sorted(by_tag.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    with open(os.path.join(ROOT, "tags.html"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(build_tags_index([(tag, len(items)) for tag, items in tags_ranked]))

    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(build_sitemap(posts, tag_urls))

    print(f"Готово: историй {written_posts}, тегов {len(tag_urls)}, sitemap обновлён")
    return 0


if __name__ == "__main__":
    sys.exit(main())
