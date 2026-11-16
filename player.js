// Плеер сказок: озвучка текста голосами браузера (Web Speech API).
// Своего сервера не требует, аудио никуда не загружается.
(function () {
    'use strict';

    const synth = window.speechSynthesis;
    const supported = !!synth && typeof window.SpeechSynthesisUtterance === 'function';
    const POS_KEY = 'shersh_audio_pos';
    const VOICE_KEY = 'shersh_audio_voice';
    const MIN_CHUNK = 140;
    const MAX_CHUNK = 260;

    let queue = [];
    let idx = 0;
    let key = null;
    let rate = 0.95;
    let state = 'idle';
    let sleepDeadline = 0;
    let runId = 0;
    let voice = null;
    let bar = null;

    function picklePositions() {
        try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}') || {}; } catch (e) { return {}; }
    }

    function savePosition(k, i) {
        if (!k) return;
        const all = picklePositions();
        all[k] = i;
        try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch (e) { /* приватный режим */ }
    }

    function savedPosition(k) {
        const i = picklePositions()[k];
        return typeof i === 'number' && i >= 0 ? i : 0;
    }

    // Режем текст на фразы: цель — короткие куски, чтобы пауза и «продолжить»
    // работали точно, а браузер не обрывал длинную реплику.
    function chunkText(text) {
        const raw = String(text || '').replace(/\r/g, '');
        if (!raw.trim()) return [];
        const paragraphs = raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        const out = [];
        paragraphs.forEach((paragraph, paragraphIndex) => {
            const clean = paragraph.replace(/\s+/g, ' ');
            const chunks = [];
            clean.split(/(?<=[.!?…;:])\s+/).forEach(sentence => {
                let rest = sentence.trim();
                while (rest.length > MAX_CHUNK) {
                    let cut = rest.lastIndexOf(' ', MAX_CHUNK);
                    if (cut < MIN_CHUNK) cut = rest.indexOf(' ', MAX_CHUNK);
                    if (cut <= 0) cut = MAX_CHUNK;
                    chunks.push(rest.slice(0, cut).trim());
                    rest = rest.slice(cut).trim();
                }
                if (rest) chunks.push(rest);
            });
            chunks.forEach((chunk, chunkIndex) => {
                const isLastInParagraph = chunkIndex === chunks.length - 1;
                const isLastParagraph = paragraphIndex === paragraphs.length - 1;
                // На границе абзаца — пауза, как при чтении вслух
                out.push({ text: chunk, gap: isLastInParagraph && !isLastParagraph ? 600 : 0 });
            });
        });
        return out;
    }

    function voiceList() {
        if (!supported) return [];
        const all = synth.getVoices() || [];
        const russian = all.filter(v => /^ru([-_]|$)/i.test(v.lang || ''));
        return russian.length ? russian : all;
    }

    const FEMALE_VOICE = /svetlana|светлана|milena|милена|alena|алёна|alena|irina|ирина|katya|катя|elena|елена|female|женск/i;
    const MALE_VOICE = /pavel|павел|dmitry|дмитрий|artem|артём|yuri|юрий|male|мужск/i;

    function preferredVoice() {
        const list = voiceList();
        if (!list.length) return null;
        let saved = '';
        try { saved = localStorage.getItem(VOICE_KEY) || ''; } catch (e) { saved = ''; }
        if (saved) {
            const found = list.find(v => v.name === saved);
            if (found) return found;
        }
        // Для сказок женский голос звучит мягче; мужской — только если выбора нет
        return list.find(v => FEMALE_VOICE.test(v.name || ''))
            || list.find(v => !MALE_VOICE.test(v.name || ''))
            || list[0];
    }

    function ensureVoice() {
        voice = preferredVoice();
        fillVoiceSelect();
        return voice;
    }

    function fillVoiceSelect() {
        if (!bar) return;
        const select = bar.querySelector('#audioVoice');
        if (!select) return;
        const list = voiceList();
        const current = voice ? voice.name : '';
        select.textContent = '';
        if (!list.length) {
            const empty = document.createElement('option');
            empty.value = '';
            empty.textContent = 'нет голосов';
            select.appendChild(empty);
            return;
        }
        list.forEach(v => {
            const option = document.createElement('option');
            option.value = v.name;
            option.textContent = v.name + (v.localService === false ? ' · онлайн' : '');
            select.appendChild(option);
        });
        if (current) select.value = current;
        warnAboutVoices(russianVoiceCount());
    }

    function russianVoiceCount() {
        if (!supported) return 0;
        return (synth.getVoices() || []).filter(v => /^ru([-_]|$)/i.test(v.lang || '')).length;
    }

    function warnAboutVoices(count) {
        let message = '';
        if (count === 0) {
            message = 'В системе нет русского голоса. Windows: Параметры → Время и язык → Язык и регион → Русский → «Речь». Либо откройте сайт в Edge.';
        } else if (count <= 2) {
            message = 'Голосов в системе мало. Windows 11: Параметры → Время и язык → Речь → Добавить голоса';
        }
        if (!message) return;
        let warned = false;
        try { warned = sessionStorage.getItem('shersh_voice_hint') === '1'; } catch (e) { warned = false; }
        if (warned) return;
        try { sessionStorage.setItem('shersh_voice_hint', '1'); } catch (e) { /* приватный режим */ }
        if (typeof showToast === 'function') showToast(message);
    }

    function buildBar() {
        if (bar) return bar;
        bar = document.createElement('div');
        bar.className = 'audio-bar';
        bar.id = 'audioBar';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Плеер сказки');
        bar.innerHTML = `
            <div class="audio-bar__title" id="audioTitle"></div>
            <div class="audio-bar__now" id="audioNow" aria-live="polite"></div>
            <div class="audio-bar__row">
                <button type="button" class="audio-btn" id="audioPlay" aria-label="Пауза">⏸</button>
                <button type="button" class="audio-btn" id="audioStop" aria-label="Остановить">⏹</button>
                <span class="audio-bar__pos" id="audioPos" aria-live="polite"></span>
                <label class="audio-bar__rate">Голос
                    <select id="audioVoice" aria-label="Голос озвучки"></select>
                </label>
                <label class="audio-bar__rate">Скорость
                    <select id="audioRate" aria-label="Скорость чтения">
                        <option value="0.8">0.8×</option>
                        <option value="0.95" selected>0.95×</option>
                        <option value="1.15">1.15×</option>
                        <option value="1.4">1.4×</option>
                    </select>
                </label>
                <label class="audio-bar__rate">Сон
                    <select id="audioSleep" aria-label="Таймер сна">
                        <option value="0" selected>выкл</option>
                        <option value="15">15 мин</option>
                        <option value="30">30 мин</option>
                        <option value="60">60 мин</option>
                    </select>
                </label>
                <button type="button" class="audio-btn" id="audioClose" aria-label="Закрыть плеер">✕</button>
            </div>`;
        document.body.appendChild(bar);

        bar.querySelector('#audioPlay').addEventListener('click', toggle);
        bar.querySelector('#audioStop').addEventListener('click', () => { stop(); });
        bar.querySelector('#audioClose').addEventListener('click', () => { stop(); hide(); });
        bar.querySelector('#audioRate').addEventListener('change', (e) => {
            rate = parseFloat(e.target.value) || 1;
            if (state === 'playing') {
                const resumeAt = idx;
                synth.cancel();
                speakFrom(resumeAt);
            }
        });
        bar.querySelector('#audioVoice').addEventListener('change', (e) => {
            voice = voiceList().find(v => v.name === e.target.value) || voice;
            try { localStorage.setItem(VOICE_KEY, voice ? voice.name : ''); } catch (err) { /* приватный режим */ }
            if (state === 'playing') {
                const resumeAt = idx;
                synth.cancel();
                speakFrom(resumeAt);
            }
        });
        bar.querySelector('#audioSleep').addEventListener('change', (e) => {
            const minutes = parseFloat(e.target.value) || 0;
            sleepDeadline = minutes > 0 ? Date.now() + minutes * 60000 : 0;
            if (typeof showToast === 'function') {
                showToast(minutes > 0 ? 'Таймер сна: ' + minutes + ' мин' : 'Таймер сна выключен');
            }
        });
        return bar;
    }

    function showBar(text) {
        buildBar();
        bar.querySelector('#audioTitle').textContent = text;
        bar.classList.add('is-open');
    }

    function hide() {
        if (bar) bar.classList.remove('is-open');
    }

    function updateBar() {
        if (!bar) return;
        const play = bar.querySelector('#audioPlay');
        const pos = bar.querySelector('#audioPos');
        play.textContent = state === 'paused' ? '▶' : '⏸';
        play.setAttribute('aria-label', state === 'paused' ? 'Продолжить' : 'Пауза');
        if (!queue.length) { pos.textContent = ''; return; }
        if (idx >= queue.length) {
            pos.textContent = 'Готово';
        } else {
            const percent = Math.round((idx / queue.length) * 100);
            pos.textContent = `${Math.min(idx + 1, queue.length)} из ${queue.length} · ${percent}%`;
        }
    }

    function showCurrentLine(text) {
        if (!bar) return;
        const now = bar.querySelector('#audioNow');
        if (!now) return;
        const clean = String(text || '').trim();
        now.textContent = clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
    }

    function speakFrom(start) {
        if (!supported) return;
        const myRun = ++runId;
        idx = Math.max(0, Math.min(start, queue.length));
        state = 'playing';
        updateBar();

        const next = () => {
            if (myRun !== runId) return;
            if (sleepDeadline && Date.now() > sleepDeadline) {
                sleepDeadline = 0;
                state = 'idle';
                updateBar();
                if (typeof showToast === 'function') showToast('Таймер сна сработал — чтение остановлено');
                return;
            }
            if (idx >= queue.length) {
                state = 'idle';
                savePosition(key, 0);
                updateBar();
                return;
            }
            const item = queue[idx];
            showCurrentLine(item.text);
            const utterance = new SpeechSynthesisUtterance(item.text);
            utterance.lang = 'ru-RU';
            utterance.rate = rate;
            if (voice) utterance.voice = voice;
            utterance.onend = () => {
                if (myRun !== runId) return;
                const gap = item.gap || 0;
                idx += 1;
                savePosition(key, idx);
                updateBar();
                if (gap > 0) {
                    // пауза на границе абзаца
                    window.setTimeout(() => { if (myRun === runId) next(); }, gap);
                } else {
                    next();
                }
            };
            utterance.onerror = (e) => {
                if (myRun !== runId) return;
                if (e && e.error === 'interrupted') return;
                state = 'idle';
                updateBar();
            };
            synth.speak(utterance);
        };
        next();
    }

    function toggle() {
        if (!supported) return;
        if (state === 'playing') {
            synth.pause();
            state = 'paused';
            updateBar();
        } else if (state === 'paused') {
            synth.resume();
            state = 'playing';
            updateBar();
        } else {
            speakFrom(idx < queue.length ? idx : 0);
        }
    }

    function stop() {
        if (!supported) return;
        runId += 1;
        synth.cancel();
        state = 'idle';
        savePosition(key, idx < queue.length ? idx : 0);
        updateBar();
    }

    function speak(postKey, postTitle, text) {
        if (!supported) {
            if (typeof showToast === 'function') showToast('Браузер не умеет озвучивать текст — попробуй Chrome или Safari', true);
            return;
        }
        stop();
        key = postKey;
        queue = chunkText(text);
        if (!queue.length) {
            if (typeof showToast === 'function') showToast('Здесь нечего читать', true);
            return;
        }
        const saved = savedPosition(postKey);
        idx = saved > 0 && saved < queue.length ? saved : 0;
        showBar(postTitle || 'Сказка');
        ensureVoice();
        speakFrom(idx);
    }

    window.speechPlayer = { speak, stop, hide, get supported() { return supported; } };

    window.speakPost = function (index) {
        const post = (typeof posts !== 'undefined' && posts) ? posts[index] : null;
        if (!post) return;
        speak('post-' + post.id, post.title || 'История', post.text || '');
    };

    window.speakTale = function () {
        const titleEl = document.getElementById('taleTitle');
        const textEl = document.getElementById('taleText');
        if (!textEl) return;
        speak('tale', titleEl ? titleEl.textContent : 'Сказка на ночь', textEl.textContent || '');
    };

    window.speakCurrentPost = function () {
        if (typeof currentPostIndexForComments === 'undefined' || currentPostIndexForComments === null) return;
        window.speakPost(currentPostIndexForComments);
    };

    if (supported) {
        ensureVoice();
        if (typeof synth.addEventListener === 'function') {
            synth.addEventListener('voiceschanged', ensureVoice);
        } else {
            synth.onvoiceschanged = ensureVoice;
        }
        window.addEventListener('beforeunload', () => { try { synth.cancel(); } catch (e) { /* ignore */ } });
    }
})();
