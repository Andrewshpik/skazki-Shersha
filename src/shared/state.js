// Доступ к общему состоянию приложения.
// Пока лента живёт в классическом app.js, значения берём через его аксессоры;
// когда app.js станет модулем, поменяется только эта прослойка.
export function getPosts() {
    return typeof window.__getPosts === 'function' ? window.__getPosts() : [];
}

export function getCurrentPostIndex() {
    return typeof window.__getCurrentPostIndex === 'function' ? window.__getCurrentPostIndex() : null;
}

export function getUser() {
    return typeof window.__getUser === 'function' ? window.__getUser() : null;
}
