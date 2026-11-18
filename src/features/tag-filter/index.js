// Фильтр по тегу: состояние, адрес вида #tag/имя и плашка активного тега.
const TAG_PREFIX = '#tag/';

let activeTag = null;
const deps = {
    render: () => {},
    toast: () => {},
    collapseCloud: () => {},
};

function tagHash(tag) {
    return TAG_PREFIX + encodeURIComponent(tag);
}

export function getActiveTag() {
    return activeTag;
}

export function applyTagFilter(tag, options) {
    activeTag = tag || null;
    const banner = document.getElementById('tagBanner');
    const text = document.getElementById('tagBannerText');

    if (activeTag) {
        if (banner && text) {
            text.textContent = 'Тег: #' + activeTag;
            banner.style.display = 'flex';
        }
        document.title = '#' + activeTag + ' — Сказки Шерша';
    } else {
        if (banner) banner.style.display = 'none';
        document.title = 'Сказки Шерша';
    }

    deps.render();
    if (!(options && options.silent)) {
        deps.toast(activeTag ? 'Показаны истории с тегом #' + activeTag : 'Фильтр по тегу снят');
    }
}

export function filterByTag(tag) {
    if (activeTag === tag) {
        clearTagFilter();
        return;
    }
    try {
        history.replaceState(null, '', tagHash(tag));
    } catch (e) {
        location.hash = tagHash(tag);
    }
    applyTagFilter(tag);
    deps.collapseCloud();
}

export function clearTagFilter() {
    try {
        history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
        location.hash = '';
    }
    applyTagFilter(null);
}

export function syncTagFromHash() {
    const match = (location.hash || '').match(/^#tag\/(.+)$/);
    if (match) {
        let tag = match[1];
        try { tag = decodeURIComponent(tag); } catch (e) { /* оставляем как есть */ }
        if (tag !== activeTag) applyTagFilter(tag, { silent: true });
    } else if (activeTag) {
        applyTagFilter(null, { silent: true });
    }
}

export function initTagFilter(options = {}) {
    Object.assign(deps, options);
    window.applyTagFilter = applyTagFilter;
    window.filterByTag = filterByTag;
    window.clearTagFilter = clearTagFilter;
    window.addEventListener('hashchange', syncTagFromHash);
    window.addEventListener('load', syncTagFromHash);
    setTimeout(syncTagFromHash, 2000);
}
