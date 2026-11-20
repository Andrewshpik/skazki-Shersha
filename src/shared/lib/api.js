// Клиент API: подставляет токен, повторяет запрос при холодном старте бэкенда.
import { API_BASE, TOKEN_KEY, USER_KEY } from '../config.js';
import { readLocal, writeLocal, removeLocal } from './storage.js';

export function getToken() {
    return readLocal(TOKEN_KEY) || '';
}

export function setToken(token) {
    if (!token) return;
    writeLocal(TOKEN_KEY, token);
}

export function clearToken() {
    removeLocal(TOKEN_KEY);
}

export function clearSession() {
    removeLocal(USER_KEY);
    clearToken();
}

let retryHandler = null;

// Подсказка «сервер просыпается»: вызывается перед повторной попыткой.
export function setRetryHandler(handler) {
    if (typeof handler === 'function') retryHandler = handler;
}

export async function api(path, options = {}) {
    const attempts = 3;
    let lastErr = null;

    for (let i = 0; i < attempts; i++) {
        try {
            if (i > 0 && retryHandler) {
                try { retryHandler(i + 1, attempts); } catch (e) { /* подсказка не должна ломать запрос */ }
            }
            const res = await fetch(API_BASE + path, {
                ...options,
                headers: Object.assign(
                    { 'Content-Type': 'application/json' },
                    getToken() ? { Authorization: 'Bearer ' + getToken() } : {},
                    (options && options.headers) || {}
                ),
            });
            const data = await res.json().catch(() => ({}));

            if (res.status === 401) {
                // токен истёк или сессия устарела — просим войти заново
                clearSession();
            }
            if (!res.ok) {
                // 5xx — сервер просыпается, пробуем ещё; 4xx — повторять бессмысленно
                if (res.status >= 500 && i < attempts - 1) {
                    lastErr = new Error(data.error || ('Ошибка ' + res.status));
                    await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
                    continue;
                }
                throw new Error(data.error || ('Ошибка ' + res.status));
            }
            return data;
        } catch (e) {
            lastErr = e;
            const isNetwork = /fetch|network|Failed|соединени|Соединени|таймаут|timeout/i.test(e.message || '');
            if (i < attempts - 1 && (isNetwork || /Ошибка 5\d\d/.test(e.message || ''))) {
                await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
                continue;
            }
            throw e;
        }
    }
    throw lastErr || new Error('Сеть недоступна');
}
