"""Этап 2: вынос блоков из src/app/main.js в модули.

Ищет объявления по имени (function NAME, window.NAME = function, const NAME),
вырезает их с балансировкой скобок, удаляет заданные фрагменты и добавляет импорты.
Скрипт одноразовый: после успешного запуска список трогать не нужно.
"""
import re
import sys

PATH = "src/app/main.js"

IMPORTS = """import { trackView } from '../features/page-view/index.js';
import { updateBell, initNotifications } from '../widgets/notifications/index.js';
"""

FUNCTIONS = [
    "trackView",
    "notifSeenAt",
    "seenLikes",
    "buildNotifications",
    "updateBell",
    "markNotificationsRead",
    "renderNotifications",
]

WINDOW_FUNCTIONS = ["openNotification"]

CONSTS = ["VIEWS_KEY", "NOTIF_KEY", "NOTIF_LIKES_KEY"]

SNIPPET_PATTERNS = [
    r"document\.getElementById\('bellBtn'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\}\);\s*\n\s*\n",
    r"const closeNotifBtn\s*=\s*document\.getElementById\('closeNotifBtn'\);[\s\S]*?\n\s*\}\);\s*\n",
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
    pattern = r"^[ \t]*const\s+" + re.escape(name) + r"\s*=[^\n]*\r?\n"
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
        removed.append(("const " + name, count > 0))
    for pattern in SNIPPET_PATTERNS:
        new_source, count = re.subn(pattern, "", source, count=1)
        source = new_source
        removed.append(("фрагмент " + pattern[:32], count > 0))

    missing = [name for name, ok in removed if not ok]
    if missing:
        print("НЕ НАЙДЕНЫ: " + ", ".join(missing), file=sys.stderr)
        return 1

    marker = "import { renderTaleOfDay } from '../widgets/tale-of-day/index.js';\n"
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
