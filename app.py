import os
import hashlib
import hmac
import base64
import json
import time
import binascii
import uuid
import secrets
import urllib.parse
from datetime import datetime, timedelta, timezone
import requests
from flask import Flask, request, jsonify, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")

# --- Токены входа: подписанная строка, без состояния на сервере ---
TOKEN_TTL_DAYS = 30
_TOKEN_SECRET = (os.environ.get("APP_SECRET") or BOT_TOKEN or "shersh-dev-secret").encode()


def issue_token(name):
    """Выдаёт токен вида <payload>.<подпись>, действует 30 дней."""
    payload = json.dumps({
        "n": name,
        "e": int((datetime.now(timezone.utc) + timedelta(days=TOKEN_TTL_DAYS)).timestamp()),
    }, separators=(",", ":"))
    raw = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    sig = hmac.new(_TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()
    return raw + "." + sig


def _token_name(token):
    """Возвращает имя из токена или пустую строку, если токен битый или истёк."""
    if not token or "." not in token:
        return ""
    raw, _, sig = token.rpartition(".")
    expected = hmac.new(_TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return ""
    try:
        padded = raw + "=" * (-len(raw) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    except Exception:
        return ""
    if int(payload.get("e") or 0) < int(datetime.now(timezone.utc).timestamp()):
        return ""
    return payload.get("n") or ""


def auth_user():
    """Имя пользователя из заголовка Authorization: Bearer <токен>."""
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return _token_name(header[7:].strip())
    return ""


def require_admin():
    """Имя админа по токену или пустая строка."""
    name = auth_user()
    if not name or not _is_admin_name(name):
        return ""
    return name


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


# --- Сессии Telegram и коды восстановления храним в БД: память умирает при сне/рестарте ---
def _iso_in(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _iso_now():
    return datetime.now(timezone.utc).isoformat()


def _db_cleanup(table):
    try:
        requests.delete(f"{SUPABASE_REST}/{table}?expires=lt.{_iso_now()}",
                        headers=_HEADERS, timeout=10)
    except Exception:
        pass


def _tg_send(chat_id, text):
    if not BOT_TOKEN or not chat_id:
        return
    try:
        requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                      json={"chat_id": chat_id, "text": text}, timeout=15)
    except Exception:
        pass


def _tg_send_checked(chat_id, text):
    """Отправляет сообщение и возвращает (успех, причина_ошибки)."""
    if not BOT_TOKEN:
        return False, "BOT_TOKEN не задан"
    if not chat_id:
        return False, "нет chat_id"
    try:
        r = requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                          json={"chat_id": chat_id, "text": text}, timeout=15)
        data = r.json()
        if data.get("ok"):
            return True, ""
        return False, str(data.get("description") or "Telegram отклонил отправку")
    except Exception as e:
        return False, str(e)


def _is_expired(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return datetime.now(timezone.utc) > parsed
    except Exception:
        return False


def _norm_ident(value):
    """Приводит имя или @ник к сравнимому виду: без @, без пробелов, нижний регистр."""
    return str(value or "").strip().lstrip("@").strip().lower()


def find_profile(identifier):
    """Ищет профиль по имени ИЛИ по нику (со @ и без, без учёта регистра)."""
    raw = str(identifier or "").strip()
    if not raw:
        return None
    bare = raw.lstrip("@").strip()

    for params_field, value in (("name", raw), ("name", bare),
                                ("nickname", raw), ("nickname", "@" + bare)):
        try:
            rows = db_select("profiles", params={"select": "*", params_field: f"eq.{value}"})
            if rows:
                return rows[0]
        except Exception:
            pass

    # мягкий поиск: без учёта регистра и с любым вариантом @ в нике
    try:
        allp = db_select("profiles", params={"select": "*"})
    except Exception:
        return None
    target = _norm_ident(raw)
    for p in allp:
        if _norm_ident(p.get("name")) == target or _norm_ident(p.get("nickname")) == target:
            return p
    return None


@app.route("/", methods=["GET"])
def home():
    return {"status": "ok", "service": "Skazki Shersha API"}


# --- Telegram: вход по коду, привязка профиля ---
@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.json or {}
    msg = data.get("message") or {}
    text = (msg.get("text") or "").strip()
    frm = msg.get("from") or {}
    if not text or not frm.get("id"):
        return "ok", 200

    if text.startswith("/start"):
        payload = urllib.parse.unquote(text[len("/start"):].strip())

        if not payload:
            _tg_send(frm["id"],
                     "Привет! Это бот «Сказок Шерша».\n\n"
                     "• Вход на сайт: нажмите на сайте «Войти через Telegram».\n"
                     "• Привязка для восстановления пароля: откройте профиль на сайте и нажмите «Привязать Telegram».")
            return "ok", 200

        # привязка по короткому ASCII-коду (кириллица в start-параметре Telegram не доходит)
        if payload.startswith("b_"):
            code = payload[2:].strip()
            try:
                _db_cleanup("bind_codes")
                rows = db_select("bind_codes", params={"select": "name,expires", "code": f"eq.{code}"})
            except Exception:
                rows = []
            if not rows:
                _tg_send(frm["id"], "Ссылка устарела. Нажмите на сайте «Привязать Telegram» ещё раз.")
                return "ok", 200
            row = rows[0]
            if _is_expired(row.get("expires")):
                try:
                    db_delete("bind_codes", "code", code)
                except Exception:
                    pass
                _tg_send(frm["id"], "Код привязки истёк. Нажмите на сайте «Привязать Telegram» ещё раз.")
                return "ok", 200
            name = row.get("name")
            try:
                db_update("profiles", {"telegram_id": str(frm["id"])}, "name", name)
                db_delete("bind_codes", "code", code)
                _tg_send(frm["id"], f"✅ Telegram привязан к профилю «{name}». Сюда придёт код восстановления пароля.")
            except Exception:
                _tg_send(frm["id"], "Не удалось привязать Telegram. Попробуйте позже.")
            return "ok", 200

        if payload.startswith("bind_"):
            name = payload[len("bind_"):].strip()
            try:
                profiles = db_select("profiles", params={"select": "name", "name": f"eq.{name}"})
            except Exception:
                profiles = []
            if not profiles:
                _tg_send(frm["id"], f"Профиль «{name}» не найден. Проверьте имя на сайте.")
                return "ok", 200
            try:
                db_update("profiles", {"telegram_id": str(frm["id"])}, "name", name)
                _tg_send(frm["id"], f"✅ Telegram привязан к профилю «{name}». Сюда придёт код восстановления пароля.")
            except Exception:
                _tg_send(frm["id"], "Не удалось привязать Telegram. Попробуйте позже.")
            return "ok", 200

        # вход по коду с сайта
        code = payload
        try:
            _db_cleanup("tg_sessions")
            db_delete("tg_sessions", "code", code)
            db_insert("tg_sessions", {
                "code": code, "tg_id": int(frm["id"]),
                "first_name": frm.get("first_name", "Друг"),
                "username": frm.get("username", ""),
                "expires": _iso_in(600),
            })
        except Exception:
            pass
        _tg_send(frm["id"], "✅ Вы успешно вошли на сайт «Сказки Шерша»! Можете вернуться в браузер.")
    return "ok", 200


@app.route("/check_auth", methods=["GET"])
def check_auth():
    code = request.args.get("code")
    if not code:
        return jsonify({"status": "waiting"}), 200
    try:
        rows = db_select("tg_sessions", params={"select": "*", "code": f"eq.{code}"})
    except Exception:
        rows = []
    if not rows:
        return jsonify({"status": "waiting"}), 200
    row = rows[0]
    if _is_expired(row.get("expires")):
        try:
            db_delete("tg_sessions", "code", code)
        except Exception:
            pass
        return jsonify({"status": "waiting"}), 200
    try:
        db_delete("tg_sessions", "code", code)
    except Exception:
        pass
    return jsonify({"status": "ok", "user": {
        "id": row.get("tg_id"),
        "first_name": row.get("first_name") or "Друг",
        "username": row.get("username") or "",
    }})


# Привязка telegram_id к профилю (вход точно по именам)
@app.route("/api/telegram-bind", methods=["POST"])
def telegram_bind():
    data = request.json or {}
    name = auth_user()
    telegram_id = str((data.get("telegram_id") or "")).strip()
    if not name:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    if not telegram_id:
        return jsonify({"error": "Нет данных"}), 400
    p = find_profile(name)
    if not p:
        return jsonify({"error": "Пользователь не найден"}), 404
    db_update("profiles", {"telegram_id": telegram_id}, "name", p["name"])
    return jsonify({"status": "ok"})


# Диагностика бота: проверка токена, регистрация вебхука, статус. Только для админа.
@app.route("/api/telegram/setup", methods=["POST"])
@rate_limit(limit=5, window=300)
def telegram_setup():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    password = (data.get("password") or "").strip()

    p = find_profile(name)
    if not p:
        return jsonify({"error": "Пользователь не найден"}), 404
    if not p.get("is_admin"):
        return jsonify({"error": "Нужны права администратора"}), 403
    if not p.get("password_hash") or not verify_password(password, p["password_hash"]):
        return jsonify({"error": "Неверный пароль"}), 401
    if not BOT_TOKEN:
        return jsonify({"error": "BOT_TOKEN не задан в переменных окружения"}), 400

    webhook_url = (data.get("webhook_url") or os.environ.get("WEBHOOK_URL")
                   or "https://shersh-auth.de1.netrun.io/webhook")
    result = {"webhook_url": webhook_url}

    try:
        result["getMe"] = requests.get(f"https://api.telegram.org/bot{BOT_TOKEN}/getMe", timeout=15).json()
    except Exception as e:
        result["getMe"] = {"error": str(e)}

    try:
        result["setWebhook"] = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook",
            json={"url": webhook_url, "allowed_updates": ["message"]}, timeout=20
        ).json()
    except Exception as e:
        result["setWebhook"] = {"error": str(e)}

    try:
        result["getWebhookInfo"] = requests.get(
            f"https://api.telegram.org/bot{BOT_TOKEN}/getWebhookInfo", timeout=15
        ).json()
    except Exception as e:
        result["getWebhookInfo"] = {"error": str(e)}

    return jsonify(result)


# Статус привязки Telegram: только флаг, без идентификаторов
@app.route("/api/telegram/status", methods=["GET"])
def telegram_status():
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "no name"}), 400
    p = find_profile(name)
    if not p:
        return jsonify({"error": "Пользователь не найден"}), 404
    return jsonify({"bound": bool(p.get("telegram_id"))})


# Одноразовый ASCII-код привязки: его подставляет кнопка «Привязать Telegram»
@app.route("/api/telegram/bind-code", methods=["POST"])
@rate_limit(limit=10, window=300)
def telegram_bind_code():
    data = request.json or {}
    name = auth_user()
    if not name:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    p = find_profile(name)
    if not p:
        return jsonify({"error": "Пользователь не найден"}), 404

    code = secrets.token_hex(4)
    try:
        _db_cleanup("bind_codes")
        db_delete("bind_codes", "name", p["name"])
        db_insert("bind_codes", {"code": code, "name": p["name"], "expires": _iso_in(900)})
    except Exception:
        return jsonify({"error": "Не удалось создать код привязки, попробуйте позже"}), 500
    return jsonify({"code": code, "expires_in": 900})


# Запрос кода восстановления пароля (отправляется в Telegram)
@app.route("/api/forgot-password", methods=["POST"])
@rate_limit(limit=5, window=300)  # не больше 5 запросов смены с одного IP за 5 минут
def forgot_password():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not BOT_TOKEN:
        return jsonify({"error": "Восстановление через Telegram недоступно"}), 400
    profile = find_profile(name)
    if not profile:
        return jsonify({"error": "Пользователь не найден"}), 404
    # дальше везде работаем с настоящим именем профиля, а не с тем, что ввели (@ник тоже допустим)
    name = profile.get("name") or name
    tid = profile.get("telegram_id")
    if not tid:
        return jsonify({"error": "К профилю не привязан Telegram. Войдите в профиль, нажмите «Привязать Telegram» и повторите."}), 400

    code = str(secrets.randbelow(1000000)).zfill(6)
    try:
        _db_cleanup("reset_codes")
        db_delete("reset_codes", "name", name)
        db_insert("reset_codes", {"code": code, "name": name, "expires": _iso_in(600)})
    except Exception:
        return jsonify({"error": "Не удалось создать код, попробуйте позже"}), 500

    sent, reason = _tg_send_checked(
        tid, f"🔑 Код восстановления пароля на сайте «Сказки Шерша»: {code}\nВведите его на сайте. Код действителен 10 минут."
    )
    if not sent:
        try:
            db_delete("reset_codes", "code", code)
        except Exception:
            pass
        low = reason.lower()
        if ("can't initiate" in low or "conversation" in low or "blocked" in low
                or "chat not found" in low or "start" in low or "deactivated" in low):
            return jsonify({"error": "Бот не может написать первым: откройте @Shersh_authbot, "
                                     "нажмите «Запустить» (и снимите блокировку, если ставили), затем повторите."}), 400
        return jsonify({"error": "Telegram не доставил код: " + reason[:120]}), 400
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
    try:
        rows = db_select("reset_codes", params={"select": "name,expires", "code": f"eq.{code}"})
    except Exception:
        rows = []
    if not rows:
        return jsonify({"error": "Неверный или истёкший код"}), 400
    row = rows[0]
    if _is_expired(row.get("expires")):
        try:
            db_delete("reset_codes", "code", code)
        except Exception:
            pass
        return jsonify({"error": "Неверный или истёкший код"}), 400
    name = row.get("name")
    try:
        db_delete("reset_codes", "code", code)
    except Exception:
        pass
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
    return jsonify({"status": "ok", "user": {"name": name, "nickname": nickname, "bio": "", "avatar": "", "is_admin": False},
                    "token": issue_token(name)})


# --- Вход ---
def _is_banned(name):
    """Есть ли профиль в списке забаненных."""
    if not name:
        return False
    try:
        rows = db_select("banned", params={"select": "name", "name": f"eq.{name}"})
    except Exception:
        return False
    return bool(rows)


@app.route("/api/login", methods=["POST"])
@rate_limit(limit=20, window=60)  # попыток входа в минуту с одного IP
def login():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    password = (data.get("password") or "").strip()

    p = find_profile(name)

    if not p:
        return jsonify({"error": "Пользователь не найден!"}), 404
    if not p.get("password_hash") or not verify_password(password, p["password_hash"]):
        return jsonify({"error": "Неверный пароль!"}), 401
    if _is_banned(p.get("name") or name):
        return jsonify({"error": "Аккаунт заблокирован модератором"}), 403

    return jsonify({"status": "ok", "user": {
        "name": p["name"], "nickname": p.get("nickname", ""),
        "bio": p.get("bio", ""), "avatar": p.get("avatar", ""),
        "is_admin": bool(p.get("is_admin")),
    }, "token": issue_token(p["name"])})


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
    me = auth_user()
    if not me:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    if me != old_name:
        return jsonify({"error": "Можно менять только свой профиль"}), 403
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
    if auth_user() != name:
        return jsonify({"error": "Можно удалить только свой профиль"}), 403
    db_delete("profiles", "name", name)
    # посты остаются, как и было в ТЗ (аккаунт удаляется, истории остаются)
    return jsonify({"status": "ok"})


@app.route("/api/profile/full", methods=["DELETE"])
def delete_profile_full():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "no name"}), 400
    if auth_user() != name:
        return jsonify({"error": "Можно удалить только свои данные"}), 403

    removed = {"posts": 0, "comments": 0, "likes": 0}

    def count_rows(table, field, value):
        try:
            rows = db_select(table, params={"select": "id", field: f"eq.{value}"})
            return len(rows or [])
        except Exception:
            return 0

    try:
        own_posts = db_select("posts", params={"select": "id", "author": f"eq.{name}"})
    except Exception:
        own_posts = []
    for p in own_posts or []:
        pid = p.get("id")
        removed["comments"] += count_rows("comments", "post_id", pid)
        removed["likes"] += count_rows("likes", "post_id", pid)
        try:
            db_delete("comments", "post_id", pid)
        except Exception:
            pass
        try:
            db_delete("likes", "post_id", pid)
        except Exception:
            pass
        try:
            db_delete("posts", "id", pid)
            removed["posts"] += 1
        except Exception:
            pass

    removed["comments"] += count_rows("comments", "author", name)
    removed["likes"] += count_rows("likes", "author", name)
    try:
        db_delete("comments", "author", name)
    except Exception:
        pass
    try:
        db_delete("likes", "author", name)
    except Exception:
        pass
    try:
        db_delete("reports", "target_author", name)
    except Exception:
        pass
    try:
        db_delete("profiles", "name", name)
    except Exception:
        pass

    return jsonify({"status": "ok", "removed": removed})


@app.route("/api/password", methods=["POST"])
@rate_limit(limit=10, window=300)  # не больше 10 смен пароля с одного IP за 5 минут
def change_password():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    old_password = (data.get("old_password") or "")
    new_password = (data.get("new_password") or "")

    if not name:
        return jsonify({"error": "Требуется авторизация"}), 401
    if auth_user() != name:
        return jsonify({"error": "Требуется авторизация"}), 401
    if len(new_password) < 4 or len(new_password) > 64:
        return jsonify({"error": "Пароль от 4 до 64 символов"}), 400

    p = find_profile(name)
    if not p:
        return jsonify({"error": "Пользователь не найден"}), 404
    if not p.get("password_hash") or not verify_password(old_password, p["password_hash"]):
        return jsonify({"error": "Неверный текущий пароль"}), 401

    db_update("profiles", {"password_hash": hash_password(new_password)}, "name", p["name"])
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
            "views": r.get("views"),
            "audio": r.get("audio"),
            "comments": (r.get("comments") or []),
        })
    return jsonify(result)


SITE_URL = "https://andrewshpik.github.io/skazki-Shersha/"


def _xml_text(value):
    return (str(value if value is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def _rfc822(value):
    try:
        raw = (value or "").replace("Z", "+00:00")
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S %z")
    except Exception:
        return datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S %z")


def _clean_audio_url(value):
    """Ссылка на авторскую озвучку: None — не задана, '' — некорректна."""
    url = (value or "").strip()
    if not url:
        return None
    if len(url) > 500 or not url.startswith("https://"):
        return ""
    return url


# Лента для подписки: любой RSS-читатель видит свежие истории
@app.route("/rss.xml", methods=["GET"])
@app.route("/feed.xml", methods=["GET"])
def rss_feed():
    try:
        rows = db_select("posts", params={"select": "id,title,text,author,date",
                                          "order": "date.desc", "limit": "30"})
    except Exception:
        rows = []

    items = []
    for r in rows:
        summary = (r.get("text") or "").strip().replace("\r", " ")
        if len(summary) > 500:
            summary = summary[:500].rstrip() + "…"
        items.append(
            "    <item>\n"
            "      <title>%s</title>\n"
            "      <link>%s</link>\n"
            "      <guid isPermaLink=\"false\">shersh-post-%s</guid>\n"
            "      <pubDate>%s</pubDate>\n"
            "      <dc:creator xmlns:dc=\"http://purl.org/dc/elements/1.1/\">%s</dc:creator>\n"
            "      <description>%s</description>\n"
            "    </item>"
            % (_xml_text(r.get("title")), _xml_text(SITE_URL + "#post-" + str(r.get("id"))),
               r.get("id"), _rfc822(r.get("date")), _xml_text(r.get("author")), _xml_text(summary))
        )

    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n'
        "  <channel>\n"
        "    <title>Сказки Шерша</title>\n"
        "    <link>%s</link>\n"
        "    <description>Сказки, истории и закулисье</description>\n"
        "    <language>ru</language>\n"
        "    <lastBuildDate>%s</lastBuildDate>\n"
        "    <atom:link href=\"https://shersh-auth.de1.netrun.io/rss.xml\" rel=\"self\" type=\"application/rss+xml\"/>\n"
        "%s\n"
        "  </channel>\n"
        "</rss>\n"
        % (_xml_text(SITE_URL), _rfc822(datetime.now(timezone.utc).isoformat()),
           "\n".join(items))
    )
    resp = Response(body, mimetype="application/rss+xml")
    resp.headers["Cache-Control"] = "public, max-age=600"
    return resp


@app.route("/api/posts", methods=["POST"])
@rate_limit(limit=10, window=60)  # не больше 10 постов в минуту с одного IP
def create_post():
    data = request.json or {}
    title = (data.get("title") or "").strip()
    text = (data.get("text") or "").strip()
    author = auth_user()
    image = data.get("image") or None
    audio = _clean_audio_url(data.get("audio"))
    if audio == "":
        return jsonify({"error": "Некорректная ссылка на озвучку"}), 400
    if not author:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    if _is_banned(author):
        return jsonify({"error": "Аккаунт заблокирован модератором"}), 403
    if not title or not text or not author:
        return jsonify({"error": "Заполни заголовок, текст и автора!"}), 400
    if len(title) > 200:
        return jsonify({"error": "Заголовок не длиннее 200 символов"}), 400
    if len(text) > 20000:
        return jsonify({"error": "Текст не длиннее 20 000 символов"}), 400
    if contains_profanity(title) or contains_profanity(text):
        return jsonify({"error": "Текст содержит нецензурные выражения"}), 400
    row = db_insert("posts", {"title": title, "text": text, "author": author,
                              "image": image, "audio": audio, "likes": 0})[0]
    return jsonify({"status": "ok", "post": row})


@app.route("/api/posts/<int:post_id>", methods=["PATCH"])
@rate_limit(limit=20, window=60)  # не больше 20 редактирований поста в минуту
def update_post(post_id):
    data = request.json or {}
    me = auth_user()
    if not me:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    owns = db_select("posts", params={"select": "author", "id": f"eq.{post_id}"})
    if not owns:
        return jsonify({"error": "Пост не найден"}), 404
    if owns[0].get("author") != me and not _is_admin_name(me):
        return jsonify({"error": "Нет прав на редактирование этого поста"}), 403
    payload = {}
    if "title" in data: payload["title"] = (data.get("title") or "").strip()
    if "text" in data: payload["text"] = (data.get("text") or "").strip()
    if "image" in data: payload["image"] = data.get("image") or None
    if "audio" in data:
        audio_value = _clean_audio_url(data.get("audio"))
        if audio_value == "":
            return jsonify({"error": "Некорректная ссылка на озвучку"}), 400
        payload["audio"] = audio_value
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
    user = auth_user()
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


# --- Просмотры ---
@app.route("/api/posts/<int:post_id>/view", methods=["POST"])
@rate_limit(limit=120, window=60)  # не больше 120 просмотров в минуту с одного IP
def add_view(post_id):
    """Считает открытия истории. Пока в таблице нет колонки views — молча ничего не делает."""
    try:
        rows = db_select("posts", params={"select": "id,views", "id": f"eq.{post_id}"})
        if not rows:
            return jsonify({"status": "ok", "views": None})
        current = int(rows[0].get("views") or 0)
        db_update("posts", {"views": current + 1}, "id", post_id)
        return jsonify({"status": "ok", "views": current + 1})
    except Exception:
        return jsonify({"status": "ok", "views": None})


# --- Лайки ---
@app.route("/api/posts/<int:post_id>/like", methods=["POST"])
@rate_limit(limit=30, window=60)  # не больше 30 лайков в минуту с одного IP
def toggle_like(post_id):
    data = request.json or {}
    user = auth_user()
    if not user:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    if _is_banned(user):
        return jsonify({"error": "Аккаунт заблокирован модератором"}), 403
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
    author = auth_user()
    text = (data.get("text") or "").strip()
    image = data.get("image") or None
    parent_id = data.get("parent_id")
    if not author:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    if parent_id in ("", 0, "0", "null"):
        parent_id = None
    if parent_id is not None:
        try:
            parent_id = int(parent_id)
        except (TypeError, ValueError):
            parent_id = None
    if _is_banned(author):
        return jsonify({"error": "Аккаунт заблокирован модератором"}), 403
    if not author and not text and not image:
        return jsonify({"error": "Пустой комментарий"}), 400
    if len(text) > 3000:
        return jsonify({"error": "Комментарий не длиннее 3000 символов"}), 400
    if contains_profanity(text):
        return jsonify({"error": "Комментарий содержит нецензурные выражения"}), 400
    payload = {"post_id": post_id, "author": author or "Аноним",
               "text": text, "image": image}
    if parent_id is not None:
        # вложенность только 1 уровень: ответ на ответ прикрепляем к корню
        try:
            parent_rows = db_select("comments", params={"select": "id,parent_id", "id": f"eq.{parent_id}"})
            if parent_rows:
                root = parent_rows[0].get("parent_id") or parent_rows[0].get("id")
                parent_id = root
            else:
                parent_id = None
        except Exception:
            pass
        payload["parent_id"] = parent_id
    try:
        row = db_insert("comments", payload)[0]
    except Exception:
        payload.pop("parent_id", None)
        row = db_insert("comments", payload)[0]
    return jsonify({"status": "ok", "comment": row})


@app.route("/api/comments/<int:comment_id>", methods=["PATCH"])
@rate_limit(limit=20, window=60)
def update_comment(comment_id):
    data = request.json or {}
    user = auth_user()
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
    user = auth_user()
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


# --- Модерация: жалобы ---
@app.route("/api/report", methods=["POST"])
@rate_limit(limit=15, window=300)  # не больше 15 жалоб с одного IP за 5 минут
def report():
    data = request.json or {}
    rtype = (data.get("type") or "").strip()
    target_id = str((data.get("target_id") or "")).strip()
    target_author = (data.get("target_author") or "").strip()
    reporter = auth_user()
    reason = (data.get("reason") or "").strip()
    if rtype not in ("post", "comment", "user") or not target_id:
        return jsonify({"error": "Некорректная жалоба"}), 400
    if not reporter:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    if _is_banned(reporter):
        return jsonify({"error": "Аккаунт заблокирован модератором"}), 403
    if len(reason) > 500:
        reason = reason[:500]
    db_insert("reports", {
        "type": rtype, "target_id": target_id,
        "target_author": target_author, "reporter": reporter, "reason": reason,
    })
    return jsonify({"status": "ok"})


@app.route("/api/reports", methods=["GET"])
def list_reports():
    user = require_admin()
    if not user:
        return jsonify({"error": "Нет прав"}), 403
    rows = db_select("reports", params={"select": "*", "order": "created_at.desc"})
    return jsonify(rows)


@app.route("/api/reports/<int:report_id>", methods=["DELETE"])
def delete_report(report_id):
    if not require_admin():
        return jsonify({"error": "Нет прав"}), 403
    db_delete("reports", "id", report_id)
    return jsonify({"status": "ok"})


# --- Модерация: баны ---
@app.route("/api/ban", methods=["POST"])
def add_ban():
    data = request.json or {}
    user = require_admin()
    target = (data.get("target") or "").strip()
    if not (user and target):
        return jsonify({"error": "Нет прав или нет цели"}), 403
    if target == user:
        return jsonify({"error": "Нельзя забанить самого себя"}), 400
    try:
        existing = db_select("banned", params={"select": "name", "name": f"eq.{target}"})
    except Exception:
        existing = []
    if existing:
        return jsonify({"status": "ok", "already": True})
    db_insert("banned", {"name": target, "reason": (data.get("reason") or "")[:300]})
    return jsonify({"status": "ok"})


@app.route("/api/ban", methods=["DELETE"])
def remove_ban():
    data = request.json or {}
    user = require_admin()
    target = (data.get("target") or "").strip()
    if not (user and target):
        return jsonify({"error": "Нет прав или нет цели"}), 403
    db_delete("banned", "name", target)
    return jsonify({"status": "ok"})


@app.route("/api/ban/check", methods=["GET"])
def check_ban():
    name = request.args.get("name", "").strip()
    if not name:
        return jsonify({"banned": False})
    rows = db_select("banned", params={"select": "name", "name": f"eq.{name}"})
    return jsonify({"banned": bool(rows)})


# --- Админ-панель ---
def _is_admin_name(name):
    """Проверяет, что у профиля с таким именем стоит флаг администратора."""
    if not name:
        return False
    try:
        rows = db_select("profiles", params={"select": "is_admin", "name": f"eq.{name}"})
    except Exception:
        return False
    return bool(rows and rows[0].get("is_admin"))


@app.route("/api/admin/overview", methods=["GET"])
def admin_overview():
    """Одна пачка данных для админки: пользователи, баны, жалобы, посты, комментарии."""
    user = require_admin()
    if not user:
        return jsonify({"error": "Нет прав"}), 403

    def safe(table, params):
        """Читает таблицу; если сортировка по полю не поддерживается — читает без неё."""
        attempts = [params]
        if "order" in params:
            plain = dict(params)
            plain.pop("order")
            attempts.append(plain)
        for attempt in attempts:
            try:
                return db_select(table, params=attempt)
            except Exception:
                continue
        return []

    users = safe("profiles", {"select": "name,nickname,bio,avatar,is_admin,telegram_id", "order": "name.asc"})
    banned = safe("banned", {"select": "*", "order": "created_at.desc"})
    reports = safe("reports", {"select": "*", "order": "created_at.desc"})
    posts = safe("posts", {"select": "id,author,title,text,date,image,likes", "order": "id.desc"})
    comments = safe("comments", {"select": "id,post_id,author,text,date", "order": "id.desc"})

    post_titles = {str(p.get("id")): (p.get("title") or "") for p in posts}
    comment_texts = {str(c.get("id")): (c.get("text") or "") for c in comments}
    for r in reports:
        target_id = str(r.get("target_id") or "")
        if r.get("type") == "post":
            r["preview"] = post_titles.get(target_id, "")
            r["gone"] = target_id not in post_titles
        elif r.get("type") == "comment":
            r["preview"] = comment_texts.get(target_id, "")
            r["gone"] = target_id not in comment_texts
        else:
            r["preview"] = ""
            r["gone"] = False

    banned_names = {b.get("name") for b in banned}
    posts_by_author = {}
    for p in posts:
        author = p.get("author") or ""
        posts_by_author[author] = posts_by_author.get(author, 0) + 1
    comments_by_author = {}
    for c in comments:
        author = c.get("author") or ""
        comments_by_author[author] = comments_by_author.get(author, 0) + 1

    for u in users:
        u["posts_count"] = posts_by_author.get(u.get("name"), 0)
        u["comments_count"] = comments_by_author.get(u.get("name"), 0)
        u["banned"] = u.get("name") in banned_names
        u["telegram"] = bool(u.pop("telegram_id", None))

    return jsonify({
        "stats": {
            "users": len(users), "posts": len(posts), "comments": len(comments),
            "reports": len(reports), "banned": len(banned),
        },
        "users": users,
        "banned": banned,
        "reports": reports,
        "posts": [{
            "id": p.get("id"), "author": p.get("author") or "", "title": p.get("title") or "",
            "date": p.get("date"), "likes": p.get("likes") or 0,
            "text": (p.get("text") or "")[:500],
        } for p in posts],
        "comments": [{
            "id": c.get("id"), "post_id": c.get("post_id"), "author": c.get("author") or "",
            "text": c.get("text") or "", "date": c.get("date"),
        } for c in comments[:200]],
    })


# --- Подписки на авторов ---
@app.route("/api/subscriptions", methods=["GET"])
def list_subscriptions():
    """Список авторов, на которых подписан текущий пользователь."""
    user = auth_user()
    if not user:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    try:
        rows = db_select("subscriptions", params={"select": "author", "follower": f"eq.{user}"})
    except Exception:
        return jsonify({"error": "Подписки временно недоступны"}), 500
    return jsonify({"authors": [r.get("author") for r in rows if r.get("author")]})


@app.route("/api/subscribe", methods=["POST"])
@rate_limit(limit=40, window=60)  # не больше 40 подписок/отписок в минуту
def toggle_subscription():
    """Подписывает или отписывает текущего пользователя от автора."""
    user = auth_user()
    if not user:
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    if _is_banned(user):
        return jsonify({"error": "Аккаунт заблокирован модератором"}), 403
    data = request.json or {}
    author = (data.get("author") or "").strip()
    if not author:
        return jsonify({"error": "Не указан автор"}), 400
    if author == user:
        return jsonify({"error": "На себя подписаться нельзя"}), 400

    try:
        existing = db_select("subscriptions", params={
            "select": "id", "follower": f"eq.{user}", "author": f"eq.{author}",
        })
    except Exception:
        return jsonify({"error": "Подписки временно недоступны"}), 500
    if existing:
        db_delete("subscriptions", "id", existing[0]["id"])
        return jsonify({"status": "unsubscribed", "subscribed": False})
    db_insert("subscriptions", {"follower": user, "author": author})
    return jsonify({"status": "subscribed", "subscribed": True})


@app.route("/api/admin/stats", methods=["GET"])
def admin_stats():
    """Сводка для аналитики: итоги, топ историй и авторов, динамика за 14 дней."""
    if not require_admin():
        return jsonify({"error": "Нет прав"}), 403

    def safe(table, params):
        attempts = [params]
        if "order" in params:
            plain = dict(params)
            plain.pop("order")
            attempts.append(plain)
        for attempt in attempts:
            try:
                return db_select(table, params=attempt)
            except Exception:
                continue
        return []

    posts = safe("posts", {"select": "id,title,author,date,likes,views", "order": "id.desc"})
    comments = safe("comments", {"select": "id,author,date", "order": "id.desc"})
    users = safe("profiles", {"select": "name"})

    total_views = sum(int(p.get("views") or 0) for p in posts)
    total_likes = sum(int(p.get("likes") or 0) for p in posts)
    avg_views = round(total_views / len(posts), 1) if posts else 0

    def top(items, key):
        ranked = sorted(items, key=lambda p: int(p.get(key) or 0), reverse=True)[:5]
        return [{
            "id": p.get("id"),
            "title": p.get("title") or "",
            "author": p.get("author") or "",
            "views": int(p.get("views") or 0),
            "likes": int(p.get("likes") or 0),
        } for p in ranked if int(p.get(key) or 0) > 0]

    today = datetime.now(timezone.utc).date()
    days = []
    for offset in range(13, -1, -1):
        day = today - timedelta(days=offset)
        days.append({"date": day.isoformat(), "posts": 0, "comments": 0})
    day_index = {d["date"]: d for d in days}

    for post in posts:
        key = str(post.get("date") or "")[:10]
        if key in day_index:
            day_index[key]["posts"] += 1
    for comment in comments:
        key = str(comment.get("date") or "")[:10]
        if key in day_index:
            day_index[key]["comments"] += 1

    authors = {}
    for post in posts:
        name = post.get("author") or "—"
        authors[name] = authors.get(name, 0) + 1
    top_authors = [{"author": name, "posts": count}
                   for name, count in sorted(authors.items(), key=lambda kv: -kv[1])[:5]]

    return jsonify({
        "totals": {
            "posts": len(posts), "comments": len(comments), "users": len(users),
            "likes": total_likes, "views": total_views, "avg_views": avg_views,
        },
        "top_by_views": top(posts, "views"),
        "top_by_likes": top(posts, "likes"),
        "top_authors": top_authors,
        "daily": days,
    })


@app.route("/api/admin/user", methods=["PATCH"])
def admin_update_user():
    """Меняет флаг администратора у профиля. Доступно только администратору."""
    data = request.json or {}
    admin = require_admin()
    target = (data.get("target") or "").strip()
    if not admin or not target:
        return jsonify({"error": "Нет прав или нет цели"}), 403
    if "is_admin" not in data:
        return jsonify({"error": "Нет данных для обновления"}), 400
    if target == admin and not bool(data.get("is_admin")):
        return jsonify({"error": "Нельзя снять права с самого себя"}), 400
    db_update("profiles", {"is_admin": bool(data.get("is_admin"))}, "name", target)
    return jsonify({"status": "ok"})


@app.route("/api/audio", methods=["POST"])
@rate_limit(limit=10, window=60)  # не больше 10 загрузок озвучки в минуту
def upload_audio():
    """Принимает base64-аудио, кладёт в Supabase Storage, возвращает публичный URL."""
    if not auth_user():
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
    data = request.json or {}
    raw = data.get("audio") or ""
    if not raw:
        return jsonify({"error": "Нет данных озвучки"}), 400
    if not raw.startswith("data:audio/"):
        return jsonify({"error": "Допустимы только аудиофайлы"}), 400
    try:
        header, b64 = raw.split(",", 1)
        audio_bytes = binascii.a2b_base64(b64)
    except Exception:
        return jsonify({"error": "Некорректная кодировка файла"}), 400
    if len(audio_bytes) > 15 * 1024 * 1024:
        return jsonify({"error": "Файл больше 15 МБ"}), 400

    mime = header.split(";")[0].split(":")[1] if ":" in header.split(";")[0] else "audio/mpeg"
    ext_map = {
        "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
        "audio/m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
        "audio/webm": "webm",
    }
    ext = ext_map.get(mime, "mp3")
    fname = f"{uuid.uuid4().hex}.{ext}"
    storage_headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
        "Content-Type": mime,
    }
    up = requests.post(
        f"{SUPABASE_STORAGE}/object/images/{fname}",
        headers=storage_headers, data=audio_bytes, timeout=60,
    )
    if up.status_code not in (200, 201):
        return jsonify({"error": "Не удалось загрузить озвучку"}), 500

    public_url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/public/images/{fname}"
    return jsonify({"status": "ok", "url": public_url})


@app.route("/api/upload", methods=["POST"])
@rate_limit(limit=30, window=60)  # не больше 30 загрузок файлов в минуту
def upload_image():
    """Принимает base64-изображение, загружает в Supabase Storage, возвращает публичный URL."""
    if not auth_user():
        return jsonify({"error": "Требуется вход в аккаунт"}), 401
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