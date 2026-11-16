"""Базовые тесты API «Сказок Шерша».

Запуск из папки shersh-auth:  python -m pytest tests -q
Сеть и Supabase не нужны — слой БД подменяется заглушкой.
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as shersh  # noqa: E402


@pytest.fixture
def client():
    shersh.app.config.update(TESTING=True)
    shersh._ratelimit_slots.clear()
    return shersh.app.test_client()


@pytest.fixture
def db(monkeypatch):
    """Простая замена Supabase: словарь таблиц и операции над ним."""
    state = {
        "profiles": [],
        "posts": [],
        "comments": [],
        "likes": [],
        "banned": [],
        "reports": [],
        "bind_codes": [],
        "reset_codes": [],
        "tg_sessions": [],
    }

    def select(table, params=None):
        params = params or {}
        rows = list(state.get(table, []))
        for key, value in params.items():
            if key in ("select", "order", "limit", "offset"):
                continue
            if isinstance(value, str) and value.startswith("eq."):
                rows = [r for r in rows if str(r.get(key)) == value[3:]]
        return rows

    def insert(table, payload, params=None):
        row = dict(payload)
        state.setdefault(table, []).append(row)
        return [row]

    def update(table, payload, filter_field, filter_value, params=None):
        for row in state.get(table, []):
            if str(row.get(filter_field)) == str(filter_value):
                row.update(payload)
        return []

    def delete(table, filter_field, filter_value):
        state[table] = [r for r in state.get(table, [])
                        if str(r.get(filter_field)) != str(filter_value)]

    monkeypatch.setattr(shersh, "db_select", select)
    monkeypatch.setattr(shersh, "db_insert", insert)
    monkeypatch.setattr(shersh, "db_update", update)
    monkeypatch.setattr(shersh, "db_delete", delete)
    monkeypatch.setattr(shersh, "_db_cleanup", lambda table: None)
    return state


def auth(name):
    return {"Authorization": "Bearer " + shersh.issue_token(name)}


def make_profile(db, name="Шерш", password="shersh2026", **extra):
    row = {
        "name": name,
        "nickname": "@" + name,
        "bio": "",
        "avatar": "",
        "is_admin": False,
        "password_hash": shersh.hash_password(password),
    }
    row.update(extra)
    db["profiles"].append(row)
    return row


# --- Токены ---

def test_token_roundtrip():
    token = shersh.issue_token("Шерш")
    assert shersh._token_name(token) == "Шерш"


def test_token_tampered_returns_empty():
    token = shersh.issue_token("Шерш")
    raw, _, _sig = token.rpartition(".")
    assert shersh._token_name(raw + ".deadbeef") == ""


def test_expired_token_rejected():
    import base64
    import hashlib
    import hmac
    import json

    payload = json.dumps({"n": "Шерш", "e": int(time.time()) - 10}, separators=(",", ":"))
    raw = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    sig = hmac.new(shersh._TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()
    assert shersh._token_name(raw + "." + sig) == ""


# --- Вход ---

def test_login_unknown_user(client, db):
    resp = client.post("/api/login", json={"name": "Никто", "password": "x"})
    assert resp.status_code == 404


def test_login_wrong_password(client, db):
    make_profile(db)
    resp = client.post("/api/login", json={"name": "Шерш", "password": "неверный"})
    assert resp.status_code == 401


def test_login_ok_returns_valid_token(client, db):
    make_profile(db, is_admin=True)
    resp = client.post("/api/login", json={"name": "Шерш", "password": "shersh2026"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["user"]["name"] == "Шерш"
    assert data["user"]["is_admin"] is True
    assert shersh._token_name(data["token"]) == "Шерш"


def test_login_banned_user_forbidden(client, db):
    make_profile(db)
    db["banned"].append({"name": "Шерш", "reason": "спам"})
    resp = client.post("/api/login", json={"name": "Шерш", "password": "shersh2026"})
    assert resp.status_code == 403


# --- Защита эндпоинтов ---

def test_create_post_without_token(client, db):
    resp = client.post("/api/posts", json={"title": "Т", "text": "Текст"})
    assert resp.status_code == 401


def test_create_post_writes_author_from_token(client, db):
    make_profile(db)
    resp = client.post("/api/posts", json={"title": "Заголовок", "text": "Жили-были..."},
                       headers=auth("Шерш"))
    assert resp.status_code == 200


def test_reports_requires_admin(client, db):
    make_profile(db)
    assert client.get("/api/reports").status_code in (401, 403)
    assert client.get("/api/reports", headers=auth("Шерш")).status_code in (401, 403)


def test_ban_requires_admin(client, db):
    make_profile(db)
    make_profile(db, name="Петя")
    resp = client.post("/api/ban", json={"name": "Петя", "reason": "спам"},
                       headers=auth("Петя"))
    assert resp.status_code in (401, 403)


def test_admin_overview_available_for_admin(client, db):
    make_profile(db, is_admin=True)
    resp = client.get("/api/admin/overview", headers=auth("Шерш"))
    assert resp.status_code == 200


# --- Восстановление пароля ---

def test_forgot_password_without_binding(client, db):
    make_profile(db)
    resp = client.post("/api/forgot-password", json={"name": "Шерш"})
    assert resp.status_code == 400
    assert "Telegram" in resp.get_json()["error"]


# --- RSS ---

def test_rss_feed_structure_and_escaping(client, db):
    db["posts"].append({
        "id": 7,
        "title": "Сказка & про <лису>",
        "text": "Жили-были " + "очень длинно " * 80,
        "author": "Шерш",
        "date": "2026-11-16T10:00:00+00:00",
    })
    resp = client.get("/rss.xml")
    assert resp.status_code == 200
    body = resp.get_data(as_text=True)
    assert body.startswith("<?xml")
    assert "<item>" in body
    assert "&amp;" in body and "&lt;" in body
    assert "#post-7" in body
    assert "application/rss+xml" in resp.headers["Content-Type"]


def test_rss_survives_db_failure(client, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("Supabase недоступен")

    monkeypatch.setattr(shersh, "db_select", boom)
    resp = client.get("/rss.xml")
    assert resp.status_code == 200
    assert "<channel>" in resp.get_data(as_text=True)
