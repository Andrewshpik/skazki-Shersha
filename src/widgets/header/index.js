// Шапка сайта: кто вошёл, кнопки админа и уведомлений, переключение страниц.
import { updateBell } from '../notifications/index.js';

export function updateHeaderUI(userData = {}) {
    const btn = document.getElementById('headerProfileBtn');
    if (btn) btn.textContent = userData.name ? `👋 ${userData.name}` : '👋 Гость';

    const logoutBtn = document.getElementById('headerLogoutBtn');
    if (logoutBtn) {
        logoutBtn.style.display = (userData.name && !userData.isGuest) ? 'block' : 'none';
    }

    // Кнопка админ-панели видна только администратору
    const adminBtn = document.getElementById('adminPanelBtn');
    if (adminBtn) {
        adminBtn.style.display = (userData.name && !userData.isGuest && userData.is_admin) ? 'block' : 'none';
    }

    // Колокольчик уведомлений виден только залогиненным
    const bellBtn = document.getElementById('bellBtn');
    const bellBadge = document.getElementById('bellBadge');
    if (bellBtn && bellBadge) {
        if (userData.name && !userData.isGuest) {
            bellBtn.style.display = 'inline-block';
            updateBell();
        } else {
            bellBtn.style.display = 'none';
            bellBadge.style.display = 'none';
        }
    }

    const searchContainer = document.getElementById('searchContainer');
    const profilePage = document.getElementById('profile-page');
    const otherProfilePage = document.getElementById('other-profile-page');
    if (searchContainer && profilePage && otherProfilePage) {
        const onProfile = profilePage.style.display === 'block' || otherProfilePage.style.display === 'block';
        searchContainer.style.display = onProfile ? 'none' : 'block';
    }
}

export function showPage(page, userData = {}, onProfile = null) {
    const feed = document.getElementById('feed-page');
    const profile = document.getElementById('profile-page');
    const other = document.getElementById('other-profile-page');
    if (feed) feed.style.display = page === 'feed' ? 'block' : 'none';
    if (profile) profile.style.display = page === 'profile' ? 'block' : 'none';
    if (other) other.style.display = page === 'other' ? 'block' : 'none';
    updateHeaderUI(userData);
    if (page === 'profile' && typeof onProfile === 'function') onProfile();
}
