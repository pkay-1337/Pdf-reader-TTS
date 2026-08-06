pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.min.js';

/* ─── State ─── */
let topSkipLines = 0;
let bottomSkipLines = 0;
let pdfDoc = null;          // kept for PDF-specific legacy references
let documentHandler = null; // active PDFHandler or EPUBHandler
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
let pageRemaining = 0;
let chapterRemaining = 0;
let sentenceDurations = {};
let chapterStartPage = null;
let chapterEndPage = null;
let serverDocNames = new Set();
let serverPdfNames = serverDocNames; // alias for legacy code

const chapterDurationCache = {};
const pendingChapterDurations = {};
const pendingPageDurations = {};

/* ─── Cache / Download state ─── */
let saveAudioEnabled = false;
let isDownloadingRange = false;

/* ─── WebSocket manager ─── */
const WS = {
    _sockets: {},
    _base() {
        return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
    },
    open(key, path, onmessage, onopen) {
        this.close(key);
        const ws = new WebSocket(this._base() + path);
        ws.onmessage = e => {
            try { onmessage(JSON.parse(e.data), e); } catch (_) { onmessage(null, e); }
        };
        ws.onopen = onopen || null;
        ws.onerror = () => {};
        ws.onclose = () => { delete this._sockets[key]; };
        this._sockets[key] = ws;
        return ws;
    },
    openBinary(key, path, onbinary, onjson) {
        this.close(key);
        const ws = new WebSocket(this._base() + path);
        ws.binaryType = 'arraybuffer';
        ws.onmessage = e => {
            if (e.data instanceof ArrayBuffer) { onbinary(e.data); }
            else { try { onjson(JSON.parse(e.data)); } catch (_) {} }
        };
        ws.onerror = () => {};
        ws.onclose = () => { delete this._sockets[key]; };
        this._sockets[key] = ws;
        return ws;
    },
    send(key, data) {
        const ws = this._sockets[key];
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    },
    close(key) {
        const ws = this._sockets[key];
        if (ws) { try { ws.close(); } catch (_) {} delete this._sockets[key]; }
    },
    closeAll() {
        Object.keys(this._sockets).forEach(k => this.close(k));
    }
};

/* ─── Highlight customisation state ─── */
let hlBaseColor = '59,130,246';
let hlOpacity = 0.32;
let hlRadius = 3;
let hlOutline = false;
let hlPadding = 1;
let playbackSpeed = 1.0;
const pageStats = {};
let topbarVisible = true;
const activePreloadJobs = {};

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

// Voice selector – fallback to a default if missing
const voiceSelector = document.getElementById('voice-selector') || { value: 'af_sarah' };

/* ─── Loading overlay ─── */
function showLoading(msg = 'Loading…') {
    loadingText.textContent = msg;
    loadingOverlay.classList.add('visible');
}
function hideLoading() {
    loadingOverlay.classList.remove('visible');
}

/* ─── Theme Handling ─── */
const themeSelector = document.getElementById('theme-selector');
function applyTheme(theme) {
    document.body.className = document.body.className
        .split(' ')
        .filter(c => !c.startsWith('theme-'))
        .join(' ');
    if (theme && theme !== 'default-light') {
        document.body.classList.add('theme-' + theme);
    }
    localStorage.setItem('docreader-theme', theme || 'default-light');
    if (themeSelector) themeSelector.value = theme || 'default-light';
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.setTheme(theme || 'default-light');
    }
}

/* ─── Mobile topbar toggle ─── */
function setTopbarVisible(visible) {
    topbarVisible = visible;
    document.body.classList.toggle('topbar-hidden', !visible);
}
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

/* ─── Server Document Library (WebSocket-driven) ─── */
function renderPdfList(docs) {
    const section = document.getElementById('server-pdf-section');
    const listEl = document.getElementById('server-pdf-list');
    document.getElementById('server-pdf-loading').style.display = 'none';
    if (!docs || docs.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    listEl.innerHTML = '';
    serverDocNames.clear();
    docs.forEach(doc => {
        serverDocNames.add(doc.name);
        addPdfToList(doc, listEl);
    });
}
function _docType(doc) {
    if (doc.type) return doc.type;
    return doc.name.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf';
}
function addPdfToList(doc, listEl) {
    listEl = listEl || document.getElementById('server-pdf-list');
    if (listEl.querySelector(`[data-pdf-name="${CSS.escape(doc.name)}"]`)) return;
    const item = document.createElement('div');
    item.className = 'server-pdf-item';
    item.dataset.pdfName = doc.name;
    item.title = `Open: ${doc.name}`;
    const sizeMB = (doc.size / (1024 * 1024)).toFixed(1);
    const isEpub = _docType(doc) === 'epub';
    const iconSvg = isEpub
        ? `<svg class="server-pdf-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
        : `<svg class="server-pdf-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
    item.innerHTML = `
        ${iconSvg}
        <span class="server-pdf-item-name">${escapeHtmlWelcome(doc.name)}</span>
        <span class="server-pdf-item-size">${sizeMB} MB</span>
    `;
    item.addEventListener('click', async () => {
        item.style.opacity = '0.5';
        item.style.pointerEvents = 'none';
        try {
            const url = doc.url || `/documents/${encodeURIComponent(doc.name)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const mimeType = isEpub ? 'application/epub+zip' : 'application/pdf';
            const file = new File([blob], doc.name, { type: mimeType });
            loadDocument(file, 1);
        } catch (err) {
            console.error(`[SERVER-DOC] Failed to load ${doc.name}:`, err);
            alert(`Could not load "${doc.name}" from server. Is the server running?`);
            item.style.opacity = '';
            item.style.pointerEvents = '';
        }
    });
    listEl.appendChild(item);
}
function removePdfFromList(name) {
    const el = document.querySelector(`[data-pdf-name="${CSS.escape(name)}"]`);
    if (el) el.remove();
    serverDocNames.delete(name);
}
function openLibrarySocket() {
    WS.open('library', '/ws/library', msg => {
        if (!msg) return;
        if (msg.type === 'init') renderPdfList(msg.documents || msg.pdfs);
        if (msg.type === 'added') {
            const doc = msg.document || msg.pdf;
            if (doc) { addPdfToList(doc); document.getElementById('server-pdf-section').style.display = 'block'; serverDocNames.add(doc.name); }
        }
        if (msg.type === 'removed') { const doc = msg.document || msg.pdf; if (doc) removePdfFromList(doc.name); }
    });
}
function escapeHtmlWelcome(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function loadServerPDFs() { openLibrarySocket(); }
openLibrarySocket();

/* ─── Highlight Customisation ─── */
const HL_PRESETS = {
    'rgba(59,130,246,0.32)': '59,130,246',
    'rgba(234,179,8,0.38)': '234,179,8',
    'rgba(16,185,129,0.35)': '16,185,129',
    'rgba(239,68,68,0.32)': '239,68,68',
    'rgba(168,85,247,0.32)': '168,85,247',
    'rgba(251,146,60,0.35)': '251,146,60',
};

let highlightUpdateFrame = null;
function applyHighlightSettings() {
    const color = `rgba(${hlBaseColor},${hlOpacity})`;
    document.documentElement.style.setProperty('--hl-color', color);
    document.documentElement.style.setProperty('--hl-radius', hlRadius + 'px');
    document.documentElement.style.setProperty('--hl-padding', hlPadding + 'px');
    const outlineVal = hlOutline ? `0 0 0 1px rgba(${hlBaseColor},${Math.min(1, hlOpacity * 2.5)})` : 'none';
    document.documentElement.style.setProperty('--hl-outline', outlineVal);
    
    if (documentHandler instanceof EPUBHandler) {
        documentHandler._injectHighlightStyle && documentHandler._injectHighlightStyle();
    }
    
    // Live Redraw via Animation Frame
    if (highlightUpdateFrame) cancelAnimationFrame(highlightUpdateFrame);
    highlightUpdateFrame = requestAnimationFrame(() => {
        if (sentences && sentences.length && currentIndex >= 0) {
            highlightActiveSentence(currentIndex, sentences);
        }
    });
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
    scrollToActiveTocItem();
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
        if (isOpen) { 
            closeMobileSidebar(); 
        } else { 
            openMobileSidebar(); 
            sidebarOpen = true; 
        }
    } else {
        sidebarOpen = !sidebarOpen;
        sidebar.classList.toggle('collapsed', !sidebarOpen);
        sidebarToggleBtn.classList.toggle('active', sidebarOpen);
        if (sidebarOpen) scrollToActiveTocItem();
        // After CSS transition, resize EPUB rendition to fill new viewer width
        setTimeout(() => {
            if (documentHandler instanceof EPUBHandler && documentHandler.rendition) {
                const epubContainer = document.getElementById('epub-container');
                if (epubContainer) {
                    const w = epubContainer.clientWidth;
                    const h = epubContainer.clientHeight;
                    try { documentHandler.rendition.resize(w, h); } catch(e) {}
                }
            }
        }, 250); // match CSS transition duration
    }
}

function openMobileSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('show');
    sidebarOpen = true;
    scrollToActiveTocItem();
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
function getPageCount() {
    if (pdfDoc) return pdfDoc.numPages;
    if (documentHandler instanceof EPUBHandler) return documentHandler.pageCount;
    return 0;
}
function updateMobilePageInfo() {
    const total = getPageCount();
    mobilePageInfo.textContent = total ? `${pageNum} / ${total}` : '0 / 0';
    updateCacheBadge();
}

/* ─── Page Jump ─── */
pageJumpBtn.addEventListener('click', jumpToPage);
pageJumpInput.addEventListener('keydown', e => { if (e.key === 'Enter') jumpToPage(); });
function jumpToPage() {
    const total = getPageCount();
    if (!total) return;
    const n = parseInt(pageJumpInput.value, 10);
    if (!n || n < 1 || n > total) return;
    if (documentHandler instanceof EPUBHandler) {
        epubGoToPage(n);
    } else {
        goToAbsolutePage(n);
    }
    pageJumpInput.value = '';
}

/* ─── IndexedDB (highlight settings) ─── */
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
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.setZoom(scale);
        saveSettingsThrottled(pageNum, scale, currentIndex);
    } else if (pdfDoc && rerender) {
        queueRenderPage(pageNum);
        saveSettingsThrottled(pageNum, scale, currentIndex);
    }
}
zoomSlider.addEventListener('input', e => { zoomVal.textContent = Math.round(parseFloat(e.target.value) * 100) + '%'; });
zoomSlider.addEventListener('change', e => setZoom(parseFloat(e.target.value)));
zoomInBtn.addEventListener('click', () => setZoom(scale + 0.1));
zoomOutBtn.addEventListener('click', () => setZoom(scale - 0.1));
zoomResetBtn.addEventListener('click', () => setZoom(1.0));

/* ─── Server settings API (WebSocket session) ─── */
let saveTimeout = null;
let _pendingSettingsResolve = null;
let isSessionSocketOpen = false;

function openSessionSocket(bookName) {
    WS.close('session');
    isSessionSocketOpen = false;
    WS.open('session', `/ws/session/${encodeURIComponent(bookName)}`, msg => {
        if (!msg) return;
        if (msg.type === 'init') {
            isSessionSocketOpen = true;
            if (_pendingSettingsResolve) {
                _pendingSettingsResolve(msg);
                _pendingSettingsResolve = null;
            }
        }
        if (msg.type === 'settings_sync') {
            if (msg.page && msg.page !== pageNum && !isPlaying) {
                pageNum = msg.page;
                queueRenderPage(pageNum);
            }
            if (msg.scale) setZoom(msg.scale, false);
        }
    });
}

function saveSettingsThrottled(page, scl, sentenceIndex) {
    // Removed the '!isSessionSocketOpen' check so it can fall back to HTTP
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveSettings(page, scl, sentenceIndex), 800);
}

function saveSettings(page, scl, sentenceIndex) {
    if (!currentFileName) return;
    const payload = {
        type: 'settings',
        book_name: currentFileName,
        page,
        scale: scl,
        sentenceIndex: sentenceIndex || 0,
        speed: playbackSpeed,
        topSkipLines,
        bottomSkipLines,
    };
    if (WS._sockets['session'] && WS._sockets['session'].readyState === WebSocket.OPEN) {
        WS.send('session', payload);
    } else {
        fetch('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).catch(() => {});
    }
}

async function loadSettings(bookName) {
    openSessionSocket(bookName);
    return new Promise(resolve => {
        let resolved = false;
        
        _pendingSettingsResolve = (msg) => {
            if (!resolved) {
                resolved = true;
                resolve(msg);
            }
        };
        
        // Immediately fetch via HTTP to race against the WebSocket connection
        fetch(`/settings?book_name=${encodeURIComponent(bookName)}`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (!resolved) {
                    resolved = true;
                    _pendingSettingsResolve = null;
                    resolve(data);
                }
            })
            .catch(() => {
                if (!resolved) {
                    resolved = true;
                    _pendingSettingsResolve = null;
                    resolve(null);
                }
            });
    });
}


/* ─── Document dispatcher ─── */
function isEpubFile(file) {
    return file.type === 'application/epub+zip' || file.name.toLowerCase().endsWith('.epub');
}
async function loadDocument(file, startPage = 1) {
    if (isEpubFile(file)) {
        await loadEPUB(file, startPage);
    } else {
        await loadPDF(file, startPage);
    }
}

/* ─── EPUB Handler ─── */
class EPUBHandler {
    constructor() {
        this.book = null;
        this.rendition = null;
        // Chapter-based: one spine item = one "page"
        this.spineItems = [];    // [{href, index}]
        this.pageCount = 0;
        this.currentPage = 1;   // 1-based spine index
        this.currentText = '';
        this.currentSentences = [];
        this.sentenceCfiMap = {};
        this.chapterCharMap = {};
        this._destroyed = false;
        this._rendering = false; // guard against concurrent renders
    }

	async load(file, startPage, containerEl, scale, theme) {
        this._destroyed = false;
        const arrayBuffer = await file.arrayBuffer();
        const EpubJS = window.ePub || window.epub || (window.ePub = ePub);
        this.book = EpubJS(arrayBuffer);
        await this.book.ready;

        this.spineItems = [];
        this.book.spine.each(item => this.spineItems.push(item));
        this.pageCount = this.spineItems.length || 1;

        const viewerEl = document.getElementById('epub-viewer');
        viewerEl.innerHTML = '';
        const epubContainer = document.getElementById('epub-container');
        const width  = epubContainer.clientWidth  || window.innerWidth;
        const height = epubContainer.clientHeight || window.innerHeight;

        this.rendition = this.book.renderTo(viewerEl, {
            width:  width,
            height: height,
            flow:   'scrolled-doc',
            spread: 'none',
            minSpreadWidth: 9999,
        });

        // --- THE MAGIC HOOK: Runs on EVERY render/resize ---
        this.rendition.hooks.content.register((contents) => {
            const doc = contents.document;
            const win = contents.window;
            
            // 1. Bridge keyboard events (j, k, arrows) to parent window
            win.addEventListener('keydown', (e) => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key }));
            });
            
            // 2. Hardware scroll lag fix
            let epubScrollTimeout;
            win.addEventListener('scroll', () => {
                if (!doc.body.classList.contains('is-scrolling')) doc.body.classList.add('is-scrolling');
                clearTimeout(epubScrollTimeout);
                epubScrollTimeout = setTimeout(() => doc.body.classList.remove('is-scrolling'), 150);
            }, { passive: true });

            // 3. Group consecutive code blocks natively into one div
            const codeBlocks = Array.from(doc.querySelectorAll('p.snippet, p.code, div.snippet, div.code, pre'));
            let currentWrapper = null;
            codeBlocks.forEach(el => {
                const prev = el.previousElementSibling;
                if (prev && prev === currentWrapper) {
                    currentWrapper.appendChild(el);
                } else {
                    currentWrapper = doc.createElement('div');
                    currentWrapper.className = 'docreader-code-wrapper';
                    el.parentNode.insertBefore(currentWrapper, el);
                    currentWrapper.appendChild(el);
                }
            });

            // 4. Force-inject styles to survive resizes
            this._injectReadingStyle(doc);
            this._injectHighlightStyle(doc);
        });

        this._registerThemes();
        this._applyCurrentTheme(theme);
        this._applyScale(scale);

        await this.renderPage(startPage);
        this._loadChapterStats();
    }


    _registerThemes() {
        const resetStyles = { 'background': 'transparent !important', 'border-color': 'currentColor !important' };
        const themeMap = {
            'default-light': {
                'body': { 'background': '#ffffff', 'color': '#111827', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#1d3a6b' }, 'strong, b': { 'color': '#2563eb' }, 'em, i': { 'color': '#f59e0b' }
            },
            'default-dark': {
                'body': { 'background': '#0d1117', 'color': '#e6edf3', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#79c0ff' }, 'strong, b': { 'color': '#58a6ff' }, 'em, i': { 'color': '#3fb950' }
            },
            'gruvbox-dark': {
                'body': { 'background': '#282828', 'color': '#ebdbb2', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#fabd2f' }, 'strong, b': { 'color': '#fb4934' }, 'em, i': { 'color': '#b8bb26' }
            },
            'gruvbox-light': {
                'body': { 'background': '#fbf1c7', 'color': '#3c3836', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#b57614' }, 'strong, b': { 'color': '#9d0006' }, 'em, i': { 'color': '#79740e' }
            },
            'nord': {
                'body': { 'background': '#2e3440', 'color': '#d8dee9', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#88c0d0' }, 'strong, b': { 'color': '#ebcb8b' }, 'em, i': { 'color': '#a3be8c' }
            },
            'solarized-dark': {
                'body': { 'background': '#002b36', 'color': '#839496', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#b58900' }, 'strong, b': { 'color': '#dc322f' }, 'em, i': { 'color': '#859900' }
            },
            'solarized-light': {
                'body': { 'background': '#fdf6e3', 'color': '#657b83', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#b58900' }, 'strong, b': { 'color': '#dc322f' }, 'em, i': { 'color': '#859900' }
            },
            'monokai': {
                'body': { 'background': '#272822', 'color': '#f8f8f2', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#f92672' }, 'strong, b': { 'color': '#fd971f' }, 'em, i': { 'color': '#a6e22e' }
            },
            'dracula': {
                'body': { 'background': '#282a36', 'color': '#f8f8f2', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#bd93f9' }, 'strong, b': { 'color': '#ff5555' }, 'em, i': { 'color': '#50fa7b' }
            },
            'catppuccin': {
                'body': { 'background': '#1e1e2e', 'color': '#cdd6f4', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#cba6f7' }, 'strong, b': { 'color': '#f38ba8' }, 'em, i': { 'color': '#a6e3a1' }
            }
        };
        Object.entries(themeMap).forEach(([name, css]) => {
            try { this.rendition.themes.register(name, css); } catch (e) {}
        });
    }

    _applyCurrentTheme(theme) {
        const t = theme || localStorage.getItem('docreader-theme') || 'default-light';
        try { this.rendition.themes.select(t); } catch (e) {}
    }

    _applyScale(scale) {
        const pct = Math.round(scale * 100);
        try { this.rendition.themes.fontSize(pct + '%'); } catch (e) {}
    }



	_extractTextFromRendition() {
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents.length) return { text: '', sentenceCfiMap: {} };
            const doc = contents[0].document;
            if (!doc || !doc.body) return { text: '', sentenceCfiMap: {} };

            // We use SHOW_ALL to catch <br> tags cleanly
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ALL, {
                acceptNode: (n) => {
                    if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
                    if (n.nodeType === Node.ELEMENT_NODE) {
                        const tag = n.tagName.toLowerCase();
                        if (['script','style','nav','aside'].includes(tag)) return NodeFilter.FILTER_REJECT;
                        if (tag === 'br') return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            });

            let fullText = '';
            const nodeRanges = [];
            let lastParentBlock = null;
            let node;

            while ((node = walker.nextNode())) {
                if (node.nodeType === Node.ELEMENT_NODE) { // It's a <br>
                    if (!fullText.endsWith('\n')) fullText += '\n';
                    continue;
                }

                // Check visibility
                const parent = node.parentElement;
                if (parent) {
                    const cs = doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
                    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
                }

                let t = node.textContent.replace(/\s+/g, ' ');
                if (t === '') continue;

                // Manage Block boundaries perfectly
                const nearestBlock = parent ? parent.closest('p,div,h1,h2,h3,h4,h5,h6,li,blockquote,section,article,pre') : null;
                if (nearestBlock && nearestBlock !== lastParentBlock) {
                    if (fullText.length > 0 && !fullText.endsWith('\n')) {
                        fullText = fullText.trimEnd() + '\n';
                    }
                    lastParentBlock = nearestBlock;
                }

                if (t === ' ' && (fullText.endsWith(' ') || fullText.endsWith('\n'))) continue;

                nodeRanges.push({ start: fullText.length, end: fullText.length + t.length, node });
                fullText += t;
            }

            const structuredText = fullText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
            const sentencesArr = splitIntoTTSChunks(structuredText, 250);

            const sentenceCfiMap = {};
            let cursor = 0;
            sentencesArr.forEach((sent, si) => {
                const idx = fullText.indexOf(sent, cursor);
                if (idx === -1) return;
                const nr = nodeRanges.find(r => idx >= r.start && idx < r.end);
                if (nr) {
                    try {
                        const range = doc.createRange();
                        range.selectNodeContents(nr.node);
                        const cfi = this.book.cfiFromRange ? this.book.cfiFromRange(range) : null;
                        if (cfi) sentenceCfiMap[si] = cfi;
                    } catch(e) {}
                }
                cursor = idx + sent.length;
            });

            return { text: structuredText, sentenceCfiMap };
        } catch(e) {
            return { text: '', sentenceCfiMap: {} };
        }
    }

    getTOC() {
        if (!this.book || !this.book.navigation) return [];
        const navItems = this.book.navigation.toc || [];
        const spineItems = this.spineItems;

        const hrefToChapter = (href) => {
            if (!href) return 1;
            const clean = href.split('#')[0];
            const idx = spineItems.findIndex(item =>
                item.href === href || item.href === clean ||
                (item.href || '').endsWith(clean) || clean.endsWith(item.href || '')
            );
            return idx >= 0 ? idx + 1 : 1;
        };

        const convert = (items) => items.map(item => ({
            title: item.label || item.title || '(untitled)',
            page: hrefToChapter(item.href),
            href: item.href,
            items: item.subitems ? convert(item.subitems) : [],
        }));
        return convert(navItems);
    }

    async search(query) {
        if (!this.book) return [];
        try {
            const results = await this.book.search(query, { limit: 200 });
            return results.map(r => {
                const page = this._cfiToChapter(r.cfi);
                return { page, context: r.excerpt || '', query };
            });
        } catch(e) { return []; }
    }

    _cfiToChapter(cfi) {
        // Extract spine index from CFI string like "epubcfi(/6/4[...]!...)"
        if (!cfi) return 1;
        try {
            const m = cfi.match(/\/6\/(\d+)/);
            if (m) {
                const spinePos = (parseInt(m[1], 10) - 2) / 2; // CFI uses even numbers
                return Math.max(1, Math.min(spinePos + 1, this.pageCount));
            }
        } catch(e) {}
        return 1;
    }

    highlightSentence(idx) {
        if (!this.rendition) return;
        this._clearHighlights();
        const cfi = this.sentenceCfiMap[idx];
        if (cfi) {
            try {
                this.rendition.annotations.highlight(cfi, {}, () => {}, 'epub-reading-hl');
                this._injectHighlightStyle();
                return;
            } catch(e) {}
        }
        this._highlightByText(idx);
    }

    _clearHighlights() {
        try { this.rendition.annotations.remove('epub-reading-hl', 'highlight'); } catch(e) {}
        try {
            const contents = this.rendition.getContents();
            if (contents && contents[0] && contents[0].document) {
                const doc = contents[0].document;
                doc.querySelectorAll('mark.epub-reading-hl').forEach(m => {
                    if (m.parentNode) m.parentNode.replaceChild(doc.createTextNode(m.textContent), m);
                });
                try { doc.body.normalize(); } catch(e) {}
            }
        } catch(e) {}
    }


	async renderPage(pageNum) {
        if (this._destroyed) return;
        if (this._rendering) return;   
        this._rendering = true;
        try {
            this.currentPage = Math.max(1, Math.min(pageNum, this.pageCount));
            const item = this.spineItems[this.currentPage - 1];
            if (!item) return;

            await new Promise(async (resolve) => {
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                const timer = setTimeout(finish, 4000);
                try {
                    this.rendition.once('rendered', () => { clearTimeout(timer); finish(); });
                    await this.rendition.display(item.href);
                } catch(e) {
                    clearTimeout(timer);
                    finish();
                }
            });

            try {
                const contents = this.rendition.getContents();
                if (contents && contents[0] && contents[0].window) {
                    contents[0].window.scrollTo(0, 0);
                }
            } catch(e) {}

            this._injectReadingStyle();
            
            // RESET THE HIGHLIGHT CURSOR FOR THE NEW PAGE
            this._lastHighlightNormIndex = 0; 
            
            const { text, sentenceCfiMap } = this._extractTextFromRendition();
            this.currentText = text;
            this.currentSentences = splitIntoTTSChunks(text, 250);
            this.sentenceCfiMap = sentenceCfiMap;
            return { text, sentences: this.currentSentences };
        } finally {
            this._rendering = false;
        }
    }


    _highlightByText(idx) {
        const sent = (this.currentSentences[idx] || '').trim();
        if (!sent) return;
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents.length) return;
            const doc = contents[0].document;
            if (!doc) return;

            const needleNorm = sent.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!needleNorm) return;

            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
                acceptNode: n => {
                    const tag = (n.parentElement && n.parentElement.tagName || '').toLowerCase();
                    return ['script','style','nav'].includes(tag) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
                }
            });

            let node;
            const textNodes = [];
            let combinedText = '';

            while ((node = walker.nextNode())) {
                textNodes.push({ node, start: combinedText.length, text: node.textContent });
                combinedText += node.textContent;
            }

            const domNorm = combinedText.toLowerCase().replace(/[^a-z0-9]/g, '');
            
            // Search forward from the last known good position
            const searchStart = Math.max(0, (this._lastHighlightNormIndex || 0) - 50);
            let matchStartNorm = domNorm.indexOf(needleNorm.slice(0, 40), searchStart);
            
            if (matchStartNorm === -1) {
                // Fallback to start if we somehow got lost
                matchStartNorm = domNorm.indexOf(needleNorm.slice(0, 40), 0);
            }
            if (matchStartNorm === -1) return;
            
            // Advance tracker so the next sentence searches forward
            this._lastHighlightNormIndex = matchStartNorm + needleNorm.length;

            const matchEndNorm = matchStartNorm + needleNorm.length;
            let rawStart = -1, rawEnd = -1, alphaCount = 0;
            const combinedLower = combinedText.toLowerCase();

            for (let i = 0; i < combinedLower.length; i++) {
                if (/[a-z0-9]/.test(combinedLower[i])) {
                    if (alphaCount === matchStartNorm) rawStart = i;
                    alphaCount++;
                    if (alphaCount === matchEndNorm) { rawEnd = i + 1; break; }
                }
            }

            if (rawStart === -1 || rawEnd === -1) return;
			while (rawEnd < combinedText.length && /[.,!?;:'"’”\]\)]/.test(combinedText[rawEnd])) {
                rawEnd++;
            }

            let firstMark = null;
            textNodes.forEach(tn => {
                const nodeStart = tn.start;
                const nodeEnd = nodeStart + tn.text.length;
                const overlapStart = Math.max(nodeStart, rawStart);
                const overlapEnd = Math.min(nodeEnd, rawEnd);

                if (overlapStart < overlapEnd) {
                    try {
                        const range = doc.createRange();
                        range.setStart(tn.node, overlapStart - nodeStart);
                        range.setEnd(tn.node, overlapEnd - nodeStart);

                        const mark = doc.createElement('mark');
                        mark.className = 'epub-reading-hl';
                        range.surroundContents(mark);
                        if (!firstMark) firstMark = mark;
                    } catch(e) {}
                }
            });

            if (firstMark) firstMark.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch(e) {}
    }



	_injectReadingStyle(targetDoc) {
        try {
            let doc = targetDoc;
            if (!doc) {
                const contents = this.rendition.getContents();
                if (!contents || !contents.length) return;
                doc = contents[0].document;
            }
            if (!doc || !doc.head) return;
            
            const id = 'epub-reader-style';
            let s = doc.getElementById(id);
            if (!s) {
                s = doc.createElement('style');
                s.id = id;
                doc.head.appendChild(s);
            }
            s.textContent = `
                @font-face { font-family: 'Mononoki'; src: url('${window.location.origin}/static/fonts/mononoki-Regular.ttf') format('truetype'); }
                
                /* Force strict box-sizing inside the isolated iframe */
                * { 
                    font-family: 'Mononoki', monospace !important; 
                    box-sizing: border-box !important; 
                }
                
                /* Kill horizontal scrolling at the root level */
                html, body {
                    overflow-x: hidden !important;
                    max-width: 100% !important;
                }
                
                body { 
                    width: 100% !important;
                    margin: 0 auto !important; 
                    padding: 20px 28px 60px !important; 
                    word-wrap: break-word !important; 
                    overflow-wrap: anywhere !important; /* Force breaks on long URLs */
                    will-change: scroll-position; 
                    transform: translateZ(0); 
                }
                body.is-scrolling * { pointer-events: none !important; }
                
                /* Ensure media doesn't break the layout */
                img, svg, figure, video, audio { max-width: 100% !important; height: auto !important; }
                h1,h2,h3,h4,h5,h6 { margin-top: 1.4em; margin-bottom: 0.5em; line-height: 1.3; }
                p { margin: 0 0 0.9em; }
                
                /* Grouped Code Block Theming */
                .docreader-code-wrapper {
                    background: rgba(120, 120, 120, 0.12) !important;
                    border: 1px solid rgba(120, 120, 120, 0.25) !important;
                    border-radius: 6px !important;
                    padding: 14px !important;
                    margin: 12px 0 !important;
                    overflow-x: auto !important; /* Code scrolls internally, doesn't break page */
                    width: 100% !important;
                }
                .docreader-code-wrapper p, .docreader-code-wrapper pre, .docreader-code-wrapper div {
                    margin: 0 !important;
                    padding: 0 !important;
                    background: transparent !important;
                    border: none !important;
                    line-height: 1.5 !important;
                }
            `;
        } catch(e) {}
    }

    _injectHighlightStyle(targetDoc) {
        try {
            let doc = targetDoc;
            if (!doc) {
                const contents = this.rendition.getContents();
                if (!contents || !contents.length) return;
                doc = contents[0].document;
            }
            if (!doc || !doc.head) return;
            
            const id = 'epub-hl-style';
            let s = doc.getElementById(id);
            if (!s) {
                s = doc.createElement('style');
                s.id = id;
                doc.head.appendChild(s);
            }
            
            const color = `rgba(${hlBaseColor}, ${hlOpacity})`;
            const outline = hlOutline ? `0 0 0 1px rgba(${hlBaseColor},${Math.min(1, hlOpacity * 2.5)})` : 'none';
            const radius = hlRadius + 'px';
            const pad = hlPadding + 2; // Added vertical padding
            
            s.textContent = `
                .epub-reading-hl, mark.epub-reading-hl {
                    background: ${color} !important;
                    border-radius: ${radius} !important;
                    color: inherit !important;
                    padding: ${pad}px 3px !important; 
                    box-shadow: ${outline} !important;
                    box-decoration-break: clone !important;
                    -webkit-box-decoration-break: clone !important;
                }
                .epubjs-hl { fill: ${color} !important; fill-opacity: 1 !important; }
            `;
        } catch(e) {}
    }

    clearHighlights() { this._clearHighlights(); }

    setZoom(scale) { this._applyScale(scale); }
    setTheme(theme) { this._applyCurrentTheme(theme); }

    resize(width, height) {
        if (this.rendition && width > 0 && height > 0) {
            try { this.rendition.resize(width, height); } catch(e) {}
        }
    }

    async _loadChapterStats() {
        if (!this.book || !this.book.spine) return;
        const items = this.spineItems;
        for (let i = 0; i < items.length; i++) {
            try {
                const content = await this.book.load(items[i].href);
                const parser = new DOMParser();
                const doc = parser.parseFromString(content, 'application/xhtml+xml');
                this.chapterCharMap[i] = doc.body ? doc.body.textContent.length : 0;
            } catch(e) { this.chapterCharMap[i] = 0; }
            if (i < items.length - 1)
                await new Promise(r => typeof requestIdleCallback !== 'undefined' ? requestIdleCallback(r) : setTimeout(r, 10));
        }
    }

    getChapterTime(pageNum, speed) {
        if (!this.book || !this.book.spine) return 0;
        const items = this.spineItems;
        let total = 0;
        for (let i = pageNum - 1; i < items.length; i++)
            total += (this.chapterCharMap[i] || 0);
        return (total / 5 / (150 * speed)) * 60;
    }

    destroy() {
        this._destroyed = true;
        if (this._epubResizeObserver) { try { this._epubResizeObserver.disconnect(); } catch(e) {} }
        if (this.rendition) { try { this.rendition.destroy(); } catch(e) {} this.rendition = null; }
        if (this.book)      { try { this.book.destroy();      } catch(e) {} this.book = null; }
        this.spineItems = [];
        this.currentSentences = [];
        this.sentenceCfiMap = {};
    }
}

const savedTheme = localStorage.getItem('docreader-theme') || 'default-light';
applyTheme(savedTheme);
if (themeSelector) {
    themeSelector.addEventListener('change', () => {
        applyTheme(themeSelector.value);
    });
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

    // Destroy any previous epub handler and show pdf container
    if (documentHandler && documentHandler instanceof EPUBHandler) {
        documentHandler.destroy();
        documentHandler = null;
    }
    document.getElementById('epub-container').style.display = 'none';
    document.getElementById('pdf-container').style.display = '';

    try {
        const task = pdfjsLib.getDocument(fileUrl);
        pdfDoc = await task.promise;
        documentHandler = null; // PDF uses pdfDoc directly

        // 🔥 Clear TOC immediately to prevent stale items during rendering
        tocList.innerHTML = '';
        tocEmpty.style.display = 'block';
        Object.keys(chapterDurationCache).forEach(k => delete chapterDurationCache[k]);

        topbarFilename.textContent = currentFileName;
        document.title = `DocReader Pro — ${currentFileName}`;
        document.getElementById('page-count').textContent = pdfDoc.numPages;
        pageJumpInput.max = pdfDoc.numPages;

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
            topSkipLines = settings.topSkipLines || 0;
            bottomSkipLines = settings.bottomSkipLines || 0;
            document.getElementById('skip-top-lines').value = topSkipLines;
            document.getElementById('skip-bottom-lines').value = bottomSkipLines;
        } else {
            if (window.innerWidth <= 768) {
                const vw = viewerArea.clientWidth - 16;
                const fp = await pdfDoc.getPage(1);
                const ov = fp.getViewport({ scale: 1 });
                scale = Math.round(Math.min(3.0, Math.max(0.9, vw / ov.width)) * 10) / 10;
                zoomSlider.value = scale;
                zoomVal.textContent = Math.round(scale * 100) + '%';
            }
        }

        openCacheSocket(currentFileName);
        try {
            await fetch('/last_document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentFileName })
            });
        } catch (e) {}

        await renderPage(pageNum);
        updateMobilePageInfo();
        await loadOutline();
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

async function loadLastDocument() {
    try {
        const res = await fetch('/last_document');
        if (!res.ok) return;
        const data = await res.json();
        const filename = data.filename;
        if (!filename) return;
        if (!serverDocNames.has(filename)) {
            console.warn(`Last document "${filename}" not in server library, skipping.`);
            return;
        }
        const docRes = await fetch(`/documents/${encodeURIComponent(filename)}`);
        if (!docRes.ok) {
            console.warn(`Last document "${filename}" not found on server.`);
            return;
        }
        const blob = await docRes.blob();
        const isEpub = filename.toLowerCase().endsWith('.epub');
        const mimeType = isEpub ? 'application/epub+zip' : 'application/pdf';
        const file = new File([blob], filename, { type: mimeType });
        loadDocument(file, 1);
    } catch (e) {
        console.warn('Failed to load last document:', e);
    }
}

/* ─── EPUB Load ─── */
async function loadEPUB(file, startPage = 1) {
    console.log(`[EPUB] Loading: "${file.name}" (${(file.size / 1024 / 1024).toFixed(2)} MB), startPage=${startPage}`);
    showLoading('Loading EPUB…');
    currentFile = file;
    currentFileName = file.name || 'Document';

    welcomeScreen.classList.remove('active');
    readerScreen.classList.add('active');

    // Show epub container, hide pdf container
    document.getElementById('pdf-container').style.display = 'none';
    document.getElementById('epub-container').style.display = 'block';

    if (documentHandler) { try { documentHandler.destroy(); } catch (e) {} }
    pdfDoc = null;
    documentHandler = new EPUBHandler();

    // Clear stale UI
    tocList.innerHTML = '';
    tocEmpty.style.display = 'block';
    Object.keys(chapterDurationCache).forEach(k => delete chapterDurationCache[k]);
    topbarFilename.textContent = currentFileName;
    document.title = `DocReader Pro — ${currentFileName}`;

    try {
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
            topSkipLines = settings.topSkipLines || 0;
            bottomSkipLines = settings.bottomSkipLines || 0;
            document.getElementById('skip-top-lines').value = topSkipLines;
            document.getElementById('skip-bottom-lines').value = bottomSkipLines;
        }
        if (startPage > 1) pageNum = startPage;

        const viewerArea = document.getElementById('pdf-viewer-area');
        const currentTheme = localStorage.getItem('docreader-theme') || 'default-light';
        await documentHandler.load(file, pageNum, viewerArea, scale, currentTheme);

        // Update page count
        const totalPages = documentHandler.pageCount;
        document.getElementById('page-count').textContent = totalPages;
        pageJumpInput.max = totalPages;
        document.getElementById('page-num').textContent = pageNum;

        // Get text for current page
        currentPageText = documentHandler.currentText;
        sentences = documentHandler.currentSentences;
        updatePageStats(pageNum, sentences);

        prevPageBtn.disabled = pageNum <= 1;
        nextPageBtn.disabled = pageNum >= totalPages;
        updateMobilePageInfo();

        // Notify server of last document
        openCacheSocket(currentFileName);
        try {
            await fetch('/last_document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentFileName })
            });
        } catch (e) {}

        // Load TOC
        loadEpubOutline();
        await updateActiveTocItem();

        if (isMobileSidebar()) closeMobileSidebar();

        // Set up epub rendition click-to-read handler
        documentHandler.rendition.on('click', () => {
            // clicks inside iframe
        });

        // ResizeObserver: keep epub rendition sized to its container
        if (window._epubResizeObserver) {
            window._epubResizeObserver.disconnect();
        }
        const epubContainerEl = document.getElementById('epub-container');
        if (epubContainerEl && typeof ResizeObserver !== 'undefined') {
            window._epubResizeObserver = new ResizeObserver((entries) => {
                if (!documentHandler || !(documentHandler instanceof EPUBHandler)) return;
                const entry = entries[0];
                if (!entry) return;
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    try { documentHandler.rendition.resize(width, height); } catch(e) {}
                }
            });
            window._epubResizeObserver.observe(epubContainerEl);
        }

    } catch (err) {
        console.error('[EPUB] Load error:', err);
        alert('Failed to load EPUB: ' + err.message);
        resetUI();
    } finally {
        hideLoading();
    }
}

function loadEpubOutline() {
    if (!documentHandler || !(documentHandler instanceof EPUBHandler)) return;
    const toc = documentHandler.getTOC();
    tocList.innerHTML = '';
    if (!toc || !toc.length) { tocEmpty.style.display = 'block'; return; }
    tocEmpty.style.display = 'none';
    let chapterCounter = 0;

    function renderEpubTree(items, level, parentEl) {
        items.forEach(item => {
            const isChapter = level === 0;
            if (isChapter) chapterCounter++;

            const wrapper = document.createElement('div');
            wrapper.className = 'toc-item-wrapper';

            const el = document.createElement('div');
            el.className = `toc-item level-${level}`;
            el.dataset.level = level;
            el.dataset.page = item.page || 1;
            el._isChapter = isChapter;
            el._chapterNumber = isChapter ? chapterCounter : null;

            const toggleSpan = document.createElement('span');
            toggleSpan.className = 'toc-toggle-container';
            toggleSpan.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:18px;margin-right:2px;';

            let childrenDiv = null;
            if (item.items && item.items.length) {
                toggleSpan.innerHTML = `<svg class="toc-toggle-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition:transform 0.2s;cursor:pointer;color:var(--text-tertiary);"><polyline points="6 9 12 15 18 9"/></svg>`;
                childrenDiv = document.createElement('div');
                childrenDiv.className = 'toc-children';
                childrenDiv.style.display = 'none';
                toggleSpan.querySelector('.toc-toggle-svg').style.transform = 'rotate(-90deg)';
                toggleSpan.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const collapsed = childrenDiv.style.display === 'none';
                    childrenDiv.style.display = collapsed ? 'block' : 'none';
                    toggleSpan.querySelector('.toc-toggle-svg').style.transform = collapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
                });
            }

            el.appendChild(toggleSpan);

            const prefix = level === 0 ? `${chapterCounter}. ` : '  '.repeat(level) + '• ';
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'tree-prefix';
            prefixSpan.textContent = prefix;
            el.appendChild(prefixSpan);

            const numSpan = document.createElement('span');
            numSpan.className = 'toc-item-num';
            numSpan.textContent = item.page || '—';
            el.appendChild(numSpan);

            const labelSpan = document.createElement('span');
            labelSpan.className = 'toc-item-label';
            labelSpan.textContent = item.title || '(untitled)';
            el.appendChild(labelSpan);

            el.addEventListener('click', async () => {
                if (!item.page) return;
                stopPipeline();
                await epubGoToPage(item.page);
                if (isMobileSidebar()) closeMobileSidebar();
            });

            wrapper.appendChild(el);
            if (childrenDiv) {
                wrapper.appendChild(childrenDiv);
                renderEpubTree(item.items, level + 1, childrenDiv);
            }
            parentEl.appendChild(wrapper);
        });
    }

    renderEpubTree(toc, 0, tocList);
}

function hardResetReadingState() {
    stopPipeline();
    clearPageAudioCache();
    currentIndex = 0;
    currentPageText = '';
    sentences = [];
}

async function epubGoToPage(target) {
    if (!documentHandler || !(documentHandler instanceof EPUBHandler)) return;
    hardResetReadingState();
    pageNum = Math.max(1, Math.min(target, documentHandler.pageCount));
    const result = await documentHandler.renderPage(pageNum);
    if (result) {
        currentPageText = result.text;
        sentences = result.sentences;
        updatePageStats(pageNum, sentences);
    }
    document.getElementById('page-num').textContent = pageNum;
    prevPageBtn.disabled = pageNum <= 1;
    nextPageBtn.disabled = pageNum >= documentHandler.pageCount;
    updateMobilePageInfo();
    await updateActiveTocItem();
    updateChapterBoundaries();
    saveSettingsThrottled(pageNum, scale, currentIndex);
    await refreshTimeEstimates();
}

function goToPage(delta, isAutoTurn = false) {
    const total = getPageCount();
    if (!total) return;
    const target = pageNum + delta;
    if (target < 1 || target > total) return;
    if (documentHandler instanceof EPUBHandler) {
        if (!isAutoTurn) { isAutoContinuing = false; }
        hardResetReadingState();
        epubGoToPage(target);
        return;
    }
    if (!pdfDoc) return;
    if (!isAutoTurn) { isAutoContinuing = false; }
    hardResetReadingState();
    pageNum = target;
    queueRenderPage(pageNum);
    saveSettingsThrottled(pageNum, scale, currentIndex);
    viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToAbsolutePage(target, callback = null) {
    if (documentHandler instanceof EPUBHandler) {
        epubGoToPage(target);
        return;
    }
    if (!pdfDoc || target < 1 || target > pdfDoc.numPages) return;
    hardResetReadingState();
    pageNum = target;
    if (callback) afterRenderCallback = callback;
    queueRenderPage(pageNum);
    saveSettingsThrottled(pageNum, scale, currentIndex);
    viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ─── PDF Outline / TOC ─── */
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
    let chapterCounter = 0;

    // CHANGED: Added parentElement parameter to allow for DOM nesting
    function renderTree(items, level, path, parentLast, parentElement) {
        items.forEach((item, index, arr) => {
            const isLast = index === arr.length - 1;
            const newPath = [...path, isLast];
            const isChapter = (level === 0);
            if (isChapter) chapterCounter++;
            
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
            if (item.dest) pageNumber = '…';

            // CHANGED: Wrap the item and its children in a structural container
            const wrapper = document.createElement('div');
            wrapper.className = 'toc-item-wrapper';

            const el = document.createElement('div');
            el.className = `toc-item level-${level}`;
            el.dataset.level = level;
            el._tocItem = item;
            el._path = newPath;
            el._level = level;
            el._isChapter = isChapter;
            el._chapterNumber = isChapter ? chapterCounter : null;

            // CHANGED: Toggle icon container for expanding/retracting
            const toggleSpan = document.createElement('span');
            toggleSpan.className = 'toc-toggle-container';
            toggleSpan.style.display = 'inline-flex';
            toggleSpan.style.alignItems = 'center';
            toggleSpan.style.justifyContent = 'center';
            toggleSpan.style.width = '18px';
            toggleSpan.style.marginRight = '2px';

            let childrenDiv = null;

            if (item.items && item.items.length) {
                toggleSpan.innerHTML = `<svg class="toc-toggle-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.2s; cursor: pointer; color: var(--text-tertiary);"><polyline points="6 9 12 15 18 9"/></svg>`;
                
                childrenDiv = document.createElement('div');
                childrenDiv.className = 'toc-children';
                childrenDiv.style.display = 'none'; // Retracted by default
                toggleSpan.querySelector('.toc-toggle-svg').style.transform = 'rotate(-90deg)';

                // Toggle click logic for manual override
                toggleSpan.addEventListener('click', (e) => {
                    e.stopPropagation(); 
                    const isCollapsed = childrenDiv.style.display === 'none';
                    childrenDiv.style.display = isCollapsed ? 'block' : 'none';
                    toggleSpan.querySelector('.toc-toggle-svg').style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
                });
            } else {
                toggleSpan.innerHTML = ''; // Spacer to align childless items
            }

            el.appendChild(toggleSpan);

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
                    if (isMobileSidebar()) closeMobileSidebar();
                } catch (e) {
                    console.warn('TOC navigation error:', e);
                }
            });

            wrapper.appendChild(el);
            
            if (childrenDiv) {
                wrapper.appendChild(childrenDiv);
                // Recursively render into the newly created children block
                renderTree(item.items, level + 1, newPath, isLast, childrenDiv);
            }

            parentElement.appendChild(wrapper);
        });
    }
    
    // CHANGED: Base call now passes tocList as the starting container
    renderTree(pdfOutline, 0, [], false, tocList);
    await resolveAllTOCPages();
    await updateActiveTocItem();
    await refreshTimeEstimates();
}

async function resolveAllTOCPages() {
    const items = tocList.querySelectorAll('.toc-item');
    const promises = [];
    items.forEach(el => {
        const item = el._tocItem;
        if (!item || !item.dest) return;
        const numSpan = el.querySelector('.toc-item-num');
        promises.push((async () => {
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
        })());
    });
    await Promise.all(promises);
}

function scrollToActiveTocItem() {
    const activeEl = document.querySelector('.toc-item.active');
    const sidebarContent = document.getElementById('sidebar-content');
    const tocPanel = document.getElementById('toc-panel');
    
    // Prevent scrolling if elements are missing, the TOC tab is hidden, or the sidebar is collapsed
    if (!activeEl || !sidebarContent || tocPanel.style.display === 'none' || sidebar.classList.contains('collapsed')) return;

    // A small timeout allows the DOM to calculate its layout after a display:block switch
    setTimeout(() => {
        activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
}

async function updateActiveTocItem() {
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
    
    items.forEach(el => el.classList.remove('active'));
    
    if (!activeEl) {
        await refreshTimeEstimates();
        return;
    }
    
    activeEl.classList.add('active');

    // CHANGED: 1. Retract everything first
    document.querySelectorAll('.toc-children').forEach(childContainer => {
        childContainer.style.display = 'none';
    });
    document.querySelectorAll('.toc-toggle-svg').forEach(svg => {
        svg.style.transform = 'rotate(-90deg)';
    });

    // CHANGED: 2. Trace up the DOM tree and explicitly expand parents of the active item
    let curr = activeEl.parentElement; 
    while (curr && curr.id !== 'toc-list') {
        if (curr.classList.contains('toc-children')) {
            curr.style.display = 'block';
            const parentTocItem = curr.previousElementSibling;
            if (parentTocItem) {
                const toggleSvg = parentTocItem.querySelector('.toc-toggle-svg');
                if (toggleSvg) toggleSvg.style.transform = 'rotate(0deg)';
            }
        }
        curr = curr.parentElement;
    }

    // CHANGED: 3. If the active item itself is a folder/chapter, expand it to show its direct contents
    const activeChildren = activeEl.nextElementSibling;
    if (activeChildren && activeChildren.classList.contains('toc-children')) {
        activeChildren.style.display = 'block';
        const toggleSvg = activeEl.querySelector('.toc-toggle-svg');
        if (toggleSvg) toggleSvg.style.transform = 'rotate(0deg)';
    }

    scrollToActiveTocItem();
    await refreshTimeEstimates();
}

/* ─── Time estimation functions ─── */
function computePageTime(page) {
    const stats = pageStats[page];
    if (!stats) return null;
    const wpm = 150;
    const words = stats.totalChars / 5;
    return (words / (wpm * playbackSpeed)) * 60;
}
function computeChapterTime() {
    const activeChapterEl = document.querySelector('.toc-item.level-0.active');
    if (!activeChapterEl) return null;
    const startPage = parseInt(activeChapterEl.dataset.page, 10);
    if (!startPage) return null;
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
    const words = totalChars / 5;
    return (words / (150 * playbackSpeed)) * 60;
}

/* ─── Duration caching with promise sharing ─── */
const pageDurationCache = {};
async function fetchPageDuration(bookName, page) {
    const key = page;
    if (pageDurationCache[key] !== undefined) return pageDurationCache[key];
    if (pendingPageDurations[key]) return pendingPageDurations[key];
    const promise = (async () => {
        try {
            const res = await fetch(`/page_duration?book_name=${encodeURIComponent(bookName)}&page=${page}`);
            if (!res.ok) return null;
            const data = await res.json();
            const dur = data.duration || 0;
            pageDurationCache[key] = dur;
            delete pendingPageDurations[key];
            return dur;
        } catch (e) {
            console.warn('fetchPageDuration error:', e);
            delete pendingPageDurations[key];
            return null;
        }
    })();
    pendingPageDurations[key] = promise;
    return promise;
}
async function fetchChapterDuration(bookName, startPage, endPage) {
    // Avoid whole-book request when no chapter defined
    if (startPage === 1 && endPage === pdfDoc?.numPages && !document.querySelector('.toc-item.level-0.active')) {
        return 0;
    }
    const key = `${startPage}-${endPage}`;
    if (chapterDurationCache[key] !== undefined) return chapterDurationCache[key];
    if (pendingChapterDurations[key]) return pendingChapterDurations[key];
    const promise = (async () => {
        try {
            const res = await fetch(`/chapter_duration?book_name=${encodeURIComponent(bookName)}&start_page=${startPage}&end_page=${endPage}`);
            if (!res.ok) return null;
            const data = await res.json();
            const dur = data.duration || 0;
            chapterDurationCache[key] = dur;
            delete pendingChapterDurations[key];
            return dur;
        } catch (e) {
            console.warn('fetchChapterDuration error:', e);
            delete pendingChapterDurations[key];
            return null;
        }
    })();
    pendingChapterDurations[key] = promise;
    return promise;
}
function estimateSentenceDuration(text) {
    const words = text.length / 5;
    return (words / 150) * 60;
}
function updatePageStats(page, sentences) {
    let totalChars = 0;
    sentences.forEach(s => totalChars += s.length);
    pageStats[page] = { totalChars, sentenceCount: sentences.length };
}

/* ─── Search ─── */
async function indexAllPagesForSearch() { searchAllPageTexts = {}; }
async function getPageText(pageIndex) {
    if (searchAllPageTexts[pageIndex] !== undefined) return searchAllPageTexts[pageIndex];
    try {
        const page = await pdfDoc.getPage(pageIndex);
        const tc = await page.getTextContent();
        const text = tc.items.map(i => i.str).join(' ');
        searchAllPageTexts[pageIndex] = text;
        return text;
    } catch (e) { return ''; }
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

let currentSearchId = 0;

async function performSearch() {
    const searchId = ++currentSearchId; // CHANGED: Track the active search execution
    const query = searchInput.value.trim();
    
    if (!query || !pdfDoc) { clearSearch(); return; }
    
    searchClearBtn.style.display = '';
    searchCount.textContent = '…';
    searchResultsPanel.classList.add('visible');
    searchResultsList.innerHTML = '<div style="padding:14px 16px;color:var(--text-tertiary);font-size:13px">Searching…</div>';
    searchMatches = [];
    
    const lowerQuery = query.toLowerCase();
    showLoading('Searching document…');
    
    for (let p = 1; p <= pdfDoc.numPages; p++) {
        // CHANGED: Abort the loop if a new search was triggered
        if (searchId !== currentSearchId) return; 
        
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
    
    // CHANGED: Final check before updating the DOM to prevent race conditions
    if (searchId !== currentSearchId) return; 
    
    hideLoading();
    
    if (searchMatches.length === 0) {
        searchCount.textContent = '0';
        searchResultsList.innerHTML = '<div class="toc-empty">No results found for <strong>"' + escapeHtml(query) + '"</strong></div>';
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

        const skipTop = Math.min(topSkipLines || 0, lines.length);
        const skipBottom = Math.min(bottomSkipLines || 0, lines.length);
        const effectiveLines = lines.slice(skipTop, lines.length - skipBottom);

        let structuredText = '';
        const unscaledH = viewport.viewBox ? viewport.viewBox[3] : 800;
        let prevY = null;
        let inListItem = false;

        effectiveLines.forEach(line => {
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

        // Render the text layer
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

        // 🔥 Update TOC and time estimates via updateActiveTocItem (which calls refreshTimeEstimates)
        await updateActiveTocItem();
        updateChapterBoundaries();

        // Only update time display if playing (refreshTimeEstimates already called above)
        if (isPlaying) {
            updateTimeDisplay();
        }

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
            viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
        }

        if (isAutoContinuing) {
            isAutoContinuing = false;
            setTimeout(() => {
                if (currentPageText.trim()) {
                    isPlaying = false;
                    startReadingPage(0);
                } else if (pageNum < getPageCount()) {
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

function updateChapterBoundaries() {
    let activeChapter = document.querySelector('.toc-item.level-0.active');
    if (!activeChapter) {
        const chapters = document.querySelectorAll('.toc-item.level-0');
        let best = null, bestStart = 0;
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
    if (activeChapter) {
        const start = parseInt(activeChapter.dataset.page, 10);
        let end = getPageCount() || (pdfDoc ? pdfDoc.numPages : 1);
        const allChapters = document.querySelectorAll('.toc-item.level-0');
        for (let i = 0; i < allChapters.length; i++) {
            if (allChapters[i] === activeChapter && i + 1 < allChapters.length) {
                const nextPage = parseInt(allChapters[i + 1].dataset.page, 10);
                if (nextPage) end = nextPage - 1;
                break;
            }
        }
        chapterStartPage = start;
        chapterEndPage = end;
    } else {
        chapterStartPage = null;
        chapterEndPage = null;
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
                    } catch (err) { console.warn('Link navigation failed:', err); }
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
prevPageBtn.addEventListener('click', () => goToPage(-1));
nextPageBtn.addEventListener('click', () => goToPage(1));
mobilePrevBtn.addEventListener('click', () => goToPage(-1));
mobileNextBtn.addEventListener('click', () => goToPage(1));

document.addEventListener('keydown', e => {
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === 'Escape') { resetUI(); return; }
    if (e.key === 's' || e.key === 'S') { toggleSidebar(); return; }
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) return;
    if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'h') goToPage(-1);
    if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') goToPage(1);
    if (e.key === '+' || e.key === '=') setZoom(scale + 0.1);
    if (e.key === '-' || e.key === '_') setZoom(scale - 0.1);
    if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
    
    // Line-by-line navigation
    if (['j', 'k', 'arrowdown', 'arrowup'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        if (!sentences || sentences.length === 0) return;
        let newIndex = currentIndex;
        if (e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'arrowdown') {
            newIndex = Math.min(currentIndex + 1, sentences.length - 1);
        } else if (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'arrowup') {
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
function isAcceptedFile(file) {
    return file && (file.type === 'application/pdf' || file.type === 'application/epub+zip' ||
        file.name.toLowerCase().endsWith('.epub') || file.name.toLowerCase().endsWith('.pdf'));
}
fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (isAcceptedFile(file)) loadDocument(file, 1);
});
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (isAcceptedFile(file)) loadDocument(file, 1);
});
document.getElementById('close-file').addEventListener('click', resetUI);

function resetUI() {
    stopPipeline();
    clearPageAudioCache();
    WS.close('session');
    WS.close('cache');
    WS.close('tts');
	Object.keys(pageDurationCache).forEach(key => delete pageDurationCache[key]);
	Object.keys(chapterDurationCache).forEach(key => delete chapterDurationCache[key]);
    Object.keys(pendingChapterDurations).forEach(k => delete pendingChapterDurations[k]);
    Object.keys(pendingPageDurations).forEach(k => delete pendingPageDurations[k]);
    clearHighlightCanvas();
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.destroy();
        documentHandler = null;
    }
    pdfDoc = null;
    currentFile = null;
    currentFileName = '';
    fileInput.value = '';
    readerScreen.classList.remove('active');
    welcomeScreen.classList.add('active');
    // Reset containers
    document.getElementById('pdf-container').style.display = '';
    document.getElementById('epub-container').style.display = 'none';
    document.getElementById('epub-viewer').innerHTML = '';
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
    pageTimeEl.textContent = 'Page: —';
    chapterTimeEl.textContent = 'Chapter: —';
    Object.keys(pageStats).forEach(key => delete pageStats[key]);
    openLibrarySocket();
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

// ─── TTS request queue ───
let _ttsQueue = [];
let _ttsBusy = false;
let _ttsPendingIdx = null;

async function processTtsQueue() {
    if (_ttsBusy || _ttsQueue.length === 0) return;
    _ttsBusy = true;
    const idx = _ttsQueue.shift();
    _ttsPendingIdx = idx;
    console.log(`[TTS] Processing queue: idx=${idx}, remaining=${_ttsQueue.length}`);
    try {
        await fetchSentenceAudio(idx);
    } catch (e) {
        console.error(`TTS fetch error for ${idx}:`, e);
        if (audioCache[idx] === 'fetching') audioCache[idx] = null;
        _onTtsDone(idx);
    }
}

function _onTtsDone(idx) {
    _ttsBusy = false;
    _ttsPendingIdx = null;
    inFlight--;
    console.log(`[TTS] Done with idx=${idx}, inFlight=${inFlight}`);
    
    if (isPlaying) {
        if (!hasStartedPlaying) {
            const required = Math.min(REQUIRED_START_BUFFER, sentences.length - currentIndex);
            let cnt = 0;
            for (let i = currentIndex; i < currentIndex + required; i++) {
                // CHANGED: Count the item as long as it's not undefined (unrequested) and not 'fetching'. 
                // This allows 'null' (errors) to satisfy the buffer requirement.
                if (audioCache[i] !== undefined && audioCache[i] !== 'fetching') cnt++;
            }
            ttsStatusText.textContent = `Generating… ${cnt}/${required}`;
            if (cnt >= required) { hasStartedPlaying = true; playNextChunk(); }
        } else {
            if (idx === currentIndex && audioPlayer.paused) playNextChunk();
        }
    }
    preloadQueue();
    processTtsQueue();
}

function enqueueTts(idx) {
    // If it's already generated (blob url) or failed (null), skip it
    if (audioCache[idx] !== undefined && audioCache[idx] !== 'fetching') return;
    
    // If it's already actively fetching, skip it
    if (audioCache[idx] === 'fetching') return;
    if (_ttsQueue.includes(idx)) return;
    
    // CHANGED: Officially claim the 'fetching' state and increment inFlight here, 
    // where we actually push to the queue.
    audioCache[idx] = 'fetching';
    inFlight++;
    
    _ttsQueue.push(idx);
    console.log(`[TTS] Enqueued idx=${idx}, queue length=${_ttsQueue.length}`);
    processTtsQueue();
}

function preloadQueue() {
    if (!isPlaying) return;
    const limit = Math.min(currentIndex + BUFFER_DEPTH, sentences.length);
    console.log(`[TTS] preloadQueue: from ${currentIndex} to ${limit-1}`);
    
    for (let i = currentIndex; i < limit; i++) {
        if (audioCache[i] === undefined) {
            // CHANGED: Hand it off directly to the enqueuer without 
            // prematurely marking it as 'fetching' or incrementing inFlight.
            enqueueTts(i);
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

/* ─── TTS fetch via WebSocket ─── */
const _ttsChunks = {};
function _ensureTtsSocket() {
    if (WS._sockets['tts'] && WS._sockets['tts'].readyState === WebSocket.OPEN) {
        console.log('[TTS] Socket already open');
        return;
    }
    console.log('[TTS] Opening WebSocket...');
    WS.openBinary('tts', '/ws/tts',
        (ab) => {
            const pending = _ttsPendingIdx;
            if (pending === null) return;
            if (!_ttsChunks[pending]) _ttsChunks[pending] = [];
            _ttsChunks[pending].push(ab);
        },
        (msg) => {
            const idx = _ttsPendingIdx;
            _ttsPendingIdx = null;
            if (msg.type === 'done') {
                if (idx !== null) {
                    const parts = _ttsChunks[idx] || [];
                    delete _ttsChunks[idx];
                    const total = parts.reduce((s, b) => s + b.byteLength, 0);
                    const merged = new Uint8Array(total);
                    let offset = 0;
                    parts.forEach(b => { merged.set(new Uint8Array(b), offset); offset += b.byteLength; });
                    const blob = new Blob([merged], { type: 'audio/wav' });
                    if (audioCache[idx] === 'fetching') audioCache[idx] = URL.createObjectURL(blob);
                    _onTtsDone(idx);
                }
            } else if (msg.type === 'error') {
                if (idx !== null && audioCache[idx] === 'fetching') audioCache[idx] = null;
                _onTtsDone(idx);
            }
        }
    );
}
async function fetchSentenceAudio(idx) {
    try {
        const raw = sentences[idx];
        const text = normalizeTTSText(/^\d{1,2}$/.test(raw.trim()) ? `Page ${raw.trim()}.` : raw);
        const voice = voiceSelector.value || 'af_sarah';
        const originalLine = idx + (parseInt(topSkipLines, 10) || 0);
        console.log(`[TTS] fetchSentenceAudio idx=${idx}, voice=${voice}, text="${text.slice(0, 30)}..."`);

        _ensureTtsSocket();
        const ws = WS._sockets['tts'];
        const sendRequest = () => {
            const payload = {
                text,
                voice,
                speed: 1.0,
                book_name: currentFileName || '',
                page: pageNum,
                line: originalLine,
                save: saveAudioEnabled || false,
                force_regenerate: false,
            };
            console.log(`[TTS] Sending request:`, payload);
            WS.send('tts', payload);
        };

        if (ws && ws.readyState === WebSocket.OPEN) {
            sendRequest();
        } else if (ws) {
            console.log('[TTS] Socket not open yet, waiting for open event');
            ws.addEventListener('open', sendRequest, { once: true });
        } else {
            throw new Error('WS not available');
        }
    } catch (e) {
        console.error(`[TTS] WS fetch FAILED for sentence ${idx}:`, e);
        if (audioCache[idx] === 'fetching') audioCache[idx] = null;
        _onTtsDone(idx);
    }
}

function playNextChunk() {
    if (!isPlaying) return;
    if (currentIndex >= sentences.length) {
        const total = getPageCount();
        if (document.getElementById('auto-read-next').checked && pageNum < total) {
            audioPlayer.pause();
            playBtn.textContent = '▶ Play Page';
            ttsStatus.classList.remove('active');
            isAutoContinuing = true;
            goToPage(1, true);
        } else { stopPipeline(); }
        return;
    }
    const url = audioCache[currentIndex];
    console.log(`[TTS] playNextChunk: currentIndex=${currentIndex}, url=${url ? (typeof url === 'string' ? url.slice(0, 50) : url) : 'undefined'}`);
    
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

        // CHANGED: Added onerror handler to recover from corrupted audio blobs
        audioPlayer.onerror = () => {
            console.warn(`[TTS] Media playback error for chunk ${currentIndex}. Skipping to next.`);
            currentIndex++;
            preloadQueue();
            playNextChunk();
        };

        audioPlayer.onended = () => {
            const dur = sentenceDurations[currentIndex] || estimateSentenceDuration(sentences[currentIndex]);
            const adjusted = dur / playbackSpeed;
            pageRemaining = Math.max(0, pageRemaining - adjusted);
            chapterRemaining = Math.max(0, chapterRemaining - adjusted);
            updateTimeDisplay();
            currentIndex++;
            saveSettingsThrottled(pageNum, scale, currentIndex);
            preloadQueue();
            playNextChunk();
        };
    } else if (url === null) {
        // If Kokoro returned an error for this sentence, it was marked null. Skip it.
        currentIndex++;
        playNextChunk();
    }
}

function getPlaybackRate() {
    return parseFloat(document.getElementById('speed-slider').value);
}
document.getElementById('speed-slider').addEventListener('input', async () => {
    const rate = getPlaybackRate();
    playbackSpeed = rate;
    speedVal.textContent = rate.toFixed(1) + '×';
    if (isPlaying && !audioPlayer.paused) {
        audioPlayer.playbackRate = rate;
        await refreshTimeEstimates();
    } else {
        await refreshTimeEstimates();
    }
    saveSettingsThrottled(pageNum, scale, currentIndex);
});

function stopPipeline() {
    isPlaying = false;
    audioPlayer.pause();
    playBtn.textContent = '▶ Play Page';
    ttsStatus.classList.remove('active');
    syncMobilePlayBtn();
    clearHighlightCanvas();
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.clearHighlights();
    } else {
        document.querySelectorAll('.textLayer span').forEach(span => {
            if (span.dataset.originalText !== undefined) {
                span.textContent = span.dataset.originalText;
            }
        });
    }
    saveSettingsThrottled(pageNum, scale, currentIndex);
    refreshTimeEstimates();
}

function clearPageAudioCache() {
    if (audioCache) {
        Object.values(audioCache).forEach(v => { 
            if (v && typeof v === 'string' && v.startsWith('blob:')) URL.revokeObjectURL(v); 
        });
    }
    // CHANGED: Forcefully close the socket on page turn to drop in-flight audio from the previous page
    WS.close('tts');
    
    audioCache = {};
    inFlight = 0;
    sentenceDurations = {};
    _ttsQueue = [];
    _ttsBusy = false;
    _ttsPendingIdx = null;
}

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
    if (!currentPageText.trim()) return;
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) return;
    let si = currentIndex >= sentences.length ? 0 : currentIndex;
    startReadingPage(si);
});

/* ─── Cache badge (WebSocket‑only with fallback) ─── */
let cacheStatusTimeout = null;

function openCacheSocket(bookName) {
    WS.close('cache');
    if (!bookName) return;
    console.log('[Cache] Opening cache socket for', bookName);
    const ws = WS.open('cache', `/ws/cache/${encodeURIComponent(bookName)}`, msg => {
        if (!msg) return;
        if (msg.type === 'cache_update') {
            console.log('[Cache] Received cache_update for page', msg.page, 'cached_lines', msg.cached_lines);
            if (msg.page === pageNum) {
                const lines = msg.cached_lines || [];
                if (lines.length > 0) {
                    cacheBadge.textContent = `${lines.length} cached`;
                    cacheBadge.classList.add('visible');
                } else {
                    cacheBadge.classList.remove('visible');
                }
                delete pageDurationCache[msg.page];
                if (cacheStatusTimeout) {
                    clearTimeout(cacheStatusTimeout);
                    cacheStatusTimeout = null;
                }
            }
        }
        if (msg.type === 'cache_cleared') {
            if (msg.page === pageNum) {
                cacheBadge.classList.remove('visible');
                delete pageDurationCache[msg.page];
            }
        }
    }, () => {
        console.log('[Cache] Socket opened for', bookName);
        if (pdfDoc && currentFileName) {
            requestCacheStatus();
        }
    });
}

function requestCacheStatus() {
    const ws = WS._sockets['cache'];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[Cache] Cannot request status – socket not open');
        return;
    }
    console.log('[Cache] Requesting cache status for page', pageNum);
    WS.send('cache', { type: 'get_status', page: pageNum });
    if (cacheStatusTimeout) clearTimeout(cacheStatusTimeout);
    cacheStatusTimeout = setTimeout(async () => {
        cacheStatusTimeout = null;
        console.log('[Cache] WebSocket status request timed out, falling back to HTTP');
        try {
            const res = await fetch(`/cache_status?book_name=${encodeURIComponent(currentFileName)}&page=${pageNum}`);
            if (!res.ok) throw new Error('HTTP error');
            const data = await res.json();
            const lines = data.cached_lines || [];
            if (lines.length > 0) {
                cacheBadge.textContent = `${lines.length} cached`;
                cacheBadge.classList.add('visible');
            } else {
                cacheBadge.classList.remove('visible');
            }
        } catch (e) {
            console.warn('[Cache] HTTP fallback failed:', e);
        }
    }, 2000);
}

function updateCacheBadge() {
    if (!currentFileName || !pdfDoc) {
        cacheBadge.classList.remove('visible');
        return;
    }
    console.log('[Cache] updateCacheBadge called for page', pageNum);
    const ws = WS._sockets['cache'];
    if (ws && ws.readyState === WebSocket.OPEN) {
        requestCacheStatus();
    } else {
        console.log('[Cache] Socket not open, re‑opening');
        openCacheSocket(currentFileName);
    }
}

/* ─── Global Preferences (Save Toggle, Voice, Auto-Read) ─── */
const PREFS_KEY = 'docreader-global-prefs';

function loadGlobalPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        
        if (prefs.voice && document.getElementById('voice-selector')) {
            document.getElementById('voice-selector').value = prefs.voice;
        }
        if (prefs.autoReadNext !== undefined && document.getElementById('auto-read-next')) {
            document.getElementById('auto-read-next').checked = prefs.autoReadNext;
        }
        if (prefs.saveAudio !== undefined && saveAudioToggle) {
            saveAudioToggle.checked = prefs.saveAudio;
            saveAudioEnabled = prefs.saveAudio;
            saveRangeRow.style.display = saveAudioEnabled ? 'flex' : 'none';
        }
    } catch(e) {
        console.warn('Failed to load global prefs', e);
    }
}

function saveGlobalPrefs() {
    const prefs = {
        voice: document.getElementById('voice-selector')?.value || 'af_sarah',
        autoReadNext: document.getElementById('auto-read-next')?.checked || false,
        saveAudio: saveAudioToggle?.checked || false
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

// Attach listeners to trigger saving when the UI is clicked
document.getElementById('voice-selector')?.addEventListener('change', saveGlobalPrefs);
document.getElementById('auto-read-next')?.addEventListener('change', saveGlobalPrefs);

if (saveAudioToggle) {
    saveAudioToggle.addEventListener('change', e => {
        saveAudioEnabled = e.target.checked;
        saveRangeRow.style.display = saveAudioEnabled ? 'flex' : 'none';
        saveGlobalPrefs();
    });
}

// Initialize preferences immediately
loadGlobalPrefs();

/* ─── Batch download ─── */
downloadRangeBtn.addEventListener('click', async () => {
    const isPdf = !!pdfDoc;
    const isEpub = documentHandler instanceof EPUBHandler;
    if (!currentFileName || isDownloadingRange || (!isPdf && !isEpub)) return;
    
    const rangeStr = pageRangeInput.value.trim();
    if (!rangeStr) { pageRangeInput.focus(); return; }
    const match = rangeStr.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (!match) {
        pageRangeInput.style.borderColor = 'var(--danger)';
        setTimeout(() => pageRangeInput.style.borderColor = '', 1500);
        return;
    }
    
    const totalDocs = isPdf ? pdfDoc.numPages : documentHandler.pageCount;
    const fromPage = Math.max(1, parseInt(match[1], 10));
    const toPage = Math.min(totalDocs, parseInt(match[2], 10));
    if (fromPage > toPage) return;
    
    const voice = document.getElementById('voice-selector').value;
    const totalPages = toPage - fromPage + 1;
    isDownloadingRange = true;
    downloadRangeBtn.disabled = true;
    dlProgress.classList.add('active');
    dlStatusText.textContent = 'Scanning...';
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
    } catch (e) {}
    
    let allSentences = {};
    let extractedPages = 0;
    
    for (let p = fromPage; p <= toPage; p++) {
        dlStatusText.textContent = `Extracting ${isEpub ? 'chapter' : 'page'} ${p} / ${toPage}…`;
        dlProgressFill.style.width = Math.round((extractedPages / totalPages) * 40) + '%';
        
        try {
            let pageSentences = [];
            if (isPdf) {
                const page = await pdfDoc.getPage(p);
                const textContent = await page.getTextContent();
                pageSentences = extractSentencesFromTextContent(textContent, page, topSkipLines, bottomSkipLines);
            } else {
                // Parse EPUB chapters directly
                const content = await documentHandler.book.load(documentHandler.spineItems[p - 1].href);
                const parser = new DOMParser();
                const doc = parser.parseFromString(content, 'application/xhtml+xml');
                doc.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,blockquote,pre,br').forEach(el => {
                    el.appendChild(doc.createTextNode('\n'));
                });
                const text = doc.body ? doc.body.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim() : '';
                pageSentences = splitIntoTTSChunks(text, 250);
            }
            
            const alreadyCached = new Set((cachedByPage[String(p)] || []));
            for (let si = 0; si < pageSentences.length; si++) {
                if (alreadyCached.has(si)) continue;
                const raw = pageSentences[si];
                const text = normalizeTTSText(
                    /^\d{1,2}$/.test(raw.trim()) ? `Page ${raw.trim()}.` : raw
                );
                allSentences[`${p}_${si}`] = text;
            }
        } catch (e) { console.warn(`[DL] Extract failed:`, e); }
        extractedPages++;
    }
    
    const newSentenceCount = Object.keys(allSentences).length;
    if (newSentenceCount === 0) {
        dlProgressFill.style.width = '100%';
        dlStatusText.textContent = `All cached ✓`;
        setTimeout(() => {
            dlProgress.classList.remove('active');
            dlProgressFill.style.width = '0%';
            isDownloadingRange = false;
            downloadRangeBtn.disabled = false;
            updateCacheBadge();
        }, 2000);
        return;
    }
    
    dlStatusText.textContent = `Queuing ${newSentenceCount} chunks…`;
    dlProgressFill.style.width = '45%';
    
    try {
        const res = await fetch('/preload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                book_name: currentFileName,
                page_from: fromPage,
                page_to: toPage,
                sentences: allSentences,
                voice,
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const jobId = data.job_id;
        
        if (jobId) {
            dlProgressFill.style.width = '70%';
            WS.open(`preload:${jobId}`, `/ws/preload/${jobId}`, msg => {
                if (!msg) return;
                const done = msg.done || 0;
                const total = msg.total || newSentenceCount;
                const pct = Math.min(99, Math.round(70 + (done / Math.max(1, total)) * 29));
                dlProgressFill.style.width = pct + '%';
                dlStatusText.textContent = `Server generating… ${done} / ${total}`;
                if (msg.status === 'done') {
                    WS.close(`preload:${jobId}`);
                    finishDownload(totalPages);
                }
            });
            setTimeout(() => { WS.close(`preload:${jobId}`); finishDownload(totalPages); }, 600000);
        } else {
            finishDownload(totalPages);
        }
    } catch (e) {
        dlStatusText.textContent = `Error: ${e.message}`;
        setTimeout(() => {
            dlProgress.classList.remove('active');
            isDownloadingRange = false;
            downloadRangeBtn.disabled = false;
        }, 3000);
    }
});
function finishDownload(pageCount) {
    dlProgressFill.style.width = '100%';
    dlStatusText.textContent = `Done! ${pageCount} page(s) queued for caching ✓`;
    setTimeout(() => {
        dlProgress.classList.remove('active');
        dlProgressFill.style.width = '0%';
        isDownloadingRange = false;
        downloadRangeBtn.disabled = false;
        updateCacheBadge();
        Object.keys(pageDurationCache).forEach(k => delete pageDurationCache[k]);
        Object.keys(chapterDurationCache).forEach(k => delete chapterDurationCache[k]);
        refreshTimeEstimates();
    }, 2500);
}

/* ─── Shared text extraction ─── */
function extractSentencesFromTextContent(textContent, page, skipTop = 0, skipBottom = 0) {
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
    const skipTopClamped = Math.min(skipTop, lines.length);
    const skipBottomClamped = Math.min(skipBottom, lines.length);
    const effectiveLines = lines.slice(skipTopClamped, lines.length - skipBottomClamped);
    let structuredText = '';
    const unscaledH = viewport.viewBox ? viewport.viewBox[3] : 800;
    let prevY = null;
    let inListItem = false;
    effectiveLines.forEach(line => {
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

/* ─── Highlighting ─── */
function clearHighlightCanvas() {
    const hlCanvas = document.getElementById('highlight-canvas');
    if (!hlCanvas) return;
    const ctx = hlCanvas.getContext('2d');
    ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
}
function highlightActiveSentence(sentenceIndex, allSentences) {
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.highlightSentence(sentenceIndex);
        return;
    }
    clearHighlightCanvas();
    const allSpans = Array.from(document.querySelectorAll('.textLayer span'));
    allSpans.forEach(span => {
        if (span.dataset.originalText === undefined) {
            span.dataset.originalText = span.textContent;
        }
        span.textContent = span.dataset.originalText;
    });
    if (sentenceIndex < 0 || sentenceIndex >= allSentences.length) return;
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
    if (matchIndex === -1) return;
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
        // Calculate the absolute center of the highlighted element
        const elementCenter = hr.top - vr.top + (hr.height / 2);
        const viewportCenter = vr.height / 2;
        
        // Scroll only if the highlight strays outside a 25% boundary from the center
        if (elementCenter < vr.height * 0.25 || elementCenter > vr.height * 0.75) {
            viewerArea.scrollTo({ 
                top: viewerArea.scrollTop + elementCenter - viewportCenter, 
                behavior: 'smooth' 
            });
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
    if (!match) { deleteStatus.textContent = 'Invalid range format. Use e.g. 5-10'; return; }
    const fromPage = Math.max(1, parseInt(match[1], 10));
    const toPage = Math.min(pdfDoc.numPages, parseInt(match[2], 10));
    if (fromPage > toPage) { deleteStatus.textContent = 'Invalid range: from > to'; return; }
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
        Object.keys(pageDurationCache).forEach(k => delete pageDurationCache[k]);
        Object.keys(chapterDurationCache).forEach(k => delete chapterDurationCache[k]);
        refreshTimeEstimates();
    } catch (e) {
        deleteStatus.textContent = `Error: ${e.message}`;
    } finally {
        deleteRangeBtn.disabled = false;
        deleteRangeInput.value = '';
    }
});

/* ─── Upload Document to Server ─── */
const serverUploadInput = document.getElementById('server-upload');
const uploadStatus = document.getElementById('upload-status');
serverUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!isAcceptedFile(file)) {
        uploadStatus.textContent = 'Please select a PDF or EPUB file.';
        return;
    }
    uploadStatus.textContent = 'Uploading…';
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch('/upload', {
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
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
}

const skipTopInput = document.getElementById('skip-top-lines');
const skipBottomInput = document.getElementById('skip-bottom-lines');
function onSkipChange() {
    topSkipLines = parseInt(skipTopInput.value, 10) || 0;
    bottomSkipLines = parseInt(skipBottomInput.value, 10) || 0;
    saveSettingsThrottled(pageNum, scale, currentIndex);
    if (!pdfDoc) return;
    stopPipeline();
    clearPageAudioCache();
    currentIndex = 0;
    sentences = [];
    currentPageText = '';
    delete searchAllPageTexts[pageNum];
    queueRenderPage(pageNum);
}
skipTopInput.addEventListener('input', onSkipChange);
skipBottomInput.addEventListener('input', onSkipChange);
skipTopInput.addEventListener('change', onSkipChange);
skipBottomInput.addEventListener('change', onSkipChange);

/* ─── Time display ─── */
function updateTimeDisplay() {
    const fmt = formatDuration;
    pageTimeEl.textContent = `Page: ${fmt(pageRemaining)}`;
    chapterTimeEl.textContent = `Chapter: ${fmt(chapterRemaining)}`;
}

let refreshDebounce = null;
let refreshing = false;

async function refreshTimeEstimates() {
    if (refreshing) return;
    clearTimeout(refreshDebounce);
    return new Promise((resolve) => {
        refreshDebounce = setTimeout(async () => {
            refreshing = true;
            try {
                if (!pdfDoc) { resolve(); return; }
                updateChapterBoundaries();
                if (chapterStartPage === null || chapterEndPage === null) {
                    chapterRemaining = 0;
                    let pageDur = await fetchPageDuration(currentFileName, pageNum);
                    if (pageDur === null || pageDur <= 0) {
                        const stats = pageStats[pageNum];
                        if (stats) {
                            const words = stats.totalChars / 5;
                            pageDur = (words / (150 * playbackSpeed)) * 60;
                        } else { pageDur = 0; }
                    }
                    pageRemaining = pageDur;
                    updateTimeDisplay();
                    resolve();
                    return;
                }
                let pageDur = await fetchPageDuration(currentFileName, pageNum);
                if (pageDur === null || pageDur <= 0) {
                    const stats = pageStats[pageNum];
                    if (stats) {
                        const words = stats.totalChars / 5;
                        pageDur = (words / (150 * playbackSpeed)) * 60;
                    } else { pageDur = 0; }
                }
                pageRemaining = pageDur;
                if (chapterStartPage && chapterEndPage && chapterStartPage < chapterEndPage) {
                    const chapterDur = await fetchChapterDuration(currentFileName, chapterStartPage, chapterEndPage);
                    chapterRemaining = chapterDur || 0;
                } else {
                    chapterRemaining = 0;
                }
                updateTimeDisplay();
                resolve();
            } finally {
                refreshing = false;
            }
        }, 100);
    });
}

/* ─── startReadingPage ─── */
async function startReadingPage(startIndex = 0) {
    if (!currentPageText.trim() || !sentences.length) return;
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) return;
    if (isPlaying) stopPipeline();
    
    currentIndex = startIndex;
    isPlaying = true;
    hasStartedPlaying = false;
    playBtn.textContent = '⏹ Stop';
    ttsStatus.classList.add('active');
    syncMobilePlayBtn();
    
    await fetchSentenceDurationsForCurrentPage();
    
    // CHANGED: Abort if the user clicked "Stop" while we were awaiting the fetch above
    if (!isPlaying) return;

    pageRemaining = 0;
    for (let i = currentIndex; i < sentences.length; i++) {
        const d = sentenceDurations[i] || estimateSentenceDuration(sentences[i]);
        pageRemaining += d / playbackSpeed;
    }
    
    if (chapterEndPage && chapterEndPage > pageNum) {
        const remainingChapterDur = await fetchChapterDuration(currentFileName, pageNum + 1, chapterEndPage);
        chapterRemaining = pageRemaining + (remainingChapterDur || 0);
    } else {
        chapterRemaining = pageRemaining;
    }
    updateTimeDisplay();
    
    const required = Math.min(REQUIRED_START_BUFFER, sentences.length - currentIndex);
    let readyCount = 0;
    for (let i = currentIndex; i < currentIndex + required; i++) {
        // CHANGED: Buffer logic sync to allow null (failed) chunks to count toward the starting requirement
        if (audioCache[i] !== undefined && audioCache[i] !== 'fetching') readyCount++;
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
    if (!currentPageText.trim()) { alert('No text on this page.'); return; }
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) return;
    let si = currentIndex >= sentences.length ? 0 : currentIndex;
    startReadingPage(si);
});

let scrollTimeout;
const pdfViewerArea = document.getElementById('pdf-viewer-area');
if (pdfViewerArea) {
    pdfViewerArea.addEventListener('scroll', () => {
        if (!document.body.classList.contains('is-scrolling')) {
            document.body.classList.add('is-scrolling');
        }
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            document.body.classList.remove('is-scrolling');
        }, 150);
    }, { passive: true });
}

console.log('DocReader Pro ready – all served from port 8000.');
