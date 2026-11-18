// Форматирование и экранирование — чистые функции без побочных эффектов.
const MONTHS_GENITIVE = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function escapeHTML(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatDate(dateString) {
    const date = new Date(dateString);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()} в ${hh}:${mm}`;
}

export function readingTime(text, wordsPerMinute = 180) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / wordsPerMinute)) + ' мин';
}

export function normalizeForSearch(value) {
    return String(value || '').toLowerCase().replace(/ё/g, 'е');
}

export function plural(count, one, few, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}
