#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Бэкап базы данных Supabase (таблицы профили/посты/комментарии/лайки) в JSON.
Использование:
    python backup_db.py
Создаёт файлы backups/backup-YYYY-MM-DD_HHMMSS.json в папке со скриптом.
Ключ берётся из переменной окружения SUPABASE_SERVICE_KEY (не хардкодить!).
"""
import os
import json
import datetime
import pathlib
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://unrabqyebygfqddfxqpx.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
REST = SUPABASE_URL.rstrip("/") + "/rest/v1"
TABLES = ["profiles", "posts", "comments", "likes"]

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
}


def main():
    if not SUPABASE_SERVICE_KEY:
        print("❌ Задайте переменную окружения SUPABASE_SERVICE_KEY!")
        return 1

    backup = {"created_at": datetime.datetime.utcnow().isoformat(), "tables": {}} 
    for table in TABLES:
        try:
            r = requests.get(f"{REST}/{table}?select=*", headers=HEADERS, timeout=30)
            r.raise_for_status()
            backup["tables"][table] = r.json()
            print(f"✅ {table}: {len(r.json())} строк")
        except Exception as e:
            print(f"⚠️ {table}: ошибка ({e})")

    out_dir = pathlib.Path(__file__).parent / "backups"
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    out_path = out_dir / f"backup-{stamp}.json"
    out_path.write_text(json.dumps(backup, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n💾 Сохранено: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())