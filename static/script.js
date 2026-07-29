pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.min.js';

/* ─── State ─── */
let pdfDoc = null;
let pageNum = 1;
let pageIsRendering = false;
let pageNumPending = null;
let scale = 1.5;
let isPlaying = false;
let isAutoContinuing = false;
let sentences = [];
let currentIndex = 0;
let audioCache = {};
let inFlight = 0;
let hasStartedPlaying = false;
let currentPageText = '';
let sidebarOpen = true;
let pdfOutline = null;
let searchMatches = [];
let searchCurrentMatch = -1;
let searchAllPageTexts = {};
let currentFile = null;
let currentFileName = '';
let pageRemaining = 0;      // seconds left on current page
let chapterRemaining = 0;   // seconds left in current chapter
let sentenceDurations = {}; // map index -> duration (for current page)
let chapterStartPage = null;
let chapterEndPage = null;

/* ─── Cache / Download state ─── */
let saveAudioEnabled = false;
let isDownloadingRange = false;

/* ─── Highlight customisation state ─── */
let hlBaseColor = '59,130,246';
let hlOpacity = 0.32;
let hlRadius = 3;
let hlOutline = false;
let hlPadding = 1;

/* ─── Playback speed ─── */
let playbackSpeed = 1.0;

/* ─── Page stats for reading time ─── */
const pageStats = {}; // { page: { totalChars, sentenceCount } }

/* ─── Mobile topbar state ─── */
let topbarVisible = true;

/* ─── Preload job tracking ─── */
const activePreloadJobs = {};

/* ─── TTS constants ─── */
const BUFFER_DEPTH = 10;
const MAX_CONCURRENT_FETCHES = 1;
const REQUIRED_START_BUFFER = 5;

/* ─── DOM refs ─── */
const welcomeScreen = document.getElementById('welcome-screen');
const readerScreen = document.getElementById('reader-screen');
const fileInput = document.getElementById('pdf-upload');
const viewerArea = document.getElementById('pdf-viewer-area');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const zoomSlider = document.getElementById('zoom-slider');
const zoomVal = document.getElementById('zoom-val');
const zoomInBtn = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const zoomResetBtn = document.getElementById('zoom-reset-btn');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const playBtn = document.getElementById('play-page-btn');
const audioPlayer = document.getElementById('tts-audio-player');
const ttsStatus = document.getElementById('tts-status');
const ttsProgressFill = document.getElementById('tts-progress-fill');
const ttsStatusText = document.getElementById('tts-status-text');
const mobilePrevBtn = document.getElementById('mobile-prev-page');
const mobileNextBtn = document.getElementById('mobile-next-page');
const mobilePageInfo = document.getElementById('mobile-page-info');
const mobileToggleBtn = document.getElementById('mobile-sidebar-toggle-btn');
const topbarFilename = document.getElementById('topbar-filename');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const searchPrevBtn = document.getElementById('search-prev-btn');
const searchNextBtn = document.getElementById('search-next-btn');
const searchClearBtn = document.getElementById('search-clear-btn');
const searchResultsPanel = document.getElementById('search-results-panel');
const searchResultsList = document.getElementById('search-results-list');
const resultsHeaderText = document.getElementById('results-header-text');
const tocList = document.getElementById('toc-list');
const tocEmpty = document.getElementById('toc-empty');
const tocPanel = document.getElementById('toc-panel');
const controlsPanel = document.getElementById('controls-panel');
const tabToc = document.getElementById('tab-toc');
const tabControls = document.getElementById('tab-controls');
const pageJumpInput = document.getElementById('page-jump-input');
const pageJumpBtn = document.getElementById('page-jump-btn');
const speedSlider = document.getElementById('speed-slider');
const speedVal = document.getElementById('speed-val');

const saveAudioToggle = document.getElementById('save-audio-toggle');
const saveRangeRow = document.getElementById('save-range-row');
const pageRangeInput = document.getElementById('page-range-input');
const downloadRangeBtn = document.getElementById('download-range-btn');
const dlProgress = document.getElementById('dl-progress');
const dlProgressFill = document.getElementById('dl-progress-fill');
const dlStatusText = document.getElementById('dl-status-text');
const cacheBadge = document.getElementById('cache-badge');

const mobilePlayBtn = document.getElementById('mobile-play-btn');
const mobilePlayLabel = document.getElementById('mobile-play-label');

const pageTimeEl = document.getElementById('page-time');
const chapterTimeEl = document.getElementById('chapter-time');

const deleteRangeInput = document.getElementById('delete-range-input');
const deleteRangeBtn = document.getElementById('delete-range-btn');
const deleteStatus = document.getElementById('delete-status');

/* ─── Loading overlay ─── */
function showLoading(msg = 'Loading…') {
    loadingText.textContent = msg;
    loadingOverlay.classList.add('visible');
}
function hideLoading() {
    loadingOverlay.classList.remove('visible');
}

/* ─── Theme ─── */
const themeCheckbox = document.getElementById('theme-toggle-checkbox');
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeIconSun = document.getElementById('theme-icon-sun');
const themeIconMoon = document.getElementById('theme-icon-moon');

function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeCheckbox.checked = dark;
    themeIconSun.style.display = dark ? 'none' : '';
    themeIconMoon.style.display = dark ? '' : 'none';
    localStorage.setItem('theme', dark ? 'dark' : 'light');
}

const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(savedTheme === 'dark');

themeCheckbox.addEventListener('change', e => applyTheme(e.target.checked));
themeToggleBtn.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark'));

/* ─── Mobile topbar toggle ─── */
function setTopbarVisible(visible) {
    topbarVisible = visible;
    document.body.classList.toggle('topbar-hidden', !visible);
}

/* ─── Landscape phone detection & auto-hide ─── */
function isLandscapePhone() {
    return window.innerHeight <= 500 && window.innerWidth > window.innerHeight;
}

function applyLandscapeMode() {
    const landscape = isLandscapePhone();
    if (landscape) {
        setTopbarVisible(false);
        sidebar.style.top = '';
        sidebar.style.height = '';
        sidebar.style.width = '';
        sidebar.style.position = '';
        sidebar.style.transform = '';
    } else {
        setTopbarVisible(true);
        sidebar.style.top = '';
        sidebar.style.height = '';
        sidebar.style.width = '';
        sidebar.style.position = '';
        sidebar.style.transform = '';
    }
}

applyLandscapeMode();
window.addEventListener('resize', applyLandscapeMode);
if (window.screen.orientation) {
    window.screen.orientation.addEventListener('change', () => {
        setTimeout(applyLandscapeMode, 120);
    });
}

/* ─── Server PDF Library ─── */
async function loadServerPDFs() {
    const section = document.getElementById('server-pdf-section');
    const loading = document.getElementById('server-pdf-loading');
    const listEl = document.getElementById('server-pdf-list');

    loading.style.display = 'block';

    try {
        const res = await fetch('/pdfs', { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const pdfs = data.pdfs || [];
        loading.style.display = 'none';

        if (pdfs.length === 0) {
            return;
        }

        section.style.display = 'block';
        listEl.innerHTML = '';

        pdfs.forEach(pdf => {
            const item = document.createElement('div');
            item.className = 'server-pdf-item';
            item.title = `Open: ${pdf.name}`;

            const sizeMB = (pdf.size / (1024 * 1024)).toFixed(1);
            item.innerHTML = `
                <svg class="server-pdf-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <span class="server-pdf-item-name">${escapeHtmlWelcome(pdf.name)}</span>
                <span class="server-pdf-item-size">${sizeMB} MB</span>
            `;

            item.addEventListener('click', async () => {
                item.style.opacity = '0.5';
                item.style.pointerEvents = 'none';
                try {
                    const pdfRes = await fetch(`/pdfs/${encodeURIComponent(pdf.name)}`);
                    if (!pdfRes.ok) throw new Error(`HTTP ${pdfRes.status}`);
                    const blob = await pdfRes.blob();
                    const file = new File([blob], pdf.name, { type: 'application/pdf' });
                    loadPDF(file, 1);
                } catch (err) {
                    console.error(`[SERVER-PDF] Failed to load ${pdf.name}:`, err);
                    alert(`Could not load "${pdf.name}" from server. Is the server running?`);
                    item.style.opacity = '';
                    item.style.pointerEvents = '';
                }
            });

            listEl.appendChild(item);
        });
    } catch (err) {
        loading.style.display = 'none';
    }
}

function escapeHtmlWelcome(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

loadServerPDFs();

/* ─── Highlight Customisation ─── */

const HL_PRESETS = {
    'rgba(59,130,246,0.32)': '59,130,246',
    'rgba(234,179,8,0.38)': '234,179,8',
    'rgba(16,185,129,0.35)': '16,185,129',
    'rgba(239,68,68,0.32)': '239,68,68',
    'rgba(168,85,247,0.32)': '168,85,247',
    'rgba(251,146,60,0.35)': '251,146,60',
};

function applyHighlightSettings() {
    const color = `rgba(${hlBaseColor},${hlOpacity})`;
    document.documentElement.style.setProperty('--hl-color', color);
    document.documentElement.style.setProperty('--hl-radius', hlRadius + 'px');
    document.documentElement.style.setProperty('--hl-padding', hlPadding + 'px');
    const outlineVal = hlOutline ? `0 0 0 1px rgba(${hlBaseColor},${Math.min(1, hlOpacity * 2.5)})` : 'none';
    document.documentElement.style.setProperty('--hl-outline', outlineVal);
    if (sentences && sentences.length && currentIndex >= 0) {
        highlightActiveSentence(currentIndex, sentences);
    }
}

document.querySelectorAll('.hl-preset').forEach(btn => {
    btn.addEventListener('click', () => {
        const colorKey = btn.dataset.color;
        hlBaseColor = HL_PRESETS[colorKey] || '59,130,246';
        document.querySelectorAll('.hl-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyHighlightSettings();
        saveHighlightSettings();
    });
});

document.getElementById('hl-opacity-slider').addEventListener('input', e => {
    hlOpacity = parseInt(e.target.value, 10) / 100;
    document.getElementById('hl-opacity-val').textContent = e.target.value + '%';
    applyHighlightSettings();
    saveHighlightSettings();
});

document.getElementById('hl-radius-slider').addEventListener('input', e => {
    hlRadius = parseInt(e.target.value, 10);
    document.getElementById('hl-radius-val').textContent = e.target.value + 'px';
    applyHighlightSettings();
    saveHighlightSettings();
});

document.getElementById('hl-outline-toggle').addEventListener('change', e => {
    hlOutline = e.target.checked;
    applyHighlightSettings();
    saveHighlightSettings();
});

/* ─── Sidebar Tabs ─── */
tabToc.addEventListener('click', () => {
    tabToc.classList.add('active');
    tabControls.classList.remove('active');
    tocPanel.style.display = 'block';
    controlsPanel.style.display = 'none';
});
tabControls.addEventListener('click', () => {
    tabControls.classList.add('active');
    tabToc.classList.remove('active');
    controlsPanel.style.display = 'block';
    tocPanel.style.display = 'none';
});

/* ─── Sidebar Toggle ─── */
function isMobileSidebar() {
    return getComputedStyle(sidebar).position === 'fixed';
}

function toggleSidebar() {
    if (isMobileSidebar()) {
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) { closeMobileSidebar(); } else { openMobileSidebar(); sidebarOpen = true; }
    } else {
        sidebarOpen = !sidebarOpen;
        sidebar.classList.toggle('collapsed', !sidebarOpen);
        sidebarToggleBtn.classList.toggle('active', sidebarOpen);
    }
}

function openMobileSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('show');
    sidebarOpen = true;
}

function closeMobileSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('show');
    sidebarOpen = false;
}

sidebarToggleBtn.addEventListener('click', toggleSidebar);
mobileToggleBtn.addEventListener('click', () => {
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) { closeMobileSidebar(); } else { openMobileSidebar(); sidebarOpen = true; }
});
sidebarOverlay.addEventListener('click', closeMobileSidebar);
sidebarToggleBtn.classList.add('active');

const fabSidebarToggle = document.getElementById('fab-sidebar-toggle');
if (fabSidebarToggle) {
    fabSidebarToggle.addEventListener('click', () => {
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) { closeMobileSidebar(); } else { openMobileSidebar(); sidebarOpen = true; }
    });
}

/* ─── Mobile Page Info ─── */
function updateMobilePageInfo() {
    mobilePageInfo.textContent = pdfDoc ? `${pageNum} / ${pdfDoc.numPages}` : '0 / 0';
    updateCacheBadge();
}

/* ─── Page Jump ─── */
pageJumpBtn.addEventListener('click', jumpToPage);
pageJumpInput.addEventListener('keydown', e => { if (e.key === 'Enter') jumpToPage(); });

function jumpToPage() {
    if (!pdfDoc) return;
    const n = parseInt(pageJumpInput.value, 10);
    if (!n || n < 1 || n > pdfDoc.numPages) return;
    goToAbsolutePage(n);
    pageJumpInput.value = '';
}

/* ─── IndexedDB (only for highlight settings) ─── */
let db;
const dbReq = indexedDB.open('DocReaderProDB', 2);
dbReq.onupgradeneeded = e => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
        console.log('[DB] Created settings store for highlights');
    }
    if (db.objectStoreNames.contains('documents')) {
        db.deleteObjectStore('documents');
        console.log('[DB] Removed old documents store');
    }
};
dbReq.onsuccess = e => {
    db = e.target.result;
    console.log('[DB] Opened DocReaderProDB v2 (settings only)');
    loadHighlightSettings();
    setTimeout(loadLastDocument, 500);
};
dbReq.onerror = e => {
    console.error('[DB] Failed to open database:', e.target.error);
};

/* ─── Highlight settings persistence ─── */
function saveHighlightSettings() {
    if (!db) return;
    const payload = { hlBaseColor, hlOpacity, hlRadius, hlOutline, hlPadding };
    db.transaction(['settings'], 'readwrite').objectStore('settings').put(payload, 'highlight');
}

function loadHighlightSettings() {
    if (!db) return;
    const req = db.transaction(['settings'], 'readonly').objectStore('settings').get('highlight');
    req.onsuccess = e => {
        const s = e.target.result;
        if (!s) return;
        if (s.hlBaseColor !== undefined) hlBaseColor = s.hlBaseColor;
        if (s.hlOpacity !== undefined) hlOpacity = s.hlOpacity;
        if (s.hlRadius !== undefined) hlRadius = s.hlRadius;
        if (s.hlOutline !== undefined) hlOutline = s.hlOutline;
        if (s.hlPadding !== undefined) hlPadding = s.hlPadding;

        const opacityPct = Math.round(hlOpacity * 100);
        document.getElementById('hl-opacity-slider').value = opacityPct;
        document.getElementById('hl-opacity-val').textContent = opacityPct + '%';
        document.getElementById('hl-radius-slider').value = hlRadius;
        document.getElementById('hl-radius-val').textContent = hlRadius + 'px';
        document.getElementById('hl-outline-toggle').checked = hlOutline;

        document.querySelectorAll('.hl-preset').forEach(btn => {
            btn.classList.remove('active');
            const presetRGB = HL_PRESETS[btn.dataset.color];
            if (presetRGB === hlBaseColor) btn.classList.add('active');
        });

        applyHighlightSettings();
    };
}

/* ─── Zoom ─── */
function setZoom(v, rerender = true) {
    v = Math.round(Math.min(3.0, Math.max(0.5, v)) * 10) / 10;
    scale = v;
    zoomSlider.value = scale;
    zoomVal.textContent = Math.round(scale * 100) + '%';
    if (pdfDoc && rerender) { queueRenderPage(pageNum); saveSettingsThrottled(pageNum, scale, currentIndex); }
}

zoomSlider.addEventListener('input', e => { zoomVal.textContent = Math.round(parseFloat(e.target.value) * 100) + '%'; });
zoomSlider.addEventListener('change', e => setZoom(parseFloat(e.target.value)));
zoomInBtn.addEventListener('click', () => setZoom(scale + 0.1));
zoomOutBtn.addEventListener('click', () => setZoom(scale - 0.1));
zoomResetBtn.addEventListener('click', () => setZoom(1.0));

/* ─── Server settings API ─── */
let saveTimeout = null;

function saveSettingsThrottled(page, scale, sentenceIndex) {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        saveSettings(page, scale, sentenceIndex);
    }, 1500);
}

async function saveSettings(page, scale, sentenceIndex) {
    if (!currentFileName) return;
    try {
        const res = await fetch('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                book_name: currentFileName,
                page,
                scale,
                sentenceIndex: sentenceIndex || 0,
                speed: playbackSpeed
            })
        });
        if (!res.ok) console.warn('Failed to save settings');
    } catch (e) {
        console.warn('Save settings error:', e);
    }
}

async function loadSettings(bookName) {
    try {
        const res = await fetch(`/settings?book_name=${encodeURIComponent(bookName)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.warn('Load settings error:', e);
        return null;
    }
}

/* ─── PDF Load ─── */
async function loadPDF(file, startPage = 1) {
    console.log(`[PDF] Loading: "${file.name}" (${(file.size / 1024 / 1024).toFixed(2)} MB), startPage=${startPage}`);
    showLoading('Loading document…');
    currentFile = file;
    currentFileName = file.name || 'Document';
    const fileUrl = URL.createObjectURL(file);

    welcomeScreen.classList.remove('active');
    readerScreen.classList.add('active');

    try {
        const task = pdfjsLib.getDocument(fileUrl);
        pdfDoc = await task.promise;

        topbarFilename.textContent = currentFileName;
        document.title = `DocReader Pro — ${currentFileName}`;

        document.getElementById('page-count').textContent = pdfDoc.numPages;
        pageJumpInput.max = pdfDoc.numPages;

        // ── Load server settings ──
        const settings = await loadSettings(currentFileName);
        if (settings) {
            pageNum = settings.page || 1;
            scale = settings.scale || 1.5;
            currentIndex = settings.sentenceIndex || 0;
            playbackSpeed = settings.speed || 1.0;
            speedSlider.value = playbackSpeed;
            speedVal.textContent = playbackSpeed.toFixed(1) + '×';
            zoomSlider.value = scale;
            zoomVal.textContent = Math.round(scale * 100) + '%';
        } else {
            // fallback mobile scaling
            if (window.innerWidth <= 768) {
                const vw = viewerArea.clientWidth - 16;
                const fp = await pdfDoc.getPage(1);
                const ov = fp.getViewport({ scale: 1 });
                scale = Math.round(Math.min(3.0, Math.max(0.9, vw / ov.width)) * 10) / 10;
                zoomSlider.value = scale;
                zoomVal.textContent = Math.round(scale * 100) + '%';
            }
        }

        // ── Save as last document ──
        try {
            await fetch('/last_document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentFileName })
            });
        } catch (e) {}

        await renderPage(pageNum);
        updateMobilePageInfo();

        // Load outline (TOC) — now with tree structure
        await loadOutline();

        // Pre-index all page texts for search
        indexAllPagesForSearch();

        if (isMobileSidebar()) closeMobileSidebar();

    } catch (err) {
        console.error(err);
        alert('Failed to load PDF.');
        resetUI();
    } finally {
        hideLoading();
    }
}

// ─── Auto-load last document ───
async function loadLastDocument() {
    try {
        const res = await fetch('/last_document');
        if (!res.ok) return;
        const data = await res.json();
        const filename = data.filename;
        if (!filename) return;

        const pdfRes = await fetch(`/pdfs/${encodeURIComponent(filename)}`);
        if (!pdfRes.ok) {
            console.warn(`Last document "${filename}" not found on server.`);
            return;
        }
        const blob = await pdfRes.blob();
        const file = new File([blob], filename, { type: 'application/pdf' });
        loadPDF(file, 1);
    } catch (e) {
        console.warn('Failed to load last document:', e);
    }
}

/* ─── PDF Outline / TOC with Tree Structure ─── */
async function loadOutline() {
    try {
        pdfOutline = await pdfDoc.getOutline();
    } catch (e) {
        pdfOutline = null;
    }

    tocList.innerHTML = '';

    if (!pdfOutline || pdfOutline.length === 0) {
        tocEmpty.style.display = 'block';
        return;
    }

    tocEmpty.style.display = 'none';

    // ── Build the tree ──
    let chapterCounter = 0;

    function renderTree(items, level, path, parentLast) {
        items.forEach((item, index, arr) => {
            const isLast = index === arr.length - 1;
            const newPath = [...path, isLast];
            const isChapter = (level === 0);

            if (isChapter) {
                chapterCounter++;
            }

            let prefix = '';
            if (level > 0) {
                for (let i = 0; i < newPath.length - 1; i++) {
                    prefix += newPath[i] ? '    ' : '│   ';
                }
                prefix += isLast ? '└── ' : '├── ';
            } else {
                prefix = `${chapterCounter}. `;
            }

            let pageNumber = '—';
            if (item.dest) {
                pageNumber = '…';
            }

            const el = document.createElement('div');
            el.className = `toc-item level-${level}`;
            el.dataset.level = level;

            el._tocItem = item;
            el._path = newPath;
            el._level = level;
            el._isChapter = isChapter;
            el._chapterNumber = isChapter ? chapterCounter : null;

            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'tree-prefix';
            prefixSpan.textContent = prefix;
            el.appendChild(prefixSpan);

            const numSpan = document.createElement('span');
            numSpan.className = 'toc-item-num';
            numSpan.textContent = pageNumber;
            el.appendChild(numSpan);

            const labelSpan = document.createElement('span');
            labelSpan.className = 'toc-item-label';
            labelSpan.textContent = item.title || '(untitled)';
            el.appendChild(labelSpan);

            el.addEventListener('click', async () => {
                if (!item.dest) return;
                try {
                    let dest = item.dest;
                    if (typeof dest === 'string') {
                        dest = await pdfDoc.getDestination(dest);
                    }
                    if (!dest) return;
                    const ref = dest[0];
                    const pageIdx = await pdfDoc.getPageIndex(ref);
                    const targetPage = pageIdx + 1;

                    numSpan.textContent = targetPage;

                    stopPipeline();
                    goToAbsolutePage(targetPage);

                    document.querySelectorAll('.toc-item').forEach(i => i.classList.remove('active'));
                    el.classList.add('active');

                    if (isMobileSidebar()) closeMobileSidebar();
                } catch (e) {
                    console.warn('TOC navigation error:', e);
                }
            });

            tocList.appendChild(el);

            if (item.items && item.items.length) {
                renderTree(item.items, level + 1, newPath, isLast);
            }
        });
    }

    renderTree(pdfOutline, 0, [], false);

    // ── Resolve page numbers (async) ──
    await resolveAllTOCPages();

    // Now the page numbers are set, update the active item
    updateActiveTocItem();
    updateReadingTimes();
}

async function resolveAllTOCPages() {
    const items = tocList.querySelectorAll('.toc-item');
    for (const el of items) {
        const item = el._tocItem;
        if (!item || !item.dest) continue;
        const numSpan = el.querySelector('.toc-item-num');
        try {
            let dest = item.dest;
            if (typeof dest === 'string') {
                dest = await pdfDoc.getDestination(dest);
            }
            if (dest) {
                const pageIdx = await pdfDoc.getPageIndex(dest[0]);
                numSpan.textContent = pageIdx + 1;
                el.dataset.page = pageIdx + 1;
            }
        } catch (e) {}
    }
}

function updateActiveTocItem() {
    const items = tocList.querySelectorAll('.toc-item[data-page]');
    let activeEl = null;
    let bestPage = 0;

    items.forEach(el => {
        const p = parseInt(el.dataset.page, 10);
        if (p <= pageNum && p > bestPage) {
            bestPage = p;
            activeEl = el;
        }
    });

    // Remove active class from all
    items.forEach(el => el.classList.remove('active'));

    if (!activeEl) {
        updateReadingTimes();
        return;
    }

    activeEl.classList.add('active');

    // Scroll the sidebar content so the active item is visible
    const sidebarContent = document.getElementById('sidebar-content');
    if (!sidebarContent) {
        updateReadingTimes();
        return;
    }

    // Retry scroll if the item's offset isn't ready yet
    let attempts = 0;
    const maxAttempts = 5;
    const attemptScroll = () => {
        const itemTop = activeEl.offsetTop - sidebarContent.offsetTop;
        // If offset is 0 or negative, the layout isn't ready
        if (itemTop <= 0 && attempts < maxAttempts) {
            attempts++;
            setTimeout(attemptScroll, 150);
            return;
        }
        // Scroll with a small padding
        sidebarContent.scrollTo({ top: Math.max(0, itemTop - 20), behavior: 'smooth' });
        updateReadingTimes();
    };

    attemptScroll();
}

/* ─── Reading Time Estimation ─── */

function computePageTime(page) {
    const stats = pageStats[page];
    if (!stats) return null;
    const wpm = 150; // average words per minute at 1.0x
    const words = stats.totalChars / 5; // approximate
    const seconds = (words / (wpm * playbackSpeed)) * 60;
    return seconds;
}

function computeChapterTime() {
    // Find active chapter (level 0) and its page range
    const activeChapterEl = document.querySelector('.toc-item.level-0.active');
    if (!activeChapterEl) return null;
    const startPage = parseInt(activeChapterEl.dataset.page, 10);
    if (!startPage) return null;

    // Find next chapter's page
    let endPage = pdfDoc.numPages;
    const allChapters = document.querySelectorAll('.toc-item.level-0');
    for (let i = 0; i < allChapters.length; i++) {
        if (allChapters[i] === activeChapterEl) {
            if (i + 1 < allChapters.length) {
                const nextPage = parseInt(allChapters[i + 1].dataset.page, 10);
                if (nextPage) endPage = nextPage - 1;
            }
            break;
        }
    }

    let totalChars = 0;
    for (let p = startPage; p <= endPage; p++) {
        const stats = pageStats[p];
        if (stats) totalChars += stats.totalChars;
    }
    if (totalChars === 0) return null;
    const wpm = 150;
    const words = totalChars / 5;
    const seconds = (words / (wpm * playbackSpeed)) * 60;
    return seconds;
}

// ─── Exact Reading Time from Server ───

async function fetchPageDuration(bookName, page) {
    try {
        const res = await fetch(`/page_duration?book_name=${encodeURIComponent(bookName)}&page=${page}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.duration || 0;
    } catch (e) {
        console.warn('fetchPageDuration error:', e);
        return null;
    }
}

async function fetchChapterDuration(bookName, startPage, endPage) {
    try {
        const res = await fetch(`/chapter_duration?book_name=${encodeURIComponent(bookName)}&start_page=${startPage}&end_page=${endPage}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.duration || 0;
    } catch (e) {
        console.warn('fetchChapterDuration error:', e);
        return null;
    }
}

// ─── Update Reading Times (exact) ───
async function updateReadingTimes() {
    if (!currentFileName || !pdfDoc) {
        pageTimeEl.textContent = 'Page: —';
        chapterTimeEl.textContent = 'Chapter: —';
        return;
    }

    const fmt = formatDuration;

    // 1) Page time
    let pageDur = 0;
    if (isPlaying && Object.keys(sentenceDurations).length) {
        let total = 0;
        for (let i = currentIndex; i < sentences.length; i++) {
            const d = sentenceDurations[i] || estimateSentenceDuration(sentences[i]);
            total += d;
        }
        pageDur = total / playbackSpeed;
        pageTimeEl.textContent = `Page: ${fmt(pageDur)}`;
    } else {
        const pageDuration = await fetchPageDuration(currentFileName, pageNum);
        if (pageDuration !== null && pageDuration > 0) {
            pageDur = pageDuration / playbackSpeed;
            pageTimeEl.textContent = `Page: ${fmt(pageDur)}`;
        } else {
            const stats = pageStats[pageNum];
            if (stats) {
                const words = stats.totalChars / 5;
                const seconds = (words / (150 * playbackSpeed)) * 60;
                pageTimeEl.textContent = `Page: ~${fmt(seconds)}`;
            } else {
                pageTimeEl.textContent = 'Page: —';
            }
        }
    }

    // 2) Chapter time – find active chapter (fallback if class missing)
    let activeChapter = document.querySelector('.toc-item.level-0.active');
    if (!activeChapter) {
        // Find the chapter whose start page <= current page and (next start > current or no next)
        const chapters = document.querySelectorAll('.toc-item.level-0');
        let best = null;
        let bestStart = 0;
        for (const el of chapters) {
            const start = parseInt(el.dataset.page, 10);
            if (start && start <= pageNum && start > bestStart) {
                bestStart = start;
                best = el;
            }
        }
        activeChapter = best;
        if (activeChapter) {
            chapters.forEach(c => c.classList.remove('active'));
            activeChapter.classList.add('active');
        }
    }

    if (!activeChapter) {
        chapterTimeEl.textContent = 'Chapter: —';
        return;
    }

    const start = parseInt(activeChapter.dataset.page, 10);
    if (!start) {
        chapterTimeEl.textContent = 'Chapter: —';
        return;
    }

    // Determine chapter end page (before next chapter starts)
    let end = pdfDoc.numPages;
    const allChapters = document.querySelectorAll('.toc-item.level-0');
    for (let i = 0; i < allChapters.length; i++) {
        if (allChapters[i] === activeChapter) {
            if (i + 1 < allChapters.length) {
                const nextPage = parseInt(allChapters[i + 1].dataset.page, 10);
                if (nextPage) end = nextPage - 1;
            }
            break;
        }
    }
    chapterStartPage = start;
    chapterEndPage = end;

    // Compute chapter remaining time
    if (isPlaying && Object.keys(sentenceDurations).length) {
        let total = 0;
        // Remaining on current page
        for (let i = currentIndex; i < sentences.length; i++) {
            const d = sentenceDurations[i] || estimateSentenceDuration(sentences[i]);
            total += d;
        }
        // Full pages after current page in chapter
        for (let p = pageNum + 1; p <= chapterEndPage; p++) {
            const dur = await fetchPageDuration(currentFileName, p);
            if (dur !== null && dur > 0) {
                total += dur;
            } else {
                const stats = pageStats[p];
                if (stats) {
                    const words = stats.totalChars / 5;
                    total += (words / 150) * 60;
                }
            }
        }
        const chapDur = total / playbackSpeed;
        chapterTimeEl.textContent = `Chapter: ${fmt(chapDur)}`;
    } else {
        const chapterDuration = await fetchChapterDuration(currentFileName, start, end);
        if (chapterDuration !== null && chapterDuration > 0) {
            const eff = chapterDuration / playbackSpeed;
            chapterTimeEl.textContent = `Chapter: ${fmt(eff)}`;
        } else {
            let totalChars = 0;
            for (let p = start; p <= end; p++) {
                const stats = pageStats[p];
                if (stats) totalChars += stats.totalChars;
            }
            if (totalChars > 0) {
                const seconds = (totalChars / 5 / (150 * playbackSpeed)) * 60;
                chapterTimeEl.textContent = `Chapter: ~${fmt(seconds)}`;
            } else {
                chapterTimeEl.textContent = 'Chapter: —';
            }
        }
    }
}

function estimateSentenceDuration(text) {
    // Assume ~150 words per minute, average word length 5 chars
    const words = text.length / 5;
    return (words / 150) * 60; // seconds at 1.0x
}
// Call after rendering a page
function updatePageStats(page, sentences) {
    let totalChars = 0;
    sentences.forEach(s => totalChars += s.length);
    pageStats[page] = { totalChars, sentenceCount: sentences.length };
}

/* ─── Search ─── */
async function indexAllPagesForSearch() {
    searchAllPageTexts = {};
}

async function getPageText(pageIndex) {
    if (searchAllPageTexts[pageIndex] !== undefined) return searchAllPageTexts[pageIndex];
    try {
        const page = await pdfDoc.getPage(pageIndex);
        const tc = await page.getTextContent();
        const text = tc.items.map(i => i.str).join(' ');
        searchAllPageTexts[pageIndex] = text;
        return text;
    } catch (e) {
        return '';
    }
}

let searchDebounceTimer = null;

searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(performSearch, 320);
});

searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.shiftKey ? prevSearchMatch() : nextSearchMatch(); }
    if (e.key === 'Escape') clearSearch();
});

searchPrevBtn.addEventListener('click', prevSearchMatch);
searchNextBtn.addEventListener('click', nextSearchMatch);
searchClearBtn.addEventListener('click', clearSearch);

async function performSearch() {
    const query = searchInput.value.trim();
    if (!query || !pdfDoc) {
        clearSearch();
        return;
    }

    searchClearBtn.style.display = '';
    searchCount.textContent = '…';
    searchResultsPanel.classList.add('visible');
    searchResultsList.innerHTML = '<div style="padding:14px 16px;color:var(--text-tertiary);font-size:13px">Searching…</div>';

    searchMatches = [];
    const lowerQuery = query.toLowerCase();

    showLoading('Searching document…');

    for (let p = 1; p <= pdfDoc.numPages; p++) {
        const text = await getPageText(p);
        const lowerText = text.toLowerCase();
        let pos = 0;
        while (true) {
            const idx = lowerText.indexOf(lowerQuery, pos);
            if (idx === -1) break;
            const context = text.slice(Math.max(0, idx - 40), idx + query.length + 60);
            searchMatches.push({ page: p, index: idx, context, query });
            pos = idx + 1;
        }
    }

    hideLoading();

    if (searchMatches.length === 0) {
        searchCount.textContent = '0';
        searchResultsList.innerHTML = '<div class="toc-empty">No results found for <strong>"' + query + '"</strong></div>';
        searchCurrentMatch = -1;
        searchPrevBtn.disabled = true;
        searchNextBtn.disabled = true;
        return;
    }

    searchCount.textContent = searchMatches.length;
    resultsHeaderText.textContent = `${searchMatches.length} result${searchMatches.length !== 1 ? 's' : ''}`;

    searchResultsList.innerHTML = '';
    searchMatches.forEach((m, i) => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.dataset.index = i;

        const badge = document.createElement('span');
        badge.className = 'result-page-badge';
        badge.textContent = 'p.' + m.page;

        const text = document.createElement('span');
        text.className = 'result-text';
        const hi = m.context.toLowerCase().indexOf(m.query.toLowerCase());
        if (hi >= 0) {
            text.innerHTML =
                escapeHtml(m.context.slice(0, hi)) +
                '<em>' + escapeHtml(m.context.slice(hi, hi + m.query.length)) + '</em>' +
                escapeHtml(m.context.slice(hi + m.query.length));
        } else {
            text.textContent = m.context;
        }

        item.appendChild(badge);
        item.appendChild(text);
        item.addEventListener('click', () => goToSearchMatch(i));
        searchResultsList.appendChild(item);
    });

    searchCurrentMatch = -1;
    searchPrevBtn.disabled = false;
    searchNextBtn.disabled = false;
    nextSearchMatch();
}

function goToSearchMatch(idx) {
    if (idx < 0 || idx >= searchMatches.length) return;
    searchCurrentMatch = idx;

    const match = searchMatches[idx];
    searchCount.textContent = `${idx + 1}/${searchMatches.length}`;

    document.querySelectorAll('.search-result-item').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
    });
    document.querySelectorAll('.search-result-item')[idx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    if (match.page !== pageNum) {
        goToAbsolutePage(match.page, () => highlightSearchOnPage(match.query));
    } else {
        highlightSearchOnPage(match.query);
    }
}

function nextSearchMatch() {
    goToSearchMatch(searchCurrentMatch + 1 < searchMatches.length ? searchCurrentMatch + 1 : 0);
}

function prevSearchMatch() {
    goToSearchMatch(searchCurrentMatch - 1 >= 0 ? searchCurrentMatch - 1 : searchMatches.length - 1);
}

function clearSearch() {
    searchInput.value = '';
    searchCount.textContent = '';
    searchMatches = [];
    searchCurrentMatch = -1;
    searchPrevBtn.disabled = true;
    searchNextBtn.disabled = true;
    searchClearBtn.style.display = 'none';
    searchResultsPanel.classList.remove('visible');
    clearSearchHighlights();
}

function highlightSearchOnPage(query) {
    clearSearchHighlights();
    if (!query) return;
    const spans = document.querySelectorAll('.textLayer span');
    const lq = query.toLowerCase();
    spans.forEach(span => {
        const orig = span.dataset.originalText !== undefined ? span.dataset.originalText : span.textContent;
        const lo = orig.toLowerCase();
        let pos = 0, result = '';
        while (true) {
            const i = lo.indexOf(lq, pos);
            if (i === -1) { result += escapeHtml(orig.slice(pos)); break; }
            result += escapeHtml(orig.slice(pos, i)) + '<mark class="search-highlight">' + escapeHtml(orig.slice(i, i + query.length)) + '</mark>';
            pos = i + query.length;
        }
        if (result !== escapeHtml(orig)) {
            if (span.dataset.originalText === undefined) span.dataset.originalText = orig;
            span.innerHTML = result;
        }
    });

    const first = document.querySelector('.search-highlight');
    if (first) {
        const rect = first.getBoundingClientRect();
        const va = viewerArea.getBoundingClientRect();
        if (rect.top < va.top || rect.bottom > va.bottom) {
            viewerArea.scrollBy({ top: rect.top - va.top - va.height / 3, behavior: 'smooth' });
        }
    }
}

function clearSearchHighlights() {
    document.querySelectorAll('.textLayer span').forEach(span => {
        if (span.dataset.originalText !== undefined) {
            span.textContent = span.dataset.originalText;
        }
    });
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('click', e => {
    if (!searchResultsPanel.contains(e.target) && !document.getElementById('search-container').contains(e.target)) {
        searchResultsPanel.classList.remove('visible');
    }
});
searchInput.addEventListener('focus', () => {
    if (searchMatches.length > 0) searchResultsPanel.classList.add('visible');
});

/* ─── PDF Rendering ─── */
let afterRenderCallback = null;

async function renderPage(num) {
    pageIsRendering = true;
    clearHighlightCanvas();
    try {
        const page = await pdfDoc.getPage(num);
        const viewport = page.getViewport({ scale });

        const canvas = document.getElementById('pdf-canvas');
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';

        const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
        await page.render({ canvasContext: ctx, viewport, transform }).promise;

        const textLayerDiv = document.getElementById('text-layer');
        textLayerDiv.innerHTML = '';
        textLayerDiv.style.height = cssH + 'px';
        textLayerDiv.style.width = cssW + 'px';
        textLayerDiv.style.setProperty('--scale-factor', viewport.scale);

        const textContent = await page.getTextContent();

        // ── Heuristic text extraction for TTS ──
        const fontSizes = textContent.items.map(i => Math.abs(i.transform[3])).filter(s => s > 0).sort((a, b) => a - b);
        const baseFontSize = fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12;

        const Y_TOL = 5;
        const sorted = [...textContent.items].sort((a, b) => {
            const dy = a.transform[5] - b.transform[5];
            if (Math.abs(dy) > Y_TOL) return b.transform[5] - a.transform[5];
            return a.transform[4] - b.transform[4];
        });

        let lines = [];
        let curLine = { y: null, items: [] };
        sorted.forEach(item => {
            if (!item.str.trim()) return;
            const y = item.transform[5];
            if (curLine.y === null || Math.abs(curLine.y - y) > Y_TOL) {
                if (curLine.items.length) lines.push(curLine);
                curLine = { y, items: [item] };
            } else {
                curLine.items.push(item);
            }
        });
        if (curLine.items.length) lines.push(curLine);

        let structuredText = '';
        const unscaledH = viewport.viewBox ? viewport.viewBox[3] : 800;
        let prevY = null;
        let inListItem = false;

        lines.forEach(line => {
            let lineText = line.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
            if (!lineText) return;
            const avgFS = line.items.reduce((s, i) => s + Math.abs(i.transform[3]), 0) / line.items.length;
            const isTop = line.y > (unscaledH - 60);
            const isBot = line.y < 60;
            const isNum = /^[\[\(\-–—\s]*\d+[\]\)\-–—\s]*$/.test(lineText);
            if ((isTop || isBot) && isNum) return;

            const isHeader = avgFS > baseFontSize * 1.2;
            const startsNewListItem = /^[\u2022\u25E6\u25A0\u25CF\u2013\-\*]\s/.test(lineText) ||
                                      /^\d+[\.\)]\s/.test(lineText) ||
                                      /^[a-zA-Z][\.\)]\s/.test(lineText);
            const isNewPara = prevY !== null && (prevY - line.y) > baseFontSize * 1.5;
            const isListContinuation = inListItem && !startsNewListItem && !isNewPara && !isHeader;

            prevY = line.y;

            if (isHeader) {
                inListItem = false;
                structuredText += `\n${lineText}.\n`;
            } else if (startsNewListItem) {
                if (inListItem) {
                    if (!structuredText.trim().match(/[.!?]$/)) {
                        structuredText = structuredText.trimEnd() + '.\n';
                    } else {
                        structuredText = structuredText.trimEnd() + '\n';
                    }
                } else {
                    structuredText += structuredText && !structuredText.endsWith('\n') ? '\n' : '';
                }
                inListItem = true;
                structuredText += lineText;
            } else if (isListContinuation) {
                if (structuredText.endsWith('-')) {
                    structuredText = structuredText.slice(0, -1) + lineText;
                } else {
                    structuredText = structuredText.trimEnd() + ' ' + lineText;
                }
            } else if (isNewPara) {
                inListItem = false;
                structuredText += (!structuredText.trim().match(/[.!?]$/) ? '.\n' : '\n') + lineText;
            } else if (structuredText.endsWith('-')) {
                structuredText = structuredText.slice(0, -1) + lineText;
            } else if (structuredText.endsWith('\n') || !structuredText) {
                structuredText += lineText;
            } else {
                structuredText += ' ' + lineText;
            }
        });

        currentPageText = structuredText;
        sentences = splitIntoTTSChunks(currentPageText, 250);
        updatePageStats(num, sentences);

        await pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
            textDivs: [],
            enhanceTextSelection: true
        }).promise;

        await renderAnnotations(page, viewport, cssW, cssH);

        document.getElementById('page-num').textContent = num;
        prevPageBtn.disabled = num <= 1;
        nextPageBtn.disabled = num >= pdfDoc.numPages;
        updateMobilePageInfo();
        updateActiveTocItem();
        updateReadingTimes();

        if (textContent.items.length) {
            searchAllPageTexts[num] = textContent.items.map(i => i.str).join(' ');
        }

        pageIsRendering = false;

        if (pageNumPending !== null) {
            const pending = pageNumPending;
            pageNumPending = null;
            renderPage(pending);
            return;
        }

		if (isPlaying && currentIndex < sentences.length) {
			highlightActiveSentence(currentIndex, sentences);
			setTimeout(() => {
				const highlight = document.querySelector('mark.reading-highlight');
				if (highlight) {
					const rect = highlight.getBoundingClientRect();
					const va = viewerArea.getBoundingClientRect();
					if (rect.top < va.top || rect.bottom > va.bottom) {
						viewerArea.scrollBy({ top: rect.top - va.top - va.height / 3, behavior: 'smooth' });
					}
				}
			}, 100);
		} else {
			// No highlight – scroll to top of the page
			viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
		}

        if (isAutoContinuing) {
            isAutoContinuing = false;
            setTimeout(() => {
                if (currentPageText.trim()) {
                    isPlaying = false;
                    startReadingPage(0);
                } else if (pageNum < pdfDoc.numPages) {
                    isAutoContinuing = true;
                    goToPage(1, true);
                } else {
                    stopPipeline();
                }
            }, 300);
        }

        const q = searchInput.value.trim();
        if (q) highlightSearchOnPage(q);

        if (afterRenderCallback) {
            const cb = afterRenderCallback;
            afterRenderCallback = null;
            cb();
        }

    } catch (err) {
        console.error('Render error:', err);
        pageIsRendering = false;
    }
}

/* ─── Annotation Layer ─── */
async function renderAnnotations(page, viewport, cssW, cssH) {
    const annotLayer = document.getElementById('annotation-layer');
    annotLayer.innerHTML = '';
    annotLayer.style.width = cssW + 'px';
    annotLayer.style.height = cssH + 'px';

    try {
        const annotations = await page.getAnnotations();

        for (const annot of annotations) {
            if (annot.subtype !== 'Link') continue;

            const rect = pdfjsLib.Util.normalizeRect([
                annot.rect[0], annot.rect[1], annot.rect[2], annot.rect[3]
            ]);
            const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);

            const linkWrap = document.createElement('div');
            linkWrap.className = 'linkAnnotation';
            linkWrap.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;

            const anchor = document.createElement('a');

            if (annot.url) {
                anchor.href = annot.url;
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
            } else if (annot.dest) {
                anchor.href = '#';
                anchor.dataset.dest = typeof annot.dest === 'string' ? annot.dest : JSON.stringify(annot.dest);
                anchor.addEventListener('click', async e => {
                    e.preventDefault();
                    try {
                        let dest = annot.dest;
                        if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
                        if (!dest) return;
                        const pageIdx = await pdfDoc.getPageIndex(dest[0]);
                        stopPipeline();
                        goToAbsolutePage(pageIdx + 1);
                    } catch (err) {
                        console.warn('Link navigation failed:', err);
                    }
                });
            } else if (annot.action && annot.action.type === 'GoTo') {
                anchor.href = '#';
                anchor.addEventListener('click', async e => {
                    e.preventDefault();
                    if (annot.action.dest) {
                        try {
                            let dest = annot.action.dest;
                            if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
                            const pageIdx = await pdfDoc.getPageIndex(dest[0]);
                            stopPipeline();
                            goToAbsolutePage(pageIdx + 1);
                        } catch (err) {}
                    }
                });
            } else {
                continue;
            }

            linkWrap.appendChild(anchor);
            annotLayer.appendChild(linkWrap);
        }
    } catch (e) {
        console.warn('Annotation rendering error:', e);
    }
}

function queueRenderPage(num) {
    pageIsRendering ? (pageNumPending = num) : renderPage(num);
}

/* ─── Page Navigation ─── */
function goToPage(delta, isAutoTurn = false) {
    if (!pdfDoc) return;
    const target = pageNum + delta;
    if (target < 1 || target > pdfDoc.numPages) return;
    if (!isAutoTurn) { stopPipeline(); isAutoContinuing = false; }
    clearPageAudioCache();
    currentIndex = 0;
    pageNum = target;
    queueRenderPage(pageNum);
    saveSettingsThrottled(pageNum, scale, currentIndex);
    viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToAbsolutePage(target, callback = null) {
    if (!pdfDoc || target < 1 || target > pdfDoc.numPages) return;
    stopPipeline();
    clearPageAudioCache();
    currentIndex = 0;
    pageNum = target;
    if (callback) afterRenderCallback = callback;
    queueRenderPage(pageNum);
    saveSettingsThrottled(pageNum, scale, currentIndex);
    viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
}

prevPageBtn.addEventListener('click', () => goToPage(-1));
nextPageBtn.addEventListener('click', () => goToPage(1));
mobilePrevBtn.addEventListener('click', () => goToPage(-1));
mobileNextBtn.addEventListener('click', () => goToPage(1));

document.addEventListener('keydown', e => {
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (e.key === 'Escape') { resetUI(); return; }
    if (e.key === 's' || e.key === 'S') { toggleSidebar(); return; }
    if (!pdfDoc) return;

    if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'h') goToPage(-1);
    if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') goToPage(1);
    if (e.key === '+' || e.key === '=') setZoom(scale + 0.1);
    if (e.key === '-' || e.key === '_') setZoom(scale - 0.1);

    if (e.key === ' ') { e.preventDefault(); playBtn.click(); }

    if (e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'k') {
        if (!sentences || sentences.length === 0) return;

        let newIndex = currentIndex;

        if (e.key.toLowerCase() === 'j') {
            newIndex = Math.min(currentIndex + 1, sentences.length - 1);
        } else if (e.key.toLowerCase() === 'k') {
            newIndex = Math.max(currentIndex - 1, 0);
        }

        if (newIndex !== currentIndex || !isPlaying) {
            currentIndex = newIndex;
            highlightActiveSentence(currentIndex, sentences);
            updateTtsStatus();
            startReadingPage(currentIndex);
            saveSettingsThrottled(pageNum, scale, currentIndex);
        }
    }
});

/* ─── File Handling ─── */
fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file && file.type === 'application/pdf') {
        loadPDF(file, 1);
    }
});

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
        loadPDF(file, 1);
    }
});

document.getElementById('close-file').addEventListener('click', resetUI);

function resetUI() {
    stopPipeline();
    clearPageAudioCache();
    clearHighlightCanvas();
    pdfDoc = null;
    currentFile = null;
    currentFileName = '';
    fileInput.value = '';
    readerScreen.classList.remove('active');
    welcomeScreen.classList.add('active');
    document.getElementById('text-layer').innerHTML = '';
    document.getElementById('annotation-layer').innerHTML = '';
    document.title = 'DocReader Pro';
    topbarFilename.textContent = 'No document';
    tocList.innerHTML = '';
    tocEmpty.style.display = 'block';
    clearSearch();
    searchAllPageTexts = {};
    pageNum = 1;
    pdfOutline = null;
    cacheBadge.classList.remove('visible');
    syncMobilePlayBtn();
    loadServerPDFs();
    pageTimeEl.textContent = 'Page: —';
    chapterTimeEl.textContent = 'Chapter: —';
    Object.keys(pageStats).forEach(key => delete pageStats[key]);
}

/* ─── TTS ─── */
function splitIntoTTSChunks(text, maxLength = 120) {
    let chunks = text.split('\n').flatMap(c => c.split(/(?<=[.!?])\s+/)).map(s => s.trim()).filter(s => s.length > 0);
    let final = [];
    chunks.forEach(chunk => {
        if (chunk.length <= maxLength) { final.push(chunk); return; }
        let subs = chunk.split(/(?<=[,;:\-—])\s+/);
        let cur = '';
        subs.forEach(sub => {
            if ((cur.length + sub.length) <= maxLength) {
                cur += (cur ? ' ' : '') + sub;
            } else {
                if (cur) final.push(cur.trim());
                if (sub.length > maxLength) {
                    let words = sub.split(/\s+/), ws = '';
                    words.forEach(w => {
                        if ((ws.length + w.length) <= maxLength) ws += (ws ? ' ' : '') + w;
                        else { if (ws) final.push(ws.trim()); ws = w; }
                    });
                    cur = ws;
                } else { cur = sub; }
            }
        });
        if (cur) final.push(cur.trim());
    });
    return final;
}

function updateTtsStatus() {
    if (!sentences.length) return;
    const di = Math.min(currentIndex + 1, sentences.length);
    ttsProgressFill.style.width = Math.round((di / sentences.length) * 100) + '%';
    ttsStatusText.textContent = `Sentence ${di} / ${sentences.length}`;
}

function startReadingPage(startIndex = 0) {
    if (!pdfDoc || !currentPageText.trim() || !sentences.length) return;
    if (isPlaying) stopPipeline();

    currentIndex = startIndex;
    isPlaying = true;
    hasStartedPlaying = false;

    playBtn.textContent = '⏹ Stop';
    ttsStatus.classList.add('active');
    syncMobilePlayBtn();

    // Fetch per‑sentence durations for this page
    fetchSentenceDurationsForCurrentPage().then(() => {
        // Now we have durations; compute remaining times
        pageRemaining = 0;
        for (let i = currentIndex; i < sentences.length; i++) {
            const d = sentenceDurations[i] || estimateSentenceDuration(sentences[i]);
            pageRemaining += d / playbackSpeed;
        }
        // Chapter remaining will be computed in updateReadingTimes
        updateReadingTimes();
    });

    const required = Math.min(REQUIRED_START_BUFFER, sentences.length - currentIndex);
    let readyCount = 0;
    for (let i = currentIndex; i < currentIndex + required; i++) {
        if (audioCache[i] && audioCache[i] !== 'fetching') readyCount++;
    }

    if (readyCount >= required) {
        hasStartedPlaying = true;
        playNextChunk();
    } else {
        ttsStatusText.textContent = `Generating… ${readyCount}/${required}`;
    }
    preloadQueue();
}

async function fetchSentenceDurationsForCurrentPage() {
    if (!currentFileName || !pdfDoc) return;
    try {
        const res = await fetch(
            `/page_sentence_durations?book_name=${encodeURIComponent(currentFileName)}&page=${pageNum}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        sentenceDurations = data.durations || {};
    } catch (e) {
        console.warn('Could not fetch sentence durations:', e);
        sentenceDurations = {};
    }
}

playBtn.addEventListener('click', () => {
    if (isPlaying) { stopPipeline(); return; }
    if (!pdfDoc || !currentPageText.trim()) { alert('No text on this page.'); return; }
    let si = currentIndex >= sentences.length ? 0 : currentIndex;
    startReadingPage(si);
});

function preloadQueue() {
    if (!isPlaying) return;
    const limit = Math.min(currentIndex + BUFFER_DEPTH, sentences.length);
    for (let i = currentIndex; i < limit; i++) {
        if (inFlight >= MAX_CONCURRENT_FETCHES) break;
        if (audioCache[i] === undefined) {
            inFlight++;
            audioCache[i] = 'fetching';
            fetchSentenceAudio(i);
        }
    }
}

function normalizeTTSText(raw) {
    let t = raw;
    t = t.replace(/https?:\/\/[^\s,;)\]>'"]+/gi, url => {
        return url
            .replace(/^https?/, m => m)
            .replace(/:\/\//, ' colon slash slash ')
            .replace(/\//g, ' slash ')
            .replace(/\./g, ' dot ')
            .replace(/\?/g, ' question mark ')
            .replace(/=/g, ' equals ')
            .replace(/&/g, ' and ')
            .replace(/-/g, ' dash ')
            .replace(/_/g, ' ')
            .replace(/\s{2,}/g, ' ');
    });
    t = t.replace(/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/gi, email => {
        const [local, domain] = email.split('@');
        const readLocal = local.replace(/\./g, ' dot ').replace(/_/g, ' underscore ').replace(/-/g, ' dash ').replace(/\+/g, ' plus ');
        const readDomain = domain.replace(/\./g, ' dot ').replace(/-/g, ' dash ');
        return `${readLocal} at ${readDomain}`;
    });
    t = t.replace(/\b([\w\-]+)\.([a-zA-Z]{2,5})\b/g, (m, name, ext) => {
        return `${name} dot ${ext}`;
    });
    t = t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
        (_, a, b, c, d) => `${a} dot ${b} dot ${c} dot ${d}`);
    t = t.replace(/\bv?(\d+)(?:\.(\d+)){1,3}\b/g, m =>
        m.replace(/\./g, ' dot '));
    t = t.replace(/(?<!\s)\.(?!\s*([A-Z]|$))/g, ' dot ');
    t = t.replace(/(\w)\.(\w)/g, '$1 dot $2');
    t = t.replace(/\.{2,}|…/g, ', ');
    t = t.replace(/[—–]/g, ', ');
    t = t.replace(/\//g, ' slash ');
    t = t.replace(/\\/g, ' backslash ');
    t = t.replace(/@/g, ' at ');
    t = t.replace(/#(\d+)/g, 'number $1');
    t = t.replace(/#/g, ' hash ');
    t = t.replace(/(\d)\s*%/g, '$1 percent');
    t = t.replace(/%/g, ' percent ');
    t = t.replace(/&amp;/g, ' and ');
    t = t.replace(/&/g, ' and ');
    t = t.replace(/\+/g, ' plus ');
    t = t.replace(/\*/g, ' times ');
    t = t.replace(/==/g, ' equals ');
    t = t.replace(/!=/g, ' not equals ');
    t = t.replace(/>=/g, ' greater than or equal to ');
    t = t.replace(/<=/g, ' less than or equal to ');
    t = t.replace(/=>/g, ' arrow ');
    t = t.replace(/(?<!\s)=(?!\s)/g, ' equals ');
    t = t.replace(/(?<!\s)>(?!\s)/g, ' greater than ');
    t = t.replace(/(?<!\s)<(?!\s)/g, ' less than ');
    t = t.replace(/\|/g, ' or ');
    t = t.replace(/_/g, ' ');
    t = t.replace(/[`''""]/g, '');
    t = t.replace(/\s{2,}/g, ' ').trim();
    return t;
}

async function fetchSentenceAudio(idx, forceRegenerate = false) {
    try {
        const raw = sentences[idx];
        const text = normalizeTTSText(
            /^\d{1,2}$/.test(raw.trim()) ? `Page ${raw.trim()}.` : raw
        );
        const voice = document.getElementById('voice-selector').value;
        const serverSpeed = 1.0;

        const headers = { 'Content-Type': 'application/json' };
        if (currentFileName) {
            headers['X-Book-Name'] = currentFileName;
            headers['X-Page-Number'] = String(pageNum);
            headers['X-Line-Number'] = String(idx);
            headers['X-Save-Audio'] = saveAudioEnabled ? 'true' : 'false';
            if (forceRegenerate) {
                headers['X-Force-Regenerate'] = 'true';
            }
        }

        const res = await fetch('/synthesize', {
            method: 'POST',
            headers,
            body: JSON.stringify({ text, voice, speed: serverSpeed })
        });
        if (!res.ok) throw new Error(`Backend ${res.status}`);

        const blob = await res.blob();

        if (audioCache[idx] === 'fetching') audioCache[idx] = URL.createObjectURL(blob);
    } catch (e) {
        console.error(`[TTS] Fetch FAILED for sentence ${idx}:`, e);
        if (audioCache[idx] === 'fetching') audioCache[idx] = null;
    } finally {
        inFlight--;
        if (isPlaying) {
            if (!hasStartedPlaying) {
                const required = Math.min(REQUIRED_START_BUFFER, sentences.length - currentIndex);
                let cnt = 0;
                for (let i = currentIndex; i < currentIndex + required; i++) {
                    if (audioCache[i] && audioCache[i] !== 'fetching') cnt++;
                }
                ttsStatusText.textContent = `Generating… ${cnt}/${required}`;
                if (cnt >= required) {
                    hasStartedPlaying = true;
                    playNextChunk();
                }
            } else {
                if (idx === currentIndex && audioPlayer.paused) playNextChunk();
            }
        }
        preloadQueue();
    }
}

function playNextChunk() {
    if (!isPlaying) return;
    if (currentIndex >= sentences.length) {
        if (document.getElementById('auto-read-next').checked && pageNum < pdfDoc.numPages) {
            audioPlayer.pause();
            playBtn.textContent = '▶ Play Page';
            ttsStatus.classList.remove('active');
            isAutoContinuing = true;
            goToPage(1, true);
        } else { stopPipeline(); }
        return;
    }
    const url = audioCache[currentIndex];
    if (url && url !== 'fetching') {
        highlightActiveSentence(currentIndex, sentences);
        updateTtsStatus();
        audioPlayer.src = url;
        audioPlayer.playbackRate = getPlaybackRate();
        const playPromise = audioPlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
                if (err.name !== 'AbortError') {
                    console.warn('Play error:', err);
                }
            });
        }

        // When the sentence ends, subtract its duration from remaining times
        audioPlayer.onended = () => {
            const dur = sentenceDurations[currentIndex] || estimateSentenceDuration(sentences[currentIndex]);
            const adjusted = dur / playbackSpeed;
            pageRemaining = Math.max(0, pageRemaining - adjusted);
            // For chapter, we'll recalc in updateReadingTimes
            currentIndex++;
            saveSettingsThrottled(pageNum, scale, currentIndex);
            preloadQueue();
            updateReadingTimes();
            playNextChunk();
        };
    } else if (url === null) {
        currentIndex++;
        playNextChunk();
    }
}

function getPlaybackRate() {
    return parseFloat(document.getElementById('speed-slider').value);
}

document.getElementById('speed-slider').addEventListener('input', () => {
    const rate = getPlaybackRate();
    playbackSpeed = rate;
    speedVal.textContent = rate.toFixed(1) + '×';
    if (isPlaying && !audioPlayer.paused) {
        audioPlayer.playbackRate = rate;
        // Recompute remaining times with the new speed
        pageRemaining = 0;
        for (let i = currentIndex; i < sentences.length; i++) {
            const d = sentenceDurations[i] || estimateSentenceDuration(sentences[i]);
            pageRemaining += d / playbackSpeed;
        }
        updateReadingTimes();
    }
    saveSettingsThrottled(pageNum, scale, currentIndex);
});

function stopPipeline() {
    isPlaying = false;
	updateReadingTimes();
    audioPlayer.pause();
    playBtn.textContent = '▶ Play Page';
    ttsStatus.classList.remove('active');
    syncMobilePlayBtn();
    clearHighlightCanvas();
    document.querySelectorAll('.textLayer span').forEach(span => {
        if (span.dataset.originalText !== undefined) {
            span.textContent = span.dataset.originalText;
        }
    });
    saveSettingsThrottled(pageNum, scale, currentIndex);
}

function clearPageAudioCache() {
    if (audioCache) Object.values(audioCache).forEach(v => { if (v && typeof v === 'string' && v.startsWith('blob:')) URL.revokeObjectURL(v); });
    audioCache = {};
    inFlight = 0;
	sentenceDurations = {};
}

/* ─── Mobile play button sync ─── */
function syncMobilePlayBtn() {
    if (isPlaying) {
        mobilePlayBtn.style.background = '#ef4444';
        mobilePlayLabel.textContent = 'Stop';
        mobilePlayBtn.querySelector('svg').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
        mobilePlayBtn.style.background = '';
        mobilePlayLabel.textContent = 'Play';
        mobilePlayBtn.querySelector('svg').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    }
}

mobilePlayBtn.addEventListener('click', () => {
    if (isPlaying) { stopPipeline(); return; }
    if (!pdfDoc || !currentPageText.trim()) { return; }
    let si = currentIndex >= sentences.length ? 0 : currentIndex;
    startReadingPage(si);
});

/* ─── Cache badge update ─── */
async function updateCacheBadge() {
    if (!currentFileName || !pdfDoc) { cacheBadge.classList.remove('visible'); return; }
    try {
        const res = await fetch(`/cache_status?book_name=${encodeURIComponent(currentFileName)}&page=${pageNum}`);
        if (!res.ok) { cacheBadge.classList.remove('visible'); return; }
        const data = await res.json();
        if (data.cached_lines && data.cached_lines.length > 0) {
            cacheBadge.textContent = `${data.cached_lines.length} cached`;
            cacheBadge.classList.add('visible');
        } else {
            cacheBadge.classList.remove('visible');
        }
    } catch (e) {
        cacheBadge.classList.remove('visible');
    }
}

/* ─── Save toggle ─── */
saveAudioToggle.addEventListener('change', e => {
    saveAudioEnabled = e.target.checked;
    saveRangeRow.style.display = saveAudioEnabled ? 'flex' : 'none';
});

/* ─── Batch download / pre-generate ─── */
downloadRangeBtn.addEventListener('click', async () => {
    if (!pdfDoc || !currentFileName || isDownloadingRange) return;

    const rangeStr = pageRangeInput.value.trim();
    if (!rangeStr) { pageRangeInput.focus(); return; }

    const match = rangeStr.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (!match) {
        pageRangeInput.style.borderColor = 'var(--danger)';
        setTimeout(() => pageRangeInput.style.borderColor = '', 1500);
        return;
    }

    const fromPage = Math.max(1, parseInt(match[1], 10));
    const toPage = Math.min(pdfDoc.numPages, parseInt(match[2], 10));
    if (fromPage > toPage) return;

    const voice = document.getElementById('voice-selector').value;
    const totalPages = toPage - fromPage + 1;

    isDownloadingRange = true;
    downloadRangeBtn.disabled = true;
    dlProgress.classList.add('active');
    dlStatusText.textContent = 'Scanning pages…';
    dlProgressFill.style.width = '0%';

    let cachedByPage = {};
    try {
        const statusRes = await fetch(
            `/cache_status_bulk?book_name=${encodeURIComponent(currentFileName)}&page_from=${fromPage}&page_to=${toPage}`
        );
        if (statusRes.ok) {
            const statusData = await statusRes.json();
            cachedByPage = statusData.pages || {};
        }
    } catch (e) {
        console.warn('[DL] cache_status_bulk failed', e);
    }

    let allSentences = {};
    let extractedPages = 0;

    for (let p = fromPage; p <= toPage; p++) {
        dlStatusText.textContent = `Extracting page ${p} / ${toPage}…`;
        dlProgressFill.style.width = Math.round((extractedPages / totalPages) * 40) + '%';

        try {
            const page = await pdfDoc.getPage(p);
            const textContent = await page.getTextContent();
            const pageSentences = extractSentencesFromTextContent(textContent, page);
            const alreadyCached = new Set((cachedByPage[String(p)] || []));

            for (let si = 0; si < pageSentences.length; si++) {
                if (alreadyCached.has(si)) continue;
                const raw = pageSentences[si];
                const text = normalizeTTSText(
                    /^\d{1,2}$/.test(raw.trim()) ? `Page ${raw.trim()}.` : raw
                );
                allSentences[`${p}_${si}`] = text;
            }
        } catch (e) {
            console.warn(`[DL] Page ${p} extract failed:`, e);
        }

        extractedPages++;
    }

    const newSentenceCount = Object.keys(allSentences).length;

    if (newSentenceCount === 0) {
        dlProgressFill.style.width = '100%';
        dlStatusText.textContent = `All ${totalPages} page(s) already cached ✓`;
        setTimeout(() => {
            dlProgress.classList.remove('active');
            dlProgressFill.style.width = '0%';
            isDownloadingRange = false;
            downloadRangeBtn.disabled = false;
            updateCacheBadge();
        }, 2000);
        return;
    }

    dlStatusText.textContent = `Queuing ${newSentenceCount} sentences on server…`;
    dlProgressFill.style.width = '45%';

    const byPage = {};
    for (const [key, text] of Object.entries(allSentences)) {
        const pageNum = key.split('_')[0];
        if (!byPage[pageNum]) byPage[pageNum] = {};
        byPage[pageNum][key] = text;
    }

    const jobIds = [];
    let sentPages = 0;
    for (const [p, pageSentences] of Object.entries(byPage)) {
        try {
            const res = await fetch('/preload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    book_name: currentFileName,
                    page_from: parseInt(p, 10),
                    page_to: parseInt(p, 10),
                    sentences: pageSentences,
                    voice,
                })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.job_id) jobIds.push(data.job_id);
            }
        } catch (e) {
            console.warn(`[DL] preload send failed for page ${p}:`, e);
        }
        sentPages++;
        dlProgressFill.style.width = Math.round(45 + (sentPages / Object.keys(byPage).length) * 25) + '%';
    }

    dlProgressFill.style.width = '70%';
    dlStatusText.textContent = `${newSentenceCount} sentences queued on server (${jobIds.length} job(s))`;

    if (jobIds.length > 0) {
        startPollingPreloadJobs(jobIds, newSentenceCount);
    } else {
        finishDownload(totalPages);
    }
});

function startPollingPreloadJobs(jobIds, totalSentences) {
    let pollCount = 0;
    const MAX_POLLS = 600;

    const interval = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
            clearInterval(interval);
            finishDownload(jobIds.length);
            return;
        }

        try {
            const res = await fetch('/preload_status_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jobIds),
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const statusMap = await res.json();

            let totalDone = 0;
            let allFinished = true;
            for (const [jobId, job] of Object.entries(statusMap)) {
                if (!job) continue;
                totalDone += job.done || 0;
                if (job.status !== 'done') allFinished = false;
            }

            const pct = Math.min(99, Math.round(70 + (totalDone / Math.max(1, totalSentences)) * 29));
            dlProgressFill.style.width = pct + '%';
            dlStatusText.textContent = `Server generating… ${totalDone} / ${totalSentences} sentences`;

            if (allFinished) {
                clearInterval(interval);
                finishDownload(jobIds.length);
            }
        } catch (e) {
            console.warn('[POLL] Bulk status request failed:', e.message);
            dlStatusText.textContent = 'Waiting for server…';
        }
    }, 1000);
}

function finishDownload(pageCount) {
    dlProgressFill.style.width = '100%';
    dlStatusText.textContent = `Done! ${pageCount} page(s) queued for caching ✓`;
    setTimeout(() => {
        dlProgress.classList.remove('active');
        dlProgressFill.style.width = '0%';
        isDownloadingRange = false;
        downloadRangeBtn.disabled = false;
        updateCacheBadge();
		updateReadingTimes();
    }, 2500);
}

/* ─── Shared text extraction ─── */
function extractSentencesFromTextContent(textContent, page) {
    const viewport = page.getViewport({ scale: 1 });
    const fontSizes = textContent.items.map(i => Math.abs(i.transform[3])).filter(s => s > 0).sort((a, b) => a - b);
    const baseFontSize = fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12;

    const Y_TOL = 5;
    const sorted = [...textContent.items].sort((a, b) => {
        const dy = a.transform[5] - b.transform[5];
        if (Math.abs(dy) > Y_TOL) return b.transform[5] - a.transform[5];
        return a.transform[4] - b.transform[4];
    });

    let lines = [];
    let curLine = { y: null, items: [] };
    sorted.forEach(item => {
        if (!item.str.trim()) return;
        const y = item.transform[5];
        if (curLine.y === null || Math.abs(curLine.y - y) > Y_TOL) {
            if (curLine.items.length) lines.push(curLine);
            curLine = { y, items: [item] };
        } else {
            curLine.items.push(item);
        }
    });
    if (curLine.items.length) lines.push(curLine);

    let structuredText = '';
    const unscaledH = viewport.viewBox ? viewport.viewBox[3] : 800;
    let prevY = null;
    let inListItem = false;

    lines.forEach(line => {
        let lineText = line.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
        if (!lineText) return;
        const avgFS = line.items.reduce((s, i) => s + Math.abs(i.transform[3]), 0) / line.items.length;
        const isTop = line.y > (unscaledH - 60);
        const isBot = line.y < 60;
        const isNum = /^[\[\(\-–—\s]*\d+[\]\)\-–—\s]*$/.test(lineText);
        if ((isTop || isBot) && isNum) return;

        const isHeader = avgFS > baseFontSize * 1.2;
        const startsNewListItem = /^[\u2022\u25E6\u25A0\u25CF\u2013\-\*]\s/.test(lineText) ||
                                  /^\d+[\.\)]\s/.test(lineText) ||
                                  /^[a-zA-Z][\.\)]\s/.test(lineText);
        const isNewPara = prevY !== null && (prevY - line.y) > baseFontSize * 1.5;
        const isListContinuation = inListItem && !startsNewListItem && !isNewPara && !isHeader;

        prevY = line.y;

        if (isHeader) {
            inListItem = false;
            structuredText += `\n${lineText}.\n`;
        } else if (startsNewListItem) {
            if (inListItem) {
                structuredText = structuredText.trimEnd() +
                    (!structuredText.trim().match(/[.!?]$/) ? '.\n' : '\n');
            } else {
                structuredText += structuredText && !structuredText.endsWith('\n') ? '\n' : '';
            }
            inListItem = true;
            structuredText += lineText;
        } else if (isListContinuation) {
            if (structuredText.endsWith('-')) {
                structuredText = structuredText.slice(0, -1) + lineText;
            } else {
                structuredText = structuredText.trimEnd() + ' ' + lineText;
            }
        } else if (isNewPara) {
            inListItem = false;
            structuredText += (!structuredText.trim().match(/[.!?]$/) ? '.\n' : '\n') + lineText;
        } else if (structuredText.endsWith('-')) {
            structuredText = structuredText.slice(0, -1) + lineText;
        } else if (structuredText.endsWith('\n') || !structuredText) {
            structuredText += lineText;
        } else {
            structuredText += ' ' + lineText;
        }
    });

    return splitIntoTTSChunks(structuredText, 250);
}

/* ─── TTS Highlighting (canvas-based) ─── */

function clearHighlightCanvas() {
    const hlCanvas = document.getElementById('highlight-canvas');
    if (!hlCanvas) return;
    const ctx = hlCanvas.getContext('2d');
    ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
}

function highlightActiveSentence(sentenceIndex, allSentences) {
    clearHighlightCanvas();
    const allSpans = Array.from(document.querySelectorAll('.textLayer span'));
    allSpans.forEach(span => {
        if (span.dataset.originalText === undefined) {
            span.dataset.originalText = span.textContent;
        }
        span.textContent = span.dataset.originalText;
    });

    if (sentenceIndex < 0 || sentenceIndex >= allSentences.length) {
        return;
    }

    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    let fullNorm = '';
    const spanMaps = [];
    allSpans.forEach(span => {
        const raw = span.dataset.originalText;
        const norm = normalize(raw);
        spanMaps.push({ element: span, rawText: raw, normStart: fullNorm.length, normEnd: fullNorm.length + norm.length });
        fullNorm += norm;
    });

    let cursor = 0, matchIndex = -1, targetNorm = '';
    for (let i = 0; i <= sentenceIndex; i++) {
        targetNorm = normalize(allSentences[i]);
        if (!targetNorm) continue;
        const found = fullNorm.indexOf(targetNorm, cursor);
        if (found !== -1) {
            matchIndex = found;
            cursor = found + targetNorm.length;
        } else {
            const fallback = fullNorm.indexOf(targetNorm, 0);
            if (fallback !== -1) { matchIndex = fallback; cursor = fallback + targetNorm.length; }
        }
    }

    if (matchIndex === -1) {
        return;
    }

    const matchEnd = matchIndex + targetNorm.length;

    const matchedSpans = [];
    let firstEl = null;

    spanMaps.forEach(map => {
        const os = Math.max(map.normStart, matchIndex);
        const oe = Math.min(map.normEnd, matchEnd);
        if (os >= oe) return;

        let alpha = map.normStart, rs = 0, re = map.rawText.length;
        let rsFound = false;
        for (let i = 0; i < map.rawText.length; i++) {
            const ch = map.rawText[i];
            if (/[a-z0-9]/i.test(ch)) {
                if (!rsFound && alpha === os) { rs = i; rsFound = true; }
                alpha++;
                if (alpha === oe) { re = i + 1; break; }
            }
        }

        while (re < map.rawText.length && /[^\w\s]/.test(map.rawText[re])) re++;

        const before = escapeHtml(map.rawText.slice(0, rs));
        const hi = escapeHtml(map.rawText.slice(rs, re));
        const after = escapeHtml(map.rawText.slice(re));
        if (hi) {
            map.element.innerHTML = `${before}<mark class="reading-highlight">${hi}</mark>${after}`;
            const markEl = map.element.querySelector('mark.reading-highlight');
            if (!firstEl && markEl) firstEl = markEl;
            matchedSpans.push(map.element);
        }
    });

    const hlCanvas = document.getElementById('highlight-canvas');
    const container = document.getElementById('pdf-container');
    if (hlCanvas && container && matchedSpans.length > 0) {
        const dpr = window.devicePixelRatio || 1;
        const cRect = container.getBoundingClientRect();

        const rows = new Map();

        matchedSpans.forEach(span => {
            const marks = span.querySelectorAll('mark.reading-highlight');
            marks.forEach(mark => {
                const r = mark.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return;

                const left = r.left - cRect.left;
                const top = r.top - cRect.top;
                const right = r.right - cRect.left;
                const bottom = r.bottom - cRect.top;

                const rowKey = Math.round(top / 2) * 2;
                if (!rows.has(rowKey)) {
                    rows.set(rowKey, { left, right, top, bottom });
                } else {
                    const row = rows.get(rowKey);
                    row.left = Math.min(row.left, left);
                    row.right = Math.max(row.right, right);
                    row.top = Math.min(row.top, top);
                    row.bottom = Math.max(row.bottom, bottom);
                }
            });
        });

        if (rows.size === 0) return;

        hlCanvas.width = Math.round(cRect.width * dpr);
        hlCanvas.height = Math.round(cRect.height * dpr);
        hlCanvas.style.width = cRect.width + 'px';
        hlCanvas.style.height = cRect.height + 'px';

        const ctx = hlCanvas.getContext('2d');
        ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
        ctx.scale(dpr, dpr);

        const pad = hlPadding;
        const r = hlRadius;
        const fillColor = `rgba(${hlBaseColor},${hlOpacity})`;
        const strokeColor = hlOutline ? `rgba(${hlBaseColor},${Math.min(1, hlOpacity * 2.5)})` : null;

        ctx.fillStyle = fillColor;
        if (strokeColor) { ctx.strokeStyle = strokeColor; ctx.lineWidth = 1; }

        rows.forEach((row) => {
            const x = row.left - pad;
            const y = row.top;
            const w = (row.right - row.left) + pad * 2;
            const h = (row.bottom - row.top) + 1;
            const cr = Math.min(r, w / 2, h / 2);

            ctx.beginPath();
            ctx.moveTo(x + cr, y);
            ctx.lineTo(x + w - cr, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + cr);
            ctx.lineTo(x + w, y + h - cr);
            ctx.quadraticCurveTo(x + w, y + h, x + w - cr, y + h);
            ctx.lineTo(x + cr, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - cr);
            ctx.lineTo(x, y + cr);
            ctx.quadraticCurveTo(x, y, x + cr, y);
            ctx.closePath();
            ctx.fill();
            if (strokeColor) ctx.stroke();
        });

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    if (firstEl && viewerArea) {
        const vr = viewerArea.getBoundingClientRect();
        const hr = firstEl.getBoundingClientRect();
        const rt = hr.top - vr.top;
        const rb = hr.bottom - vr.top;
        if (rt < vr.height * 0.15 || rb > vr.height * 0.8) {
            viewerArea.scrollTo({ top: viewerArea.scrollTop + rt - vr.height / 3, behavior: 'smooth' });
        }
    }
}

/* ─── Click-to-Read ─── */
document.getElementById('text-layer').addEventListener('click', e => {
    let target = e.target;
    if (target.tagName.toLowerCase() === 'mark') target = target.parentElement;
    if (target.tagName.toLowerCase() !== 'span') return;
    if (!sentences || !sentences.length) return;

    const allSpans = Array.from(document.querySelectorAll('.textLayer span'));
    const ti = allSpans.indexOf(target);
    if (ti === -1) return;

    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let fullNorm = '';
    let offsets = [];
    allSpans.forEach(span => {
        const raw = span.dataset.originalText !== undefined ? span.dataset.originalText : span.textContent;
        offsets.push(fullNorm.length);
        fullNorm += normalize(raw);
    });

    const clickedOffset = offsets[ti];
    let cursor = 0, found = -1;
    for (let i = 0; i < sentences.length; i++) {
        const tn = normalize(sentences[i]);
        if (!tn) continue;
        let mi = fullNorm.indexOf(tn, cursor);
        if (mi === -1) mi = fullNorm.indexOf(tn, 0);
        if (mi !== -1) {
            if (clickedOffset >= mi && clickedOffset < mi + tn.length) { found = i; break; }
            cursor = mi + tn.length;
        }
    }
    if (found !== -1) startReadingPage(found);
});

/* ─── Delete Cache Range ─── */

deleteRangeBtn.addEventListener('click', async () => {
    if (!currentFileName || !pdfDoc) return;
    const rangeStr = deleteRangeInput.value.trim();
    if (!rangeStr) { deleteStatus.textContent = 'Enter a page range (e.g. 5-10)'; return; }

    const match = rangeStr.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (!match) {
        deleteStatus.textContent = 'Invalid range format. Use e.g. 5-10';
        return;
    }

    const fromPage = Math.max(1, parseInt(match[1], 10));
    const toPage = Math.min(pdfDoc.numPages, parseInt(match[2], 10));
    if (fromPage > toPage) {
        deleteStatus.textContent = 'Invalid range: from > to';
        return;
    }

    deleteStatus.textContent = 'Deleting…';
    deleteRangeBtn.disabled = true;

    try {
        const res = await fetch('/delete_cache_range', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                book_name: currentFileName,
                page_from: fromPage,
                page_to: toPage
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        deleteStatus.textContent = `Deleted ${data.deleted} cached audio file(s).`;
        updateCacheBadge();
		updateReadingTimes();
    } catch (e) {
        deleteStatus.textContent = `Error: ${e.message}`;
    } finally {
        deleteRangeBtn.disabled = false;
        deleteRangeInput.value = '';
    }
});

/* ─── Upload PDF to Server ─── */
const serverUploadInput = document.getElementById('server-upload');
const uploadStatus = document.getElementById('upload-status');

serverUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !file.type === 'application/pdf') {
        uploadStatus.textContent = 'Please select a PDF.';
        return;
    }

    uploadStatus.textContent = 'Uploading…';
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/upload_pdf', {
            method: 'POST',
            body: formData,
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Upload failed');
        }

        const data = await res.json();
        uploadStatus.textContent = `✅ Uploaded: ${data.filename}`;
        await loadServerPDFs();
    } catch (err) {
        uploadStatus.textContent = `❌ ${err.message}`;
        console.error('Upload error:', err);
    } finally {
        serverUploadInput.value = '';
    }
});

function formatDuration(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
}
console.log('DocReader Pro ready – all served from port 8000.');
