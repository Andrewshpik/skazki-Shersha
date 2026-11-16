import os
import hashlib
import time
import binascii
import uuid
import secrets
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")

# --- Лёгкий rate limiting по IP (простая in-memory реализация) ---
from collections import defaultdict, deque
_ratelimit_slots = defaultdict(list)


def rate_limit(limit=60, window=60):
    """Разрешает не более `limit` вызовов с одного IP за `window` секунд."""
    def decorator(fn):
        def wrapper(*args, **kwargs):
            ip = request.headers.get('X-Forwarded-For', request.remote_addr or '0.0.0.0').split(',')[0].strip()
            now = time.time()
            slots = _ratelimit_slots[ip]
            slots[:] = [t for t in slots if now - t < window]
            if len(slots) >= limit:
                return jsonify({"error": "Слишком много запросов, подождите немного"}), 429
            slots.append(now)
            return fn(*args, **kwargs)
        wrapper.__name__ = fn.__name__
        return wrapper
    return decorator

# --- Supabase подключение ---
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://unrabqyebygfqddfxqpx.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SUPABASE_REST = SUPABASE_URL.rstrip("/") + "/rest/v1"
SUPABASE_STORAGE = SUPABASE_URL.rstrip("/") + "/storage/v1"
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


# --- Фильтр нецензурной лексики ---
PROFANITY_WORDS = tuple([
    "блядь", "бляд", "хуй", "хуя", "хуе", "пизд", "ебать", "ебал", "ебет",
    "ебан", "нахуй", "оху", "заеб", "сука", "бля", "пиздец", "пизде",
    "гандон", "мудак", "мудил", "мудозвон", "пидор", "уёбок", "ёб", "ебл",
    "шлюха", "проститут", "разъеб", "выеб", "хуета", "хуйня",
])


def contains_profanity(text):
    if not text:
        return False
    low = text.lower()
    for w in PROFANITY_WORDS:
        if w in low:
            return True
    return False


# --- Хранение сессий Telegram (код -> пользователь) ---
sessions = {}
# Коды восстановления пароля: code -> {"name": ..., "expires": ts}
reset_codes = {}


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


# Привязка telegram_id к профилю (вход точно по именам)
@app.route("/api/telegram-bind", methods=["POST"])
def telegram_bind():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    telegram_id = str((data.get("telegram_id") or "")).strip()
    if not name or not telegram_id:
        return jsonify({"error": "Нет данных"}), 400
    db_update("profiles", {"telegram_id": telegram_id}, "name", name)
    return jsonify({"status": "ok"})


# Запрос кода восстановления пароля (отправляется в Telegram)
@app.route("/api/forgot-password", methods=["POST"])
@rate_limit(limit=5, window=300)  # не больше 5 запросов смены с одного IP за 5 минут
def forgot_password():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not BOT_TOKEN:
        return jsonify({"error": "Восстановление через Telegram недоступно"}), 400
    profiles = db_select("profiles", params={"select": "telegram_id", "name": f"eq.{name}"})
    if not profiles:
        return jsonify({"error": "Пользователь не найден"}), 404
    profile = profiles[0]
    tid = profile.get("telegram_id")
    if not tid:
        return jsonify({"error": "К этому профилю не привязан Telegram"}), 400

    code = str(secrets.randbelow(1000000)).zfill(6)
    reset_codes[code] = {"name": name, "expires": time.time() + 600}  # действует 10 минут
    requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage", json={
        "chat_id": tid,
        "text": f"🔑 Код восстановления пароля на сайте «Сказки Шерша»: {code}\nВведите его на сайте. Код действителен 10 минут.",
    })
    return jsonify({"status": "ok"})


# Подтверждение кода и установка нового пароля
@app.route("/api/reset-password", methods=["POST"])
@rate_limit(limit=10, window=300)
def reset_password():
    data = request.json or {}
    code = (data.get("code") or "").strip()
    new_password = data.get("new_password") or ""
    if len(new_password) < 4 or len(new_password) > 64:
        return jsonify({"error": "Пароль от 4 до 64 символов"}), 400
    entry = reset_codes.get(code)
    if not entry or time.time() > entry["expires"]:
        return jsonify({"error": "Неверный или истёкший код"}), 400
    name = entry["name"]
    del reset_codes[code]
    db_update("profiles", {"password_hash": hash_password(new_password)}, "name", name)
    return jsonify({"status": "ok"})


# --- Регистрация ---
@app.route("/api/register", methods=["POST"])
@rate_limit(limit=10, window=300)  # не больше 10 регистраций с одного IP за 5 минут
def register():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    nickname = (data.get("nickname") or "").strip()
    password = (data.get("password") or "").strip()

    if not name or not nickname or not password:
        return jsonify({"error": "Заполни все поля!"}), 400
    if len(name) > 30:
        return jsonify({"error": "Имя не длиннее 30 символов"}), 400
    if len(nickname) > 30:
        return jsonify({"error": "Ник не длиннее 30 символов"}), 400
    if len(password) < 4 or len(password) > 64:
        return jsonify({"error": "Пароль от 4 до 64 символов"}), 400

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
    return jsonify({"status": "ok", "user": {"name": name, "nickname": nickname, "bio": "", "avatar": "", "is_admin": False}})


# --- Вход ---
@app.route("/api/login", methods=["POST"])
@rate_limit(limit=20, window=60)  # попыток входа в минуту с одного IP
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
        "is_admin": bool(p.get("is_admin")),
    }})


# --- Список всех профилей (для аватаров/ников в ленте) ---
@app.route("/api/profiles", methods=["GET"])
def all_profiles():
    rows = db_select("profiles", params={"select": "name,nickname,bio,avatar,is_admin"})
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
        "is_admin": bool(p.get("is_admin")),
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


@app.route("/api/password", methods=["POST"])
@rate_limit(limit=10, window=300)  # не больше 10 смен пароля с одного IP за 5 минут
def change_password():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    old_password = (data.get("old_password") or "")
    new_password = (data.get("new_password") or "")

    if not name:
        return jsonify({"error": "Требуется авторизация"}), 401
    if len(new_password) < 4 or len(new_password) > 64:
        return jsonify({"error": "Пароль от 4 до 64 символов"}), 400

    profiles = db_select("profiles", params={"select": "*", "name": f"eq.{name}"})
    if not profiles:
        return jsonify({"error": "Пользователь не найден"}), 404
    p = profiles[0]
    if not p.get("password_hash") or not verify_password(old_password, p["password_hash"]):
        return jsonify({"error": "Неверный текущий пароль"}), 401

    db_update("profiles", {"password_hash": hash_password(new_password)}, "name", name)
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
@rate_limit(limit=10, window=60)  # не больше 10 постов в минуту с одного IP
def create_post():
    data = request.json or {}
    title = (data.get("title") or "").strip()
    text = (data.get("text") or "").strip()
    author = (data.get("author") or "").strip()
    image = data.get("image") or None
    if not title or not text or not author:
        return jsonify({"error": "Заполни заголовок, текст и автора!"}), 400
    if len(title) > 200:
        return jsonify({"error": "Заголовок не длиннее 200 символов"}), 400
    if len(text) > 20000:
        return jsonify({"error": "Текст не длиннее 20 000 символов"}), 400
    if contains_profanity(title) or contains_profanity(text):
        return jsonify({"error": "Текст содержит нецензурные выражения"}), 400
    row = db_insert("posts", {"title": title, "text": text, "author": author,
                              "image": image, "likes": 0})[0]
    return jsonify({"status": "ok", "post": row})


@app.route("/api/posts/<int:post_id>", methods=["PATCH"])
@rate_limit(limit=20, window=60)  # не больше 20 редактирований поста в минуту
def update_post(post_id):
    data = request.json or {}
    payload = {}
    if "title" in data: payload["title"] = (data.get("title") or "").strip()
    if "text" in data: payload["text"] = (data.get("text") or "").strip()
    if "image" in data: payload["image"] = data.get("image") or None
    if "title" in payload and len(payload["title"]) > 200:
        return jsonify({"error": "Заголовок не длиннее 200 символов"}), 400
    if "text" in payload and len(payload["text"]) > 20000:
        return jsonify({"error": "Текст не длиннее 20 000 символов"}), 400
    if not payload:
        return jsonify({"error": "Нет данных для обновления"}), 400
    db_update("posts", payload, "id", post_id)
    return jsonify({"status": "ok"})


@app.route("/api/posts/<int:post_id>", methods=["DELETE"])
def delete_post(post_id):
    data = request.json or {}
    user = (data.get("user") or "").strip()
    # проверяем права: автор поста или админ
    posts = db_select("posts", params={"select": "author", "id": f"eq.{post_id}"})
    if not posts:
        return jsonify({"error": "Пост не найден"}), 404
    author = posts[0]["author"]
    if not user:
        return jsonify({"error": "Требуется авторизация"}), 401
    if user == author:
        db_delete("posts", "id", post_id)
        return jsonify({"status": "ok"})
    # проверяем, является ли пользователь админом
    profiles = db_select("profiles", params={"select": "is_admin", "name": f"eq.{user}"})
    is_admin = bool(profiles and profiles[0].get("is_admin"))
    if is_admin:
        db_delete("posts", "id", post_id)
        return jsonify({"status": "ok"})
    return jsonify({"error": "Нет прав на удаление этого поста"}), 403


# --- Лайки ---
@app.route("/api/posts/<int:post_id>/like", methods=["POST"])
@rate_limit(limit=30, window=60)  # не больше 30 лайков в минуту с одного IP
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
@rate_limit(limit=20, window=60)  # не больше 20 комментариев в минуту с одного IP
def add_comment(post_id):
    data = request.json or {}
    author = (data.get("author") or "").strip()
    text = (data.get("text") or "").strip()
    image = data.get("image") or None
    if not author and not text and not image:
        return jsonify({"error": "Пустой комментарий"}), 400
    if len(text) > 3000:
        return jsonify({"error": "Комментарий не длиннее 3000 символов"}), 400
    if contains_profanity(text):
        return jsonify({"error": "Комментарий содержит нецензурные выражения"}), 400
    row = db_insert("comments", {"post_id": post_id, "author": author or "Аноним",
                                  "text": text, "image": image})[0]
    return jsonify({"status": "ok", "comment": row})


@app.route("/api/comments/<int:comment_id>", methods=["PATCH"])
@rate_limit(limit=20, window=60)
def update_comment(comment_id):
    data = request.json or {}
    user = (data.get("user") or "").strip()
    text = (data.get("text") or "").strip()
    if not user:
        return jsonify({"error": "Требуется авторизация"}), 401
    if not text:
        return jsonify({"error": "Пустой комментарий"}), 400
    if len(text) > 3000:
        return jsonify({"error": "Комментарий не длиннее 3000 символов"}), 400
    if contains_profanity(text):
        return jsonify({"error": "Комментарий содержит нецензурные выражения"}), 400

    comments = db_select("comments", params={"select": "author", "id": f"eq.{comment_id}"})
    if not comments:
        return jsonify({"error": "Комментарий не найден"}), 404
    if comments[0]["author"] != user:
        return jsonify({"error": "Можно редактировать только свой комментарий"}), 403

    db_update("comments", {"text": text}, "id", comment_id)
    return jsonify({"status": "ok"})


@app.route("/api/comments/<int:comment_id>", methods=["DELETE"])
def delete_comment(comment_id):
    data = request.json or {}
    user = (data.get("user") or "").strip()
    # проверяем: автор комментария или админ
    comments = db_select("comments", params={"select": "author", "id": f"eq.{comment_id}"})
    if not comments:
        return jsonify({"error": "Комментарий не найден"}), 404
    comment_author = comments[0]["author"]
    if not user:
        return jsonify({"error": "Требуется авторизация"}), 401
    if user == comment_author:
        db_delete("comments", "id", comment_id)
        return jsonify({"status": "ok"})
    profiles = db_select("profiles", params={"select": "is_admin", "name": f"eq.{user}"})
    is_admin = bool(profiles and profiles[0].get("is_admin"))
    if is_admin:
        db_delete("comments", "id", comment_id)
        return jsonify({"status": "ok"})
    return jsonify({"error": "Нет прав на удаление комментария"}), 403


@app.route("/api/upload", methods=["POST"])
@rate_limit(limit=30, window=60)  # не больше 30 загрузок файлов в минуту
def upload_image():
    """Принимает base64-изображение, загружает в Supabase Storage, возвращает публичный URL."""
    data = request.json or {}
    base64_data = data.get("image") or ""
    if not base64_data:
        return jsonify({"error": "Нет данных изображения"}), 400
    if not base64_data.startswith("data:image/"):
        return jsonify({"error": "Недопустимый формат изображения"}), 400

    try:
        header, b64 = base64_data.split(",", 1)
        image_bytes = binascii.a2b_base64(b64)
    except Exception:
        return jsonify({"error": "Некорректная кодировка изображения"}), 400

    # проверка размера (≤ 4 МБ) и типа
    if len(image_bytes) > 4 * 1024 * 1024:
        return jsonify({"error": "Файл больше 4 МБ"}), 400
    mime = header.split(";")[0].split(":")[1] if ":" in header.split(";")[0] else "image/jpeg"
    ext = "jpg" if "jpeg" in mime else ("png" if "png" in mime else ("webp" if "webp" in mime else "jpg"))

    fname = f"{uuid.uuid4().hex}.{ext}"
    storage_headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
        "Content-Type": mime,
    }
    up = requests.post(
        f"{SUPABASE_STORAGE}/object/images/{fname}",
        headers=storage_headers, data=image_bytes, timeout=30,
    )
    if up.status_code not in (200, 201):
        return jsonify({"error": "Не удалось загрузить файл"}), 500

    public_url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/public/images/{fname}"
    return jsonify({"status": "ok", "url": public_url})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)