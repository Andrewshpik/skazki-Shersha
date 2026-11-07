import os
import hashlib
import hmac
from flask import Flask, request, jsonify

app = Flask(__name__)

# Netrun передаст токен бота через переменную окружения BOT_TOKEN
BOT_TOKEN = os.environ.get("BOT_TOKEN", "ТВОЙ_ТОКЕН_ЗДЕСЬ")

def check_telegram_auth(data):
    # Функция для проверки, что данные пришли именно от Telegram
    # (Упрощённая логика для примера)
    return True

@app.route('/')
def home():
    return "Сервер авторизации Шерша работает!"

@app.route('/auth/telegram', methods=['POST'])
def telegram_auth():
    data = request.json
    if check_telegram_auth(data):
        # Здесь мы бы создавали сессию для пользователя
        return jsonify({"status": "ok", "user": data.get('username')})
    return jsonify({"status": "error", "message": "Invalid auth"}), 403

if __name__ == '__main__':
    # ЭТО ВАЖНО: слушаем 0.0.0.0 и порт из переменной PORT
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)