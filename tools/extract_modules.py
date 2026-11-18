"""Этап 2: вынос блоков из src/app/main.js в модули.

Ищет объявления по имени (function NAME, window.NAME = function, const/let NAME),
вырезает их с балансировкой скобок, удаляет заданные фрагменты и добавляет импорты.
Списки ниже меняются под каждую итерацию.
"""
import re
import sys

PATH = "src/app/main.js"

IMPORTS = """import { getActiveTag, initTagFilter, syncTagFromHash } from '../features/tag-filter/index.js';
"""

FUNCTIONS = [
    "tagHash",
    "syncTagFromHash",
]

WINDOW_FUNCTIONS = ["applyTagFilter", "filterByTag", "clearTagFilter"]

CONSTS = ["TAG_PREFIX", "activeTag"]

SNIPPET_PATTERNS = [
    r"window\.addEventListener\('hashchange', syncTagFromHash\);\s*\n\s*window\.addEventListener\('load', syncTagFromHash\);\s*\n\s*setTimeout\(syncTagFromHash, 2000\);\s*\n\s*\n",
]


def _cut_block(source, start, params_from):
    i = params_from
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
    j = brace
    while j < len(source):
        if source[j] == "{":
            depth += 1
        elif source[j] == "}":
            depth -= 1
            if depth == 0:
                end = j + 1
                while end < len(source) and source[end] in "; \t\r\n":
                    end += 1
                return source[:start] + source[end:], True
        j += 1
    return source, False


def cut_function(source, name):
    match = re.search(r"^[ \t]*(async\s+)?function\s+" + re.escape(name) + r"\s*\(", source, re.M)
    if not match:
        return source, False
    return _cut_block(source, match.start(), match.end())


def cut_window_function(source, name):
    match = re.search(r"^[ \t]*window\." + re.escape(name) + r"\s*=\s*(async\s+)?function\s*\(", source, re.M)
    if not match:
        return source, False
    return _cut_block(source, match.start(), match.end())


def cut_const(source, name):
    pattern = r"^[ \t]*(const|let)\s+" + re.escape(name) + r"\s*=[^\n]*\n"
    return re.subn(pattern, "", source, count=1, flags=re.M)


def main():
    with open(PATH, encoding="utf-8") as handle:
        source = handle.read().replace("\r\n", "\n")

    removed = []
    for name in FUNCTIONS:
        source, ok = cut_function(source, name)
        removed.append(("function " + name, ok))
    for name in WINDOW_FUNCTIONS:
        source, ok = cut_window_function(source, name)
        removed.append(("window." + name, ok))
    for name in CONSTS:
        new_source, count = cut_const(source, name)
        source = new_source
        removed.append(("const/let " + name, count > 0))
    for pattern in SNIPPET_PATTERNS:
        new_source, count = re.subn(pattern, "", source, count=1)
        source = new_source
        removed.append(("фрагмент " + pattern[:32], count > 0))

    missing = [name for name, ok in removed if not ok]
    if missing:
        print("НЕ НАЙДЕНЫ: " + ", ".join(missing), file=sys.stderr)
        return 1

    marker = "import { filterPosts } from '../features/search/index.js';\n"
    if marker not in source:
        print("Не найден блок импортов", file=sys.stderr)
        return 1
    source = source.replace(marker, marker + IMPORTS, 1)

    with open(PATH, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(source)

    print("Вынесено: " + ", ".join(name for name, _ in removed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
