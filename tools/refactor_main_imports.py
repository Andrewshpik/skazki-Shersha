"""Этап 2: убираем из src/app/main.js дубли утилит, которые уже есть в shared/entities.

Скрипт ищет объявления по имени, вырезает их с балансировкой скобок
и вставляет импорты в начало файла. Никаких массовых regex-замен.
"""
import re
import sys

PATH = "src/app/main.js"

IMPORTS = """// Точка входа приложения. Общие утилиты и клиент API живут в shared.
import { API_BASE, TOKEN_KEY, POSTS_CACHE_KEY, MAX_UPLOAD_BYTES } from '../shared/config.js';
import { api, getToken, setToken, clearToken, clearSession } from '../shared/lib/api.js';
import { escapeHTML, formatDate, readingTime, normalizeForSearch } from '../shared/lib/format.js';
import { validateImageFile, compressImage, uploadImage } from '../shared/lib/images.js';
import { extractTags } from '../entities/post/model.js';

"""


def cut_function(source, name):
    """Вырезает function NAME(...) {...} вместе с отступом и хвостовыми переводами строк."""
    match = re.search(r"^[ \t]*(async\s+)?function\s+" + re.escape(name) + r"\s*\(", source, re.M)
    if not match:
        return source, False
    start = match.start()
    # сначала находим закрывающую скобку списка параметров: внутри бывают
    # значения по умолчанию вида options = {}, и их скобки нельзя путать с телом
    i = match.end()
    depth = 1
    while i < len(source) and depth > 0:
        if source[i] == "(":
            depth += 1
        elif source[i] == ")":
            depth -= 1
        i += 1
    brace = source.find("{", i)
    if brace == -1:
        return source, False
    depth = 0
    i = brace
    while i < len(source):
        char = source[i]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                while end < len(source) and source[end] in "\r\n":
                    end += 1
                return source[:start] + source[end:], True
        i += 1
    return source, False


def cut_line(source, pattern):
    """Удаляет строку по регулярному выражению (для const-объявлений)."""
    new_source, count = re.subn(pattern + r"[^\n]*\r?\n", "", source, count=1, flags=re.M)
    return new_source, count > 0


def main():
    with open(PATH, encoding="utf-8") as handle:
        source = handle.read()

    removed = []

    for name in ["getToken", "setToken", "clearToken", "clearSession", "escapeHTML",
                 "validateImageFile", "compressImage", "uploadImage", "api",
                 "extractTags", "formatDate", "normalizeForSearch", "readingTime"]:
        source, ok = cut_function(source, name)
        removed.append((name, ok))

    for name in ["API_BASE", "TOKEN_KEY", "POSTS_CACHE_KEY", "MAX_UPLOAD_BYTES"]:
        source, ok = cut_line(source, r"^[ \t]*const\s+" + re.escape(name) + r"\s*=")
        removed.append((name, ok))

    missing = [name for name, ok in removed if not ok]
    if missing:
        print("НЕ НАЙДЕНЫ: " + ", ".join(missing), file=sys.stderr)
        return 1

    # убираем шапку с комментариями о настройках API, если она осталась висеть
    source = re.sub(r"^[ \t]*// --- НАСТРОЙКИ API[^\n]*\n", "", source, count=1, flags=re.M)
    source = re.sub(r"^[ \t]*// --- Токен входа[^\n]*\n", "", source, count=1, flags=re.M)

    source = IMPORTS + source.lstrip("\r\n")

    with open(PATH, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(source)

    print("Вырезано: " + ", ".join(name for name, _ in removed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
