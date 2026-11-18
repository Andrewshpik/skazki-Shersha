"""Генерация отдельных страниц историй и sitemap.

Зачем: лента живёт на одной странице с якорями (#post-4) — такие ссылки
поисковики не индексируют и они плохо выглядят при пересылке. Скрипт берёт
истории из API и создаёт для каждой статическую страницу post-<id>.html
с заголовком, описанием, Open Graph и микроразметкой Article.

Запуск из корня репозитория:
    python tools/build_post_pages.py

Только стандартная библиотека: работает и локально, и в GitHub Actions.
"""
import datetime
import html
import json
import os
import sys
import urllib.request

API = os.environ.get("SHERSH_API", "https://shersh-auth.de1.netrun.io")
SITE = os.environ.get("SHERSH_SITE", "https://andrewshpik.github.io/skazki-Shersha")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — Сказки Шерша</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Сказки Шерша">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{image}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{image}">
<script type="application/ld+json">{jsonld}</script>
<style>
:root {{ color-scheme: light dark; --fg: #2c3e50; --muted: #6b7a8c; --bg: #f4f6f8; --card: #fff; --line: #e1e8ed; --gold: #c9a227; }}
@media (prefers-color-scheme: dark) {{ :root {{ --fg: #e6e6e6; --muted: #a3a3a3; --bg: #1a1a2e; --card: #1f2b4d; --line: #2a3b66; --gold: #ffd700; }} }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6; }}
main {{ max-width: 760px; margin: 0 auto; padding: 28px 18px 60px; }}
a {{ color: var(--gold); }}
h1 {{ font-size: clamp(1.5rem, 3.5vw, 2.1rem); line-height: 1.25; margin: 0 0 10px; }}
.meta {{ color: var(--muted); font-size: 0.9rem; margin-bottom: 18px; }}
img.cover {{ width: 100%; border-radius: 14px; margin-bottom: 18px; }}
.text {{ white-space: pre-wrap; font-size: 1.05rem; }}
.nav {{ display: flex; gap: 14px; flex-wrap: wrap; margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 0.95rem; }}
</style>
</head>
<body>
<main>
<article>
<h1>{title}</h1>
<div class="meta">{author} · {date} · {reading}</div>
{cover}
<div class="text">{text}</div>
</article>
<nav class="nav">
<a href="index.html#post-{id}">💬 Читать с комментариями на сайте</a>
<a href="index.html">← Все истории</a>
</nav>
</main>
</body>
</html>
"""


def esc(value):
    return html.escape(str(value or ""), quote=True)


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
    minutes = max(1, round(words / 180))
    return f"{minutes} мин чтения"


def human_date(value):
    raw = str(value or "")[:10]
    try:
        year, month, day = (int(part) for part in raw.split("-"))
        months = ["января", "февраля", "марта", "апреля", "мая", "июня",
                  "июля", "августа", "сентября", "октября", "ноября", "декабря"]
        return f"{day} {months[month - 1]} {year}"
    except Exception:
        return raw


def build_page(post):
    post_id = post.get("id")
    title = post.get("title") or "История"
    text = post.get("text") or ""
    author = post.get("author") or "Автор"
    image = post.get("image") or (SITE.rstrip("/") + "/banner.jpg")
    url = f"{SITE.rstrip('/')}/post-{post_id}.html"
    description = short(text)

    jsonld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title,
        "description": description,
        "datePublished": post.get("date"),
        "author": {"@type": "Person", "name": author},
        "image": [image],
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "publisher": {"@type": "Organization", "name": "Сказки Шерша"},
    }, ensure_ascii=False)

    cover = f'<img class="cover" src="{esc(image)}" alt="{esc(title)}" loading="lazy">' if post.get("image") else ""

    return PAGE_TEMPLATE.format(
        id=post_id,
        title=esc(title),
        description=esc(description),
        url=esc(url),
        image=esc(image),
        jsonld=jsonld.replace("</", "<\\/"),
        author=esc(author),
        date=esc(human_date(post.get("date"))),
        reading=esc(reading_time(text)),
        cover=cover,
        text=esc(text),
    )


def build_sitemap(posts):
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

    written = 0
    for post in posts:
        if not post.get("id"):
            continue
        path = os.path.join(ROOT, f"post-{post['id']}.html")
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(build_page(post))
        written += 1

    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(build_sitemap(posts))

    print(f"Готово: страниц историй {written}, sitemap обновлён")
    return 0


if __name__ == "__main__":
    sys.exit(main())
