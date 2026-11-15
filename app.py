import os
import hashlib
import time
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")

# --- Supabase подключение ---
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://unrabqyebygfqddfxqpx.supabase.co/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SUPABASE_REST = SUPABASE_URL.rstrip("/") + "/rest/v1"
_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


def db_select(table, params=None):
    params = params or {}
    r = requests.get(f"{SUPABASE_REST}/{table}", headers=_HEADERS, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def db_insert(table, payload, params=None):
    r = requests.post(f"{SUPABASE_REST}/{table}", headers=_HEADERS, params=params or {}, json=payload, timeout=20)
    r.raise_for_status()
    return r.json()


def db_update(table, payload, filter_field, filter_value, params=None):
    r = requests.patch(
        f"{SUPABASE_REST}/{table}?{filter_field}=eq.{filter_value}",
        headers=_HEADERS, json=payload, params=params or {}, timeout=20,
    )
    r.raise_for_status()
    return r.json()


def db_delete(table, filter_field, filter_value):
    r = requests.delete(
        f"{SUPABASE_REST}/{table}?{filter_field}=eq.{filter_value}",
        headers=_HEADERS, timeout=20,
    )
    r.raise_for_status()
    return r.status_code


def hash_password(password, salt=None):
    if salt is None:
        salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100000)
    return salt.hex() + ":" + dk.hex()


def verify_password(password, stored):
    try:
        salt_hex, hash_hex = stored.split(":")
        salt = bytes.fromhex(salt_hex)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100000)
        return dk.hex() == hash_hex
    except Exception:
        return False


# --- Хранение сессий Telegram (код -> пользователь) ---
sessions = {}


@app.route("/", methods=["GET"])
def home():
    return {"status": "ok", "service": "Skazki Shersha API"}


# --- TeleGRAM вход (без изменений) ---
@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.json
    if "message" in data and "text" in data["message"]:
        text = data["message"]["text"]
        if text.startswith("/start "):
            code = text.split(" ")[1]
            user = data["message"]["from"]
            sessions[code] = {
                "id": user["id"],
                "first_name": user.get("first_name", "Друг"),
                "username": user.get("username", ""),
            }
            if BOT_TOKEN:
                requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage", json={
                    "chat_id": user["id"],
                    "text": "✅ Вы успешно вошли на сайт «Сказки Шерша»! Можете вернуться в браузер.",
                })
    return "ok", 200


@app.route("/check_auth", methods=["GET"])
def check_auth():
    code = request.args.get("code")
    if code in sessions:
        user_data = sessions.pop(code)
        return jsonify({"status": "ok", "user": user_data})
    return jsonify({"status": "waiting"}), 200


# --- Регистрация ---
@app.route("/api/register", methods=["POST"])
def register():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    nickname = (data.get("nickname") or "").strip()
    password = (data.get("password") or "").strip()

    if not name or not nickname or not password:
        return jsonify({"error": "Заполни все поля!"}), 400

    existing = db_select("profiles", params={"select": "name"})
    for p in existing:
        if p.get("name", "").lower() == name.lower():
            return jsonify({"error": "Это имя уже занято!"}), 409
        if p.get("nickname", "").lower() == nickname.lower():
            return jsonify({"error": "Этот ник уже занят!"}), 409

    try:
        profile = db_insert("profiles", {
            "name": name, "nickname": nickname,
            "password_hash": hash_password(password), "bio": "", "avatar": "",
        })
    except requests.HTTPError as e:
        if e.response.status_code == 409:
            return jsonify({"error": "Имя или ник уже заняты!"}), 409
        raise
    return jsonify({"status": "ok", "user": {"name": name, "nickname": nickname, "bio": "", "avatar": ""}})


# --- Вход ---
@app.route("/api/login", methods=["POST"])
def login():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    password = (data.get("password") or "").strip()

    profiles = db_select("profiles", params={"select": "*", "name": f"eq.{name}"})
    if not profiles:
        # ищем без учёта регистра
        allp = db_select("profiles", params={"select": "*"})
        profiles = [p for p in allp if p.get("name", "").lower() == name.lower()]

    if not profiles:
        return jsonify({"error": "Пользователь не найден!"}), 404
    p = profiles[0]
    if not p.get("password_hash") or not verify_password(password, p["password_hash"]):
        return jsonify({"error": "Неверный пароль!"}), 401

    return jsonify({"status": "ok", "user": {
        "name": p["name"], "nickname": p.get("nickname", ""),
        "bio": p.get("bio", ""), "avatar": p.get("avatar", ""),
    }})


# --- Список всех профилей (для аватаров/ников в ленте) ---
@app.route("/api/profiles", methods=["GET"])
def all_profiles():
    rows = db_select("profiles", params={"select": "name,nickname,bio,avatar"})
    return jsonify(rows)


# --- Профиль по имени (для страницы автора) ---
@app.route("/api/profile/<name>", methods=["GET"])
def get_profile(name):
    allp = db_select("profiles", params={"select": "*"})
    p = next((x for x in allp if x.get("name", "").lower() == name.lower()), None)
    if not p:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "name": p["name"], "nickname": p.get("nickname", ""),
        "bio": p.get("bio", ""), "avatar": p.get("avatar", ""),
    })


# --- Обновление / удаление профиля ---
@app.route("/api/profile", methods=["PATCH"])
def update_profile():
    data = request.json or {}
    old_name = (data.get("old_name") or "").strip()
    payload = {}
    if "name" in data and data.get("name"): payload["name"] = (data.get("name") or "").strip()
    if "nickname" in data and data.get("nickname"): payload["nickname"] = (data.get("nickname") or "").strip()
    if "bio" in data: payload["bio"] = (data.get("bio") or "")
    if "avatar" in data: payload["avatar"] = (data.get("avatar") or "")
    if not old_name or not payload:
        return jsonify({"error": "Нет данных"}), 400

    # Проверка уникальности нового имени/ника
    if "name" in payload:
        same = [p for p in db_select("profiles", params={"select": "*"})
                if p["name"].lower() == payload["name"].lower() and p["name"].lower() != old_name.lower()]
        if same:
            return jsonify({"error": "Это имя уже занято!"}), 409
    if "nickname" in payload:
        profs = [p for p in db_select("profiles", params={"select": "*"})
                 if p.get("nickname", "").lower() == payload["nickname"].lower()]
        if profs:
            return jsonify({"error": "Этот ник уже занят!"}), 409

    db_update("profiles", payload, "name", old_name)
    # если меняли имя — обновить его в постах и комментариях и лайках
    if "name" in payload:
        posts = db_select("posts", params={"select": "*", "author": f"eq.{old_name}"})
        for p in posts:
            db_update("posts", {"author": payload["name"]}, "id", p["id"])
        comments = db_select("comments", params={"select": "*", "author": f"eq.{old_name}"})
        for c in comments:
            db_update("comments", {"author": payload["name"]}, "id", c["id"])
        likes = db_select("likes", params={"select": "*", "user_name": f"eq.{old_name}"})
        for l in likes:
            db_update("likes", {"user_name": payload["name"]}, "post_id", l["post_id"])
    return jsonify({"status": "ok", "name": payload.get("name", old_name)})


@app.route("/api/profile", methods=["DELETE"])
def delete_profile():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "no name"}), 400
    db_delete("profiles", "name", name)
    # посты остаются, как и было в ТЗ (аккаунт удаляется, истории остаются)
    return jsonify({"status": "ok"})


@app.route("/api/liked", methods=["GET"])
def liked_posts():
    user = request.args.get("user", "").strip()
    rows = db_select("likes", params={"select": "post_id", "user_name": f"eq.{user}"}) if user else []
    return jsonify([r["post_id"] for r in rows])


# --- Посты ---
@app.route("/api/posts", methods=["GET"])
def list_posts():
    rows = db_select("posts", params={"select": "*,comments(*)", "order": "date.desc"})
    result = []
    for r in rows:
        result.append({
            "id": r["id"], "title": r["title"], "text": r["text"],
            "author": r["author"], "date": r["date"], "image": r.get("image"),
            "likes": len(r.get("likes") or []) if False else r.get("likes", 0),
            "comments": (r.get("comments") or []),
        })
    return jsonify(result)


@app.route("/api/posts", methods=["POST"])
def create_post():
    data = request.json or {}
    title = (data.get("title") or "").strip()
    text = (data.get("text") or "").strip()
    author = (data.get("author") or "").strip()
    image = data.get("image") or None
    if not title or not text or not author:
        return jsonify({"error": "Заполни заголовок, текст и автора!"}), 400
    row = db_insert("posts", {"title": title, "text": text, "author": author,
                              "image": image, "likes": 0})[0]
    return jsonify({"status": "ok", "post": row})


@app.route("/api/posts/<int:post_id>", methods=["PATCH"])
def update_post(post_id):
    data = request.json or {}
    payload = {}
    if "title" in data: payload["title"] = (data.get("title") or "").strip()
    if "text" in data: payload["text"] = (data.get("text") or "").strip()
    if "image" in data: payload["image"] = data.get("image") or None
    if not payload:
        return jsonify({"error": "Нет данных для обновления"}), 400
    db_update("posts", payload, "id", post_id)
    return jsonify({"status": "ok"})


@app.route("/api/posts/<int:post_id>", methods=["DELETE"])
def delete_post(post_id):
    db_delete("posts", "id", post_id)
    return jsonify({"status": "ok"})


# --- Лайки ---
@app.route("/api/posts/<int:post_id>/like", methods=["POST"])
def toggle_like(post_id):
    data = request.json or {}
    user = (data.get("user") or "").strip()
    if not user:
        return jsonify({"error": "no user"}), 400
    existing = db_select("likes", params={"select": "*", "post_id": f"eq.{post_id}", "user_name": f"eq.{user}"})
    posts = db_select("posts", params={"select": "likes", "id": f"eq.{post_id}"})
    current_likes = posts[0]["likes"] if posts else 0
    if existing:
        db_delete("likes", "post_id", post_id)
        db_update("posts", {"likes": max(current_likes - 1, 0)}, "id", post_id)
        return jsonify({"status": "unliked", "likes": max(current_likes - 1, 0)})
    db_insert("likes", {"post_id": post_id, "user_name": user})
    db_update("posts", {"likes": current_likes + 1}, "id", post_id)
    return jsonify({"status": "liked", "likes": current_likes + 1})


# --- Комментарии ---
@app.route("/api/posts/<int:post_id>/comments", methods=["GET"])
def list_comments(post_id):
    rows = db_select("comments", params={"select": "*", "post_id": f"eq.{post_id}", "order": "date.asc"})
    return jsonify(rows)


@app.route("/api/posts/<int:post_id>/comments", methods=["POST"])
def add_comment(post_id):
    data = request.json or {}
    author = (data.get("author") or "").strip()
    text = (data.get("text") or "").strip()
    image = data.get("image") or None
    if not author and not text and not image:
        return jsonify({"error": "Пустой комментарий"}), 400
    row = db_insert("comments", {"post_id": post_id, "author": author or "Аноним",
                                  "text": text, "image": image})[0]
    return jsonify({"status": "ok", "comment": row})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)