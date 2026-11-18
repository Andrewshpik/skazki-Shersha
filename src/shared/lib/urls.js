// Адреса страниц сайта — общая мелочь для нескольких модулей.
export function postPageUrl(id) {
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    return base + 'post-' + id + '.html';
}
