// Безопасная обёртка над хранилищем: приватный режим не должен ломать страницу.
export function readLocal(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function writeLocal(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
}

export function removeLocal(key) {
    try { localStorage.removeItem(key); return true; } catch (e) { return false; }
}

export function readJSON(key, fallback = null) {
    const raw = readLocal(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

export function writeJSON(key, value) {
    try { return writeLocal(key, JSON.stringify(value)); } catch (e) { return false; }
}

export function readSession(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
}

export function writeSession(key, value) {
    try { sessionStorage.setItem(key, value); return true; } catch (e) { return false; }
}
