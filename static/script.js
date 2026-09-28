/* ═══════════════════════════════════════════════════════════════════════════
 * script.js — single-file frontend for a web-based PDF/EPUB reader with
 * WebSocket-backed text-to-speech playback.
 *
 * Main subsystems (in rough file order):
 *   - Global reader state + DOM references (this section)
 *   - Theme system: CSS-variable themes applied to both the app shell and,
 *     via injected <style> tags, inside EPUB iframe documents.
 *   - PDF pipeline: pdf.js rendering, per-page sentence extraction, text-layer
 *     highlight overlays, hover highlighting.
 *   - EPUBHandler class: wraps an epub.js rendition ("scrolled-doc" flow) with
 *     serialized page renders, theme injection into iframes, manual full-text
 *     search over the spine, and reflow-safe scroll anchoring.
 *   - TTS playback pipeline: sentence queue -> WebSocket TTS server ->
 *     blob-URL audio cache -> sequential <audio> playback, with buffering,
 *     preload of upcoming sentences, and stale-response guards.
 *   - Search UI, TOC/outline sidebar, batch download ("save audio") flow,
 *     time estimates, keyboard shortcuts, resize handling.
 *
 * Debugging: set localStorage.setItem('dr-debug', '1') to enable verbose
 * console logging throughout the file (see _dlog).
 *
 * NOTE: this file is intentionally kept dependency-free apart from pdf.js
 * (global `pdfjsLib`) and epub.js (loaded lazily by loadEPUB).
 * ═══════════════════════════════════════════════════════════════════════ */

// Point pdf.js at its worker script; without this every render would run on
// the main thread and freeze the UI during page rasterization.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.min.js';

/* ─── State ───
 * Core mutable reader state. Everything here is global on purpose: this is a
 * small single-page app and most subsystems read/write these directly.
 * Lifecycle notes:
 *   - pdfDoc / documentHandler hold exactly one open document at a time;
 *     they are replaced (never mutated in place) by loadPDF / loadEPUB.
 *   - audioCache entries live until clearPageAudioCache revokes their blob URLs.
 * ─── */
let rest = 500;                  // ms pause inserted between sentences during playback
let topSkipLines = 0;            // text lines at top of page excluded from sentence extraction
let bottomSkipLines = 0;         // same, for the bottom of the page (skipped headers/footers)
let pdfDoc = null;               // pdf.js PDFDocumentProxy for the currently open PDF (null in EPUB mode)
let documentHandler = null;      // EPUBHandler instance when an EPUB is open, else null
let pageNum = 1;                 // current page (PDF) / spine index+1 style counter (EPUB)
let pageIsRendering = false;     // guard: a renderToCanvas pass is in flight; queue further page turns
let pageNumPending = null;       // page requested while a render was busy; replayed after render completes
let scale = 1.5;                 // current PDF zoom factor
let isPlaying = false;           // TTS playback loop active (drives Play/Pause button state)
let isAutoContinuing = false;    // set true only inside auto-advance chains so UI can distinguish user-initiated play
let sentences = [];              // text of the current page/chapter split into TTS-ordered sentences
let currentIndex = 0;            // index within `sentences` of the sentence being played (or next to play)
let audioCache = {};             // idx -> 'fetching' | blob URL | null (fetch failed); one entry per sentence
let inFlight = 0;                // number of TTS fetch requests currently outstanding
let hasStartedPlaying = false;    // becomes true on first play of this session; used to skip "resume" prompts
let currentPageText = '';        // raw extracted text of the current page, kept for PDF search
let sidebarOpen = true;          // sidebar visibility flag (desktop layout)
let pdfOutline = null;           // pdf.js outline tree for the TOC panel (null until fetched)
let searchMatches = [];          // {page, index} hits for the active query, ordered current-page-first
let searchCurrentMatch = -1;     // position in searchMatches currently highlighted (-1 = none)
let searchAllPageTexts = {};     // pageNum -> cached plain text, built lazily so PDF search can scan pages
let currentFile = null;          // File/Blob handle of the uploaded document (for name + re-reads)
let currentFileUrl = null;       // object URL for currentFile; revoked on switch/close (see resetUI)
let currentFileName = '';        // display name shown in the topbar / used as server cache key
let pageRemaining = 0;           // 1x seconds of audio left on the current page (speed applied at display)
let chapterRemaining = 0;        // 1x seconds of audio left in the current chapter/range (speed applied at display)
let pageExact = true;            // false when pageRemaining includes 150wpm guesses (shows ≈)
let chapterExact = true;         // false when chapterRemaining includes guesses (shows ≈)
let sentenceDurations = {};      // idx -> measured audio duration in seconds (filled as clips play)
let chapterStartPage = null;     // inclusive start of the current chapter's page span (PDF mode)
let chapterEndPage = null;       // inclusive end of the same span; bounds auto-advance & estimates
let serverDocNames = new Set();  // document names the server reports as cached (EPUB/other)
let serverPdfNames = serverDocNames; // legacy alias: historically only PDFs were listed; now shared set

// Duration-estimate caches. Keys are composite strings ("page:N" / "chapter:a-b");
// pending* maps dedupe in-flight estimate requests so we don't spam the server.
const chapterDurationCache = {};
const pendingChapterDurations = {};
const pendingPageDurations = {};

/* ─── Cache / Download state ─── */
let saveAudioEnabled = false;    // user opted to keep generated audio on the server ("save audio" toggle)
let isDownloadingRange = false;  // batch-download of an audio range is currently running (guards re-entry)

/* ─── WebSocket manager ───
 * Thin registry of named sockets. Keys used across the app:
 *   'session'      — control channel (document listing, cache mgmt)
 *   'cache'        — cache status updates
 *   'tts'          — TTS audio requests (JSON in / binary audio out)
 *   'preload:*'    — one-off sockets for prefetching sentences ahead of playback
 * Reopening a key always closes the previous socket first, so callers never
 * have to track stale connections themselves.
 * ─── */
const WS = {
    _sockets: {},                // key -> live WebSocket (entries removed on close)
    _base() {
        // Build an absolute ws(s):// URL so sockets survive being opened from file:// proxies etc.
        return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
    },
    /* Open a JSON-text socket under `key`. onmessage receives parsed JSON,
     * or null if the frame wasn't valid JSON. Any existing socket for the key
     * is closed first — this is what makes single-flight semantics easy. */
    open(key, path, onmessage, onopen) {
        this.close(key);
        const ws = new WebSocket(this._base() + path);
        ws.onmessage = e => {
            // A replaced socket's late frames must never reach the new
            // session (e.g. an old book's settings_sync landing on the new one).
            if (this._sockets[key] !== ws) return;
            try { onmessage(JSON.parse(e.data), e); } catch (_) { onmessage(null, e); }
        };
        ws.onopen = onopen || null;
        ws.onerror = () => { try { console.warn('[WS] socket error on', key); } catch (_) {} };
        // Identity check: close(key) deletes the entry synchronously, but the
        // OLD socket's onclose fires later — without this it would delete the
        // NEW socket stored under the same key, leaking it untracked.
        ws.onclose = () => { if (this._sockets[key] === ws) delete this._sockets[key]; };
        this._sockets[key] = ws;
        return ws;
    },
    /* Variant of open() for endpoints that answer with binary audio frames
     * interleaved with JSON control frames ("done"/"error"). */
    openBinary(key, path, onbinary, onjson) {
        this.close(key);
        const ws = new WebSocket(this._base() + path);
        ws.binaryType = 'arraybuffer';
        ws.onmessage = e => {
            // Drop frames from a superseded socket: after a session restart
            // the old connection's late audio must not merge into the new
            // session's clips.
            if (this._sockets[key] !== ws) return;
            if (e.data instanceof ArrayBuffer) { onbinary(e.data); }
            else { try { onjson(JSON.parse(e.data)); } catch (_) {} }
        };
        ws.onerror = () => { try { console.warn('[WS] socket error on', key); } catch (_) {} };
        ws.onclose = () => { if (this._sockets[key] === ws) delete this._sockets[key]; };
        this._sockets[key] = ws;
        return ws;
    },
    /* Send a JSON payload. Returns false when the socket isn't open yet so
     * callers can retry instead of stalling (TTS treats send as
     * request/response). */
    send(key, data) {
        const ws = this._sockets[key];
        if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(data)); return true; }
        return false;
    },
    close(key) {
        const ws = this._sockets[key];
        // close() can throw if the socket is in CLOSING state in some browsers; swallow it.
        if (ws) { try { ws.close(); } catch (_) {} delete this._sockets[key]; }
    },
    closeAll() {
        Object.keys(this._sockets).forEach(k => this.close(k));
    }
};

/* ─── Highlight customisation state ───
 * User-tunable appearance settings (persisted via IndexedDB settings store).
 * hl* values feed the generated CSS for sentence highlights in both PDF text
 * layer and EPUB iframes; epubSidePadding is the reading-margin slider value
 * owned exclusively by EPUBHandler._injectReadingStyle.
 * ─── */
let hlBaseColor = '59,130,246';  // highlight fill as "r,g,b" (no alpha) so opacity can vary independently
let epubSidePadding = 28;        // px padding injected around EPUB content (side-margin slider)
let hlOpacity = 0.32;            // alpha of the active-sentence highlight
let hlHoverOpacity = 0.18;       // alpha of the hover preview highlight
let hlRadius = 3;                // border-radius of highlight boxes (px)
let hlOutline = false;           // draw a visible outline around highlights?
let hlPadding = 1;               // extra px inflate around each highlight rect
let focusModeEnabled = false;    // dim non-active UI chrome while playing
let playbackSpeed = 1.0;         // audio.playbackRate applied to every clip
const pageStats = {};            // pageNum -> {sentences, words,...} per-page extraction stats cache
let topbarVisible = true;        // topbar show/hide toggle state
const activePreloadJobs = {};    // "page:idx" -> true while a preload socket is fetching that sentence

// TTS buffering policy:
//   REQUIRED_START_BUFFER — don't start audible playback until N clips are ready
//   BUFFER_DEPTH          — how many sentences ahead to keep prefetched/preloaded
//   MAX_CONCURRENT_FETCHES — server prefers serialized requests (1 at a time)
const BUFFER_DEPTH = 10;
const MAX_CONCURRENT_FETCHES = 1;
const REQUIRED_START_BUFFER = 5;

/* ─── DOM refs ─── */
/* ─── DOM refs ───
 * One-time lookups for every element the script touches. Kept as consts at
 * top level so handlers can reference them freely; a few (voiceSelector)
 * fall back to stubs when the element is absent from minimal layouts.
 * ─── */
const welcomeScreen = document.getElementById('welcome-screen');   // initial upload/library screen
const readerScreen = document.getElementById('reader-screen');     // main reader shell, hidden until a doc opens
const fileInput = document.getElementById('pdf-upload');           // hidden <input type=file>
const viewerArea = document.getElementById('pdf-viewer-area');     // scrollable canvas/text-layer container
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
const voiceSelector = document.getElementById('voice-selector') || { value: 'af_sarah' }; // stub when voice picker absent
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeSelector = document.getElementById('theme-selector');

/* ─── Loading overlay ───
 * Blocking full-screen overlay used while documents load. show/hide are just
 * class flips; the CSS handles fade transitions. */
function showLoading(msg = 'Loading…') {
    loadingText.textContent = msg;
    loadingOverlay.classList.add('visible');
}
function hideLoading() {
    loadingOverlay.classList.remove('visible');
}

/* ─── Theme Handling ───
 * Themes are pure CSS: body gets a `theme-<name>` class and the stylesheet
 * defines variable overrides per class. DARK_THEMES only drives which sun/
 * moon icon shows on the toggle button; the cycle order comes from the
 * #theme-selector <option> list when present.
 * ─── */
// Used by _updateThemeToggleUi to decide sun vs moon icon.
const DARK_THEMES = new Set([
    'default-dark', 'gruvbox-dark', 'nord', 'solarized-dark', 'monokai',
    'dracula', 'catppuccin', 'tokyo-night', 'everforest-dark', 'ayu-dark',
    'rosepine', 'midnight', 'one-dark', 'kanagawa', 'night-owl',
    'material-ocean', 'synthwave', 'github-dark'
]);
// Fallback cycle used when the #theme-selector element is missing — keep in
// sync with index.html's option order so the toggle button behaves the same.
const DEFAULT_THEME_CYCLE = [
    'default-light', 'default-dark', 'gruvbox-dark', 'gruvbox-light',
    'nord', 'nord-light', 'solarized-dark', 'solarized-light', 'monokai',
    'dracula', 'catppuccin', 'catppuccin-latte', 'tokyo-night',
    'tokyo-night-light', 'everforest-dark', 'everforest-light',
    'ayu-dark', 'ayu-light', 'rosepine', 'rosepine-dawn', 'one-dark',
    'kanagawa', 'night-owl', 'material-ocean', 'synthwave',
    'github-light', 'github-dark', 'paper', 'midnight'
];

/* Ordered list of themes to cycle through; prefers the DOM selector's
 * options so HTML stays the single source of truth. */
function _themeList() {
    if (themeSelector && themeSelector.options.length) {
        return Array.from(themeSelector.options).map(o => o.value);
    }
    return DEFAULT_THEME_CYCLE;
}

/* Sync the toggle button's icon (sun/moon) and tooltip with the active theme. */
function _updateThemeToggleUi(theme) {
    const isDark = DARK_THEMES.has(theme);
    const sun = document.getElementById('theme-icon-sun');
    const moon = document.getElementById('theme-icon-moon');
    if (sun) sun.style.display = isDark ? 'none' : '';
    if (moon) moon.style.display = isDark ? '' : 'none';
    if (themeToggleBtn) themeToggleBtn.title = `Theme: ${theme} (T to cycle)`;
}

/* Apply a named theme app-wide:
 *  - swaps body classes (single source of truth for CSS variables)
 *  - persists choice to localStorage
 *  - keeps selector + toggle UI in sync
 *  - forwards to EPUBHandler.setTheme so open iframes restyle too */
function applyTheme(theme) {
    // Strip every existing theme-* class first so unknown/renamed themes can't linger.
    document.body.className = document.body.className
        .split(' ')
        .filter(c => !c.startsWith('theme-'))
        .join(' ');
    // default-light is the stylesheet default, no class needed.
    if (theme && theme !== 'default-light') {
        document.body.classList.add('theme-' + theme);
    }
    localStorage.setItem('docreader-theme', theme || 'default-light');
    if (themeSelector) themeSelector.value = theme || 'default-light';
    _updateThemeToggleUi(theme || 'default-light');
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.setTheme(theme || 'default-light');
    }
}
// Toggle button cycles through all themes in selector order (wraps at end).
if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
        const themes = _themeList();
        const current = localStorage.getItem('docreader-theme') || 'default-light';
        const idx = themes.indexOf(current);
        const next = themes[(idx + 1 + themes.length) % themes.length] || themes[0];
        applyTheme(next);
    });
}
/* ─── Mobile topbar toggle ───
 * On short landscape phones the topbar eats too much vertical space, so it's
 * hidden and the sidebar is stretched full-screen. Re-evaluated on resize and
 * orientation change. */
function setTopbarVisible(visible) {
    topbarVisible = visible;
    document.body.classList.toggle('topbar-hidden', !visible);
}
// Heuristic: "landscape phone" = wider than tall with very little height.
function isLandscapePhone() {
    return window.innerHeight <= 500 && window.innerWidth > window.innerHeight;
}
// Switch layout between desktop/normal and landscape-phone modes. Both
// branches clear inline sidebar styles so CSS media queries stay in control.
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
// orientationchange fires before dimensions settle — small delay avoids acting on stale sizes.
if (window.screen.orientation) {
    window.screen.orientation.addEventListener('change', () => {
        setTimeout(applyLandscapeMode, 120);
    });
}

/* Lightweight debug logger — silent by default.
   Enable in console: localStorage.setItem('dr-debug','1') */
const _dlog = (...args) => {
    try { if (localStorage.getItem('dr-debug') === '1') console.log('%c[dbg]', 'color:#9333ea', ...args); } catch(e) {}
};

/*update padding*/
// EPUB side-margin slider: updates live label immediately but debounces the
// expensive reflow (which must re-inject reading styles into the iframe).
const epubPaddingSlider = document.getElementById('epub-padding-slider');
const epubPaddingVal = document.getElementById('epub-padding-val');

if (epubPaddingSlider) {
    let _epubPadTimer = null;
    epubPaddingSlider.addEventListener('input', e => {
        epubSidePadding = parseInt(e.target.value, 10);
        if (epubPaddingVal) epubPaddingVal.textContent = epubSidePadding + 'px';
        clearTimeout(_epubPadTimer);
        _epubPadTimer = setTimeout(() => {
            if (documentHandler instanceof EPUBHandler) {
                // Padding reflows the chapter — keep the reading position anchored
                documentHandler._reflowPreservingPosition(() => {
                    documentHandler._injectReadingStyle();
                });
            }
            // Persist per-book so it survives reloads
            saveSettingsThrottled(pageNum, scale, currentIndex);
        }, 150);
    });
}

/* ─── Server Document Library (WebSocket-driven) ───
 * The server pushes its /documents library over the 'library' socket:
 * 'init' on connect, then 'added'/'removed' as files change on disk.
 * The welcome screen renders the list; clicking an item downloads it and
 * opens it exactly like a local upload. */

/* Rebuild the server-documents list UI from a [{name,size,type?}] array and
 * refresh the serverDocNames set used for cache badges elsewhere. */
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
// Type detection: trust an explicit type field, else fall back to extension sniffing.
function _docType(doc) {
    if (doc.type) return doc.type;
    return doc.name.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf';
}
/* Append one entry to the library list (idempotent — skips duplicates by
 * data-pdf-name). Click handler fetches the file, wraps it in a File with
 * the right MIME type and routes it through loadDocument like any upload. */
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
        <button class="server-pdf-item-delete" title="Delete from server" aria-label="Delete ${escapeHtmlWelcome(doc.name)}">×</button>
    `;
    item.querySelector('.server-pdf-item-delete').addEventListener('click', async (e) => {
        // Don't open the book: this click is delete-only.
        e.stopPropagation();
        if (!confirm(`Delete "${doc.name}" from the server?\n\nThis also removes its cached audio. This cannot be undone.`)) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            const res = await fetch(`/documents/${encodeURIComponent(doc.name)}`, { method: 'DELETE' });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try { detail = (await res.json()).detail || detail; } catch (_) {}
                throw new Error(detail);
            }
            // The server also broadcasts 'removed' over the library socket;
            // removePdfFromList is idempotent so a double-apply is harmless.
            removePdfFromList(doc.name);
        } catch (err) {
            console.error(`[SERVER-DOC] Failed to delete ${doc.name}:`, err);
            alert(`Could not delete "${doc.name}":\n${err && err.message ? err.message : err}`);
            btn.disabled = false;
        }
    });
    item.addEventListener('click', async () => {
        // Dim + lock the row while downloading so double-clicks can't open twice.
        item.style.opacity = '0.5';
        item.style.pointerEvents = 'none';
        const url = `/documents/${encodeURIComponent(doc.name)}`;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            const blob = await res.blob();
            const mimeType = isEpub ? 'application/epub+zip' : 'application/pdf';
            const file = new File([blob], doc.name, { type: mimeType });
            await loadDocument(file, 1);
        } catch (err) {
            console.error(`[SERVER-DOC] Failed to load ${doc.name} (url=${url}):`, err);
            alert(`Could not load "${doc.name}" from server.\nURL: ${url}\nError: ${err && err.message ? err.message : err}`);
        } finally {
            // Always unlock: success leaves via loadDocument, failure stays usable.
            item.style.opacity = '';
            item.style.pointerEvents = '';
        }
    });
    listEl.appendChild(item);
}
/* Remove one library entry from UI and the name set (after server 'removed'). */
function removePdfFromList(name) {
    const el = document.querySelector(`[data-pdf-name="${CSS.escape(name)}"]`);
    if (el) el.remove();
    serverDocNames.delete(name);
}
/* Subscribe to the library feed; reconnects are handled by re-invoking this
 * (the WS manager closes any previous socket under the same key). */
function openLibrarySocket() {
    WS.open('library', '/ws/library', msg => {
        if (!msg) return;
        if (msg.type === 'init') renderPdfList(msg.documents || msg.pdfs);
        if (msg.type === 'added') {
            // Accept both new ("document") and legacy ("pdf") payload shapes.
            const doc = msg.document || msg.pdf;
            if (doc) { addPdfToList(doc); document.getElementById('server-pdf-section').style.display = 'block'; serverDocNames.add(doc.name); }
        }
        if (msg.type === 'removed') { const doc = msg.document || msg.pdf; if (doc) removePdfFromList(doc.name); }
    });
}
// Minimal HTML escaping for names interpolated into innerHTML above.
function escapeHtmlWelcome(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function loadServerPDFs() { openLibrarySocket(); }
openLibrarySocket();

/* ─── Highlight Customisation ───
 * Maps preset swatch keys (CSS color strings in data-color) to the "r,g,b"
 * triple stored in hlBaseColor, letting opacity be applied independently. */
const HL_PRESETS = {
    'rgba(59,130,246,0.32)': '59,130,246',
    'rgba(234,179,8,0.38)': '234,179,8',
    'rgba(16,185,129,0.35)': '16,185,129',
    'rgba(239,68,68,0.32)': '239,68,68',
    'rgba(168,85,247,0.32)': '168,85,247',
    'rgba(251,146,60,0.35)': '251,146,60',
    /* ── Extended palette ── */
    'rgba(236,72,153,0.32)': '236,72,153',     // Pink
    'rgba(255,105,180,0.35)': '255,105,180',   // Hot Pink
    'rgba(244,63,94,0.32)': '244,63,94',       // Rose
    'rgba(217,70,239,0.30)': '217,70,239',     // Fuchsia
    'rgba(139,92,246,0.32)': '139,92,246',     // Violet
    'rgba(167,139,250,0.38)': '167,139,250',   // Lavender
    'rgba(99,102,241,0.30)': '99,102,241',     // Indigo
    'rgba(37,99,235,0.30)': '37,99,235',       // Royal Blue
    'rgba(14,165,233,0.32)': '14,165,233',     // Sky
    'rgba(6,182,212,0.32)': '6,182,212',       // Cyan
    'rgba(20,184,166,0.33)': '20,184,166',     // Teal
    'rgba(64,224,208,0.35)': '64,224,208',     // Turquoise
    'rgba(52,211,153,0.38)': '52,211,153',     // Mint
    'rgba(132,204,22,0.35)': '132,204,22',     // Lime
    'rgba(134,148,42,0.35)': '134,148,42',     // Olive
    'rgba(161,98,7,0.32)': '161,98,7',         // Brown
    'rgba(159,18,57,0.32)': '159,18,57',       // Maroon
    'rgba(251,113,133,0.35)': '251,113,133',   // Salmon
    'rgba(255,127,80,0.35)': '255,127,80',     // Coral
    'rgba(100,116,139,0.30)': '100,116,139',   // Steel Gray
    'rgba(255,255,255,0.45)': '255,255,255',   // White
};

let highlightUpdateFrame = null; // rAF handle used to coalesce highlight redraws within one frame
/* Push current hl* settings into CSS custom properties (app shell) and into
 * any open EPUB iframe. The active-sentence overlay is re-rendered on the
 * next animation frame so slider drags don't trigger layout thrash. */
function applyHighlightSettings() {
    const color = `rgba(${hlBaseColor},${hlOpacity})`;
    document.documentElement.style.setProperty('--hl-color', color);
    document.documentElement.style.setProperty('--hl-radius', hlRadius + 'px');
    document.documentElement.style.setProperty('--hl-padding', hlPadding + 'px');
    // Outline uses a boosted alpha so a faint fill still gets a visible border.
    const outlineVal = hlOutline ? `0 0 0 1px rgba(${hlBaseColor},${Math.min(1, hlOpacity * 2.5)})` : 'none';
    document.documentElement.style.setProperty('--hl-outline', outlineVal);

    if (highlightUpdateFrame) cancelAnimationFrame(highlightUpdateFrame);
    highlightUpdateFrame = requestAnimationFrame(() => {
        // Coalesced: iframe injection + active redraw ride one frame per
        // slider tick instead of running synchronously on every input event.
        if (documentHandler instanceof EPUBHandler) {
            documentHandler._injectHighlightStyle && documentHandler._injectHighlightStyle();
        }
        // Re-apply the active highlight so live color/opacity changes are visible instantly.
        if (sentences && sentences.length && currentIndex >= 0) {
            highlightActiveSentence(currentIndex, sentences);
        }
    });
}

// Preset swatch clicks in the controls panel.
document.querySelectorAll('.hl-preset').forEach(btn => {
    btn.addEventListener('click', () => {
        const colorKey = btn.dataset.color;
        hlBaseColor = HL_PRESETS[colorKey] || '59,130,246';
        document.querySelectorAll('.hl-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyHighlightSettings();
        // Persist to BOTH stores: IDB is the global default, the server copy
        // is per-book — without it the next book open would overwrite these
        // values with stale ones.
        saveHighlightSettings();
        saveSettingsThrottled(pageNum, scale, currentIndex);
    });
});
/* Keyboard support (C): cycle through the highlight palette in order.
   Keeps the swatch UI, canvas/EPUB rendering and both persistence stores
   in sync exactly like clicking a swatch does. */
function cycleHighlightColor() {
    const keys = Object.keys(HL_PRESETS);
    if (!keys.length) return;
    const curIdx = keys.findIndex(k => HL_PRESETS[k] === hlBaseColor);
    const nextKey = keys[(curIdx + 1) % keys.length]; // -1 (custom color) wraps to first
    hlBaseColor = HL_PRESETS[nextKey];
    document.querySelectorAll('.hl-preset').forEach(b =>
        b.classList.toggle('active', b.dataset.color === nextKey));
    applyHighlightSettings();
    saveHighlightSettings();
    saveSettingsThrottled(pageNum, scale, currentIndex);
}
document.getElementById('hl-opacity-slider')?.addEventListener('input', e => {
    hlOpacity = parseInt(e.target.value, 10) / 100;
    document.getElementById('hl-opacity-val').textContent = e.target.value + '%';
    applyHighlightSettings();
    // Persist to IDB (global) and server (per-book) so a later book open
    // can't clobber these with stale values.
    saveHighlightSettings();
    saveSettingsThrottled(pageNum, scale, currentIndex);
});
document.getElementById('hl-radius-slider')?.addEventListener('input', e => {
    hlRadius = parseInt(e.target.value, 10);
    document.getElementById('hl-radius-val').textContent = e.target.value + 'px';
    applyHighlightSettings();
    // Persist to IDB (global) and server (per-book) so a later book open
    // can't clobber these with stale values.
    saveHighlightSettings();
    saveSettingsThrottled(pageNum, scale, currentIndex);
});
document.getElementById('hl-padding-slider')?.addEventListener('input', e => {
    hlPadding = parseInt(e.target.value, 10);
    document.getElementById('hl-padding-val').textContent = e.target.value + 'px';
    applyHighlightSettings();
    // Persist to IDB (global) and server (per-book) so a later book open
    // can't clobber these with stale values.
    saveHighlightSettings();
    saveSettingsThrottled(pageNum, scale, currentIndex);
});

document.getElementById('hl-hover-opacity-slider')?.addEventListener('input', e => {
    hlHoverOpacity = parseInt(e.target.value, 10) / 100;
    document.getElementById('hl-hover-opacity-val').textContent = e.target.value + '%';
    applyHighlightSettings();
    // Persist to IDB (global) and server (per-book) so a later book open
    // can't clobber these with stale values.
    saveHighlightSettings();
    saveSettingsThrottled(pageNum, scale, currentIndex);
});
document.getElementById('hl-outline-toggle')?.addEventListener('change', e => {
    hlOutline = e.target.checked;
    applyHighlightSettings();
    // Persist to IDB (global) and server (per-book) so a later book open
    // can't clobber these with stale values.
    saveHighlightSettings();
    saveSettingsThrottled(pageNum, scale, currentIndex);
});

/* ─── Focus Mode ───
 * Dims everything except the sentence being read. Persisted independently in
 * localStorage so it survives reloads; applied per-renderer (EPUBHandler has
 * its own dimming overlay, PDF relies on highlightActiveSentence). */
const focusModeBtn = document.getElementById('focus-mode-btn');
const focusModeToggle = document.getElementById('focus-mode-toggle');
/* Enable/disable focus mode; updates both button and checkbox UI, persists,
 * forwards to EPUBHandler, and redraws the active highlight immediately so
 * the change is visible without waiting for the next sentence. */
function setFocusMode(enabled) {
    focusModeEnabled = !!enabled;
    if (focusModeBtn) focusModeBtn.classList.toggle('active', focusModeEnabled);
    if (focusModeToggle) focusModeToggle.checked = focusModeEnabled;
    localStorage.setItem('docreader-focus-mode', focusModeEnabled ? '1' : '0');
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.setFocusMode(focusModeEnabled);
    }
    // PDF focus mode will be handled inside highlightActiveSentence
    // Re-draw highlight if currently playing or active
    if (sentences && sentences.length && currentIndex >= 0) {
        highlightActiveSentence(currentIndex, sentences);
    }
}
if (focusModeBtn) focusModeBtn.addEventListener('click', () => setFocusMode(!focusModeEnabled));
if (focusModeToggle) focusModeToggle.addEventListener('change', e => setFocusMode(e.target.checked));
// Restore persisted focus mode at startup (before any document loads).
focusModeEnabled = localStorage.getItem('docreader-focus-mode') === '1';
if (focusModeBtn) focusModeBtn.classList.toggle('active', focusModeEnabled);
if (focusModeToggle) focusModeToggle.checked = focusModeEnabled;

/* ─── Sidebar Tabs ─── */
// Two mutually exclusive panels (TOC vs playback controls) inside the sidebar.
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

/* ─── Sidebar Toggle ───
 * Desktop: collapse/expand inline sidebar, then resize the EPUB renderer to
 * the new container size (delayed so the CSS transition finishes first).
 * Mobile: slide-over with dimmed backdrop instead. */
// The mobile layout uses position:fixed on the sidebar — that's the tell.
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
        // Wait 250ms for the width transition to finish before telling epub.js
        // its viewport changed, otherwise it measures mid-animation.
        setTimeout(() => {
            _dlog('toggleSidebar resize timeout fired');
            if (documentHandler instanceof EPUBHandler && documentHandler.rendition) {
                const epubContainer = document.getElementById('epub-container');
                if (epubContainer) {
                    const w = epubContainer.clientWidth;
                    const h = epubContainer.clientHeight;
                    try {
                        // _lastResizedKey dedupe: ResizeObserver may already have
                        // handled this exact size; skip to avoid a needless reflow.
                        const key = Math.round(w) + 'x' + Math.round(h);
                        if (documentHandler._lastResizedKey === key) {
                            _dlog('skipping duplicate resize from toggleSidebar', key);
                            return;
                        }
                        documentHandler._lastResizedKey = key;
                        documentHandler.resizePreservingScroll(w, h);
                    } catch(e) {}
                }
            }
        }, 250);
    }
}

/* Slide-over variants for mobile: 'open' class + backdrop; overlay click
 * dismisses (wired up below). */
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

// Toggle buttons (desktop, mobile topbar, floating action button) + backdrop.
// All route through toggleSidebar() so mobile/desktop can't disagree.
sidebarToggleBtn.addEventListener('click', toggleSidebar);
mobileToggleBtn.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', closeMobileSidebar);
sidebarToggleBtn.classList.add('active');

const fabSidebarToggle = document.getElementById('fab-sidebar-toggle');
if (fabSidebarToggle) {
    fabSidebarToggle.addEventListener('click', toggleSidebar);
}

/* ─── Mobile Page Info ─── */
/* Total "pages" of the current document (PDF pages or EPUB spine items). */
function getPageCount() {
    if (pdfDoc) return pdfDoc.numPages;
    if (documentHandler instanceof EPUBHandler) return documentHandler.pageCount;
    return 0;
}
/* Sync the mobile page indicator (e.g. "3 / 120"). */
function updateMobilePageInfo() {
    const total = getPageCount();
    mobilePageInfo.textContent = total ? `${pageNum} / ${total}` : '0 / 0';
    updateCacheBadge();
}

/* ─── Page Jump ─── */
// Jump-to-page box: button click or Enter key.
pageJumpBtn.addEventListener('click', jumpToPage);
pageJumpInput.addEventListener('keydown', e => { if (e.key === 'Enter') jumpToPage(); });
/* Parse the input, validate against page count, and navigate via whichever
 * renderer is active. */
function jumpToPage() {
    const total = getPageCount();
    if (!total) return;
    const n = parseInt(pageJumpInput.value, 10);
    if (!n || n < 1 || n > total) {
        // Transient hint instead of silent failure.
        pageJumpInput.style.borderColor = 'var(--danger)';
        setTimeout(() => { pageJumpInput.style.borderColor = ''; }, 1500);
        return;
    }
    if (documentHandler instanceof EPUBHandler) {
        epubGoToPage(n);
    } else {
        goToAbsolutePage(n);
    }
    pageJumpInput.value = '';
}

/* ─── IndexedDB (highlight settings) ───
 * Small local store ('settings' key/value) used only for highlight
 * appearance prefs; document position/theme sync goes through the server
 * session instead. v2 dropped the legacy 'documents' store. */
let db;
const dbReq = indexedDB.open('DocReaderProDB', 2);
dbReq.onupgradeneeded = e => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
        console.log('[DB] Created settings store for highlights');
    }
    // Documents were moved to server-side storage; purge any stale local copies.
    if (db.objectStoreNames.contains('documents')) {
        db.deleteObjectStore('documents');
        console.log('[DB] Removed old documents store');
    }
};
dbReq.onsuccess = e => {
    db = e.target.result;
    console.log('[DB] Opened DocReaderProDB v2 (settings only)');
    loadHighlightSettings();
    // Slight delay lets the welcome screen paint before we auto-reopen the last book.
    setTimeout(loadLastDocument, 500);
};
dbReq.onerror = e => {
    console.error('[DB] Failed to open database:', e.target.error);
};
/* Debounced write of the current highlight settings (250ms trailing) so
 * slider drags don't hammer IndexedDB with a transaction per pixel. */
function saveHighlightSettings() {
    if (!db) return;
    clearTimeout(saveHighlightSettings._timer);
    saveHighlightSettings._timer = setTimeout(() => {
        if (!db) return;
        const payload = { hlBaseColor, hlOpacity, hlHoverOpacity, hlRadius, hlOutline, hlPadding };
        db.transaction(['settings'], 'readwrite').objectStore('settings').put(payload, 'highlight');
    }, 250);
}
/* Read persisted highlight settings and sync every related control's UI to
 * the loaded values before applying them. Missing fields keep defaults. */
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
        if (s.hlHoverOpacity !== undefined) hlHoverOpacity = s.hlHoverOpacity;
        document.getElementById('hl-padding-slider').value = hlPadding;
        document.getElementById('hl-padding-val').textContent = hlPadding + 'px';
        const hoverPct = Math.round(hlHoverOpacity * 100);
        document.getElementById('hl-hover-opacity-slider').value = hoverPct;
        document.getElementById('hl-hover-opacity-val').textContent = hoverPct + '%';
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
/* Set zoom (clamped 0.5–3.0, rounded to 0.1). For EPUB it delegates to the
 * handler's reflow-preserving resize; for PDF it queues a canvas rerender.
 * `rerender=false` is used when echoing a remote scale change that shouldn't
 * trigger another render round-trip. */
function setZoom(v, rerender = true) {
    v = Math.round(Math.min(3.0, Math.max(0.5, v)) * 10) / 10;
    scale = v;
    zoomSlider.value = scale;
    zoomVal.textContent = Math.round(scale * 100) + '%';
    // Only persist on local changes: remote echoes (rerender=false) must not
    // re-save, or two clients ping-pong settings_sync forever.
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.setZoom(scale);
        if (rerender) saveSettingsThrottled(pageNum, scale, currentIndex);
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

/* ─── Server settings API (WebSocket session) ───
 * Per-book settings sync: the 'session' socket pushes saved position/scale
 * on connect ('init') and echoes changes from other clients
 * ('settings_sync'). Saves are debounced and sent over the socket, falling
 * back to an HTTP POST when the socket isn't open. */
let saveTimeout = null;            // handle for the 800ms save debounce
let isSessionSocketOpen = false;

/* Open (or re-open) the per-book session channel. The 'init' message carries
 * previously saved settings; incoming 'settings_sync' updates are ignored
 * while playing so remote echoes can't fight local playback. */
function openSessionSocket(bookName) {
    WS.close('session');
    isSessionSocketOpen = false;
    WS.open('session', `/ws/session/${encodeURIComponent(bookName)}`, msg => {
        if (!msg) return;
        if (msg.type === 'init') {
            isSessionSocketOpen = true;
        }
        if (msg.type === 'settings_sync' || msg.type === 'settings') {
            // Server broadcasts saves as type "settings"; keep accepting both
            // for backward compatibility. Echoes of our own writes are harmless
            // (same values; setZoom is a no-op when unchanged).
            if (Number.isInteger(msg.page) && msg.page >= 1 && msg.page <= getPageCount() &&
                msg.page !== pageNum && !isPlaying) {
                if (documentHandler instanceof EPUBHandler) {
                    epubGoToPage(msg.page);
                } else if (pdfDoc) {
                    pageNum = msg.page;
                    queueRenderPage(pageNum);
                }
            }
            if (msg.scale) setZoom(msg.scale, false);
        }
    });
}

/* Debounced variant of saveSettings — coalesces bursts of page turns /
 * zoom tweaks into a single server write. Captures the book name so a
 * pending save for book A never lands on book B after a quick switch. */
function saveSettingsThrottled(page, scl, sentenceIndex) {
    const book = currentFileName;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (book && book === currentFileName) saveSettings(page, scl, sentenceIndex);
    }, 800);
}

/* Persist full reader state for this book. Prefers the open session socket;
 * silently falls back to HTTP POST (and gives up quietly on failure). */
function saveSettings(page, scl, sentenceIndex) {
    if (!currentFileName) return;
    const voice = voiceSelector?.value || 'af_sarah';
    const autoReadNext = document.getElementById('auto-read-next')?.checked || false;
    const saveAudio = document.getElementById('save-audio-toggle')?.checked || false;
    const theme = document.getElementById('theme-selector')?.value || 'default-light';

    const payload = {
        type: 'settings',
        book_name: currentFileName,
        page: page,
        scale: scl,
        sentenceIndex: sentenceIndex || 0,
        speed: playbackSpeed,
        topSkipLines: topSkipLines,
        bottomSkipLines: bottomSkipLines,
        epubSidePadding: epubSidePadding,
        focusModeEnabled: focusModeEnabled,
        theme: theme,
        voice: voice,
        autoReadNext: autoReadNext,
        saveAudioEnabled: saveAudioEnabled,
        hlBaseColor: hlBaseColor,
        hlOpacity: hlOpacity,
        hlHoverOpacity: hlHoverOpacity,
        hlRadius: hlRadius,
        hlPadding: hlPadding,
        hlOutline: hlOutline
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

/* Fetch saved settings for a book over plain HTTP. Returns the parsed
 * object, or null when absent/unreachable (callers treat null as defaults). */
async function loadSettings(bookName) {
    // Use only HTTP GET; WebSocket is for sync only
    try {
        const res = await fetch(`/settings?book_name=${encodeURIComponent(bookName)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data;
    } catch (e) {
        console.warn('Failed to load settings via HTTP:', e);
        return null;
    }
}

/* ─── Document generation token (guards async pipelines across document switches) ───
 * Bumped on every loadPDF/loadEPUB/resetUI. Long async pipelines snapshot
 * `const gen = docGeneration` at start and check `gen !== docGeneration`
 * after every await; on mismatch the stale work aborts silently so a
 * superseded document can't paint into the new one's UI or cache. */
let docGeneration = 0;

/* ─── Document dispatcher ─── */
/* Sniff EPUB by MIME type or .epub extension (some browsers send octet-stream). */
function isEpubFile(file) {
    const result = file.type === 'application/epub+zip' || file.name.toLowerCase().endsWith('.epub');
    _dlog(`[isEpubFile] name="${file.name}" type="${file.type}" -> ${result}`);
    return result;
}
/* Route an uploaded/server File to the right loader. startPage lets callers
 * restore a saved position (1-based page / spine index). */
async function loadDocument(file, startPage = 1) {
    if (isEpubFile(file)) {
        await loadEPUB(file, startPage);
    } else {
        await loadPDF(file, startPage);
    }
}

/* ─── Syntax highlighting (code blocks) ───
 * Dependency-free tokenizer driven by declarative per-language specs in
 * SYNTAX_HIGHLIGHTERS. The shared tokenizer handles comments (incl. multi-line
 * state carried across paragraph rows), strings/chars, preprocessor
 * directives, numbers, keywords/types, function calls and operator runs.
 *
 * To support a new language just append a spec object here; detection uses
 * each spec's `classes` token (e.g. "language-python") on the block, falling
 * back to HL_LANG_DEFAULT for unlabeled snippets.
 *
 * Each merged code wrapper gets a small header row: a language label and an
 * on/off toggle that flips .docreader-hl-off (CSS-neutralized colors, no
 * re-tokenizing). */
const SYNTAX_HIGHLIGHTERS = {
    c: {
        name: 'C',
        keywords: new Set([
            'auto','break','case','const','continue','default','do','else','enum','extern',
            'for','goto','if','inline','register','restrict','return','sizeof','static',
            'struct','switch','typedef','union','volatile','while','_Alignas','_Alignof',
            '_Atomic','_Bool','_Complex','_Generic','_Imaginary','_Noreturn','_Static_assert',
            '_Thread_local',
        ]),
        types: new Set([
            'void','char','short','int','long','float','double','signed','unsigned','bool',
            'size_t','ssize_t','ptrdiff_t','wchar_t','int8_t','int16_t','int32_t','int64_t',
            'uint8_t','uint16_t','uint32_t','uint64_t','intptr_t','uintptr_t','intmax_t',
            'uintmax_t','FILE','va_list','off_t','pid_t','uid_t','gid_t','mode_t','dev_t',
            'ino_t','nlink_t','blksize_t','blkcnt_t','time_t','clock_t','pthread_t',
            'pthread_mutex_t','pthread_cond_t','pthread_attr_t','pthread_key_t','pthread_once_t',
            'errno_t','socklen_t',
        ]),
        lineComment: '//',
        blockComment: { open: '/*', close: '*/' },
        strings: ['"', "'"],
        preprocessor: true,
        operators: '~!@#$%^&*()-=+[]{}|;:,.<>?/\\',
        classes: ['language-c', 'lang-c', 'c', 'code'],
    },
    /* Example spec to copy when adding a language:
    python: {
        name: 'Python',
        keywords: new Set(['def','return','import','from','as','class','if','elif','else',
            'for','while','break','continue','pass','try','except','finally','raise',
            'with','yield','lambda','global','nonlocal','del','assert','async','await',
            'in','is','not','and','or','None','True','False']),
        types: new Set(['int','float','str','bytes','bool','list','tuple','dict','set','object']),
        lineComment: '#',
        blockComment: { open: '"""', close: '"""' },
        strings: ['"', "'"],
        preprocessor: false,
        operators: '+-/%*=<>!&|^~:;,()[]{}',
        classes: ['language-python', 'lang-python', 'lang-py', 'py'],
    },
    */
};

/* Fallback language for blocks with no usable hint. */
const HL_LANG_DEFAULT = 'c';

/* Code colors tuned for light vs dark themes; see HL_LIGHT_THEMES. */
const HL_PALETTES = {
    light: {
        muted: '#6e7781',    keyword: '#cf222e',  type: '#0550ae',
        string: '#0a3069',   char: '#0a3069',     comment: '#6e7781',
        number: '#0550ae',   preproc: '#953800',  operator: '#630f7f',
        function: '#8250df',
    },
    dark: {
        muted: '#8b949e',    keyword: '#ff7b72',  type: '#79c0ff',
        string: '#a5d6ff',   char: '#a5d6ff',     comment: '#8b949e',
        number: '#79c0ff',   preproc: '#ffa657',  operator: '#ff7b72',
        function: '#d2a8ff',
    },
};

const HL_LIGHT_THEMES = new Set([
    'default-light', 'gruvbox-light', 'solarized-light', 'rosepine-dawn',
    'paper', 'tokyo-night-light', 'everforest-light', 'ayu-light',
    'github-light', 'catppuccin-latte', 'nord-light',
]);
const hlIsLightTheme = (t) => !!(t && HL_LIGHT_THEMES.has(t));

const hlIsIdChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/* Scan a number literal (hex/bin/oct/dec, floats, integer suffixes). */
function hlScanNumber(text, i) {
    const rest = text.slice(i);
    let m;
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
        return text.slice(i, i + m[0].length + (text.slice(i + m[0].length).match(/^(?:[uUlL]{1,2})/) || [''])[0].length);
    }
    if ((m = /^0[bB][01]+/.exec(rest))) {
        return text.slice(i, i + m[0].length + (text.slice(i + m[0].length).match(/^(?:[uUlL]{1,2})/) || [''])[0].length);
    }
    m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    return text.slice(i, i + m[0].length);
}

/* Tokenize one text run into [{type, text}] using a language spec. `st` is a
 * shared state object so multi-line block comments continue across rows. */
function tokenizeCode(text, spec, st) {
    const toks = [];
    const n = text.length;
    let i = 0;
    const kw = spec.keywords || null;
    const ty = spec.types || null;
    const lineCom = spec.lineComment || null;
    const blk = spec.blockComment || null;
    const strs = spec.strings || [];
    const ops = spec.operators || '';

    while (i < n) {
        const ch = text[i];

        if (blk && st.inBlockComment) {
            const close = text.indexOf(blk.close, i);
            if (close === -1) { toks.push({ type: 'comment', text: text.slice(i) }); i = n; }
            else {
                toks.push({ type: 'comment', text: text.slice(i, close + blk.close.length) });
                i = close + blk.close.length;
                st.inBlockComment = false;
            }
            continue;
        }
        if (lineCom && text.startsWith(lineCom, i)) {
            const eol = text.indexOf('\n', i);
            toks.push({ type: 'comment', text: text.slice(i, eol === -1 ? n : eol) });
            i = eol === -1 ? n : eol;
            continue;
        }
        if (blk && text.startsWith(blk.open, i)) {
            const close = text.indexOf(blk.close, i + blk.open.length);
            if (close === -1) { toks.push({ type: 'comment', text: text.slice(i) }); st.inBlockComment = true; i = n; }
            else {
                toks.push({ type: 'comment', text: text.slice(i, close + blk.close.length) });
                i = close + blk.close.length;
            }
            continue;
        }
        if (strs.includes(ch)) {
            let k = i + 1;
            while (k < n) {
                const ck = text[k];
                if (ck === '\\') { k += 2; continue; }
                if (ck === ch) { k++; break; }
                if (ck === '\n') break;
                k++;
            }
            toks.push({ type: ch === '"' ? 'string' : 'char', text: text.slice(i, k) });
            i = k;
            continue;
        }
        if (spec.preprocessor && ch === '#') {
            let atLineStart = true;
            for (let k = i - 1; k >= 0; k--) {
                const pk = text[k];
                if (pk === '\n') break;
                if (pk !== ' ' && pk !== '\t') { atLineStart = false; break; }
            }
            if (atLineStart) {
                let eol = text.indexOf('\n', i);
                if (eol === -1) eol = n;
                toks.push({ type: 'preprocessor', text: text.slice(i, eol) });
                i = eol;
                continue;
            }
        }
        if (ch >= '0' && ch <= '9') {
            toks.push({ type: 'number', text: hlScanNumber(text, i) });
            i += toks[toks.length - 1].text.length;
            continue;
        }
        if (hlIsIdChar(ch)) {
            let j = i;
            while (j < n && hlIsIdChar(text[j])) j++;
            const word = text.slice(i, j);
            let type = 'identifier';
            if (kw && kw.has(word)) type = 'keyword';
            else if (ty && ty.has(word)) type = 'type';
            else {
                let k = j;
                while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
                if (text[k] === '(') type = 'function';
            }
            toks.push({ type, text: word });
            i = j;
            continue;
        }
        if (ops.includes(ch)) {
            let j = i;
            while (j < n && ops.includes(text[j])) j++;
            toks.push({ type: 'operator', text: text.slice(i, j) });
            i = j;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            let j = i;
            while (j < n && /\s/.test(text[j])) j++;
            toks.push({ type: 'plain', text: text.slice(i, j) });
            i = j;
            continue;
        }
        toks.push({ type: 'plain', text: ch });
        i++;
    }
    return toks;
}

/* Pick a language spec for a code block from class hints, or null to fall
 * back to HL_LANG_DEFAULT. */
function detectCodeLanguage(el) {
    const scan = [el, ...el.querySelectorAll('*')];
    for (const node of scan) {
        if (!node.className) continue;
        const cs = node.className.baseVal !== undefined ? node.className.baseVal : node.className;
        const parts = String(cs).split(/\s+/);
        for (const c of parts) {
            const key = c.toLowerCase();
            if (!key) continue;
            for (const lang in SYNTAX_HIGHLIGHTERS) {
                if (SYNTAX_HIGHLIGHTERS[lang].classes.includes(key)) return lang;
            }
        }
    }
    return null;
}

/* Wipe a single code row and rebuild it as .hl-* spans. */
function renderHighlightedCode(el, spec, st) {
    const text = el.textContent;
    const toks = tokenizeCode(text, spec, st);
    el.textContent = '';
    const doc = el.ownerDocument;
    for (const t of toks) {
        if (t.type === 'plain') { el.appendChild(doc.createTextNode(t.text)); continue; }
        const s = doc.createElement('span');
        s.className = 'hl-' + t.type;
        s.textContent = t.text;
        el.appendChild(s);
    }
}

/* Decorate a merged code wrapper: language header + HL on/off toggle, then
 * highlight its rows (state shared across rows for multi-line comments). */
function setupCodeBlockWrapper(wrapper) {
    if (wrapper.dataset.hlReady) return;
    wrapper.dataset.hlReady = '1';
    const doc = wrapper.ownerDocument;
    const spec = SYNTAX_HIGHLIGHTERS[detectCodeLanguage(wrapper) || HL_LANG_DEFAULT];

    const toolbar = doc.createElement('div');
    toolbar.className = 'docreader-code-toolbar';
    const label = doc.createElement('span');
    label.className = 'docreader-code-lang';
    label.textContent = spec.name;

    const actions = doc.createElement('span');
    actions.className = 'docreader-code-toolbar-actions';

    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'docreader-code-copy-btn';
    copyBtn.title = 'Copy code';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
        const codeText = Array.prototype.slice
            .call(wrapper.querySelectorAll('p.snippet, p.code, div.snippet, div.code, pre'))
            .map(el => el.textContent.replace(/\s+$/g, ''))
            .filter(s => s.length)
            .join('\n');
        if (!codeText) return;
        const done = () => {
            const prev = copyBtn.textContent;
            copyBtn.textContent = '✓';
            copyBtn.disabled = true;
            setTimeout(() => { copyBtn.textContent = prev; copyBtn.disabled = false; }, 1200);
        };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(codeText).then(done).catch(() => hlLegacyCopy(doc, codeText, done));
            } else {
                hlLegacyCopy(doc, codeText, done);
            }
        } catch (e) {
            hlLegacyCopy(doc, codeText, done);
        }
    });

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'docreader-code-hl-toggle';
    btn.title = 'Toggle syntax highlighting';
    btn.textContent = 'HL';
    btn.setAttribute('aria-pressed', 'true');
    btn.addEventListener('click', () => {
        const off = wrapper.classList.toggle('docreader-hl-off');
        btn.setAttribute('aria-pressed', off ? 'false' : 'true');
        btn.textContent = off ? 'HL off' : 'HL';
    });

    actions.appendChild(copyBtn);
    actions.appendChild(btn);
    toolbar.appendChild(label);
    toolbar.appendChild(actions);
    wrapper.insertBefore(toolbar, wrapper.firstChild);

    const st = { inBlockComment: false };
    wrapper.querySelectorAll('p.snippet, p.code, div.snippet, div.code, pre')
        .forEach(el => renderHighlightedCode(el, spec, st));
}

/* Clipboard fallback for sandboxed iframes without the async Clipboard API.
 * The textarea must live in the SAME document the click activated (the epub
 * iframe), otherwise execCommand('copy') is rejected by the browser. */
function hlLegacyCopy(doc, text, done) {
    try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-10px;left:0;width:2px;height:2px;opacity:0;';
        doc.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = doc.execCommand('copy');
        ta.remove();
        if (ok) done();
    } catch (e) {}
}

/* ─── EPUB Handler ───
 * Wraps an epub.js rendition configured with flow:'scrolled-doc'.
 * Key invariants:
 *  - renderPage() serializes through _renderChain because epub.js's
 *    display() is not reentrant.
 *  - The real scroll container is epub.js's own .epub-container div, not the
 *    iframe window; all scroll math goes through _epubScrollTargets().
 *  - Themes are injected as a <style id="dr-theme-style"> directly into each
 *    iframe document (epub.js themes.select() races under rapid toggling).
 *  - Padding is owned by _injectReadingStyle and deliberately excluded from
 *    generated theme CSS.
 */
class EPUBHandler {
    constructor() {
        this.book = null;              // epub.js Book object
        this.rendition = null;         // epub.js Rendition (null until load / after destroy)
        this.spineItems = [];          // ordered spine items — index+1 doubles as "page number"
        this.pageCount = 0;            // spine length (a "page" == one spine document)
        this.currentPage = 1;          // currently displayed spine index+1
        this.currentText = '';         // plain text of current chapter (for TTS + search)
        this.currentSentences = [];    // chapter text split into sentences
        this.sentenceCfiMap = {};      // sentence idx -> CFI range for highlighting/jumps
        this.chapterCharMap = {};      // per-chapter char offsets for whole-book position math
        this._destroyed = false;       // set by destroy(); all async polls bail out when true
        this._rendering = false;       // true while a renderPage is in flight
        this._focusMode = false;       // dim chrome except active sentence
        this._currentTheme = 'default-light'; // last theme requested (may be pending rendition)
        this._themeCssMap = null;      // theme name -> CSS built by _buildThemeCss
        this._themeApplyTimer = null;  // debounce handle for setTheme (50ms)
        this._lastAppliedScale = null; // dedupes setZoom so settings_sync echoes don't cancel restores
        this._reflowActive = false;  // a _reflowPreservingPosition run is still settling
        this._reflowQueued = null;   // latest coalesced {mutate, opts} while active
        this._lastActiveFrags = [];  // cached active-sentence fragments (see _syncActiveSentenceClass)
    }

    /* Open an EPUB file and bootstrap the rendition.
     * Steps: read bytes -> parse book -> snapshot spine (each item becomes a
     * "page") -> create rendition (scrolled-doc, single column) -> register a
     * content hook that instruments every chapter iframe as it loads ->
     * apply theme/scale -> render the requested start page. */
    async load(file, startPage, containerEl, scale, theme) {
        this._destroyed = false;
        const arrayBuffer = await file.arrayBuffer();
        // epub.js is loaded globally by the script tag; resolve whichever name it exposed.
        const EpubJS = window.ePub || window.epub || (typeof ePub !== 'undefined' ? ePub : null);
        if (!EpubJS) throw new Error('epub.js failed to load (CDN script missing)');
        this.book = EpubJS(arrayBuffer);
        await this.book.ready;

        // Snapshot the spine once; "pages" in EPUB mode are spine documents.
        this.spineItems = [];
        this.book.spine.each(item => this.spineItems.push(item));
        this.pageCount = this.spineItems.length || 1;

        const viewerEl = document.getElementById('epub-viewer');
        viewerEl.innerHTML = '';
        const epubContainer = document.getElementById('epub-container');
        const width  = epubContainer.clientWidth  || window.innerWidth;
        const height = epubContainer.clientHeight || window.innerHeight;

        // scrolled-doc + spread:none => one chapter at a time, no facing pages.
        this.rendition = this.book.renderTo(viewerEl, {
            width:  width,
            height: height,
            flow:   'scrolled-doc',
            spread: 'none',
            minSpreadWidth: 9999,
        });

        // Content hook: runs for EVERY chapter document epub.js loads into an
        // iframe. This is where keyboard relay, hover highlighting, code-block
        // wrapping, and style/theme injection get attached per-document.
        this.rendition.hooks.content.register((contents) => {
            const doc = contents.document;
            const win = contents.window;
            // epub.js may re-run the hook on an already-instrumented window
            // (re-display); without this, listeners stack and fire N times.
            if (win._drHooked) return;
            win._drHooked = true;

            // Relay nav keys out of the sandboxed iframe to the top-level
            // document's keyboard handler (iframes swallow key events).
            // Skipped inside form controls so typing/space still work there.
            win.addEventListener('keydown', (e) => {
                try {
                    const t = e.target;
                    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
                              t.tagName === 'SELECT' || t.tagName === 'BUTTON' ||
                              t.isContentEditable)) return;
                } catch (err) {}
                const navKeys = ['j','k','J','K','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','h','l','H','L',' '];
                if (navKeys.includes(e.key)) e.preventDefault();
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: e.key,
                    code: e.code,
                    repeat: !!e.repeat,
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    altKey: e.altKey,
                    metaKey: e.metaKey,
                    bubbles: true,
                    cancelable: true,
                }));
            });
            
            this._injectFocusModeStyle(doc);
            if (this._focusMode) doc.body.classList.add('dr-focus-mode');

            // 'is-scrolling' body class lets CSS hide scrollbars / fade edges
            // while the user is actively scrolling.
            let epubScrollTimeout;
            win.addEventListener('scroll', () => {
                if (!doc.body.classList.contains('is-scrolling')) doc.body.classList.add('is-scrolling');
                clearTimeout(epubScrollTimeout);
                epubScrollTimeout = setTimeout(() => doc.body.classList.remove('is-scrolling'), 150);
            }, { passive: true });

            // Hover preview: highlight the .dr-sent span under the cursor.
            // A sentence can wrap across lines producing multiple spans that
            // share data-sent-idx; all fragments get the hover class, with
            // start/middle/end markers so CSS can round only outer corners.
            // A floating badge shows the 1-based line number next to the cursor.
            let _epubHoverIdx = -1;
            let _epubHoverFrags = [];
            const _epubHoverBadge = (clientX, clientY, sentIdx) => {
                try { this._showLineBadge(doc, clientX, clientY, sentIdx); } catch(e) {}
            };
            const _epubHideBadge = () => {
                try { this._hideLineBadge(doc); } catch(e) {}
            };
            win.addEventListener('mousemove', (e) => {
                // Coalesce to one DOM pass per frame: raw mousemove fires per
                // pixel and each pass queries the whole chapter otherwise.
                if (win._drHoverRaf) return;
                win._drHoverRaf = 1;
                const raf = (win.requestAnimationFrame || requestAnimationFrame).bind(win);
                raf(() => {
                    win._drHoverRaf = 0;
                    handleEpubHover(e);
                });
            });
            const handleEpubHover = (e) => {
                const span = e.target.closest && e.target.closest('.dr-sent');
                if (!span) { _clearEpubHover(); return; }
                const bestSentIdx = Number(span.getAttribute('data-sent-idx'));
                if (isNaN(bestSentIdx)) { _clearEpubHover(); return; }
                // Same sentence: keep highlight, just follow the cursor.
                if (bestSentIdx === _epubHoverIdx) {
                    _epubHoverBadge(e.clientX, e.clientY, bestSentIdx);
                    return;
                }
                _clearEpubHover();
                _epubHoverIdx = bestSentIdx;
                _epubHoverFrags = Array.from(doc.querySelectorAll(`.dr-sent[data-sent-idx="${bestSentIdx}"]`));
                _epubHoverFrags.forEach((el, i) => {
                    el.classList.add('dr-sentence-hover');
                    if (_epubHoverFrags.length > 1) {
                        if (i === 0) el.classList.add('dr-fragment-start');
                        else if (i === _epubHoverFrags.length - 1) el.classList.add('dr-fragment-end');
                        else el.classList.add('dr-fragment-middle');
                    }
                });
                _epubHoverBadge(e.clientX, e.clientY, bestSentIdx);
            };

            /* Remove hover styling from all fragments of the last hovered
             * sentence, preserving 'active' fragment markers if playing.
             * Uses the cached fragment list (no document-wide query). */
            function _clearEpubHover() {
                _epubHideBadge();
                if (_epubHoverIdx === -1) { _epubHoverFrags = []; return; }
                const frags = _epubHoverFrags.length ? _epubHoverFrags :
                    Array.from(doc.querySelectorAll('.dr-sent.dr-sentence-hover'));
                frags.forEach(el => {
                        el.classList.remove('dr-sentence-hover');
                        if (!el.classList.contains('dr-sentence-active')) {
                            el.classList.remove('dr-fragment-start', 'dr-fragment-middle', 'dr-fragment-end');
                        }
                    });
                _epubHoverIdx = -1;
                _epubHoverFrags = [];
            }

            win.addEventListener('mouseleave', () => { _clearEpubHover(); _epubHideBadge(); });
            win.addEventListener('scroll', () => { _epubHideBadge(); }, { passive: true });

            // Long-press on touch devices: 500ms hold without moving shows the
            // line-number badge pinned to the sentence. Sets a suppression
            // window so the tap-to-play click handler ignores this gesture.
            // Single taps are untouched and still start playback immediately.
            let _lpTimer = null;
            let _lpStartX = 0, _lpStartY = 0;
            let _lpSentIdx = -1;
            let _lpFired = false;
            const _lpCancel = () => {
                if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
            };
            win.addEventListener('touchstart', (e) => {
                _lpFired = false;
                _lpCancel();
                if (!e.touches || e.touches.length !== 1) return;
                const t = e.touches[0];
                const span = t.target && t.target.closest && t.target.closest('.dr-sent');
                if (!span) { _lpSentIdx = -1; return; }
                const si = Number(span.getAttribute('data-sent-idx'));
                if (isNaN(si)) { _lpSentIdx = -1; return; }
                _lpSentIdx = si;
                _lpStartX = t.clientX; _lpStartY = t.clientY;
                _lpTimer = setTimeout(() => {
                    _lpTimer = null;
                    _lpFired = true;
                    try {
                        const frags = doc.querySelectorAll(`.dr-sent[data-sent-idx="${_lpSentIdx}"]`);
                        const first = frags && frags[0];
                        const rect = first && first.getBoundingClientRect ? first.getBoundingClientRect() : null;
                        if (rect) this._showLineBadgeAtRect(doc, rect, _lpSentIdx);
                        else this._showLineBadge(doc, _lpStartX, _lpStartY, _lpSentIdx);
                    } catch(err) {}
                    try { if (navigator.vibrate) navigator.vibrate(10); } catch(err) {}
                    // Suppress the click-to-play that the tap would otherwise fire.
                    try { window._epubSuppressClickUntil = Date.now() + 900; } catch(err) {}
                    // Auto-hide so the badge never sticks.
                    setTimeout(() => { try { this._hideLineBadge(doc); } catch(err) {} }, 1600);
                }, 500);
            }, { passive: true });
            win.addEventListener('touchmove', (e) => {
                if (!_lpTimer) return;
                if (!e.touches || !e.touches.length) return;
                const t = e.touches[0];
                if (Math.hypot(t.clientX - _lpStartX, t.clientY - _lpStartY) > 10) _lpCancel();
            }, { passive: true });
            const _lpEnd = () => {
                _lpCancel();
                // If it was a plain tap (no long-press), make sure no stale badge lingers.
                if (!_lpFired) { try { this._hideLineBadge(doc); } catch(e) {} }
                setTimeout(() => { _lpFired = false; }, 950);
            };
            win.addEventListener('touchend', _lpEnd, { passive: true });
            win.addEventListener('touchcancel', _lpEnd, { passive: true });

            // Group consecutive code-ish blocks into a single wrapper div so
            // CSS can style multi-paragraph snippets as one unit.
            const codeBlocks = Array.from(doc.querySelectorAll('p.snippet, p.code, div.snippet, div.code, pre'))
                .filter(el => !el.closest('.docreader-code-wrapper'));
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

            this._injectReadingStyle(doc);
            this._injectHighlightStyle(doc);

            // Syntax highlighting: style + language header/toggle per block.
            this._injectSyntaxHighlightCss(doc);
            doc.querySelectorAll('.docreader-code-wrapper')
                .forEach(w => setupCodeBlockWrapper(w));

            // Must come last so theme CSS can't be overridden by the above.
            this._injectThemeStyleIntoDoc(doc);
        });

        this._registerThemes();
        this._applyCurrentTheme(theme);
        this._applyScale(scale);

        await this.renderPage(startPage);
        this._loadChapterStats();
    }

    /* Register every built-in theme with epub.js AND keep the raw rule maps
     * in _themeCssMap for _buildThemeCss (direct iframe injection). The
     * 'resetStyles' entries neutralize publisher background/border colors so
     * dark themes stay readable on badly-authored EPUBs. */
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
            },
            'tokyo-night': {
                'body': { 'background': '#1a1b26', 'color': '#a9b1d6', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#7aa2f7' }, 'strong, b': { 'color': '#f7768e' }, 'em, i': { 'color': '#9ece6a' }
            },
            'tokyo-night-light': {
                'body': { 'background': '#d5d6db', 'color': '#343b58', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#3760bf' }, 'strong, b': { 'color': '#f52a65' }, 'em, i': { 'color': '#587539' }
            },
            'everforest-dark': {
                'body': { 'background': '#2d353b', 'color': '#d3c6aa', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#a7c080' }, 'strong, b': { 'color': '#e67e80' }, 'em, i': { 'color': '#dbbc7f' }
            },
            'everforest-light': {
                'body': { 'background': '#fdf6e3', 'color': '#5c6a72', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#8da101' }, 'strong, b': { 'color': '#f85552' }, 'em, i': { 'color': '#dfa000' }
            },
            'ayu-dark': {
                'body': { 'background': '#0b0e14', 'color': '#b3b1ad', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#39bae6' }, 'strong, b': { 'color': '#ff8f40' }, 'em, i': { 'color': '#aad94c' }
            },
            'ayu-light': {
                'body': { 'background': '#fafafa', 'color': '#575f66', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#399ee6' }, 'strong, b': { 'color': '#f2ae49' }, 'em, i': { 'color': '#86b300' }
            },
            'rosepine': {
                'body': { 'background': '#191724', 'color': '#e0def4', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#c4a7e7' }, 'strong, b': { 'color': '#eb6f92' }, 'em, i': { 'color': '#31748f' }
            },
            'rosepine-dawn': {
                'body': { 'background': '#faf4ed', 'color': '#575279', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#907aa9' }, 'strong, b': { 'color': '#b4637a' }, 'em, i': { 'color': '#286983' }
            },
            'paper': {
                'body': { 'background': '#f2ede4', 'color': '#3a3226', 'line-height': '1.8', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#5a3e28' }, 'strong, b': { 'color': '#7c4a1e' }, 'em, i': { 'color': '#8b6f47' }
            },
            'midnight': {
                'body': { 'background': '#000000', 'color': '#cccccc', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#ffffff' }, 'strong, b': { 'color': '#aaaaaa' }, 'em, i': { 'color': '#888888' }
            },
            'one-dark': {
                'body': { 'background': '#282c34', 'color': '#abb2bf', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#61afef' }, 'strong, b': { 'color': '#98c379' }, 'em, i': { 'color': '#e5c07b' }
            },
            'kanagawa': {
                'body': { 'background': '#1f1f28', 'color': '#dcd7ba', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#7e9cd8' }, 'strong, b': { 'color': '#98bb6c' }, 'em, i': { 'color': '#ffa066' }
            },
            'night-owl': {
                'body': { 'background': '#011627', 'color': '#d6deeb', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#82aaff' }, 'strong, b': { 'color': '#addb67' }, 'em, i': { 'color': '#c792ea' }
            },
            'material-ocean': {
                'body': { 'background': '#0f111a', 'color': '#e3e6ee', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#84ffff' }, 'strong, b': { 'color': '#c3e88d' }, 'em, i': { 'color': '#ffcb6b' }
            },
            'synthwave': {
                'body': { 'background': '#262335', 'color': '#dedbf0', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#ff7edb' }, 'strong, b': { 'color': '#72f1b8' }, 'em, i': { 'color': '#fede5d' }
            },
            'github-light': {
                'body': { 'background': '#ffffff', 'color': '#24292f', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#0550ae' }, 'strong, b': { 'color': '#116329' }, 'em, i': { 'color': '#9a6700' }
            },
            'github-dark': {
                'body': { 'background': '#0d1117', 'color': '#e6edf3', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#58a6ff' }, 'strong, b': { 'color': '#3fb950' }, 'em, i': { 'color': '#d29922' }
            },
            'catppuccin-latte': {
                'body': { 'background': '#eff1f5', 'color': '#4c4f69', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#8839ef' }, 'strong, b': { 'color': '#40a02b' }, 'em, i': { 'color': '#df8e1d' }
            },
            'nord-light': {
                'body': { 'background': '#eceff4', 'color': '#2e3440', 'line-height': '1.7', 'padding': '20px 32px' },
                'div, blockquote, figure, aside, section': resetStyles,
                'h1, h2, h3, h4, h5, h6': { 'color': '#5e81ac' }, 'strong, b': { 'color': '#567d2d' }, 'em, i': { 'color': '#8f6c00' }
            }
        };
        this._themeCssMap = themeMap;
        // Also register with epub.js for good measure; real application goes
        // through _injectThemeStyleIntoDoc.
        Object.entries(themeMap).forEach(([name, css]) => {
            try { this.rendition.themes.register(name, css); } catch (e) {}
        });
    }

    /* Serialize a theme rule map into a flat CSS string with !important on
     * every declaration (publisher styles must always lose). 'padding' is
     * deliberately excluded — the side-margin slider owns it. Returns ''
     * for unknown theme names. */
    _buildThemeCss(t) {
        const entry = this._themeCssMap && this._themeCssMap[t];
        if (!entry) return '';
        const lines = [];
        Object.entries(entry).forEach(([selector, props]) => {
            // Padding is owned by _injectReadingStyle (epub side-padding slider);
            // a !important theme padding would permanently override it.
            const decls = Object.entries(props)
                .filter(([p]) => p !== 'padding')
                .map(([p, v]) => {
                    const val = typeof v === 'string' && v.endsWith('!important') ? v : v + ' !important';
                    return `${p}: ${val};`;
                }).join(' ');
            lines.push(`${selector} { ${decls} }`);
        });
        return lines.join('\n');
    }

    /* Deterministic theme assertion: write the theme CSS directly into the
       iframe document. Unlike epub.js themes.select(), this is synchronous,
       idempotent and immune to rapid-toggle races — last write always wins. */
    _injectThemeStyleIntoDoc(doc) {
        try {
            if (!doc || !doc.head) return;
            const t = this._currentTheme || localStorage.getItem('docreader-theme') || 'default-light';
            let s = doc.getElementById('dr-theme-style');
            if (!s) {
                s = doc.createElement('style');
                s.id = 'dr-theme-style';
                doc.head.appendChild(s);
            }
            s.textContent = this._buildThemeCss(t);
        } catch(e) {}
    }

    /* Apply theme via epub.js API, then force-inject into live documents as
     * a belt-and-braces fix for select() races under rapid toggling. */
    _applyCurrentTheme(theme) {
        const t = theme || localStorage.getItem('docreader-theme') || 'default-light';
        this._currentTheme = t;
        try { this.rendition.themes.select(t); } catch (e) {}
        // Assert directly on all live chapter documents (fixes epub.js races)
        try {
            const contents = this.rendition && this.rendition.getContents();
            if (contents && contents.length) {
                contents.forEach(c => {
                    this._injectThemeStyleIntoDoc(c.document);
                    this._injectSyntaxHighlightCss(c.document);
                });
            }
        } catch(e) {}
    }

    /* Re-assert the current theme on freshly rendered chapter documents */
    _ensureCurrentTheme() {
        if (this._destroyed || !this.rendition) return;
        this._applyCurrentTheme(this._currentTheme);
    }

    /* Apply a font-size scale to the chapter content. Recording
     * _lastAppliedScale lets setZoom() short-circuit same-scale calls, so a
     * settings_sync echo can't cancel an in-flight load-time scroll restore.
     * Written directly into live documents AND via themes.fontSize (the
     * latter is async/racy in scrolled-doc, so direct injection wins). */
    _applyScale(scale) {
        this._lastAppliedScale = scale;
        const pct = Math.round(scale * 100);
        try { this.rendition.themes.fontSize(pct + '%'); } catch (e) {}
        try {
            const contents = this.rendition && this.rendition.getContents();
            const doc = contents && contents[0] && contents[0].document;
            if (doc && doc.documentElement) {
                doc.documentElement.style.setProperty('font-size', pct + '%', 'important');
            }
        } catch (e) {}
    }

    /* Extract visible chapter text and map each TTS sentence back into the DOM.
     * Pipeline:
     *   1. Unwrap any previous .dr-sent spans + normalize() to restore clean text nodes.
     *   2. TreeWalker over body: accept text nodes (and <br> as line breaks),
     *      reject script/style/nav/aside, skip container elements; block-level
     *      ancestors insert '\n' separators into the flattened text.
     *   3. nodeRanges records each text node's [start,end) span within fullText,
     *      letting us translate sentence offsets -> DOM ranges later.
     *   4. Shared buildStructuredText/trimSkipLines produce the sentence list
     *      (top/bottom skips applied, so ordinals match download cache keys);
     *      each sentence is located via the structured->fullText index map and
     *      translated to wrap operations (no CFI — it was never read).
     *   5. Wrap ops are grouped per node and applied right-to-left so earlier
     *      offsets stay valid while surrounding with <span class="dr-sent">.
     * Returns { text: normalized chapter text, sentenceCfiMap: si -> CFI }. */
    _extractTextFromRendition() {
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents.length) return { text: '', sentences: [], sentenceCfiMap: {} };
            const doc = contents[0].document;
            if (!doc || !doc.body) return { text: '', sentences: [], sentenceCfiMap: {} };

            try {
                doc.querySelectorAll('.dr-sent').forEach(el => {
                    const parent = el.parentNode;
                    while (el.firstChild) parent.insertBefore(el.firstChild, el);
                    parent.removeChild(el);
                });
                doc.body.normalize(); 
            } catch(e) {}

            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ALL, {
                acceptNode: (n) => {
                    if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
                    if (n.nodeType === Node.ELEMENT_NODE) {
                        const tag = n.tagName.toLowerCase();
                        if (['script','style','nav','aside'].includes(tag)) return NodeFilter.FILTER_REJECT;
                        // Line-number badge + code-block toolbar are chrome,
                        // not reading content — never feed them to the TTS extractor.
                        if (n.id === 'dr-line-badge') return NodeFilter.FILTER_REJECT;
                        if (n.classList &&
                            (n.classList.contains('docreader-code-toolbar') ||
                             n.classList.contains('docreader-code-toolbar-actions') ||
                             n.classList.contains('docreader-code-lang') ||
                             n.classList.contains('docreader-code-hl-toggle') ||
                             n.classList.contains('docreader-code-copy-btn'))) return NodeFilter.FILTER_REJECT;
                        if (tag === 'br') return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            });

            let fullText = '';
            const nodeRanges = [];
            let lastParentBlock = null;
            let node;

            // Per-element caches: many text nodes share one parent, so the
            // style/block lookups happen once per element instead of once
            // per text node (getComputedStyle flushes style per call).
            const _hiddenCache = new Map();
            const _blockCache = new Map();
            const _BLOCK_SEL = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,section,article,pre';
            const isHiddenEl = (el) => {
                let h = _hiddenCache.get(el);
                if (h === undefined) {
                    h = false;
                    try {
                        const cs = doc.defaultView ? doc.defaultView.getComputedStyle(el) : null;
                        h = !!(cs && (cs.display === 'none' || cs.visibility === 'hidden'));
                    } catch (e) { h = false; }
                    _hiddenCache.set(el, h);
                }
                return h;
            };
            const nearestBlockOf = (el) => {
                if (!_blockCache.has(el)) {
                    let b = null;
                    try { b = el.closest(_BLOCK_SEL); } catch (e) { b = null; }
                    _blockCache.set(el, b);
                }
                return _blockCache.get(el);
            };

            while ((node = walker.nextNode())) {
                if (node.nodeType === Node.ELEMENT_NODE) { 
                    if (!fullText.endsWith('\n')) fullText += '\n';
                    continue;
                }

                const parent = node.parentElement;
                if (parent && isHiddenEl(parent)) continue;

                let t = node.textContent.replace(/\s+/g, ' ');
                if (t === '') continue;

                const nearestBlock = parent ? nearestBlockOf(parent) : null;
                if (nearestBlock && nearestBlock !== lastParentBlock) {
                    if (fullText.length > 0 && !fullText.endsWith('\n')) {
                        // Trailing run is at most one ' ' (whitespace is
                        // collapsed on append), so drop one char instead of
                        // copying the whole string via trimEnd().
                        if (fullText.endsWith(' ')) fullText = fullText.slice(0, -1);
                        fullText += '\n';
                    }
                    lastParentBlock = nearestBlock;
                }

                if (t === ' ' && (fullText.endsWith(' ') || fullText.endsWith('\n'))) continue;

                nodeRanges.push({ start: fullText.length, end: fullText.length + t.length, node });
                fullText += t;
            }

            // Structured text via the shared builder (identical output for the
            // batch extractor), then top/bottom line skips — playback ordinals
            // match download cache keys by construction.
            const built = buildStructuredText(fullText);
            const structuredText = built.text;
            const stMap = built.map;
            const skipped = trimSkipLines(structuredText, topSkipLines, bottomSkipLines);
            const sentencesArr = splitIntoTTSChunks(skipped.text, 250);

            // Map sentences back onto the DOM. Sentences advance in order
            // through the kept text; offsets translate from structured space
            // to fullText space via stMap (transforms only delete characters).
            // sentenceCfiMap is kept (empty) for API compat (it was computed
            // per sentence via cfiFromRange but never read anywhere).
            const sentenceCfiMap = {};
            const wrapOperations = [];

            // Sentences and nodeRanges both advance forward through fullText,
            // so a single linear sweep replaces find()+filter() per sentence
            // (was O(sentences x text-nodes)).
            let ri = 0;
            let searchFrom = 0;
            sentencesArr.forEach((sent, si) => {
                const sRel = skipped.text.indexOf(sent, searchFrom);
                if (sRel === -1) return;
                searchFrom = sRel + sent.length;
                const sAbs = skipped.start + sRel;
                const idx = stMap[sAbs];
                const lastCh = stMap[sAbs + sent.length - 1];
                if (idx === undefined || lastCh === undefined) return;
                const sentEnd = lastCh + 1;

                while (ri < nodeRanges.length && nodeRanges[ri].end <= idx) ri++;

                // A sentence may straddle several text nodes (inline markup);
                // emit one wrap op per overlapping node segment.
                for (let k = ri; k < nodeRanges.length && nodeRanges[k].start < sentEnd; k++) {
                    const r = nodeRanges[k];
                    const overlapStart = Math.max(r.start, idx);
                    const overlapEnd = Math.min(r.end, sentEnd);
                    if (overlapStart < overlapEnd) {
                        wrapOperations.push({
                            node: r.node,
                            startOffset: overlapStart - r.start,
                            endOffset: overlapEnd - r.start,
                            si: si
                        });
                    }
                }
            });

            const opsByNode = new Map();
            wrapOperations.forEach(op => {
                if (!opsByNode.has(op.node)) opsByNode.set(op.node, []);
                opsByNode.get(op.node).push(op);
            });

            opsByNode.forEach((ops, node) => {
                // Sort descending: mutating offsets from the end backwards keeps
                // earlier offsets in the same node untouched.
                ops.sort((a, b) => b.startOffset - a.startOffset);
            });
            // Wrap each sentence segment in a <span class="dr-sent">.
            // splitText+insertBefore is used instead of Range.surroundContents
            // (~1.6ms/call here: 2943 ops took 4.7s on one chapter). Split at
            // end first, then at start (descending order keeps offsets valid).
            // Wrapping happens in a detached fragment (extracted below) so
            // per-mutation render costs don't apply; re-inserted once after.
            const doWrap = () => {
                opsByNode.forEach((ops, node) => {
                    ops.forEach(op => {
                        try {
                            let t = node;
                            if (op.endOffset < t.data.length) t.splitText(op.endOffset);
                            let mid = t;
                            if (op.startOffset > 0) mid = t.splitText(op.startOffset);
                            const span = doc.createElement('span');
                            span.className = 'dr-sent';
                            span.setAttribute('data-sent-idx', op.si);
                            span.setAttribute('data-line-num', String(op.si + 1));
                            span.setAttribute('title', 'Line ' + (op.si + 1));
                            mid.parentNode.insertBefore(span, mid);
                            span.appendChild(mid);
                        } catch(e) {}
                    });
                });
            };
            let _wrapped = false;
            try {
                const _r = doc.createRange();
                _r.selectNodeContents(doc.body);
                const _frag = _r.extractContents();
                doWrap();
                doc.body.appendChild(_frag);
                _wrapped = true;
            } catch (e) { _wrapped = false; }
            if (!_wrapped) {
                // Fallback path: the fragment walk above threw midway and may
                // have left partial wraps behind — strip them first so the
                // re-run can't nest .dr-sent inside .dr-sent.
                try {
                    doc.querySelectorAll('.dr-sent').forEach(el => {
                        const p = el.parentNode;
                        while (el.firstChild) p.insertBefore(el.firstChild, el);
                        p.removeChild(el);
                    });
                    doc.body.normalize();
                    doWrap();
                } catch (e) {}
            }

            // Return the SKIP-TRIMMED text + sentence list so the DOM
            // (data-sent-idx), playback (`sentences`), click-to-read, the
            // hover badge, and line-range downloads all share one ordinal.
            // (Previously this returned the untrimmed structuredText and each
            // caller re-split it, so any top/bottom skip shifted the badge
            // by the skipped amount vs playback/cache keys.)
            return { text: skipped.text, sentences: sentencesArr, sentenceCfiMap };
        } catch(e) {
            return { text: '', sentences: [], sentenceCfiMap: {} };
        }
    }

    /* Build the sidebar TOC from the book's nav table. Each entry is mapped to
     * a 1-based spine "page" via best-effort href matching (fragments stripped,
     * relative paths tolerated). Nested subitems are converted recursively. */
    getTOC() {
        if (!this.book || !this.book.navigation) return [];
        const navItems = this.book.navigation.toc || [];
        const spineItems = this.spineItems;

        const hrefToChapter = (href) => {
            if (!href) return null;
            const clean = href.split('#')[0];
            if (!clean) return null; // pure fragment: no spine file to match
            const idx = spineItems.findIndex(item => {
                const ih = item.href || '';
                if (!ih) return false;
                return ih === href || ih === clean ||
                    ih.endsWith(clean) || clean.endsWith(ih);
            });
            return idx >= 0 ? idx + 1 : null;
        };

        const convert = (items) => items.map(item => ({
            title: item.label || item.title || '(untitled)',
            page: hrefToChapter(item.href),
            href: item.href,
            items: item.subitems ? convert(item.subitems) : [],
        }));
        return convert(navItems);
    }

    /* Full-text search across the whole spine. epub.js has no built-in
     * book.search for this setup, so we iterate spine items ourselves:
     * a worker pool of 4 pulls the next unscanned index (shared `next`
     * cursor), loads each chapter via book.load, and regex-free indexOf
     * scans its flattened text. Results are collected per-chapter in
     * `perPage`, so flattening restores spine order; capped at 200 hits.
     * Returns [{page, context, query, index}]. */
    async search(query) {
        if (!this.book) return [];
        if (!query || !query.trim()) return [];
        const lowerQuery = query.toLowerCase();
        const items = this.spineItems;
        const perPage = new Array(items.length);
        let next = 0;

        const scanChapter = async (i) => {
            const item = items[i];
            let doc;
            try {
                const content = await this.book.load(item.href);
                if (typeof content === 'string') {
                    doc = new DOMParser().parseFromString(content, 'application/xhtml+xml');
                } else if (content && typeof content === 'object') {
                    doc = content;
                }
            } catch(e) { perPage[i] = []; return; }
            if (!doc || !doc.body) { perPage[i] = []; return; }

            // Visible text only: skip script/style/nav/aside subtrees, like the
            // live rendition extractor does (never mutate — the doc may be shared).
            let text = '';
            try {
                const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
                    acceptNode: (n) => {
                        const p = n.parentElement;
                        if (p) {
                            const t = p.tagName.toLowerCase();
                            if (t === 'script' || t === 'style' || t === 'nav' || t === 'aside') {
                                return NodeFilter.FILTER_REJECT;
                            }
                        }
                        return n.textContent.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                    }
                });
                const parts = [];
                let nn;
                while ((nn = walker.nextNode())) parts.push(nn.textContent);
                text = parts.join(' ').replace(/\s+/g, ' ');
            } catch(e) { perPage[i] = []; return; }
            if (!text) { perPage[i] = []; return; }

            const matches = [];
            const lowerText = text.toLowerCase();
            let pos = 0;
            while (true) {
                const idx = lowerText.indexOf(lowerQuery, pos);
                if (idx === -1) break;
                matches.push({
                    page: i + 1,
                    context: text.slice(Math.max(0, idx - 40), idx + query.length + 60),
                    query,
                    index: idx
                });
                // Non-overlapping stepping — matches occurrence counting in
                // scrollToSearchMatch and the PDF highlighter.
                pos = idx + query.length;
            }
            perPage[i] = matches;
        };

        const worker = async () => {
            while (next < items.length) {
                const i = next++;
                await scanChapter(i);
            }
        };
        // 4-way concurrency: enough to hide book.load latency without
        // thrashing memory on huge EPUBs.
        await Promise.all(Array.from({ length: Math.min(4, Math.max(1, items.length)) }, worker));

        return perPage.filter(Boolean).flat().slice(0, 200);
    }

    /* Scroll the currently rendered chapter so the Nth occurrence of `query`
     * is visible, and select it inside the iframe.
     * Concatenates text nodes with an offset table so matches spanning inline
     * markup are found, then maps the range back across nodes. Non-overlapping
     * occurrence counting matches search(). Returns true on success, false if
     * the chapter isn't rendered or the match can't be located (caller falls
     * back to plain page navigation). */
    async scrollToSearchMatch(query, occurrence = 0) {
        try {
            if (!query || !query.trim()) return false;
            const contents = this.rendition.getContents();
            if (!contents || !contents[0] || !contents[0].document) return false;
            const win = contents[0].window;
            const doc = contents[0].document;
            const root = doc.body || doc.documentElement;
            if (!root) return false;

            const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) => {
                    const p = n.parentElement;
                    if (!p) return NodeFilter.FILTER_REJECT;
                    const tag = p.tagName.toLowerCase();
                    if (['script', 'style', 'head'].includes(tag)) return NodeFilter.FILTER_REJECT;
                    return n.textContent.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                }
            });
            const nodes = [];
            let node;
            while ((node = walker.nextNode())) nodes.push(node);
            if (!nodes.length) return false;

            let full = '';
            const starts = nodes.map(n => { const s = full.length; full += n.textContent; return s; });
            const lq = query.toLowerCase();
            const lfull = full.toLowerCase();
            const step = Math.max(1, lq.length);
            let count = -1, pos = 0, mIdx = -1;
            while (true) {
                mIdx = lfull.indexOf(lq, pos);
                if (mIdx === -1) return false;
                count++;
                if (count === occurrence) break;
                pos = mIdx + step;
            }
            const mEnd = mIdx + query.length;
            let si = 0;
            while (si + 1 < nodes.length && starts[si + 1] <= mIdx) si++;
            let ei = si;
            while (ei + 1 < nodes.length && starts[ei + 1] < mEnd) ei++;
            const range = doc.createRange();
            range.setStart(nodes[si], Math.min(Math.max(0, mIdx - starts[si]), nodes[si].textContent.length));
            range.setEnd(nodes[ei], Math.min(Math.max(0, mEnd - starts[ei]), nodes[ei].textContent.length));
            const el = range.startContainer.parentElement;
            if (el) this._scrollEpubElIntoView(el, true);
            try {
                const sel = win.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            } catch(e) {}
            return true;
        } catch(e) { return false; }
    }

    /* Move highlight + scroll to the given sentence (playback-time path). */
    highlightSentence(idx) {
        if (!this.rendition) return;
        this._syncActiveSentenceClass(idx);
        this._scrollEpubSentenceIntoView(idx);
    }

    /* Scroll to a sentence for load-time position restore.
       Returns 'missing' (spans not injected yet), 'scrolled' (scroll issued,
       needs confirmation it stuck) or 'inview' (already visible). */
    scrollToSentence(idx) {
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents[0] || !contents[0].document) return 'missing';
            const c = contents[0];
            const spans = c.document.querySelectorAll(`.dr-sent[data-sent-idx="${idx}"]`);
            if (!spans.length) return 'missing';

            // epub.js scrolled-doc scrolls its own .epub-container div, not
            // the iframe window — fall back through candidate scrollers.
            const scroller =
                document.querySelector('#epub-viewer .epub-container') ||
                document.getElementById('epub-viewer') ||
                document.getElementById('epub-container');
            // Decide which viewport to measure against (outer scroller vs iframe).
            const hasOuterScroller = scroller && scroller.scrollHeight - scroller.clientHeight > 10;
            const frameEl = c.window.frameElement;
            const sRect = hasOuterScroller ? scroller.getBoundingClientRect() : null;
            const fTop = frameEl ? frameEl.getBoundingClientRect().top : 0;
            const vh = hasOuterScroller ? sRect.height : c.window.innerHeight;
            const vTop = hasOuterScroller ? sRect.top : 0;

            // Use the middle fragment so multi-fragment sentences center properly
            const target = spans[Math.floor(spans.length / 2)];
            const r = target.getBoundingClientRect();
            const elTop = (hasOuterScroller ? fTop : 0) + r.top;
            const elBottom = elTop + r.height;
            const inView = elTop > vTop + vh * 0.15 && elBottom < vTop + vh * 0.85;

            // "in view" means inside a 15%..85% comfort band of the viewport.
            if (inView) {
                this._syncActiveSentenceClass(idx);
                return 'inview';
            }
            // scrollIntoView targets the iframe viewport, not the outer
            // scroller — center through the outer scroller when it owns scroll.
            if (hasOuterScroller) {
                const top = Math.max(0, scroller.scrollTop + (elTop + r.height / 2) - (vTop + vh / 2));
                try { scroller.scrollTo({ top, behavior: 'smooth' }); }
                catch (e) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
            } else {
                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            this._syncActiveSentenceClass(idx);
            return 'scrolled';
        } catch(e) { return 'missing'; }
    }

    /* Jump to a URL fragment (#anchor) inside the current chapter; falls back
     * to scrolling the chapter to the top when the anchor can't be found.
     * Returns true if the fragment element was scrolled to. */
    scrollToFragment(fragment = null) {
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents[0] || !contents[0].document) return false;
            const doc = contents[0].document;
            if (fragment) {
                const el = doc.getElementById(fragment) || doc.querySelector(`[name="${fragment}"]`);
                if (el) {
                    this._scrollEpubElIntoView(el, true);
                    return true;
                }
            }
            this._scrollEpubToTop(false);
            return false;
        } catch(e) { return false; }
    }

    /* Playback-time scroll helper. Retries (up to 10 × 80ms) when the target
     * span has no layout yet — epub.js may still be laying out after display().
     * Only scrolls if the sentence sits outside the central 20%..80% band, so
     * normal forward playback doesn't jitter the page. */
    _scrollEpubSentenceIntoView(idx, attempt = 0) {
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents[0] || !contents[0].document) return;
            const doc = contents[0].document;
            const win = contents[0].window;
            const activeSpans = doc.querySelectorAll(`.dr-sent[data-sent-idx="${idx}"]`);
            if (!activeSpans.length) return;

            const firstSpan = activeSpans[0];
            const rect = firstSpan.getBoundingClientRect();

            if (rect.width < 1 && attempt < 10) {
                // Zero-width rect => layout not ready; poll until it is.
                setTimeout(() => this._scrollEpubSentenceIntoView(idx, attempt + 1), 80);
                return;
            }

            // Translate iframe-viewport rects into outer-scroller coordinates
            // (the iframe window itself never scrolls under scrolled-doc).
            const frameEl = contents[0].window.frameElement;
            const scroller =
                document.querySelector('#epub-viewer .epub-container') ||
                document.getElementById('epub-viewer') ||
                document.getElementById('epub-container');
            const hasOuter = !!(scroller && frameEl && scroller.scrollHeight - scroller.clientHeight > 10);
            let top = rect.top, bottom = rect.bottom, vh = win.innerHeight || 600;
            if (hasOuter) {
                const fTop = frameEl.getBoundingClientRect().top;
                const sTop = scroller.getBoundingClientRect().top;
                vh = scroller.clientHeight || vh;
                top = fTop + rect.top - sTop;
                bottom = fTop + rect.bottom - sTop;
            }

            const inBand = top > vh * 0.2 && bottom < vh * 0.8;
            if (!inBand) {
                if (hasOuter) {
                    const target = Math.max(0, scroller.scrollTop + (top + bottom) / 2 - vh / 2);
                    try { scroller.scrollTo({ top: target, behavior: 'smooth' }); }
                    catch (e) { firstSpan.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
                } else {
                    firstSpan.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            }
        } catch(e) {
            console.warn('[EPUB] Sentence scroll failed:', e);
        }
    }

    /* Swap the 'dr-sentence-active' class from the old sentence to `idx`,
     * tagging every fragment of multi-line sentences with start/middle/end
     * markers (CSS rounds corners only on the outer fragments). Only the
     * previously-active fragments are touched (cached), not the whole chapter. */
    _syncActiveSentenceClass(idx) {
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents[0] || !contents[0].document) return;
            const doc = contents[0].document;

            const clearOne = (el) => {
                try {
                    if (!el.isConnected) return;
                    el.classList.remove('dr-sentence-active');
                    if (!el.classList.contains('dr-sentence-hover')) {
                        el.classList.remove('dr-fragment-start', 'dr-fragment-middle', 'dr-fragment-end');
                    }
                } catch (e) {}
            };
            const prev = this._lastActiveFrags || [];
            if (prev.length) {
                prev.forEach(clearOne);
            } else {
                doc.querySelectorAll('.dr-sent.dr-sentence-active').forEach(clearOne);
            }
            this._lastActiveFrags = [];

            const fragments = doc.querySelectorAll(`.dr-sent[data-sent-idx="${idx}"]`);
            fragments.forEach((el, i) => {
                el.classList.add('dr-sentence-active');
                if (fragments.length > 1) {
                    if (i === 0) el.classList.add('dr-fragment-start');
                    else if (i === fragments.length - 1) el.classList.add('dr-fragment-end');
                    else el.classList.add('dr-fragment-middle');
                }
            });
            this._lastActiveFrags = Array.from(fragments);
        } catch(e) {}
    }

    /* Remove active-sentence classes and any legacy epub.js annotation
     * highlights from the current chapter document. */
    _clearHighlights() {
        try {
            const contents = this.rendition.getContents();
            if (contents && contents[0] && contents[0].document) {
                const doc = contents[0].document;
                doc.querySelectorAll('.dr-sent.dr-sentence-active')
                   .forEach(el => {
                       el.classList.remove('dr-sentence-active');
                       if (!el.classList.contains('dr-sentence-hover')) {
                           el.classList.remove('dr-fragment-start', 'dr-fragment-middle', 'dr-fragment-end');
                       }
                   });
                try { this.rendition.annotations.remove('epub-reading-hl', 'highlight'); } catch(e) {}
                doc.querySelectorAll('mark.epub-reading-hl').forEach(m => {
                    if (m.parentNode) m.parentNode.replaceChild(doc.createTextNode(m.textContent), m);
                });
            }
        } catch(e) {}
    }

    /* Public render entry point. epub.js's display() is NOT reentrant —
     * concurrent calls corrupt the rendition. Chaining every request onto
     * _renderChain serializes them; the rejected-callback also uses `run` so a
     * failed render doesn't poison the chain for subsequent renders.
     * Returns the chained promise (resolves with {text, sentences} or null). */
    renderPage(pageNumArg, targetHref = null) {
        const run = () => this._doRenderPage(pageNumArg, targetHref);
        this._renderChain = (this._renderChain || Promise.resolve()).then(run, run);
        return this._renderChain;
    }

    /* Wait for the displayed chapter iframe to finish loading, with a ~3s
     * deadline so a stuck document can't wedge the serialized _renderChain
     * forever (unbounded polling here used to block all future renders). */
    _awaitChapterReady() {
        return new Promise(r => {
            let n = 0;
            const check = () => {
                if (this._destroyed || !this.rendition) return r();
                try {
                    const contents = this.rendition.getContents();
                    const doc = contents && contents[0] && contents[0].document;
                    if (doc && doc.readyState === 'complete') return r();
                } catch(e) {}
                if (++n >= 150) return r(); // ~3s: continue best-effort
                setTimeout(check, 20);
            };
            setTimeout(check, 20);
        });
    }

    /* Actual chapter render (always invoked serialized via _renderChain).
     * Displays the spine item (or explicit href), waits for the iframe doc to
     * reach readyState 'complete' by polling (bails immediately if destroyed),
     * applies fragment/top-of-chapter scroll, re-asserts theme/styles/focus,
     * then extracts text + sentence spans for TTS. */
    async _doRenderPage(pageNum, targetHref = null) {
        if (this._destroyed) return;
        try {
            // Clamp to valid spine range — callers may pass out-of-range pages.
            const safePageNum = Math.max(1, Math.min(pageNum, this.pageCount));
            const item = this.spineItems[safePageNum - 1];
            if (!item) return null;

            const hrefToRender = targetHref || item.href;
            const fragment = hrefToRender.includes('#') ? hrefToRender.split('#')[1] : null;

            try {
                await this.rendition.display(hrefToRender);
                // display() resolves before the iframe finishes loading; poll
                // for readyState==='complete' (bounded, with a destroy escape
                // hatch) so text extraction doesn't race the DOM.
                await this._awaitChapterReady();
            } catch(e) {
                console.warn('Custom href display failed, falling back to canonical spine href:', e);
                // Same readiness poll for the fallback path.
                await this.rendition.display(item.href);
                await this._awaitChapterReady();
            }

            if (fragment) {
                try {
                    const contents = this.rendition.getContents();
                    if (contents && contents[0] && contents[0].document) {
                        const doc = contents[0].document;
                        const el = doc.getElementById(fragment) || doc.querySelector(`[name="${fragment}"]`);
                        if (el) this._scrollEpubElIntoView(el, true);
                    }
                } catch(e) {}
            } else {
                this._scrollEpubToTop(false);
            }

            // Re-assert per-document styling that epub.js may have reset on
            // the fresh iframe (same set + order as the content hook, so a
            // fresh document never loses highlight/syntax CSS).
            this.currentPage = safePageNum;
            this._ensureCurrentTheme();
            this._injectReadingStyle();
            this._injectHighlightStyle();
            try {
                const contents = this.rendition.getContents();
                const hdoc = contents && contents[0] && contents[0].document;
                if (hdoc) {
                    this._injectSyntaxHighlightCss(hdoc);
                    this._ensureLineBadge(hdoc);
                }
            } catch(e) {}
            this._injectFocusModeStyle();
            if (this._focusMode) {
                try {
                    const contents = this.rendition.getContents();
                    if (contents && contents[0] && contents[0].document) {
                        contents[0].document.body.classList.add('dr-focus-mode');
                    }
                } catch(e) {}
            }
            this._lastHighlightNormIndex = 0; 
            
            const { text, sentences: extSentences, sentenceCfiMap } = this._extractTextFromRendition();
            this.currentText = text;
            // Prefer the extractor's skip-trimmed list (matches the DOM
            // data-sent-idx ordinals); fall back to a re-split for safety.
            this.currentSentences = (extSentences && extSentences.length !== undefined)
                ? extSentences : splitIntoTTSChunks(text, 250);
            this.sentenceCfiMap = sentenceCfiMap;
            this._lastActiveFrags = []; // chapter DOM was rebuilt
            
            return { text, sentences: this.currentSentences };
        } catch (err) {
            console.error('EPUB render error:', err);
            return null;
        }
    }

    /* Inject the base reading stylesheet (fonts, scrollbar hiding, layout
     * rules) into a chapter document. Also applies epubSidePadding directly
     * on body — this method is the sole owner of padding, which is why
     * _buildThemeCss excludes it. */
    _injectReadingStyle(targetDoc) {
        if (!this.rendition) {
            _dlog('[EPUB] Skipping reading-style injection – rendition not ready');
            return;
        }
        try {
            let doc = targetDoc;
            if (!doc) {
                const contents = this.rendition.getContents();
                if (!contents || !contents.length) return;
                doc = contents[0].document;
            }
            if (!doc || !doc.head) return;

            if (doc.body) {
                doc.body.style.padding = `20px ${epubSidePadding}px 60px`;
            }

            const id = 'epub-reader-style';
            let s = doc.getElementById(id);
            if (!s) {
                s = doc.createElement('style');
                s.id = id;
                doc.head.appendChild(s);
            }
            s.textContent = `
                @font-face { font-family: 'Mononoki'; src: url('${window.location.origin}/static/fonts/mononoki-Regular.ttf') format('truetype'); }
                * {
                    font-family: 'Mononoki', monospace !important; 
                    box-sizing: border-box !important; 
                    max-width: 100% !important;
                    scrollbar-width: none !important;
                    -ms-overflow-style: none !important;
                }
                ::-webkit-scrollbar {
                    display: none !important;
                    width: 0 !important;
                    height: 0 !important;
                    background: transparent !important;
                }
                .epub-container, .epub-view, 
                .epub-container *, .epub-view *,
                [class*="epub-container"], [class*="epub-view"] {
                    scrollbar-width: none !important;
                    -ms-overflow-style: none !important;
                }
                .epub-container::-webkit-scrollbar, .epub-view::-webkit-scrollbar,
                .epub-container *::-webkit-scrollbar, .epub-view *::-webkit-scrollbar,
                [class*="epub-container"]::-webkit-scrollbar, [class*="epub-view"]::-webkit-scrollbar {
                    display: none !important;
                    width: 0 !important;
                    height: 0 !important;
                    background: transparent !important;
                }
                html, body {
                    overflow-x: hidden !important;
                    overflow-y: auto !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    margin: 0 !important;
                    scrollbar-width: none !important;
                    -ms-overflow-style: none !important;
                }
                body { 
                    margin: 0 auto !important; 
                    padding: 20px ${epubSidePadding}px 60px !important; 
                    word-wrap: break-word !important; 
                    overflow-wrap: break-word !important; 
                    will-change: scroll-position; 
                    transform: translateZ(0); 
                }
                body.is-scrolling * { pointer-events: none !important; }
                img, svg, figure, video, audio, table { 
                    max-width: 100% !important; 
                    height: auto !important; 
                }
                pre, code, table {
                    overflow-x: auto !important;
                    max-width: 100% !important;
                }
                h1,h2,h3,h4,h5,h6 { margin-top: 1.4em; margin-bottom: 0.5em; line-height: 1.3; }
                p { margin: 0 0 0.9em; }
                a, a:visited, a:hover, a:active {
                    color: inherit !important;
                    text-decoration: underline !important;
                    text-underline-offset: 2px !important;
                    opacity: 0.75;
                }
                a:hover { opacity: 1; }
                .docreader-code-wrapper {
                    background: rgba(120, 120, 120, 0.12) !important;
                    border: 1px solid rgba(120, 120, 120, 0.25) !important;
                    border-radius: 6px !important;
                    padding: 14px !important;
                    margin: 12px 0 !important;
                    overflow-x: auto !important;
                    width: 100% !important;
                    max-width: 100% !important;
                }
                .docreader-code-wrapper p, .docreader-code-wrapper pre, .docreader-code-wrapper div {
                    margin: 0 !important;
                    padding: 0 !important;
                    background: transparent !important;
                    border: none !important;
                    line-height: 1.5 !important;
                    overflow-x: visible !important;
                    white-space: pre !important;
                }
                .docreader-code-wrapper code {
                    overflow-x: visible !important;
                    white-space: pre !important;
                    padding: 0 !important;
                    background: transparent !important;
                }
            `;
        } catch(e) {}
    }

    /* Inject highlight-appearance CSS (driven by the hl* globals) into a
     * chapter document. Fragment corner rules ensure multi-line sentences
     * look like one continuous pill rather than stacked rounded boxes. */
    _injectHighlightStyle(targetDoc) {
        if (!this.rendition) {
            _dlog('[EPUB] Skipping highlight injection – rendition not ready');
            return;
        }
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
            const hoverColor = `rgba(${hlBaseColor}, ${hlHoverOpacity})`;
            const radius = hlRadius + 'px';
            const pad = hlPadding;
            const outlineColor = hlOutline
                ? `rgba(${hlBaseColor}, ${Math.min(1, hlOpacity * 2.5)})`
                : null;
            const outlineShadow = outlineColor
                ? `0 0 0 1px ${outlineColor} !important;`
                : '';

            s.textContent = `
                .dr-sent {
                    cursor: pointer !important;
                    background-color: transparent !important;
                    box-shadow: none !important;
                    transition: background-color 0.08s ease, box-shadow 0.08s ease !important;
                    border-radius: ${radius} !important;
                    padding: ${pad}px ${pad}px !important;
                    margin: 0 !important;
                    box-decoration-break: clone !important;
                    -webkit-box-decoration-break: clone !important;
                }
                .dr-sent.dr-sentence-hover {
                    background-color: ${hoverColor} !important;
                    box-shadow: ${outlineShadow}
                }
                .dr-sent.dr-sentence-active {
                    background-color: ${color} !important;
                    box-shadow: ${outlineShadow}
                }
                .dr-sent.dr-fragment-start.dr-sentence-hover,
                .dr-sent.dr-fragment-start.dr-sentence-active {
                    border-top-right-radius: 0 !important;
                    border-bottom-right-radius: 0 !important;
                }
                .dr-sent.dr-fragment-middle.dr-sentence-hover,
                .dr-sent.dr-fragment-middle.dr-sentence-active {
                    border-radius: 0 !important;
                }
                .dr-sent.dr-fragment-end.dr-sentence-hover,
                .dr-sent.dr-fragment-end.dr-sentence-active {
                    border-top-left-radius: 0 !important;
                    border-bottom-left-radius: 0 !important;
                }
                #dr-line-badge {
                    position: fixed !important;
                    z-index: 99999 !important;
                    pointer-events: none !important;
                    background: #111827 !important;
                    color: #f9fafb !important;
                    font-family: monospace !important;
                    font-size: 12px !important;
                    font-weight: 700 !important;
                    line-height: 1 !important;
                    padding: 5px 8px !important;
                    border-radius: 6px !important;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.35) !important;
                    opacity: 0 !important;
                    transition: opacity 0.12s ease !important;
                    white-space: nowrap !important;
                }
                #dr-line-badge.dr-visible { opacity: 1 !important; }
            `;
        } catch(e) {
            console.warn('Error injecting highlight style:', e);
        }
    }

    /* Inject code-block syntax-highlight CSS into a chapter document: toolbar
     * layout, token colors (light/dark by theme), and the .docreader-hl-off
     * neutralizer used by the per-block toggle. */
    _injectSyntaxHighlightCss(targetDoc) {
        try {
            let doc = targetDoc;
            if (!doc) {
                const contents = this.rendition && this.rendition.getContents();
                if (!contents || !contents.length) return;
                doc = contents[0].document;
            }
            if (!doc || !doc.head) return;

            const pal = HL_PALETTES[hlIsLightTheme(this._currentTheme) ? 'light' : 'dark'];
            let s = doc.getElementById('docreader-hl-style');
            if (!s) {
                s = doc.createElement('style');
                s.id = 'docreader-hl-style';
                doc.head.appendChild(s);
            }
            s.textContent = `
                .docreader-code-wrapper .docreader-code-toolbar {
                    display: flex !important;
                    align-items: center !important;
                    justify-content: space-between !important;
                    gap: 8px !important;
                    margin: -14px -14px 12px !important;
                    padding: 3px 10px !important;
                    background: rgba(120,120,120,0.10) !important;
                    border-bottom: 1px solid rgba(120,120,120,0.20) !important;
                    border-radius: 6px 6px 0 0 !important;
                    font-size: 11px !important;
                    font-family: 'JetBrains Mono', monospace !important;
                    color: ${pal.muted} !important;
                    position: sticky !important;
                    left: 0 !important;
                }
                .docreader-code-wrapper .docreader-code-lang {
                    text-transform: uppercase !important;
                    letter-spacing: 0.5px !important;
                    font-weight: 700 !important;
                    color: ${pal.muted} !important;
                }
                .docreader-code-wrapper .docreader-code-toolbar-actions {
                    display: inline-flex !important;
                    align-items: center !important;
                    gap: 6px !important;
                    margin: 0 !important;
                    padding: 0 !important;
                }
                .docreader-code-wrapper .docreader-code-copy-btn,
                .docreader-code-wrapper .docreader-code-hl-toggle {
                    font: inherit !important;
                    font-weight: 700 !important;
                    color: ${pal.function} !important;
                    background: transparent !important;
                    border: 1px solid rgba(120,120,120,0.35) !important;
                    border-radius: 4px !important;
                    padding: 1px 8px !important;
                    cursor: pointer !important;
                }
                .docreader-code-wrapper .docreader-code-copy-btn:disabled {
                    opacity: 0.7 !important;
                    cursor: default !important;
                }
                .docreader-code-wrapper .docreader-code-copy-btn:hover,
                .docreader-code-wrapper .docreader-code-hl-toggle:hover {
                    background: rgba(120,120,120,0.15) !important;
                }
                .docreader-code-wrapper .hl-keyword   { color: ${pal.keyword} !important; font-weight: 600 !important; }
                .docreader-code-wrapper .hl-type      { color: ${pal.type} !important; }
                .docreader-code-wrapper .hl-string    { color: ${pal.string} !important; }
                .docreader-code-wrapper .hl-char      { color: ${pal.char} !important; }
                .docreader-code-wrapper .hl-comment   { color: ${pal.comment} !important; font-style: italic !important; }
                .docreader-code-wrapper .hl-number    { color: ${pal.number} !important; }
                .docreader-code-wrapper .hl-preprocessor { color: ${pal.preproc} !important; font-weight: 600 !important; }
                .docreader-code-wrapper .hl-operator  { color: ${pal.operator} !important; }
                .docreader-code-wrapper .hl-function  { color: ${pal.function} !important; }
                .docreader-code-wrapper.docreader-hl-off .hl-keyword,
                .docreader-code-wrapper.docreader-hl-off .hl-type,
                .docreader-code-wrapper.docreader-hl-off .hl-string,
                .docreader-code-wrapper.docreader-hl-off .hl-char,
                .docreader-code-wrapper.docreader-hl-off .hl-comment,
                .docreader-code-wrapper.docreader-hl-off .hl-number,
                .docreader-code-wrapper.docreader-hl-off .hl-preprocessor,
                .docreader-code-wrapper.docreader-hl-off .hl-operator,
                .docreader-code-wrapper.docreader-hl-off .hl-function {
                    color: inherit !important;
                    font-weight: inherit !important;
                    font-style: inherit !important;
                }
            `;
        } catch(e) {}
    }

    /* Inject focus-mode CSS: everything except the active sentence fades to
     * ~20% opacity; hover keeps a mid-level opacity as a preview. */
    _injectFocusModeStyle(targetDoc) {
        try {
            let doc = targetDoc;
            if (!doc) {
                const contents = this.rendition.getContents();
                if (!contents || !contents.length) return;
                doc = contents[0].document;
            }
            if (!doc || !doc.head) return;

            const id = 'epub-focus-style';
            let s = doc.getElementById(id);
            if (!s) {
                s = doc.createElement('style');
                s.id = id;
                doc.head.appendChild(s);
            }

            s.textContent = `
                body.dr-focus-mode .dr-sent,
                body.dr-focus-mode img,
                body.dr-focus-mode svg,
                body.dr-focus-mode figure {
                    opacity: 0.2 !important;
                    filter: saturate(0.5) blur(0.15px) !important;
                    transition: opacity 0.4s ease, filter 0.4s ease !important;
                }
                body.dr-focus-mode .dr-sent.dr-sentence-active {
                    opacity: 1 !important;
                    filter: none !important;
                    text-shadow: 0 0 22px rgba(${hlBaseColor}, 0.35) !important;
                }
                body.dr-focus-mode .dr-sent.dr-sentence-hover:not(.dr-sentence-active) {
                    opacity: 0.55 !important;
                    filter: none !important;
                }
            `;
        } catch(e) {}
    }

    /* Toggle focus mode on the live chapter document (style + body class). */
    setFocusMode(enabled) {
        this._focusMode = !!enabled;
        try {
            const contents = this.rendition && this.rendition.getContents();
            if (contents && contents[0] && contents[0].document) {
                const doc = contents[0].document;
                this._injectFocusModeStyle(doc);
                doc.body.classList.toggle('dr-focus-mode', this._focusMode);
            }
        } catch(e) {}
    }

    clearHighlights() { this._clearHighlights(); }

    /* ─── Line-number badge (hover on desktop, long-press on mobile) ───
     * One fixed-position div per chapter iframe (id dr-line-badge). Created
     * lazily so re-renders / theme injections never duplicate it. All
     * methods are null-safe: they no-op when the rendition/doc is gone. */
    _ensureLineBadge(targetDoc) {
        try {
            let doc = targetDoc;
            if (!doc) {
                const contents = this.rendition && this.rendition.getContents();
                if (!contents || !contents.length) return null;
                doc = contents[0].document;
            }
            if (!doc || !doc.body) return null;
            let badge = doc.getElementById('dr-line-badge');
            if (!badge) {
                badge = doc.createElement('div');
                badge.id = 'dr-line-badge';
                badge.setAttribute('aria-hidden', 'true');
                doc.body.appendChild(badge);
            }
            return badge;
        } catch(e) { return null; }
    }

    _showLineBadge(targetDoc, x, y, sentIdx) {
        try {
            const badge = this._ensureLineBadge(targetDoc);
            if (!badge) return;
            badge.textContent = 'Line ' + (sentIdx + 1);
            badge.classList.add('dr-visible');
            // Clamp inside the iframe viewport so the badge never clips.
            const win = targetDoc && targetDoc.defaultView;
            const vw = (win && win.innerWidth) || 400;
            const bx = Math.max(4, Math.min(x + 14, vw - 90));
            const by = Math.max(4, y - 30);
            badge.style.left = bx + 'px';
            badge.style.top = by + 'px';
        } catch(e) {}
    }

    _showLineBadgeAtRect(targetDoc, rect, sentIdx) {
        try {
            if (!rect) return;
            // Anchor above the sentence; fall back below it near the top edge.
            const y = rect.top < 40 ? rect.bottom + 8 : rect.top;
            this._showLineBadge(targetDoc, rect.left + rect.width / 2 - 14, y, sentIdx);
        } catch(e) {}
    }

    _hideLineBadge(targetDoc) {
        try {
            let doc = targetDoc;
            if (!doc) {
                const contents = this.rendition && this.rendition.getContents();
                if (!contents || !contents.length) return;
                doc = contents[0].document;
            }
            const badge = doc && doc.getElementById && doc.getElementById('dr-line-badge');
            if (badge) badge.classList.remove('dr-visible');
        } catch(e) {}
    }

    /* Resize the rendition. Same-scale calls are skipped (see setZoom) so a
     * settings_sync echo can't cancel an in-flight scroll restore; real size
     * changes go through the reflow-preserve wrapper to keep reading position. */
    setZoom(scale) {
        // Ignore no-op zoom calls (e.g. settings_sync echoes of our own saves) —
        // running the reflow-preserve machinery for them would fight the
        // load-time scroll restore and dim the reader during playback.
        // Epsilon compare: slider floats (1.5 vs 1.5000001) must not rebuild.
        if (this._lastAppliedScale !== null && this._lastAppliedScale !== undefined &&
            Math.abs(this._lastAppliedScale - scale) < 1e-4) return;
        this._reflowPreservingPosition(() => this._applyScale(scale));
    }
    /* Theme switch entry point. 50ms debounce coalesces rapid toggling; if
     * the rendition doesn't exist yet the theme is only stored and applied
     * later by _ensureCurrentTheme() during render. */
    setTheme(theme) {
        // Rendition may not exist yet (e.g. theme restored during document load).
        // Store it; load()/renderPage will apply via _ensureCurrentTheme().
        this._currentTheme = theme || localStorage.getItem('docreader-theme') || 'default-light';
        if (!this.rendition) return;
        // Coalesce rapid toggles into a single application pass
        clearTimeout(this._themeApplyTimer);
        this._themeApplyTimer = setTimeout(() => {
            if (this._destroyed || !this.rendition) return;
            this._applyCurrentTheme(this._currentTheme);
        }, 50);
    }

    resize(width, height) {
        if (this.rendition && width > 0 && height > 0) {
            try { this.rendition.resize(width, height); } catch(e) {}
        }
    }

    /* Find every element that actually participates in scrolling the reader.
       For flow:'scrolled-doc', epub.js scrolls its own .epub-container div —
       NOT the iframe window, which always stays at scrollY 0. */
    _epubScrollTargets() {
        const targets = [];
        try {
            const contents = this.rendition.getContents();
            if (contents && contents[0] && contents[0].window) {
                const win = contents[0].window;
                const docEl = contents[0].document.documentElement || contents[0].document.body;
                if (docEl && docEl.scrollHeight - win.innerHeight > 10) {
                    targets.push({
                        name: 'iframe',
                        getY: () => win.scrollY,
                        maxY: () => Math.max(0, docEl.scrollHeight - win.innerHeight),
                        setY: (y) => win.scrollTo(0, y)
                    });
                }
            }
        } catch(e) {}
        const candidates = [
            document.querySelector('#epub-viewer .epub-container'),
            document.getElementById('epub-viewer'),
            document.getElementById('epub-container')
        ];
        candidates.forEach(el => {
            if (el && el.scrollHeight - el.clientHeight > 10) {
                targets.push({
                    name: 'dom:' + (el.className || el.id),
                    el,
                    getY: () => el.scrollTop,
                    maxY: () => Math.max(0, el.scrollHeight - el.clientHeight),
                    setY: (y) => { el.scrollTop = y; }
                });
            }
        });
        return targets;
    }

    /* The real viewport scroller under flow:'scrolled-doc' (the outer
     * .epub-container div — the iframe window itself never scrolls). */
    _outerEpubScroller() {
        try {
            const cands = [
                document.querySelector('#epub-viewer .epub-container'),
                document.getElementById('epub-viewer'),
                document.getElementById('epub-container')
            ];
            for (const el of cands) {
                if (el && el.scrollHeight - el.clientHeight > 10) return el;
            }
        } catch(e) {}
        return null;
    }

    /* Scroll an in-chapter element into view through the outer scroller
     * (el.scrollIntoView targets the wrong viewport under scrolled-doc). */
    _scrollEpubElIntoView(el, smooth = true) {
        try {
            const s = this._outerEpubScroller();
            if (s) {
                const sr = s.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                const top = Math.max(0, s.scrollTop + (r.top - sr.top) - 8);
                try { s.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' }); return true; }
                catch (e) { s.scrollTop = top; return true; }
            }
        } catch(e) {}
        try { el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }); return true; }
        catch (e) {}
        return false;
    }

    _scrollEpubToTop(smooth = true) {
        try {
            const s = this._outerEpubScroller();
            if (s) {
                try { s.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' }); return true; }
                catch (e) { s.scrollTop = 0; return true; }
            }
        } catch(e) {}
        return false;
    }

    /* Anchor = the topmost visible sentence. Stored as the sentence index
       (data-sent-idx), NOT the raw span-list position: one sentence produces
       N .dr-sent fragments (one per text node), so a flat ordinal can point
       at the wrong sentence after re-fragmentation. */
    _captureTopAnchor() {
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents[0] || !contents[0].document) return null;
            const c = contents[0];
            const frameEl = c.window.frameElement;
            const spans = c.document.querySelectorAll('.dr-sent');
            if (!frameEl || !spans.length) return null;
            const scroller =
                document.querySelector('#epub-viewer .epub-container') ||
                document.getElementById('epub-viewer') ||
                document.getElementById('epub-container');
            if (!scroller || scroller.scrollHeight - scroller.clientHeight <= 10) return null;
            const iframeTop = frameEl.getBoundingClientRect().top;
            const sTop = scroller.getBoundingClientRect().top;
            let bestIdx = -1, bestTop = Infinity;
            for (let i = 0; i < spans.length; i++) {
                const r = spans[i].getBoundingClientRect();
                if (r.height < 1) continue;
                const topInPage = iframeTop + r.top;
                if (iframeTop + r.bottom < sTop + 1) continue; // fully above viewport
                if (topInPage < bestTop) { bestTop = topInPage; bestIdx = i; }
            }
            if (bestIdx === -1) return null;
            const sentIdx = Number(spans[bestIdx].getAttribute('data-sent-idx'));
            if (!Number.isInteger(sentIdx)) return null;
            return { sentIdx, delta: Math.max(0, bestTop - sTop), total: spans.length };
        } catch(e) { return null; }
    }

    /* Scroll so the anchored sentence sits at its pre-resize viewport offset.
       Returns false while the chapter is still being re-displayed/re-injected. */
    _applyTopAnchor(anchor) {
        if (!anchor || !Number.isInteger(anchor.sentIdx)) return false;
        try {
            const contents = this.rendition.getContents();
            if (!contents || !contents[0] || !contents[0].document) return false;
            const c = contents[0];
            const frameEl = c.window.frameElement;
            const frags = c.document.querySelectorAll(`.dr-sent[data-sent-idx="${anchor.sentIdx}"]`);
            if (!frameEl || !frags.length) return false;
            const scroller =
                document.querySelector('#epub-viewer .epub-container') ||
                document.getElementById('epub-viewer') ||
                document.getElementById('epub-container');
            if (!scroller || scroller.scrollHeight - scroller.clientHeight <= 10) return false;
            const sp = frags[0];
            const r = sp.getBoundingClientRect();
            if (r.height < 1) return false;
            const iframeTop = frameEl.getBoundingClientRect().top;
            const sTop = scroller.getBoundingClientRect().top;
            const diff = ((iframeTop + r.top) - sTop) - anchor.delta;
            if (Math.abs(diff) > 2) {
                scroller.scrollTop = Math.max(0, scroller.scrollTop + diff);
                _dlog('anchor applied: sent#', anchor.sentIdx, 'shift', Math.round(diff));
            }
            return true;
        } catch(e) { return false; }
    }

    /* Snapshot scroll offsets of every real scroller (pixel fallback for when
     * no sentence spans exist yet, e.g. before first render). */
    _restorePixelOffsets(saved) {
        let applied = false;
        this._epubScrollTargets().forEach(t => {
            const s = saved.find(x => x.name === t.name);
            if (!s) return;
            let max = 0;
            try { max = t.maxY(); } catch(e) {}
            // Content not laid out yet (rebuild in flight): report failure so
            // the caller keeps retrying instead of settling at scrollTop 0.
            if (max <= 10) return;
            const target = Math.min(s.prevY, max);
            if (Math.abs(t.getY() - target) > 2) t.setY(target);
            applied = true;
        });
        return applied;
    }

    /* Run a mutation that reflows the chapter (resize, padding, font size)
       while keeping the reader anchored to the same reading position.
       NOTE: epub.js's manager.resize() clears all views and then ASYNC-
       re-displays the section from its start CFI, which resets scroll and
       wipes .dr-sent spans. So the settle chain is: wait for the rebuilt
       document -> re-wrap sentence spans -> restore the anchor. Reflows are
       SERIALIZED: a request arriving mid-reflow is coalesced (latest wins)
       because overlapping rendition.resize() calls corrupt epub.js state
       (blank iframe). opts.onSettled({rewrapped}) fires exactly once per run.
       We anchor to the topmost visible sentence span so the line that was
       at the top of the view stays there regardless of text reflow. */
    _reflowPreservingPosition(mutate, opts = {}) {
        if (!this.rendition || this._destroyed) return;
        // Coalesce overlapping reflows (sidebar toggle + ResizeObserver, or
        // devtools resize bursts, otherwise fire together). Anchor is
        // captured fresh when the queued run executes.
        if (this._reflowActive) {
            this._reflowQueued = { mutate, opts };
            return;
        }
        this._reflowActive = true;

        const anchor = this._captureTopAnchor();
        const pixelFallback = this._epubScrollTargets().map(t => ({ name: t.name, prevY: t.getY() }));
        _dlog('reflow preserving position:',
            anchor ? `anchor=sent#${anchor.sentIdx}/${anchor.total} delta=${Math.round(anchor.delta)}`
                   : 'anchor=none (pixel fallback)',
            'offsets:', pixelFallback.map(s => s.name + '=' + Math.round(s.prevY)).join(', ') || 'none');

        let settled = false;
        let pendingTimer = null;
        let rewrapped = false;
        // Dim the reader while the chapter rebuilds so the intermediate
        // "jumped to top" frame is never visible. 3s failsafe undims even if
        // events never fire (prevents a permanently black reader).
        const scrollerEl =
            document.querySelector('#epub-viewer .epub-container') ||
            document.getElementById('epub-viewer') ||
            document.getElementById('epub-container');
        // Re-query at undim time: the rebuild may have replaced the dimmed
        // element, and a stale reference would leave the new one dark.
        const undim = () => {
            try {
                if (scrollerEl) scrollerEl.style.opacity = '';
                ['#epub-viewer .epub-container', '#epub-viewer', '#epub-container'].forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => { el.style.opacity = ''; });
                });
            } catch(e) {}
        };
        if (scrollerEl) {
            clearTimeout(scrollerEl._dimFailsafe);
            scrollerEl.style.transition = 'opacity 80ms linear';
            scrollerEl.style.opacity = '0';
            scrollerEl._dimFailsafe = setTimeout(undim, 3000); // failsafe
        }
        const cleanup = () => {
            try {
                this.rendition.off('rendered', onRerendered);
                this.rendition.off('displayed', onRerendered);
            } catch(e) {}
            clearTimeout(pendingTimer);
            undim();
        };
        const finish = () => {
            this._reflowActive = false;
            try { if (opts.onSettled) opts.onSettled({ rewrapped }); } catch(e) {}
            const q = this._reflowQueued;
            this._reflowQueued = null;
            if (q && !this._destroyed && this.rendition) {
                this._reflowPreservingPosition(q.mutate, q.opts);
            }
        };
        const done = () => {
            if (settled) return;
            settled = true;
            cleanup();
            finish();
        };
        const retry = (n) => {
            if (n < 60) pendingTimer = setTimeout(() => attempt(n + 1), 50);
            else done(); // give up (~3s): keep old sentences, never clobber
        };
        const attempt = (n = 0) => {
            if (settled || this._destroyed || !this.rendition) return;
            try {
                const contents = this.rendition.getContents();
                const cdoc = contents && contents[0] && contents[0].document;
                if (!cdoc || !cdoc.body || cdoc.readyState !== 'complete') return retry(n);
                // Rebuilds wipe .dr-sent spans: re-wrap before restoring, so
                // the anchor exists and `sentences` matches the live DOM.
                let spans = null;
                try { spans = cdoc.querySelectorAll('.dr-sent'); } catch(e) {}
                const hadSentences = !!(this.currentSentences && this.currentSentences.length);
                if ((!spans || spans.length === 0) && hadSentences) {
                    try {
                        const { text, sentences: extSentences } = this._extractTextFromRendition();
                        const prevLen = (this.currentText || '').length;
                        // Clobber guard: a mid-rebuild chapter yields empty or
                        // partial text — wait for more instead of corrupting
                        // `sentences` (which would kill highlighting).
                        if (text && text.length >= 20 &&
                            (prevLen < 100 || text.length >= prevLen * 0.5)) {
                            this.currentText = text;
                            this.currentSentences = (extSentences && extSentences.length !== undefined)
                                ? extSentences : splitIntoTTSChunks(text, 250);
                            this.sentenceCfiMap = {};
                            rewrapped = true;
                        } else {
                            return retry(n);
                        }
                    } catch(e) { return retry(n); }
                }
                // Prefer sentence-ordinal anchoring; degrade to raw pixel offsets.
                const ok = anchor ? this._applyTopAnchor(anchor) : this._restorePixelOffsets(pixelFallback);
                if (ok) { done(); return; }
            } catch(e) {}
            return retry(n);
        };
        // Event-driven restore: epub.js fires 'rendered'/'displayed' after the
        // async re-display; each event restarts the bounded retry loop.
        const onRerendered = () => {
            clearTimeout(pendingTimer);
            attempt(0);
        };

        try {
            this.rendition.on('rendered', onRerendered);
            this.rendition.on('displayed', onRerendered);
        } catch(e) {}

        try { mutate(); } catch(e) {}

        // Kick immediately and again shortly after, in case no event fires.
        // The second kick is skipped if the first already armed a retry, so
        // two attempt loops can't run in parallel with orphaned timers.
        attempt(0);
        if (!pendingTimer) pendingTimer = setTimeout(() => attempt(0), 120);
    }

    /* Public wrapper: resize the rendition while preserving reading position.
     * Serialized with other reflows (see _reflowPreservingPosition); opts
     * passes through (e.g. {onSettled}). */
    resizePreservingScroll(width, height, opts) {
        if (!this.rendition || !(width > 0) || !(height > 0)) return;
        this._reflowPreservingPosition(() => {
            try { this.rendition.resize(width, height); } catch(e) {}
        }, opts || {});
    }

    /* Precompute character length of every spine chapter (for time
     * estimates). Yields to idle between loads so it never competes with
     * rendering; results land incrementally in chapterCharMap. */
    async _loadChapterStats() {
        if (!this.book || !this.book.spine) return;
        const items = this.spineItems;
        for (let i = 0; i < items.length; i++) {
            // Abort on close/switch: don't compete with the new book's display().
            if (this._destroyed || !this.book) return;
            try {
                const content = await this.book.load(items[i].href);
                let len = 0;
                if (typeof content === 'string') {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(content, 'application/xhtml+xml');
                    len = doc.body ? doc.body.textContent.length : 0;
                } else if (content && content.body) {
                    len = content.body.textContent.length;
                } else if (content && content.textContent) {
                    len = content.textContent.length;
                }
                this.chapterCharMap[i] = len;
            } catch(e) { this.chapterCharMap[i] = 0; }
            if (i < items.length - 1)
                await new Promise(r => typeof requestIdleCallback !== 'undefined' ? requestIdleCallback(r) : setTimeout(r, 10));
        }
    }

    /* Rough remaining-chapter time estimate: assumes ~5 chars/word and
     * ~150 words/min at 1x speed, scaled by playback speed. */
    getChapterTime(pageNum, speed) {
        if (!this.book || !this.book.spine) return 0;
        const items = this.spineItems;
        let total = 0;
        for (let i = pageNum - 1; i < items.length; i++)
            total += (this.chapterCharMap[i] || 0);
        return (total / 5 / (150 * speed)) * 60;
    }

    /* Tear down everything. Setting _destroyed first makes all pending polls
     * and chained renders bail out on their next tick. */
    destroy() {
        this._destroyed = true;
        clearTimeout(this._themeApplyTimer);
        // The resize observer + debounce timers live on window (see loadEPUB);
        // clear them here too so they can't fire into a dead handler.
        if (window._epubResizeObserver) { try { window._epubResizeObserver.disconnect(); } catch(e) {} }
        if (window._epubRoResizeTimer) { clearTimeout(window._epubRoResizeTimer); window._epubRoResizeTimer = null; }
        if (window._epubResizeDebounce) { clearTimeout(window._epubResizeDebounce); window._epubResizeDebounce = null; }
        // Unstick the reflow serializer + any dimmed scroller.
        this._reflowActive = false;
        this._reflowQueued = null;
        try {
            ['#epub-viewer .epub-container', '#epub-viewer', '#epub-container'].forEach(sel => {
                document.querySelectorAll(sel).forEach(el => { el.style.opacity = ''; });
            });
        } catch(e) {}
        this._renderChain = null;
        this._lastActiveFrags = [];
        if (this._epubResizeObserver) { try { this._epubResizeObserver.disconnect(); } catch(e) {} }
        if (this.rendition) { try { this.rendition.destroy(); } catch(e) {} this.rendition = null; }
        if (this.book)      { try { this.book.destroy();      } catch(e) {} this.book = null; }
        this.spineItems = [];
        this.currentSentences = [];
        this.sentenceCfiMap = {};
    }
}

// Startup: restore persisted theme and keep the selector in sync afterwards.
const savedTheme = localStorage.getItem('docreader-theme') || 'default-light';
applyTheme(savedTheme);
if (themeSelector) {
    themeSelector.addEventListener('change', () => {
        applyTheme(themeSelector.value);
    });
}

/* ─── PDF Load ─── */
/* Open a PDF: bump docGeneration (any in-flight work from the previous doc
 * aborts after its next await), tear down any EPUB handler, swap containers,
 * parse with pdf.js, then kick off background full-text indexing of every
 * page for search. */
async function loadPDF(file, startPage = 1) {
    const gen = ++docGeneration;
    currentSearchId++; // invalidate in-flight searches from the previous document
    pageIsRendering = false; // stale renders bail via gen guard; drop queued turns
    pageNumPending = null;
    console.log(`[PDF] Loading: "${file.name}" (${(file.size / 1024 / 1024).toFixed(2)} MB), startPage=${startPage}`);
    showLoading('Loading document…');
    // Stop the old book's playback/fetch state before replacing anything.
    stopPipeline();
    clearPageAudioCache();
    chapterStartPage = null;
    chapterEndPage = null;
    // Tear down the previous PDF document and its blob URL (no leaks across books).
    try { if (pdfDoc && pdfDoc.destroy) await pdfDoc.destroy(); } catch (e) {}
    pdfDoc = null;
    if (currentFileUrl) { try { URL.revokeObjectURL(currentFileUrl); } catch (e) {} currentFileUrl = null; }
    currentFile = file;
    currentFileName = file.name || 'Document';
    const fileUrl = URL.createObjectURL(file);
    currentFileUrl = fileUrl;

    welcomeScreen.classList.remove('active');
    readerScreen.classList.add('active');

    if (documentHandler && documentHandler instanceof EPUBHandler) {
        documentHandler.destroy();
        documentHandler = null;
    }
    document.getElementById('epub-container').style.display = 'none';
    document.getElementById('pdf-container').style.display = '';

    try {
        const task = pdfjsLib.getDocument(fileUrl);
        const doc = await task.promise;
        // Another loadPDF/loadEPUB won while we awaited — abandon silently.
        if (gen !== docGeneration) return;
        pdfDoc = doc;
        searchAllPageTexts = {};
        Object.keys(pageStats).forEach(k => delete pageStats[k]);
        // Background indexer: 4 workers pull page numbers from a shared
        // cursor, extract plain text, and store it for search. Every await
        // re-checks the generation token so a superseded document stops early.
        (async function indexAllPages() {
            try {
                const texts = new Array(doc.numPages);
                let nextIdx = 0;
                const worker = async () => {
                    while (nextIdx < doc.numPages) {
                        if (gen !== docGeneration) return;
                        const p = ++nextIdx;
                        const page = await doc.getPage(p);
                        if (gen !== docGeneration) return;
                        const tc = await page.getTextContent();
                        if (gen !== docGeneration) return;
                        texts[p - 1] = tc.items.map(i => i.str).join(' ');
                    }
                };
                await Promise.all(Array.from({ length: Math.min(4, doc.numPages) }, worker));
                // Merge only if this document is still the active one
                if (gen !== docGeneration) return;
                for (let p = 1; p <= doc.numPages; p++) {
                    if (texts[p - 1] !== undefined) searchAllPageTexts[p] = texts[p - 1];
                }
            } catch(e) { console.warn('Indexing error:', e); }
        })();

        // Reset per-book UI state and cached duration estimates.
        tocList.innerHTML = '';
        tocEmpty.style.display = 'block';
        Object.keys(chapterDurationCache).forEach(k => delete chapterDurationCache[k]);
        Object.keys(pageDurationCache).forEach(k => delete pageDurationCache[k]);
        Object.keys(pendingChapterDurations).forEach(k => delete pendingChapterDurations[k]);
        Object.keys(pendingPageDurations).forEach(k => delete pendingPageDurations[k]);

        topbarFilename.textContent = currentFileName;
        document.title = `DocReader Pro — ${currentFileName}`;
        document.getElementById('page-count').textContent = pdfDoc.numPages;
        pageJumpInput.max = pdfDoc.numPages;

        // Restore this book's saved settings (position, appearance, TTS prefs).
        const settings = await loadSettings(currentFileName);
        if (gen !== docGeneration) return;
        if (settings) {
            const savedPage = Number.isInteger(settings.page) && settings.page >= 1 ? settings.page : 1;
            pageNum = Math.max(1, Math.min(savedPage, pdfDoc.numPages));
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

            if (settings.epubSidePadding !== undefined) {
                epubSidePadding = settings.epubSidePadding;
                document.getElementById('epub-padding-slider').value = epubSidePadding;
                document.getElementById('epub-padding-val').textContent = epubSidePadding + 'px';
                if (documentHandler instanceof EPUBHandler) {
                    documentHandler._injectReadingStyle();
                }
            }

            if (settings.focusModeEnabled !== undefined) {
                focusModeEnabled = settings.focusModeEnabled;
                document.getElementById('focus-mode-toggle').checked = focusModeEnabled;
                document.getElementById('focus-mode-btn').classList.toggle('active', focusModeEnabled);
                if (documentHandler instanceof EPUBHandler) {
                    documentHandler.setFocusMode(focusModeEnabled);
                }
            }

            if (settings.theme) {
                applyTheme(settings.theme);
            }

            if (settings.voice) {
                const voiceSelector = document.getElementById('voice-selector');
                if (voiceSelector && voiceSelector.querySelector(`option[value="${settings.voice}"]`)) {
                    voiceSelector.value = settings.voice;
                }
            }

            if (settings.autoReadNext !== undefined) {
                document.getElementById('auto-read-next').checked = settings.autoReadNext;
            }

            if (settings.saveAudioEnabled !== undefined) {
                saveAudioEnabled = settings.saveAudioEnabled;
                document.getElementById('save-audio-toggle').checked = saveAudioEnabled;
                document.getElementById('save-range-row').style.display = saveAudioEnabled ? 'flex' : 'none';
            }

            if (settings.hlBaseColor !== undefined) {
                hlBaseColor = settings.hlBaseColor;
                document.querySelectorAll('.hl-preset').forEach(btn => {
                    btn.classList.remove('active');
                    const presetRGB = HL_PRESETS[btn.dataset.color];
                    if (presetRGB === hlBaseColor) btn.classList.add('active');
                });
            }

            if (settings.hlOpacity !== undefined) {
                hlOpacity = settings.hlOpacity;
                document.getElementById('hl-opacity-slider').value = Math.round(hlOpacity * 100);
                document.getElementById('hl-opacity-val').textContent = Math.round(hlOpacity * 100) + '%';
            }

            if (settings.hlHoverOpacity !== undefined) {
                hlHoverOpacity = settings.hlHoverOpacity;
                document.getElementById('hl-hover-opacity-slider').value = Math.round(hlHoverOpacity * 100);
                document.getElementById('hl-hover-opacity-val').textContent = Math.round(hlHoverOpacity * 100) + '%';
            }

            if (settings.hlRadius !== undefined) {
                hlRadius = settings.hlRadius;
                document.getElementById('hl-radius-slider').value = hlRadius;
                document.getElementById('hl-radius-val').textContent = hlRadius + 'px';
            }

            if (settings.hlPadding !== undefined) {
                hlPadding = settings.hlPadding;
                document.getElementById('hl-padding-slider').value = hlPadding;
                document.getElementById('hl-padding-val').textContent = hlPadding + 'px';
            }

            if (settings.hlOutline !== undefined) {
                hlOutline = settings.hlOutline;
                document.getElementById('hl-outline-toggle').checked = hlOutline;
            }

            applyHighlightSettings();
        } else {
            // No saved settings: on narrow screens auto-fit page 1 to width.
            if (window.innerWidth <= 768) {
                const vw = viewerArea.clientWidth - 16;
                const fp = await pdfDoc.getPage(1);
                const ov = fp.getViewport({ scale: 1 });
                scale = Math.round(Math.min(3.0, Math.max(0.9, vw / ov.width)) * 10) / 10;
                zoomSlider.value = scale;
                zoomVal.textContent = Math.round(scale * 100) + '%';
            }
        }
        // An explicit startPage (e.g. reopen request) wins over saved position.
        if (Number.isInteger(startPage) && startPage > 1) {
            pageNum = Math.max(1, Math.min(startPage, pdfDoc.numPages));
        }
        if (gen !== docGeneration) return;

        openCacheSocket(currentFileName);
        openSessionSocket(currentFileName);
        if (gen !== docGeneration) return;
        // Remember this as the book to auto-reopen on next visit.
        try {
            await fetch('/last_document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentFileName })
            });
        } catch (e) {}
        if (gen !== docGeneration) return;

        await renderPage(pageNum);
        if (gen !== docGeneration) return;
        updateMobilePageInfo();

        // Restore reading position visually: jump to the last-played sentence
        // right away instead of waiting for the user to press Play.
        // Uses normalized offsets -> span mapping from _getPdfSpanData().
        if (currentIndex > 0 && sentences && sentences.length && currentIndex < sentences.length) {
            try {
                const entry = _pdfSentenceOffsets.get(currentIndex);
                if (entry) {
                    const { spanNorms } = _getPdfSpanData();
                    const map = spanNorms.find(m => m.normStart < entry.end && m.normEnd > entry.start);
                    if (map) _scrollToHighlightedSentence(map.span);
                }
            } catch(e) {}
        }

        await loadOutline();
        if (gen !== docGeneration) return;

        if (isMobileSidebar()) closeMobileSidebar();

    } catch (err) {
        console.error(err);
        if (gen !== docGeneration) return;
        alert(`Failed to load PDF.\nFile: "${file.name}" (type="${file.type}")\nError: ${err && err.message ? err.message : err}`);
        resetUI();
    } finally {
        // Only hide the overlay if this load is still the current one — a
        // superseded load must not dismiss the newer document's overlay.
        if (gen === docGeneration) hideLoading();
    }
}

/* Auto-reopen the most recently opened server document at startup. Skipped
 * when the file is no longer in the library (e.g. deleted server-side). */
async function loadLastDocument() {
    try {
        const res = await fetch('/last_document');
        if (!res.ok) return;
        const data = await res.json();
        const filename = data.filename;
        if (!filename) return;
        // The library socket may not have delivered its init yet at startup;
        // give it one grace window before giving up on auto-reopen.
        if (!serverDocNames.has(filename)) {
            await new Promise(r => setTimeout(r, 2000));
            if (!serverDocNames.has(filename)) {
                console.warn(`Last document "${filename}" not in server library, skipping.`);
                return;
            }
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
        await loadDocument(file, 1);
    } catch (e) {
        console.warn('Failed to load last document:', e);
    }
}

/* ─── EPUB Load ─── */
/* EPUB counterpart of loadPDF: bump generation token, destroy any previous
 * handler, create a fresh EPUBHandler, then restore this book's saved
 * settings before rendering the requested start page. */
async function loadEPUB(file, startPage = 1) {
    const gen = ++docGeneration;
    currentSearchId++; // invalidate in-flight searches from the previous document
    pageIsRendering = false; // stale renders bail via gen guard; drop queued turns
    pageNumPending = null;
    console.log(`[EPUB] Loading: "${file.name}" (${(file.size / 1024 / 1024).toFixed(2)} MB), startPage=${startPage}`);
    showLoading('Loading EPUB…');
    // Stop the old book's playback/fetch state before replacing anything.
    stopPipeline();
    clearPageAudioCache();
    chapterStartPage = null;
    chapterEndPage = null;
    currentFile = file;
    currentFileName = file.name || 'Document';

    welcomeScreen.classList.remove('active');
    readerScreen.classList.add('active');

    document.getElementById('pdf-container').style.display = 'none';
    document.getElementById('epub-container').style.display = 'block';

    if (documentHandler) { try { documentHandler.destroy(); } catch (e) {} }
    pdfDoc = null;
    const epubHandler = new EPUBHandler();
    documentHandler = epubHandler;

    // Reset per-book UI + duration caches.
    tocList.innerHTML = '';
    tocEmpty.style.display = 'block';
    Object.keys(pageStats).forEach(k => delete pageStats[k]);
    Object.keys(chapterDurationCache).forEach(k => delete chapterDurationCache[k]);
    Object.keys(pageDurationCache).forEach(k => delete pageDurationCache[k]);
    Object.keys(pendingChapterDurations).forEach(k => delete pendingChapterDurations[k]);
    Object.keys(pendingPageDurations).forEach(k => delete pendingPageDurations[k]);
    topbarFilename.textContent = currentFileName;
    document.title = `DocReader Pro — ${currentFileName}`;

    try {
        const settings = await loadSettings(currentFileName);
        if (gen !== docGeneration) return;
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

            if (settings.epubSidePadding !== undefined) {
                epubSidePadding = settings.epubSidePadding;
                document.getElementById('epub-padding-slider').value = epubSidePadding;
                document.getElementById('epub-padding-val').textContent = epubSidePadding + 'px';
                if (documentHandler instanceof EPUBHandler) {
                    documentHandler._injectReadingStyle();
                }
            }

            if (settings.focusModeEnabled !== undefined) {
                focusModeEnabled = settings.focusModeEnabled;
                document.getElementById('focus-mode-toggle').checked = focusModeEnabled;
                document.getElementById('focus-mode-btn').classList.toggle('active', focusModeEnabled);
                if (documentHandler instanceof EPUBHandler) {
                    documentHandler.setFocusMode(focusModeEnabled);
                }
            }

            if (settings.theme) {
                applyTheme(settings.theme);
            }

            if (settings.voice) {
                const voiceSelector = document.getElementById('voice-selector');
                if (voiceSelector && voiceSelector.querySelector(`option[value="${settings.voice}"]`)) {
                    voiceSelector.value = settings.voice;
                }
            }

            if (settings.autoReadNext !== undefined) {
                document.getElementById('auto-read-next').checked = settings.autoReadNext;
            }

            if (settings.saveAudioEnabled !== undefined) {
                saveAudioEnabled = settings.saveAudioEnabled;
                document.getElementById('save-audio-toggle').checked = saveAudioEnabled;
                document.getElementById('save-range-row').style.display = saveAudioEnabled ? 'flex' : 'none';
            }

            if (settings.hlBaseColor !== undefined) {
                hlBaseColor = settings.hlBaseColor;
                document.querySelectorAll('.hl-preset').forEach(btn => {
                    btn.classList.remove('active');
                    const presetRGB = HL_PRESETS[btn.dataset.color];
                    if (presetRGB === hlBaseColor) btn.classList.add('active');
                });
            }

            if (settings.hlOpacity !== undefined) {
                hlOpacity = settings.hlOpacity;
                document.getElementById('hl-opacity-slider').value = Math.round(hlOpacity * 100);
                document.getElementById('hl-opacity-val').textContent = Math.round(hlOpacity * 100) + '%';
            }

            if (settings.hlHoverOpacity !== undefined) {
                hlHoverOpacity = settings.hlHoverOpacity;
                document.getElementById('hl-hover-opacity-slider').value = Math.round(hlHoverOpacity * 100);
                document.getElementById('hl-hover-opacity-val').textContent = Math.round(hlHoverOpacity * 100) + '%';
            }

            if (settings.hlRadius !== undefined) {
                hlRadius = settings.hlRadius;
                document.getElementById('hl-radius-slider').value = hlRadius;
                document.getElementById('hl-radius-val').textContent = hlRadius + 'px';
            }

            if (settings.hlPadding !== undefined) {
                hlPadding = settings.hlPadding;
                document.getElementById('hl-padding-slider').value = hlPadding;
                document.getElementById('hl-padding-val').textContent = hlPadding + 'px';
            }

            if (settings.hlOutline !== undefined) {
                hlOutline = settings.hlOutline;
                document.getElementById('hl-outline-toggle').checked = hlOutline;
            }

            applyHighlightSettings();
        }
        
        if (startPage > 1) pageNum = startPage;

        // Build the rendition (this renders the start page and extracts text).
        const viewerArea = document.getElementById('pdf-viewer-area');
        const currentTheme = localStorage.getItem('docreader-theme') || 'default-light';
        await epubHandler.load(file, pageNum, viewerArea, scale, currentTheme);
        if (gen !== docGeneration) return;
        documentHandler.setFocusMode(focusModeEnabled);

        const totalPages = documentHandler.pageCount;
        document.getElementById('page-count').textContent = totalPages;
        pageJumpInput.max = totalPages;
        document.getElementById('page-num').textContent = pageNum;

        currentPageText = documentHandler.currentText;
        sentences = documentHandler.currentSentences;
        updatePageStats(pageNum, sentences);

        prevPageBtn.disabled = pageNum <= 1;
        nextPageBtn.disabled = pageNum >= totalPages;
        updateMobilePageInfo();

        // Check staleness BEFORE opening sockets: a superseded load must not
        // replace the new book's session/cache channels.
        if (gen !== docGeneration) return;
        openCacheSocket(currentFileName);
        openSessionSocket(currentFileName);
        try {
            await fetch('/last_document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentFileName })
            });
        } catch (e) {}
        if (gen !== docGeneration) return;

        loadEpubOutline();
        await updateActiveTocItem();

        // Restore reading position visually: jump to the last-played sentence
        // right away instead of waiting for the user to press Play.
        // Self-verifying: re-issues the scroll if something (e.g. a late
        // chapter rebuild) interrupts it, bounded to ~4s.
        if (gen === docGeneration && currentIndex > 0 && sentences && sentences.length && currentIndex < sentences.length) {
            let restoreAttempts = 0;
            const tryRestorePos = () => {
                if (gen !== docGeneration) return;
                if (!documentHandler || !(documentHandler instanceof EPUBHandler) || documentHandler._destroyed) return;
                if (isPlaying) return; // playback manages its own highlighting
                const st = documentHandler.scrollToSentence(currentIndex);
                restoreAttempts++;
                if (restoreAttempts >= 20) return;
                if (st === 'missing') setTimeout(tryRestorePos, 200);
                else if (st === 'scrolled') setTimeout(tryRestorePos, 450);
                // 'inview' → done
            };
            setTimeout(tryRestorePos, 120);
        }

        if (isMobileSidebar()) closeMobileSidebar();

        documentHandler.rendition.on('click', (e) => {
            // Click-to-read: tapping a sentence span starts playback there.
            // Links are exempt so navigation still works normally.
            // A just-fired long-press (line-number peek) suppresses playback.
            try {
                if (window._epubSuppressClickUntil && Date.now() < window._epubSuppressClickUntil) return;
            } catch(err) {}
            if (!sentences || !sentences.length) return;
            const clickedNode = e.target;
            if (!clickedNode) return;
            if (clickedNode.closest && clickedNode.closest('a[href]')) return;
            const span = clickedNode.closest && clickedNode.closest('.dr-sent');
            if (!span) return;
            const targetIdx = Number(span.getAttribute('data-sent-idx'));
            if (!isNaN(targetIdx) && targetIdx < sentences.length) {
                startReadingPage(targetIdx);
            }
        });

        /* ResizeObserver on the EPUB container: keeps the rendition sized to
         * its box (sidebar toggles, window resizes, orientation changes).
         * Three defenses against redundant re-layouts:
         *   1. seeded _lastResizedKey + initial lastW/lastH skip the observer's
         *      first (same-size) event, which would otherwise cancel the
         *      load-time scroll restore;
         *   2. sub-pixel jitter filter;
         *   3. 200ms trailing debounce before epub.js resize. Overlapping
         *      resizes are serialized inside _reflowPreservingPosition, and
         *      sentence re-wrapping happens in its settle chain (after the
         *      rebuild completes) — never on a separate timer that can fire
         *      mid-rebuild and clobber `sentences` with partial text. */
        if (window._epubResizeObserver) {
            window._epubResizeObserver.disconnect();
        }
        if (window._epubResizeDebounce) { clearTimeout(window._epubResizeDebounce); window._epubResizeDebounce = null; }
        const epubContainerEl = document.getElementById('epub-container');
        if (epubContainerEl && typeof ResizeObserver !== 'undefined') {
            // Seed with the current size so the observer's initial event
            // (same size the rendition was created with) is skipped —
            // that redundant first resize rebuilds the chapter and kills
            // any in-flight scroll, e.g. the load-time position restore.
            let lastW = epubContainerEl.clientWidth || 0;
            let lastH = epubContainerEl.clientHeight || 0;
            documentHandler._lastResizedKey = Math.round(lastW) + 'x' + Math.round(lastH);
            window._epubResizeObserver = new ResizeObserver((entries) => {
                if (!documentHandler || !(documentHandler instanceof EPUBHandler)) return;
                if (documentHandler !== epubHandler) return;
                const entry = entries[0];
                if (!entry) return;
                const { width, height } = entry.contentRect;
                // Skip sub-pixel jitter; only react to real size changes
                if (!(width > 0 && height > 0)) return;
                if (Math.abs(width - lastW) < 1 && Math.abs(height - lastH) < 1) return;
                _dlog('ResizeObserver fired:', Math.round(width) + 'x' + Math.round(height), '(was ' + Math.round(lastW) + 'x' + Math.round(lastH) + ')');
                lastW = width; lastH = height;
                // Debounce: sidebar width transitions fire many intermediate sizes;
                // wait for it to settle so epub.js does one full re-layout, not ten.
                clearTimeout(window._epubRoResizeTimer);
                window._epubRoResizeTimer = setTimeout(() => {
                    window._epubRoResizeTimer = null;
                    try {
                        const key = Math.round(lastW) + 'x' + Math.round(lastH);
                        if (documentHandler._lastResizedKey === key) {
                            _dlog('skipping duplicate resize', key);
                            return;
                        }
                        documentHandler._lastResizedKey = key;
                        documentHandler.resizePreservingScroll(lastW, lastH, {
                            onSettled: () => {
                                try {
                                    if (!documentHandler || documentHandler !== epubHandler || gen !== docGeneration) return;
                                    sentences = documentHandler.currentSentences;
                                    if (isPlaying) highlightActiveSentence(currentIndex, sentences);
                                } catch(e) {}
                            }
                        });
                    } catch(e) {}
                }, 200);
            });
            window._epubResizeObserver.observe(epubContainerEl);
        }
    } catch (err) {
        console.error('[EPUB] Load error:', err);
        if (gen !== docGeneration) return;
        alert('Failed to load EPUB: ' + err.message);
        resetUI();
    } finally {
        if (gen === docGeneration) hideLoading();
    }
}

/* Render the EPUB TOC tree in the sidebar: numbered chapters at level 0,
 * collapsible nested subitems below, click navigates via href fragment or
 * spine page. */
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
            if (item.page) el.dataset.page = item.page;
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
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                stopPipeline();
                const parsed = parseInt(item.page, 10);
                const targetPage = Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
                if (item.href && (item.href.includes('#') || targetPage === null)) {
                    await epubGoToHref(item.href, targetPage);
                } else if (targetPage !== null) {
                    await epubGoToPage(targetPage);
                }
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

/* Full reset of reading state: stop playback, revoke cached audio, clear
 * sentence list. Used when jumping between pages/chapters. */
function hardResetReadingState() {
    stopPipeline();
    clearPageAudioCache();
    currentIndex = 0;
    currentPageText = '';
    sentences = [];
}

/* Navigate to a spine page. If already there, just scroll the chapter to the
 * top (smooth). Otherwise re-renders via the serialized renderPage queue and
 * refreshes sentence state for TTS. */
async function epubGoToPage(target) {
    if (!documentHandler || !(documentHandler instanceof EPUBHandler)) return;
    const targetPage = Math.max(1, Math.min(target, documentHandler.pageCount));
    if (targetPage === pageNum) {
        documentHandler._scrollEpubToTop(true);
        if (isMobileSidebar()) closeMobileSidebar();
        return;
    }

    hardResetReadingState();
    const result = await documentHandler.renderPage(targetPage);
    if (result) {
        pageNum = targetPage;
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
    refreshTimeEstimates();
}

/* Navigate to a TOC href. Resolves the href to a spine index (explicit page
 * number wins; else fuzzy matching on path/basename). If it's the current
 * chapter, only scrolls to the anchor — avoids a needless re-render. */
async function epubGoToHref(href, targetPageNumber) {
    if (!documentHandler || !(documentHandler instanceof EPUBHandler)) return;
    const cleanHref = href.split('#')[0];
    const fuzzyMatch = () => documentHandler.spineItems.findIndex(item => {
        const itemHref = item.href || '';
        if (!itemHref || !cleanHref) return false;
        return itemHref === href || itemHref === cleanHref ||
               itemHref.endsWith(cleanHref) || cleanHref.endsWith(itemHref) ||
               itemHref.split('/').pop() === cleanHref.split('/').pop();
    });
    let spineIdx = -1;
    // An explicit page number wins only if the href actually lives there;
    // otherwise fall through to fuzzy matching (never blindly trust it).
    if (Number.isInteger(targetPageNumber) && targetPageNumber > 0 &&
        targetPageNumber <= documentHandler.spineItems.length && cleanHref) {
        const candHref = documentHandler.spineItems[targetPageNumber - 1].href || '';
        if (candHref === href || candHref === cleanHref ||
            (candHref && cleanHref && (candHref.endsWith(cleanHref) || cleanHref.endsWith(candHref)))) {
            spineIdx = targetPageNumber - 1;
        } else {
            spineIdx = fuzzyMatch();
        }
    } else {
        // Improved matching: try exact, then endsWith, then basename
        spineIdx = fuzzyMatch();
    }

    const targetPage = spineIdx >= 0 ? spineIdx + 1 : pageNum;
    const fragment = href.includes('#') ? href.split('#')[1] : null;

    // Same chapter already rendered: jump straight to the anchor, no re-render
    if (targetPage === pageNum) {
        stopPipeline();
        documentHandler.scrollToFragment(fragment);
        await updateActiveTocItem();
        updateChapterBoundaries();
        saveSettingsThrottled(pageNum, scale, currentIndex);
        refreshTimeEstimates();
        return;
    }

    stopPipeline();
    hardResetReadingState();
    const result = await documentHandler.renderPage(targetPage, href);
    if (result) {
        pageNum = targetPage;
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
    refreshTimeEstimates();
}

/* Page-turn by relative delta. In EPUB mode delegates to epubGoToPage; in
 * PDF mode queues a rerender. isAutoTurn marks automatic end-of-page turns
 * (keeps isAutoContinuing untouched for user-initiated turns). */
function goToPage(delta, isAutoTurn = false) {
    const total = getPageCount();
    if (!total) return;
    const target = pageNum + delta;
    if (target < 1 || target > total) return;
    if (documentHandler instanceof EPUBHandler) {
        if (!isAutoTurn) { isAutoContinuing = false; }
        hardResetReadingState();
        // hardReset->stopPipeline clears the flag; restore it for auto turns
        // so the new chapter resumes playback on arrival.
        if (isAutoTurn) { isAutoContinuing = true; }
        epubGoToPage(target).then(() => {
            if (isAutoTurn && isAutoContinuing && sentences && sentences.length) {
                isAutoContinuing = false;
                startReadingPage(0);
            }
        }).catch(() => {});
        return;
    }
    if (!pdfDoc) return;
    if (!isAutoTurn) { isAutoContinuing = false; }
    hardResetReadingState();
    if (isAutoTurn) { isAutoContinuing = true; }
    pageNum = target;
    queueRenderPage(pageNum);
    saveSettingsThrottled(pageNum, scale, currentIndex);
    viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
}

/* Jump to a specific page; optional `callback` runs once that page has
 * rendered (used by auto-continue chains). */
function goToAbsolutePage(target, callback = null) {
    if (documentHandler instanceof EPUBHandler) {
        epubGoToPage(target);
        return;
    }
    if (!pdfDoc || target < 1 || target > pdfDoc.numPages) return;
    hardResetReadingState();
    pageNum = target;
    // Always assign (null clears): a stale callback from an earlier
    // navigation must not fire on this page. The target tag guards against
    // a superseded render invoking it late.
    afterRenderCallback = callback ? { cb: callback, target } : null;
    queueRenderPage(pageNum);
    saveSettingsThrottled(pageNum, scale, currentIndex);
    viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ─── PDF Outline / TOC ─── */
/* Build the sidebar TOC from the pdf.js outline. Tree lines are drawn with
 * box-drawing characters (├/└). Destinations resolve lazily: page numbers
 * show '…' until clicked or until resolveAllTOCPages fills them in. */
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
                childrenDiv.style.display = 'none';
                toggleSpan.querySelector('.toc-toggle-svg').style.transform = 'rotate(-90deg)';
                toggleSpan.addEventListener('click', (e) => {
                    e.stopPropagation(); 
                    const isCollapsed = childrenDiv.style.display === 'none';
                    childrenDiv.style.display = isCollapsed ? 'block' : 'none';
                    toggleSpan.querySelector('.toc-toggle-svg').style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
                });
            } else {
                toggleSpan.innerHTML = '';
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
                // Resolve dest (named or direct) -> page index, then navigate.
                // If already on the target page, scroll to the destination's
                // Y coordinate instead of re-rendering.
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

                    // Same page already rendered: jump straight to the destination's Y position
                    const destY = Array.isArray(dest) && Number.isFinite(dest[3]) ? dest[3] : null;
                    if (targetPage === pageNum && destY !== null) {
                        try {
                            const page = await pdfDoc.getPage(targetPage);
                            const viewport = page.getViewport({ scale });
                            const [, vy] = viewport.convertToViewportPoint(0, destY);
                            const canvasEl = document.getElementById('pdf-canvas');
                            if (canvasEl) {
                                const cRect = canvasEl.getBoundingClientRect();
                                const vRect = viewerArea.getBoundingClientRect();
                                const top = viewerArea.scrollTop + (cRect.top - vRect.top) + vy;
                                viewerArea.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
                            } else {
                                goToAbsolutePage(targetPage);
                            }
                        } catch (e) {
                            goToAbsolutePage(targetPage);
                        }
                    } else {
                        goToAbsolutePage(targetPage);
                    }
                    if (isMobileSidebar()) closeMobileSidebar();
                } catch (e) {
                    console.warn('TOC navigation error:', e);
                }
            });

            wrapper.appendChild(el);
            if (childrenDiv) {
                wrapper.appendChild(childrenDiv);
                renderTree(item.items, level + 1, newPath, isLast, childrenDiv);
            }
            parentElement.appendChild(wrapper);
        });
    }
    
    renderTree(pdfOutline, 0, [], false, tocList);
    await resolveAllTOCPages();
    await updateActiveTocItem();
    await refreshTimeEstimates();
}

/* Resolve every TOC entry's destination to a concrete page number in
 * parallel, replacing the '…' placeholders. */
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

/* Scroll the TOC panel so the entry for the current page is visible. */
function scrollToActiveTocItem() {
    const activeEl = document.querySelector('.toc-item.active');
    const sidebarContent = document.getElementById('sidebar-content');
    const tocPanel = document.getElementById('toc-panel');
    if (!activeEl || !sidebarContent || tocPanel.style.display === 'none' || sidebar.classList.contains('collapsed')) return;
    setTimeout(() => {
        activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
}

/* Mark the TOC entry matching the current page as active: the entry with the
 * greatest start page <= current page wins. Expands all ancestor sections
 * (and collapses the rest) so the active item is always visible. */
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
        refreshTimeEstimates();
        return;
    }
    activeEl.classList.add('active');

    // Collapse only unrelated branches: ancestors of the active item and its
    // own children stay as they are, so user expand-state elsewhere survives.
    const ownKids = activeEl.nextElementSibling;
    document.querySelectorAll('.toc-children').forEach(childContainer => {
        if (childContainer !== ownKids && !childContainer.contains(activeEl)) {
            childContainer.style.display = 'none';
        }
    });
    // Sync each toggle chevron to its container's actual state.
    document.querySelectorAll('.toc-toggle-svg').forEach(svg => {
        const item = svg.closest('.toc-item');
        const kids = item && item.nextElementSibling;
        const expanded = !!(kids && kids.classList && kids.classList.contains('toc-children') &&
            kids.style.display !== 'none');
        svg.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    });

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

    const activeChildren = activeEl.nextElementSibling;
    if (activeChildren && activeChildren.classList.contains('toc-children')) {
        activeChildren.style.display = 'block';
        const toggleSvg = activeEl.querySelector('.toc-toggle-svg');
        if (toggleSvg) toggleSvg.style.transform = 'rotate(0deg)';
    }

    scrollToActiveTocItem();
    refreshTimeEstimates();
}

/* ─── Time estimation functions ─── */
/* Removed unused computePageTime and computeChapterTime */

/* ─── Duration caching with promise sharing ───
 * Server-side duration lookups are cached AND in-flight requests are shared:
 * a second caller with the same key awaits the same promise instead of
 * issuing a duplicate fetch. */
const pageDurationCache = {};
/* Seconds of audio the server has cached for one page; null if unknown.
 * Keyed by book+page so two books never share durations. null is cached
 * distinctly from 0 (unknown vs genuinely empty). */
async function fetchPageDuration(bookName, page) {
    const key = `${bookName}::${page}`;
    if (pageDurationCache[key] !== undefined) return pageDurationCache[key];
    if (pendingPageDurations[key]) return pendingPageDurations[key];
    const promise = (async () => {
        try {
            const res = await fetch(`/page_duration?book_name=${encodeURIComponent(bookName)}&page=${page}`);
            if (!res.ok) return null;
            const data = await res.json();
            const dur = (data && data.duration != null) ? data.duration : null;
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
/* Duration for a chapter page range. Returns 0 (skip the fetch) when the
 * range spans the whole book and no explicit TOC chapter is active — that
 * case is displayed differently in the UI. */
async function fetchChapterDuration(bookName, startPage, endPage) {
    if (startPage === 1 && endPage === pdfDoc?.numPages && !document.querySelector('.toc-item.level-0.active')) {
        return 0;
    }
    const key = `${bookName}::${startPage}-${endPage}`;
    if (chapterDurationCache[key] !== undefined) return chapterDurationCache[key];
    if (pendingChapterDurations[key]) return pendingChapterDurations[key];
    const promise = (async () => {
        try {
            const res = await fetch(`/chapter_duration?book_name=${encodeURIComponent(bookName)}&start_page=${startPage}&end_page=${endPage}`);
            if (!res.ok) return null;
            const data = await res.json();
            const dur = (data && data.duration != null) ? data.duration : null;
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
/* Local heuristic: ~150 wpm, 5 chars/word — used when no server data exists. */
function estimateSentenceDuration(text) {
    const words = text.length / 5;
    return (words / 150) * 60;
}
/* Hybrid remaining time from sentence `fromIdx` to the end of the current
 * page: measured server durations where cached, 150wpm guesses otherwise.
 * Returns 1x seconds ({ total, exact }); playback speed is applied only at
 * display time so the numbers stay valid when the speed changes. Shared by
 * playback start and the estimate refresh so both show the same numbers. */
function computeRemainingFrom(fromIdx) {
    if (!sentences || !sentences.length) {
        const stats = pageStats[pageNum];
        if (!stats) return { total: 0, exact: true };
        return { total: (stats.totalChars / 5 / 150) * 60, exact: false };
    }
    let total = 0, exact = true;
    const start = Math.max(0, Math.min(fromIdx, sentences.length));
    for (let i = start; i < sentences.length; i++) {
        const d = sentenceDurations[i];
        if (d != null && d > 0) total += d;
        else { total += estimateSentenceDuration(sentences[i]); exact = false; }
    }
    return { total, exact };
}
/* Hybrid remainder for pages after the current one up to chapterEndPage:
 * measured server audio plus the 150wpm heuristic for whatever the
 * measurements don't cover yet (EPUB spine char map; unknown for PDF, which
 * keeps its measured-only lower bound). 1x seconds; exact is true only when
 * there are no later pages left to guess about. */
async function computeChapterRest() {
    if (!chapterEndPage || chapterEndPage <= pageNum) return { total: 0, exact: true };
    const measured = await fetchChapterDuration(currentFileName, pageNum + 1, chapterEndPage) || 0;
    let heuristic = 0;
    if (documentHandler instanceof EPUBHandler) {
        const items = documentHandler.spineItems || [];
        for (let p = pageNum + 1; p <= chapterEndPage && p - 1 < items.length; p++) {
            heuristic += (((documentHandler.chapterCharMap[p - 1] || 0) / 5) / 150) * 60;
        }
    }
    return { total: measured + Math.max(0, heuristic - measured), exact: false };
}
/* Record per-page extraction stats (chars + sentence count) for estimates. */
function updatePageStats(page, sentences) {
    let totalChars = 0;
    sentences.forEach(s => totalChars += s.length);
    pageStats[page] = { totalChars, sentenceCount: sentences.length };
}

/* ─── Search ───
 * PDF search scans cached page texts (built by loadPDF's background indexer,
 * fetching on demand as fallback). EPUB search delegates to EPUBHandler's
 * spine scan. Input is debounced 320ms; currentSearchId invalidates results
 * of superseded queries (e.g. after a document switch mid-search). */
let searchDebounceTimer = null;
// Debounce typing so we don't search per keystroke; 320ms feels instant
// while avoiding a full-document scan on every character.
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

let currentSearchId = 0; // monotonic id; stale async searches bail when it moves on

/* Run a search for the query box's current value. Every await re-checks
 * searchId/generation so an older search never overwrites a newer one's
 * results. Results stay in document order so Next/Prev walk sequentially. */
async function performSearch() {
    const searchId = ++currentSearchId;
    const query = searchInput.value.trim();

    if (!query) { clearSearch(); return; }

    const isPdf = !!pdfDoc;
    const isEpub = documentHandler instanceof EPUBHandler;
    if (!isPdf && !isEpub) { clearSearch(); return; }

    searchClearBtn.style.display = '';
    searchCount.textContent = '…';
    searchResultsPanel.classList.add('visible');
    searchResultsList.innerHTML = '<div style="padding:14px 16px;color:var(--text-tertiary);font-size:13px">Searching…</div>';
    searchMatches = [];
    // Capture document identity: a mid-search switch must neither scan the
    // new document with the old query nor paint into its UI.
    const searchDoc = pdfDoc;
    const searchGen = docGeneration;
    const stale = () => searchId !== currentSearchId || searchGen !== docGeneration ||
        (isPdf && pdfDoc !== searchDoc);

    try {
        if (isPdf) {
            const lowerQuery = query.toLowerCase();
            showLoading('Searching PDF…');
            try {
                const total = searchDoc.numPages;
                for (let p = 1; p <= total; p++) {
                    if (stale()) return;
                    let text = searchAllPageTexts[p];
                    if (text === undefined) {
                        const page = await searchDoc.getPage(p);
                        if (stale()) return;
                        const tc = await page.getTextContent();
                        if (stale()) return;
                        text = tc.items.map(i => i.str).join(' ');
                        searchAllPageTexts[p] = text;
                    }
                    const lowerText = text.toLowerCase();
                    let pos = 0;
                    while (true) {
                        const idx = lowerText.indexOf(lowerQuery, pos);
                        if (idx === -1) break;
                        const context = text.slice(Math.max(0, idx - 40), idx + query.length + 60);
                        searchMatches.push({ page: p, index: idx, context, query });
                        // Non-overlapping stepping — matches the highlighter.
                        pos = idx + query.length;
                    }
                }
            } finally {
                hideLoading();
            }
        } else if (isEpub) {
            const results = await documentHandler.search(query);
            if (stale()) return;
            if (results && results.length) {
                searchMatches = results.map(r => ({
                    page: r.page,
                    context: r.context || `(match on page ${r.page})`,
                    query: query,
                    index: 0
                }));
            } else {
                searchMatches = [];
            }
        }

        if (stale()) return;

        if (searchMatches.length === 0) {
            searchCount.textContent = '0';
            searchResultsList.innerHTML = `<div class="toc-empty">No results found for <strong>"${escapeHtml(query)}"</strong></div>`;
            searchCurrentMatch = -1;
            searchPrevBtn.disabled = true;
            searchNextBtn.disabled = true;
            return;
        }

        // Document order is kept so Next/Prev walk pages sequentially.

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

            const context = m.context || `Match on page ${m.page}`;
            const hi = context.toLowerCase().indexOf(query.toLowerCase());
            if (hi >= 0) {
                text.innerHTML =
                    escapeHtml(context.slice(0, hi)) +
                    '<em>' + escapeHtml(context.slice(hi, hi + query.length)) + '</em>' +
                    escapeHtml(context.slice(hi + query.length));
            } else {
                text.textContent = context;
            }

            item.appendChild(badge);
            item.appendChild(text);
            item.addEventListener('click', () => goToSearchMatch(i));
            searchResultsList.appendChild(item);
        });

        searchCurrentMatch = -1;
        searchPrevBtn.disabled = false;
        searchNextBtn.disabled = false;

    } catch (e) {
        console.error('Search error:', e);
        hideLoading();
        searchCount.textContent = 'Error';
        searchResultsList.innerHTML = `<div class="toc-empty">Search failed: ${e.message}</div>`;
    }
}

/* Navigate to a search hit: highlight it in the results list, jump to its
 * page, and (EPUB) select the exact occurrence inside the iframe —
 * occOnPage is how many earlier hits share this page. PDF highlights the
 * same occurrence with .current once the right page has rendered. */
let _searchNavToken = 0; // bumped by clearSearch; stale highlight pollers bail
async function goToSearchMatch(idx) {
    if (idx < 0 || idx >= searchMatches.length) return;
    const myNav = ++_searchNavToken;
    searchCurrentMatch = idx;
    const match = searchMatches[idx];
    searchCount.textContent = `${idx + 1}/${searchMatches.length}`;
    document.querySelectorAll('.search-result-item').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
    });
    document.querySelectorAll('.search-result-item')[idx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    const targetPage = match.page;
    const occOnPage = searchMatches.slice(0, idx).filter(m => m.page === targetPage).length;
    if (targetPage && targetPage > 0) {
        const isEpub = documentHandler instanceof EPUBHandler;
        if (isEpub) {
            await epubGoToPage(targetPage);
            setTimeout(() => {
                if (myNav !== _searchNavToken) return;
                if (documentHandler && documentHandler.scrollToSearchMatch) {
                    documentHandler.scrollToSearchMatch(match.query, occOnPage);
                }
            }, 150);
        } else if (pdfDoc) {
            goToAbsolutePage(targetPage);
        }
    }

    if (pdfDoc && match.query) {
        const navDoc = pdfDoc;
        let attempts = 0;
        const highlight = () => {
            if (myNav !== _searchNavToken || pdfDoc !== navDoc) return;
            if (pageNum === targetPage) {
                highlightSearchOnPage(match.query, occOnPage);
            } else if (++attempts < 15) {
                setTimeout(highlight, 200);
            }
        };
        setTimeout(highlight, 300);
    }
}

function nextSearchMatch() {
    goToSearchMatch(searchCurrentMatch + 1 < searchMatches.length ? searchCurrentMatch + 1 : 0);
}
function prevSearchMatch() {
    goToSearchMatch(searchCurrentMatch - 1 >= 0 ? searchCurrentMatch - 1 : searchMatches.length - 1);
}
function clearSearch() {
    currentSearchId++; // invalidate in-flight searches so stale results can't resurrect
    _searchNavToken++; // cancel pending highlight pollers
    hideLoading(); // dismiss a stuck "Searching…" overlay
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
/* Wrap query matches inside the PDF text layer with <mark> elements.
 * Original span text is stashed in data-originalText so clearSearchHighlights
 * can restore it without a re-render. The occ-th mark on the page gets the
 * .current class and is scrolled into view. */
function highlightSearchOnPage(query, occ = 0) {
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
    const marks = document.querySelectorAll('.search-highlight');
    const target = marks[Math.min(Math.max(0, occ), marks.length - 1)];
    marks.forEach(m => m.classList.remove('current'));
    if (target) {
        target.classList.add('current');
        const rect = target.getBoundingClientRect();
        const va = viewerArea.getBoundingClientRect();
        if (rect.top < va.top || rect.bottom > va.bottom) {
            viewerArea.scrollBy({ top: rect.top - va.top - va.height / 3, behavior: 'smooth' });
        }
    }
}
/* Restore original text-layer spans, undoing search <mark> wrapping. */
function clearSearchHighlights() {
    document.querySelectorAll('.textLayer span').forEach(span => {
        if (span.dataset.originalText !== undefined) {
            span.textContent = span.dataset.originalText;
            delete span.dataset.originalText;
        }
    });
    _invalidatePdfSpanCache();
}
/* HTML-escape for search context snippets. */
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* Click-away closes the results panel; refocusing the input re-opens it. */
document.addEventListener('click', e => {
    if (!searchResultsPanel.contains(e.target) && !document.getElementById('search-container').contains(e.target)) {
        searchResultsPanel.classList.remove('visible');
    }
});
searchInput.addEventListener('focus', () => {
    if (searchMatches.length > 0) searchResultsPanel.classList.add('visible');
});

/* ─── PDF Rendering ───
 * pdf.js render pipeline: rasterize page to canvas at devicePixelRatio,
 * rebuild the text layer, then reconstruct reading structure (lines ->
 * paragraphs/lists/headers) so TTS gets clean sentences instead of raw
 * text-run soup. */
let afterRenderCallback = null; // one-shot callback run after goToAbsolutePage's render completes

/* Render page `num` to the canvas + text layer, extract structured text and
 * split it into sentences. This is the heart of PDF sentence extraction:
 *  1. Sort text items top-to-bottom / left-to-right within a Y tolerance.
 *  2. Group items into visual lines.
 *  3. Drop user-skipped top/bottom lines and bare page numbers near edges.
 *  4. Classify each line (header by font size; list item by bullet/number
 *     prefix; new paragraph by Y gap > 1.5em) and join accordingly —
 *     headers get trailing periods, hyphenated line breaks are merged,
 *     list continuations are appended without breaking sentences.
 */
async function renderPage(num) {
    // Capture identity: a superseded render (book switch / close) must not
    // paint into the new document's canvas, layers, or sentence state.
    const gen = docGeneration;
    const renderDoc = pdfDoc;
    const staleRender = () => gen !== docGeneration || pdfDoc !== renderDoc;
    pageIsRendering = true;
    clearHighlightCanvas();
    // A pending retry-scroll from a previous page must not fire into this one.
    if (typeof _autoScrollRetryTimer !== 'undefined' && _autoScrollRetryTimer) {
        clearTimeout(_autoScrollRetryTimer); _autoScrollRetryTimer = null;
    }
    try {
        const page = await pdfDoc.getPage(num);
        if (staleRender()) { pageIsRendering = false; return; }
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
        if (staleRender()) { pageIsRendering = false; return; }

        const textLayerDiv = document.getElementById('text-layer');
        textLayerDiv.innerHTML = '';
        _invalidatePdfSpanCache();
        textLayerDiv.style.height = cssH + 'px';
        textLayerDiv.style.width = cssW + 'px';
        textLayerDiv.style.cursor = 'pointer';
        textLayerDiv.style.setProperty('--scale-factor', viewport.scale);

        const textContent = await page.getTextContent();
        if (staleRender()) { pageIsRendering = false; return; }

        // Median font size across the page = baseline for header detection.
        const fontSizes = textContent.items.map(i => Math.abs(i.transform[3])).filter(s => s > 0).sort((a, b) => a - b);
        const baseFontSize = fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12;

        // Group text items into visual lines: same baseline row first
        // (Y quantized into buckets so the order is transitive even on
        // slightly skewed pages), then left-to-right within a row.
        const Y_TOL = 5;
        const sorted = [...textContent.items].sort((a, b) => {
            const ba = Math.round(a.transform[5] / Y_TOL);
            const bb = Math.round(b.transform[5] / Y_TOL);
            if (ba !== bb) return bb - ba;
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

        // Apply user-configured line skipping (headers/footers the reader
        // wants excluded from TTS). Bottom is clamped against what's left
        // after the top skip so the slice can't underflow to empty.
        const skipTop = Math.max(0, Math.min(topSkipLines || 0, lines.length));
        const skipBottom = Math.max(0, Math.min(bottomSkipLines || 0, lines.length - skipTop));
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
            // Drop bare page numbers near the top/bottom margins.
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
                // Don't double-punctuate headers that already end a sentence.
                structuredText += `\n${lineText}${/[.!?…]$/.test(lineText) ? '' : '.'}\n`;
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
        if (staleRender()) { pageIsRendering = false; return; }

        await pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
            textDivs: [],
            enhanceTextSelection: true
        }).promise;
        if (staleRender()) { pageIsRendering = false; return; }

        await renderAnnotations(page, viewport, cssW, cssH);
        if (staleRender()) { pageIsRendering = false; return; }

        _rebuildPdfSentenceOffsets();
        _clearHoverCanvas();

        document.getElementById('page-num').textContent = num;
        prevPageBtn.disabled = num <= 1;
        nextPageBtn.disabled = num >= pdfDoc.numPages;
        updateMobilePageInfo();

        await updateActiveTocItem();
        updateChapterBoundaries();

        if (isPlaying) {
            updateTimeDisplay();
        }

        if (textContent.items.length) {
            searchAllPageTexts[num] = textContent.items.map(i => i.str).join(' ');
        }

        pageIsRendering = false;
        if (staleRender()) return;

        // If the user turned pages while we rendered, replay the newest
        // request now instead of rendering every intermediate page.
        if (pageNumPending !== null) {
            const pending = pageNumPending;
            pageNumPending = null;
            renderPage(pending);
            return;
        }

        if (isPlaying && currentIndex < sentences.length) {
            highlightActiveSentence(currentIndex, sentences);
        } else if (viewerArea.scrollTop > 2) {
            // The page-turn path already scrolled; only re-scroll when needed
            // so two smooth animations can't fight each other.
            viewerArea.scrollTo({ top: 0, behavior: 'smooth' });
        }

        if (isAutoContinuing) {
            // End-of-page auto-continue: start reading the next page (or turn
            // it first when the new page has no text). 300ms grace pause.
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
            const entry = afterRenderCallback;
            afterRenderCallback = null;
            if (typeof entry === 'function') {
                entry();
            } else if (entry && entry.target === pageNum) {
                entry.cb();
            }
        }

    } catch (err) {
        console.error('Render error:', err);
        pageIsRendering = false;
        if (pageNumPending !== null) {
            const pending = pageNumPending;
            pageNumPending = null;
            renderPage(pending);
        }
    }
}

/* ─── Removed dead code: injectPdfSentenceSpans, drawBoxesOnCanvas ─── */

/* Determine the page span of the chapter containing the current page (from
 * the TOC's level-0 entries) and store it in chapterStartPage/chapterEndPage.
 * Also back-fills the active chapter marker when updateActiveTocItem
 * couldn't set one. Bounds feed time estimates and auto-advance. */
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
            if (allChapters[i] === activeChapter) {
                // Skip unresolved chapters ('…') to the next numeric page.
                for (let k = i + 1; k < allChapters.length; k++) {
                    const nextPage = parseInt(allChapters[k].dataset.page, 10);
                    if (nextPage) { end = nextPage - 1; break; }
                }
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
/* Render PDF link annotations as clickable overlays. External URLs open in a
 * new tab; internal dests/actions resolve to a page and navigate there
 * (stopping playback first, since navigation resets the TTS pipeline). */
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

/* Single-slot render queue: if a render is running, remember only the latest
 * requested page (intermediate pages are skipped — they'd be wasted work). */
function queueRenderPage(num) {
    pageIsRendering ? (pageNumPending = num) : renderPage(num);
}

/* ─── Page Navigation ─── */
prevPageBtn.addEventListener('click', () => goToPage(-1));
nextPageBtn.addEventListener('click', () => goToPage(1));
mobilePrevBtn.addEventListener('click', () => goToPage(-1));
mobileNextBtn.addEventListener('click', () => goToPage(1));

/* Global keyboard shortcuts (ignored while typing in form fields):
 *   Esc close search/sidebar/reader, s sidebar, f focus mode,
 *   h/l/arrows page turns, +/- zoom, Space play/pause, j/k sentence step. */
document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === 'Escape') {
        if (searchResultsPanel.classList.contains('visible')) { clearSearch(); return; }
        const sidebarEl = document.getElementById('sidebar');
        if (sidebarEl && sidebarEl.classList.contains('open')) { closeMobileSidebar(); return; }
        resetUI(); return;
    }
    if (e.key === 's' || e.key === 'S') { toggleSidebar(); return; }
    if (e.key === 'f' || e.key === 'F') { setFocusMode(!focusModeEnabled); return; }
    // C: cycle highlight colour, T: cycle theme (same as clicking the toggle)
    if (e.key === 'c' || e.key === 'C') { cycleHighlightColor(); return; }
    if (e.key === 't' || e.key === 'T') { themeToggleBtn?.click(); return; }
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) return;
    if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'h') goToPage(-1);
    if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') goToPage(1);
    if (e.key === '+' || e.key === '=') setZoom(scale + 0.1);
    if (e.key === '-' || e.key === '_') setZoom(scale - 0.1);
    if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
    
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
            updateTtsStatus();
            startReadingPage(currentIndex);
            requestAnimationFrame(() => {
                if (sentences && sentences.length && currentIndex < sentences.length) {
                    highlightActiveSentence(currentIndex, sentences);
                }
            });
            saveSettingsThrottled(pageNum, scale, currentIndex);
        }
    }
});

/* ─── File Handling ─── */
/* Accept PDFs and EPUBs by MIME type, falling back to extension sniffing
 * (some OSes report empty/octet-stream types). */
function isAcceptedFile(file) {
    return file && (file.type === 'application/pdf' || file.type === 'application/epub+zip' ||
        file.name.toLowerCase().endsWith('.epub') || file.name.toLowerCase().endsWith('.pdf'));
}
fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (isAcceptedFile(file)) loadDocument(file, 1);
});
/* Drag & drop onto the welcome screen. */
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

/* Close the current document and return to the welcome screen. Bumps
 * docGeneration first so every pending async pipeline (renders, searches,
 * TTS fetches) aborts on its next generation check; then releases all
 * sockets, caches and blob URLs. */
function resetUI() {
    docGeneration++; // invalidate all in-flight async pipelines for the old document
    hideLoading(); // never leave the overlay stuck (e.g. load error paths)
    currentSearchId++; // kill in-flight searches before clearSearch()
    _invalidatePdfSpanCache();
    if (window._epubResizeObserver) { window._epubResizeObserver.disconnect(); window._epubResizeObserver = null; }
    if (window._epubResizeDebounce) { clearTimeout(window._epubResizeDebounce); window._epubResizeDebounce = null; }
    if (window._epubRoResizeTimer) { clearTimeout(window._epubRoResizeTimer); window._epubRoResizeTimer = null; }
    if (typeof saveTimeout !== 'undefined' && saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
    if (typeof cacheStatusTimeout !== 'undefined' && cacheStatusTimeout) { clearTimeout(cacheStatusTimeout); cacheStatusTimeout = null; }
    if (typeof searchDebounceTimer !== 'undefined' && searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
    stopPipeline();
    clearPageAudioCache();
    WS.close('session');
    WS.close('cache');
    WS.close('tts');
    // Batch-download preload sockets outlive the book otherwise (10-min self-close).
    Object.keys(WS._sockets).forEach(k => { if (k.indexOf('preload:') === 0) WS.close(k); });
    Object.keys(activePreloadJobs).forEach(k => delete activePreloadJobs[k]);
    Object.keys(pageDurationCache).forEach(key => delete pageDurationCache[key]);
    Object.keys(chapterDurationCache).forEach(key => delete chapterDurationCache[key]);
    Object.keys(pendingChapterDurations).forEach(k => delete pendingChapterDurations[k]);
    Object.keys(pendingPageDurations).forEach(k => delete pendingPageDurations[k]);
    clearHighlightCanvas();
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.destroy();
        documentHandler = null;
    }
    // Tear down the PDF document and its blob URL (no leaks across books).
    try { if (pdfDoc && pdfDoc.destroy) pdfDoc.destroy(); } catch (e) {}
    pdfDoc = null;
    if (currentFileUrl) { try { URL.revokeObjectURL(currentFileUrl); } catch (e) {} currentFileUrl = null; }
    // Drop reading/render/search state so nothing fires into the next doc.
    sentences = [];
    currentIndex = 0;
    currentPageText = '';
    pageIsRendering = false;
    pageNumPending = null;
    afterRenderCallback = null;
    currentFile = null;
    currentFileName = '';
    fileInput.value = '';
    readerScreen.classList.remove('active');
    welcomeScreen.classList.add('active');
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
    if (typeof _autoScrollRetryTimer !== 'undefined' && _autoScrollRetryTimer) {
        clearTimeout(_autoScrollRetryTimer); _autoScrollRetryTimer = null;
    }
    pageTimeEl.textContent = 'Page: —';
    chapterTimeEl.textContent = 'Chapter: —';
    Object.keys(pageStats).forEach(key => delete pageStats[key]);
    openLibrarySocket();
}

/* ─── TTS ─── */
/* Split text into TTS-friendly chunks (≤ maxLength chars):
 *  1. Break on newlines and sentence-ending punctuation.
 *  2. Re-join fragments ending in honorific abbreviations ("Mr.", "Dr.")
 *     with the next chunk so they aren't treated as sentence ends.
 *  3. Oversized chunks are subdivided at clause punctuation, then finally
 *     at word boundaries, so the synthesizer never gets a monster string. */
function splitIntoTTSChunks(text, maxLength = 120) {
    const titleAbbrevs = /^(Mr|Mrs|Ms|Dr|Prof|Rev|Hon|Capt|Lt|Col|Maj|Gen|St|Sr|Jr|Sgt|Cpl|Rep|Sen|Gov|Pres|Fig|No|Vol|Ch|Sec|Eq|Ref)$/i;
    const rawChunks = text.split('\n').flatMap(c => c.split(/(?<=[.!?])\s+/)).map(s => s.trim()).filter(s => s.length > 0);

    const joined = [];
    let carry = '';
    for (const chunk of rawChunks) {
        const combined = carry ? carry + ' ' + chunk : chunk;
        const lastWord = chunk.trimEnd().split(/\s+/).pop().replace(/\.$/, '');
        // Rejoin when the boundary is an abbreviation ("Mr."), a latin
        // initialism ("e.g."/"i.e."), a decimal/version ("3.", "v2.") —
        // otherwise "3.14" or "e.g. Smith" would split mid-token.
        if (titleAbbrevs.test(lastWord) || /^(e\.g|i\.e)$/i.test(lastWord) ||
            /^\d+$/.test(lastWord) || /^[vV]\d+$/.test(lastWord)) {
            carry = combined;
        } else {
            joined.push(combined);
            carry = '';
        }
    }
    if (carry) joined.push(carry);

    let final = [];
    joined.forEach(chunk => {
        if (chunk.length <= maxLength) { final.push(chunk); return; }
        let subs = chunk.split(/(?<=[,;:\-—])\s+/);
        let cur = '';
        subs.forEach(sub => {
            if ((cur.length + sub.length) <= maxLength) {
                cur += (cur ? ' ' : '') + sub;
            } else {
                if (cur) { final.push(cur.trim()); cur = ''; }
                if (sub.length > maxLength) {
                    let words = sub.split(/\s+/), ws = '';
                    words.forEach(w => {
                        if ((ws.length + w.length) <= maxLength) {
                            ws += (ws ? ' ' : '') + w;
                            return;
                        }
                        if (ws) { final.push(ws.trim()); ws = ''; }
                        // A single token longer than maxLength: hard-split it
                        // instead of emitting one oversized TTS request.
                        while (w.length > maxLength) { final.push(w.slice(0, maxLength)); w = w.slice(maxLength); }
                        ws = w;
                    });
                    cur = ws;
                } else { cur = sub; }
            }
        });
        if (cur) final.push(cur.trim());
    });
    return final;
}

/* EPUB text normalization shared by the live-rendition extractor and the
 * detached-DOM batch extractor so both produce identical sentence lists
 * (playback ordinals must match download cache keys).
 * buildStructuredText replicates
 *   fullText.replace(/\n{3,}/g,'\n\n').replace(/[ \t]+\n/g,'\n').trim()
 * exactly, and records map[o] = the fullText index that structuredText[o]
 * came from (the transforms only delete characters, so the map is monotonic).
 * trimSkipLines cuts top/bottom newline-separated lines (counts clamped, sum
 * clamped) and returns { text, start } with start = the offset in
 * structuredText where the kept text begins. */
function buildStructuredText(fullText) {
    const out = [];
    const map = [];
    const n = fullText.length;
    let i = 0;
    while (i < n) {
        const ch = fullText[i];
        if (ch === '\n') {
            let j = i + 1;
            while (j < n && fullText[j] === '\n') j++;
            const keep = (j - i) >= 3 ? 2 : (j - i);
            for (let k = 0; k < keep; k++) { out.push('\n'); map.push(i + k); }
            i = j;
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            let j = i + 1;
            while (j < n && (fullText[j] === ' ' || fullText[j] === '\t')) j++;
            if (j < n && fullText[j] === '\n') { i = j; continue; } // [ \t]+\n -> \n
            for (let k = i; k < j; k++) { out.push(fullText[k]); map.push(k); }
            i = j;
            continue;
        }
        out.push(ch);
        map.push(i);
        i++;
    }
    let s = 0, e = out.length;
    while (s < e && /\s/.test(out[s])) s++;
    while (e > s && /\s/.test(out[e - 1])) e--;
    return { text: out.slice(s, e).join(''), map: map.slice(s, e) };
}

function trimSkipLines(structuredText, skipTop, skipBottom) {
    const lines = structuredText.split('\n');
    const t = Math.max(0, Math.min(Math.floor(skipTop) || 0, lines.length));
    const b = Math.max(0, Math.min(Math.floor(skipBottom) || 0, lines.length - t));
    let start = structuredText.length;
    if (t < lines.length) {
        start = 0;
        for (let k = 0; k < t; k++) start += lines[k].length + 1; // +1 for '\n'
    }
    return { text: lines.slice(t, lines.length - b).join('\n'), start };
}

/* Refresh the progress bar + "Sentence N / M" readout from currentIndex. */
function updateTtsStatus() {
    if (!sentences.length) return;
    const di = Math.min(currentIndex + 1, sentences.length);
    ttsProgressFill.style.width = Math.round((di / sentences.length) * 100) + '%';
    ttsStatusText.textContent = `Sentence ${di} / ${sentences.length}`;
}

/* TTS fetch queue state:
 *   _ttsQueue    — sentence indices awaiting synthesis, kept sorted
 *   _ttsBusy     — one request at a time (single-flight)
 *   _ttsPending  — { id, idx, gen, startedAt } of the live request; the server echoes
 *                  request_id in done/error frames so stale responses are ignored
 *   _ttsGen      — bumped by stopPipeline/clearPageAudioCache; completions
 *                  from an older generation are ignored (stops background
 *                  synthesis of stopped pages)
 *   _nextChunkTimer — timer chaining playback to the next sentence
 *   _ttsFetchTimer  — watchdog for one stuck synthesis request (single-flight) */
let _ttsQueue = [];
let _ttsBusy = false;
let _ttsPending = null; // { id, idx, gen, startedAt } — the single in-flight TTS request
let _ttsReqSeq = 0;
let _ttsGen = 0;
let _ttsReconnectAttempts = 0;
let _nextChunkTimer = null;
let _ttsFetchTimer = null;
// Stall detector: while "Generating…" is showing (pre-start buffering), one
// lost response must not wedge the single-flight slot forever. Fires every
// few seconds and force-fails a pending request older than the fetch timeout,
// or re-kicks the queue when it looks idle but non-empty.
let _ttsStallTimer = null;
let _ttsLastProgress = 0;
const _TTS_FETCH_TIMEOUT_MS = 20000;
const _TTS_STALL_CHECK_MS = 5000;
const _ttsChunkOwner = {}; // idx -> reqId of the request currently owning _ttsChunks[idx]

function _clearTtsStallTimer() {
    if (_ttsStallTimer) { clearInterval(_ttsStallTimer); _ttsStallTimer = null; }
}

function _armTtsStallTimer() {
    _clearTtsStallTimer();
    _ttsLastProgress = Date.now();
    _ttsStallTimer = setInterval(() => {
        try {
            if (!isPlaying || hasStartedPlaying) { _clearTtsStallTimer(); return; }
            const now = Date.now();
            const pend = _ttsPending;
            if (pend && (now - (pend.startedAt || now)) > _TTS_FETCH_TIMEOUT_MS) {
                console.warn(`[TTS] Stall detected: request ${pend.id} for sentence ${pend.idx} made no progress in ${_TTS_FETCH_TIMEOUT_MS}ms, skipping`);
                const idx = pend.idx, gen = pend.gen;
                _ttsPending = null;
                delete _ttsChunkOwner[idx];
                delete _ttsChunks[idx];
                if (audioCache[idx] === 'fetching') audioCache[idx] = null;
                _onTtsDone(idx, gen);
                return;
            }
            // Queue looks idle but has work (e.g. a completion threw before
            // re-kicking): nudge it instead of stalling silently.
            if (!_ttsBusy && !pend && _ttsQueue.length > 0) {
                console.warn('[TTS] Stall detected: queue non-empty but idle, re-kicking');
                processTtsQueue();
                return;
            }
            // Inconsistent state: marked busy with no pending record.
            if (_ttsBusy && !pend) {
                console.warn('[TTS] Stall detected: busy flag with no pending request, resetting');
                _ttsBusy = false;
                processTtsQueue();
                return;
            }
            // Idle with an unfilled pre-start buffer and nothing outstanding:
            // any 'fetching' markers left in the window are orphans of a
            // superseded session (their responses were dropped as stale, so
            // nothing will ever complete them). Reap them and re-kick so the
            // missing clip is actually re-requested.
            if (!_ttsBusy && !pend && _ttsQueue.length === 0) {
                const need = Math.min(REQUIRED_START_BUFFER, Math.max(0, sentences.length - currentIndex));
                let swept = 0;
                for (let i = currentIndex; i < currentIndex + need; i++) {
                    if (audioCache[i] === 'fetching') {
                        delete audioCache[i];
                        delete _ttsChunks[i];
                        delete _ttsChunkOwner[i];
                        swept++;
                    }
                }
                if (swept > 0) {
                    console.warn(`[TTS] Stall detected: reaped ${swept} orphaned request(s), re-kicking`);
                    inFlight = 0;
                    try { preloadQueue(); } catch (_) {}
                    processTtsQueue();
                }
            }
        } catch (e) {
            console.warn('[TTS] Stall check failed:', e);
        }
    }, _TTS_STALL_CHECK_MS);
}

/* Snapshot of the TTS pipeline for console diagnosis, e.g.
 * `__drDiag()` when "Generating…" won't clear. */
window.__drDiag = () => {
    try {
        const total = (typeof sentences !== 'undefined' && sentences) ? sentences.length : 0;
        const need = Math.min(REQUIRED_START_BUFFER, Math.max(0, total - currentIndex));
        const win = [];
        for (let i = currentIndex; i < currentIndex + need; i++) {
            const v = audioCache[i];
            win.push([i, v === undefined ? 'missing' : (v === 'fetching' ? 'fetching' : (v === null ? 'failed' : 'ready'))]);
        }
        return {
            build: DR_BUILD, isPlaying, hasStartedPlaying, currentIndex,
            busy: _ttsBusy, pending: _ttsPending ? { ..._ttsPending } : null,
            queue: [..._ttsQueue], inFlight, window: win,
        };
    } catch (e) { return { error: String(e) }; }
};

/* Pop the next index off the queue and start its synthesis request.
 * Single-flight: returns immediately if a request is already active. */
async function processTtsQueue() {
    if (!isPlaying) return;
    if (_ttsBusy || _ttsQueue.length === 0) return;
    _ttsBusy = true;
    const idx = _ttsQueue.shift();
    _ttsPending = { id: ++_ttsReqSeq, idx, gen: _ttsGen, startedAt: Date.now() };
    const reqId = _ttsPending.id;
    const gen = _ttsPending.gen;
    _ttsChunkOwner[idx] = reqId;
    _dlog(`[TTS] Processing queue: idx=${idx}, reqId=${reqId}, remaining=${_ttsQueue.length}`);
    try {
        await fetchSentenceAudio(idx, reqId);
        // Superseded while sending (stop/page-turn/book-switch): the new
        // generation owns the slot now — don't touch its state.
        if (gen !== _ttsGen) {
            if (!_ttsPending || _ttsPending.gen <= gen) { _ttsBusy = false; _ttsPending = null; }
            return;
        }
    } catch (e) {
        console.error(`TTS fetch error for ${idx}:`, e);
        if (gen !== _ttsGen) return;
        if (audioCache[idx] === 'fetching') audioCache[idx] = null;
        _onTtsDone(idx, gen);
    }
}

/* Completion handler for one TTS request. Releases the single-flight slot,
 * marks failures, and drives playback start:
 *  - before first start: wait until REQUIRED_START_BUFFER clips are ready
 *    (shows "Generating… N/M"), then begin;
 *  - after start: chain straight into the next clip when it was the one
 *    currently due.
 * Always re-kicks preload + queue processing. */
function _onTtsDone(idx, gen) {
    // Stale completion from a stopped/superseded session: never touch the
    // new session's busy/pending flags, queue, or playback.
    if (gen !== undefined && gen !== _ttsGen) return;
    if (_ttsFetchTimer) { clearTimeout(_ttsFetchTimer); _ttsFetchTimer = null; }
    _ttsBusy = false;
    _ttsPending = null;
    _ttsAcceptingBinaryFor = null;
    inFlight = Math.max(0, inFlight - 1);
    _ttsLastProgress = Date.now();
    _dlog(`[TTS] Done with idx=${idx}, inFlight=${inFlight}`);

    try {
        if (isPlaying) {
            if (!hasStartedPlaying) {
                const required = Math.min(REQUIRED_START_BUFFER, sentences.length - currentIndex);
                let cnt = 0;
                for (let i = currentIndex; i < currentIndex + required; i++) {
                    if (audioCache[i] !== undefined && audioCache[i] !== 'fetching') cnt++;
                }
                ttsStatusText.textContent = `Generating… ${cnt}/${required}`;
                if (cnt >= required) {
                    hasStartedPlaying = true;
                    _clearTtsStallTimer();
                    playNextChunk();
                }
            } else {
                if (idx === currentIndex && audioPlayer.paused) playNextChunk();
                // Evict clips well behind the playhead so long chapters don't
                // accumulate a blob URL per sentence (seek-back refetches).
                for (const k of Object.keys(audioCache)) {
                    const n = Number(k);
                    if (Number.isInteger(n) && n < currentIndex - 5) {
                        const v = audioCache[k];
                        if (typeof v === 'string' && v.startsWith('blob:')) {
                            try { URL.revokeObjectURL(v); } catch (e) {}
                        }
                        delete audioCache[k];
                    }
                }
            }
        }
    } catch (e) {
        // Playback/highlight must never wedge the fetch queue: log and
        // continue so the lines below still advance synthesis.
        console.warn('[TTS] Playback step failed after done, continuing queue:', e);
    } finally {
        // Always advance: an exception above must not strand queued
        // sentences with no one left to fetch them (the "Generating… 4/5
        // forever with no server traffic" stall).
        try { preloadQueue(); } catch (e) { console.warn('[TTS] preloadQueue failed:', e); }
        try { processTtsQueue(); } catch (e) { console.warn('[TTS] processTtsQueue failed:', e); }
    }
}

/* Request synthesis for a sentence unless it's already cached, in flight,
 * or queued. Queue stays sorted so playback order is preserved even when
 * preloads enqueue out of order. */
function enqueueTts(idx) {
    if (audioCache[idx] !== undefined && audioCache[idx] !== 'fetching') return;
    if (audioCache[idx] === 'fetching') return;
    if (_ttsQueue.includes(idx)) return;
    audioCache[idx] = 'fetching';
    inFlight++;
    _ttsQueue.push(idx);
    _ttsQueue.sort((a, b) => a - b);
    _dlog(`[TTS] Enqueued idx=${idx}, queue length=${_ttsQueue.length}`);
    processTtsQueue();
}

/* Keep BUFFER_DEPTH sentences ahead of currentIndex fetched so playback
 * never catches up with synthesis. */
function preloadQueue() {
    if (!isPlaying) return;
    const limit = Math.min(currentIndex + BUFFER_DEPTH, sentences.length);
    _dlog(`[TTS] preloadQueue: from=${currentIndex} to=${limit - 1}`);
    for (let i = currentIndex; i < limit; i++) {
        if (audioCache[i] === undefined) {
            enqueueTts(i);
        }
    }
}

/* Rewrite technical notation into speakable words: URLs ("h t t p colon…"),
 * email addresses, file names, IP addresses, version numbers, symbols
 * (%, #, /, math operators). Order matters — specific patterns (URLs,
 * emails, IPs) are handled before generic punctuation rules so they don't
 * get mangled twice. */
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
    t = t.replace(/(?<!\s)\.(?!\s*([A-Z]|$|["""''\)\]]))/g, ' dot ');
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

/* ─── TTS fetch via WebSocket ───
 * Binary audio arrives as multiple ArrayBuffer frames, buffered in
 * _ttsChunks[idx] and merged into a single WAV blob on the 'done' JSON.
 * Raw bytes carry no identity, so the server opens each stream with a
 * 'begin' frame: only bytes received after the CURRENT request's begin
 * (tracked in _ttsAcceptingBinaryFor) are buffered. Without this, a seek
 * interleaves sessions and the old clip's late bytes merge into the new
 * clip — highlight shows line N while line M's audio plays. */
const _ttsChunks = {};
let _ttsSocketClosed = false;
let _ttsAcceptingBinaryFor = null; // reqId whose audio bytes we currently trust

/* Open (or reuse) the 'tts' socket. Binary frames append to the pending
 * sentence's chunk buffer, but only between its 'begin' and 'done' frames;
 * JSON 'done'/'error' frames finalize it — but only if request_id matches
 * the current _ttsPending (stale-response guard).
 * On unexpected close: exponential backoff reconnect while playing
 * (giving up to stopPipeline after 5 tries), fail the outstanding request. */
function _ensureTtsSocket() {
    const cur = WS._sockets['tts'];
    if (cur && cur.readyState === WebSocket.OPEN) {
        _ttsReconnectAttempts = 0;
        return;
    }
    // Still connecting: keep it — the caller attaches its own 'open'
    // listener. Tearing it down here would orphan that send.
    if (cur && cur.readyState === WebSocket.CONNECTING) return;
    console.log('[TTS] Opening WebSocket...');
    const ws = WS.openBinary('tts', '/ws/tts',
        (ab) => {
            if (!_ttsPending) return;
            const o = _ttsPending;
            // Only bytes from the current request's own stream (after its
            // 'begin'): a previous session's late bytes must not merge into
            // this clip.
            if (_ttsAcceptingBinaryFor !== o.id) return;
            // Drop bytes from a superseded request sharing this idx (e.g.
            // stop -> replay before the old socket drained).
            if (_ttsChunkOwner[o.idx] !== o.id) return;
            if (!_ttsChunks[o.idx]) _ttsChunks[o.idx] = [];
            _ttsChunks[o.idx].push(ab);
        },
        (msg) => {
            if (msg && msg.type === 'begin') {
                // Stream opener: the bytes that follow belong to this
                // request_id. A stale begin (previous session) is ignored so
                // its late stream can't arm acceptance for the new request.
                const p = _ttsPending;
                if (!p || msg.request_id !== p.id) return;
                if (_ttsChunkOwner[p.idx] !== p.id) return;
                _ttsAcceptingBinaryFor = p.id;
                _ttsChunks[p.idx] = [];
                return;
            }
            const pending = _ttsPending;
            // Ignore stale/late responses from a previous request or session
            if (!pending) return;
            if (msg.request_id !== undefined && msg.request_id !== pending.id) return;
            if (_ttsChunkOwner[pending.idx] !== pending.id) return;
            const gen = pending.gen;
            _ttsPending = null;
            const idx = pending.idx;
            if (msg.type === 'done') {
                const parts = _ttsChunks[idx] || [];
                delete _ttsChunks[idx];
                delete _ttsChunkOwner[idx];
                if (audioCache[idx] === 'fetching') {
                    const total = parts.reduce((s, b) => s + b.byteLength, 0);
                    const merged = new Uint8Array(total);
                    let offset = 0;
                    parts.forEach(b => { merged.set(new Uint8Array(b), offset); offset += b.byteLength; });
                    const blob = new Blob([merged], { type: 'audio/wav' });
                    audioCache[idx] = URL.createObjectURL(blob);
                }
                _onTtsDone(idx, gen);
            } else if (msg.type === 'error') {
                delete _ttsChunkOwner[idx];
                if (audioCache[idx] === 'fetching') {
                    audioCache[idx] = null;
                }
                _onTtsDone(idx, gen);
            }
        }
    );
    // Error handling: on close, attempt reconnect if still playing.
    // A replaced socket's close must not touch the new session's state.
    ws.addEventListener('close', () => {
        if (WS._sockets['tts'] !== ws) return;
        console.warn('[TTS] WebSocket closed unexpectedly');
        if (isPlaying) {
            _ttsReconnectAttempts++;
            if (_ttsReconnectAttempts < 5) {
                const delay = Math.min(1000 * Math.pow(2, _ttsReconnectAttempts - 1), 10000);
                console.log(`[TTS] Reconnecting in ${delay}ms...`);
                setTimeout(() => {
                    if (isPlaying) _ensureTtsSocket();
                }, delay);
            } else {
                console.error('[TTS] Max reconnect attempts reached. Stopping TTS.');
                stopPipeline();
            }
        }
        // Clean up pending chunks and fail only the genuinely outstanding request
        Object.keys(_ttsChunks).forEach(k => delete _ttsChunks[k]);
        Object.keys(_ttsChunkOwner).forEach(k => delete _ttsChunkOwner[k]);
        if (_ttsPending) {
            const idx = _ttsPending.idx;
            const gen = _ttsPending.gen;
            _ttsPending = null;
            if (audioCache[idx] === 'fetching') {
                audioCache[idx] = null;
            }
            _onTtsDone(idx, gen);
        }
    });
}

/* Send the synthesis request for sentence `idx`. A bare-number line is
 * reworded to "Page N." so page-number-only pages still read sensibly.
 * Waits for the socket's 'open' event if it's still connecting. */
async function fetchSentenceAudio(idx, reqId) {
    if (!sentences || idx >= sentences.length || !sentences[idx]) {
        console.warn(`[TTS] Sentence ${idx} not available, skipping`);
        _onTtsDone(idx, _ttsGen);
        return;
    }

    try {
        const raw = sentences[idx];
        const text = normalizeTTSText(/^\d{1,2}$/.test(raw.trim()) ? `Page ${raw.trim()}.` : raw);
        const voice = voiceSelector.value || 'af_sarah';
        // Canonical post-skip ordinal: `sentences` is already skip-filtered,
        // and batch downloads key the same way (`${page}_${si}`). Using
        // idx + topSkip here collided with download keys whenever skip > 0
        // (file p_k held two different texts), so playback could serve audio
        // for a different line than the highlighted one.

        _ensureTtsSocket();
        const ws = WS._sockets['tts'];
        // Watchdog: a dropped send or a response that never arrives must not
        // hold the single-flight slot forever — fail the chunk instead.
        const armWatchdog = () => {
            if (_ttsFetchTimer) clearTimeout(_ttsFetchTimer);
            _ttsFetchTimer = setTimeout(() => {
                _ttsFetchTimer = null;
                if (_ttsPending && _ttsPending.id === reqId && audioCache[idx] === 'fetching') {
                    console.warn(`[TTS] Request ${reqId} timed out after ${_TTS_FETCH_TIMEOUT_MS}ms, skipping sentence ${idx}`);
                    delete _ttsChunkOwner[idx];
                    delete _ttsChunks[idx];
                    audioCache[idx] = null;
                    _onTtsDone(idx, _ttsPending.gen);
                }
            }, _TTS_FETCH_TIMEOUT_MS);
        };
        const sendRequest = () => {
            const payload = {
                request_id: reqId,
                text,
                voice,
                speed: 1.0,
                book_name: currentFileName || '',
                page: pageNum,
                line: idx,
                save: saveAudioEnabled || false,
                force_regenerate: false,
            };
            if (!WS.send('tts', payload)) throw new Error('TTS socket not open');
            armWatchdog();
        };

        if (ws && ws.readyState === WebSocket.OPEN) {
            sendRequest();
        } else if (ws) {
            ws.addEventListener('open', () => {
                // The session may have moved on while connecting — don't emit
                // a stale request the server would synthesize for nothing
                // (its response is dropped on arrival).
                if (!_ttsPending || _ttsPending.id !== reqId || audioCache[idx] !== 'fetching') return;
                try { sendRequest(); } catch (e) { if (audioCache[idx] === 'fetching') audioCache[idx] = null; _onTtsDone(idx, _ttsGen); }
            }, { once: true });
            armWatchdog();
        } else {
            throw new Error('WS not available');
        }
    } catch (e) {
        console.error(`[TTS] WS fetch FAILED for sentence ${idx}:`, e);
        if (audioCache[idx] === 'fetching') audioCache[idx] = null;
        _onTtsDone(idx, _ttsGen);
    }
}

/* Play the sentence at currentIndex (the playback loop's core step).
 *  - End of page: auto-advance to next page if "auto read next" is on,
 *    otherwise stop the pipeline.
 *  - Clip ready: highlight, play, and on 'ended' advance + chain the next
 *    clip after the `rest` pause (timer handle in _nextChunkTimer so Stop
 *    can cancel it — prevents the Stop->Play race where a stale timer
 *    restarts playback after a stop).
 *  - Clip failed (null): skip it silently.
 *  - Still fetching: do nothing; _onTtsDone will call back when ready. */
function playNextChunk() {
    if (!isPlaying) return;
    try {
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
        try {
            highlightActiveSentence(currentIndex, sentences);
        } catch (e) {
            // A highlight miss (e.g. EPUB CFI not laid out yet) must never
            // kill audible playback — log and keep playing.
            console.warn('[TTS] Highlight failed, continuing playback:', e);
        }
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

        audioPlayer.onerror = () => {
            console.warn(`[TTS] Media playback error for chunk ${currentIndex}. Skipping to next.`);
            currentIndex++;
            preloadQueue();
            playNextChunk();
        };

        audioPlayer.onended = () => {
            // Stored remainders are 1x seconds (speed is applied at display),
            // so subtract the raw duration — stays correct even if the speed
            // changed mid-page.
            const dur = sentenceDurations[currentIndex] || estimateSentenceDuration(sentences[currentIndex]);
            pageRemaining = Math.max(0, pageRemaining - dur);
            chapterRemaining = Math.max(0, chapterRemaining - dur);
            updateTimeDisplay();
            currentIndex++;
            saveSettingsThrottled(pageNum, scale, currentIndex);
            preloadQueue();
            clearTimeout(_nextChunkTimer);
            _nextChunkTimer = setTimeout(() => {
                playNextChunk();
            }, rest);
        };
    } else if (url === null) {
        // Skip failed chunks without recursing (long failure runs would
        // otherwise nest hundreds deep); then re-evaluate end-of-page.
        let skips = 0;
        while (audioCache[currentIndex] === null && currentIndex < sentences.length && skips < 500) {
            currentIndex++;
            skips++;
        }
        playNextChunk();
    } else if (url === undefined) {
        // Never enqueued and the queue is empty (e.g. after a skip run):
        // enqueue it and retry shortly instead of stalling silently.
        // ('fetching' needs no action — its completion resumes via _onTtsDone.)
        enqueueTts(currentIndex);
        clearTimeout(_nextChunkTimer);
        _nextChunkTimer = setTimeout(() => { if (isPlaying) playNextChunk(); }, 500);
    }
    } catch (e) {
        // Never let one bad clip wedge the whole page: skip it and continue.
        console.warn(`[TTS] playNextChunk failed for chunk ${currentIndex}, skipping:`, e);
        try {
            if (audioCache[currentIndex] !== undefined && audioCache[currentIndex] !== 'fetching') {
                const v = audioCache[currentIndex];
                if (typeof v === 'string' && v.startsWith('blob:')) { try { URL.revokeObjectURL(v); } catch (_) {} }
                delete audioCache[currentIndex];
            }
            currentIndex++;
            preloadQueue();
        } catch (_) {}
        clearTimeout(_nextChunkTimer);
        _nextChunkTimer = setTimeout(() => { if (isPlaying) playNextChunk(); }, 300);
    }
}

/* Current playback rate from the speed slider. */
function getPlaybackRate() {
    return parseFloat(document.getElementById('speed-slider').value);
}
// Speed slider: update label + live playbackRate, repaint estimates
// immediately at the new speed, then refresh data + persist.
document.getElementById('speed-slider').addEventListener('input', async () => {
    const rate = getPlaybackRate();
    playbackSpeed = rate;
    speedVal.textContent = rate.toFixed(1) + '×';
    updateTimeDisplay();
    if (isPlaying && !audioPlayer.paused) {
        audioPlayer.playbackRate = rate;
        await refreshTimeEstimates();
    } else {
        await refreshTimeEstimates();
    }
    saveSettingsThrottled(pageNum, scale, currentIndex);
});

/* Halt playback and tear down all player-side state: cancel the chained
 * next-chunk timer (Stop->Play race), detach player handlers, unload src,
 * clear highlights, persist position. */
function stopPipeline() {
    isPlaying = false;
    isAutoContinuing = false; // reset auto-advance flag
    _ttsGen++; // invalidate in-flight completions so the stopped page can't resume
    _ttsBusy = false;
    _ttsPending = null;
    _ttsAcceptingBinaryFor = null;
    _clearTtsStallTimer();
    if (_ttsFetchTimer) { clearTimeout(_ttsFetchTimer); _ttsFetchTimer = null; }
    if (_nextChunkTimer) { clearTimeout(_nextChunkTimer); _nextChunkTimer = null; }
    audioPlayer.pause();
    audioPlayer.onerror = null;
    audioPlayer.onended = null;
    audioPlayer.src = ''; // unload to avoid revoke issues
    playBtn.textContent = '▶ Play Page';
    ttsStatus.classList.remove('active');
    syncMobilePlayBtn();
    clearHighlightCanvas();
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.clearHighlights();
    }
    saveSettingsThrottled(pageNum, scale, currentIndex);
    refreshTimeEstimates();
}

/* Revoke all cached blob URLs and reset the TTS fetch state. Must unload
 * audioPlayer first — playing a revoked URL throws. */
function clearPageAudioCache() {
    // Pause and unload audio before revoking URLs
    audioPlayer.pause();
    audioPlayer.src = '';
    if (audioCache) {
        Object.values(audioCache).forEach(v => { 
            if (v && typeof v === 'string' && v.startsWith('blob:')) URL.revokeObjectURL(v); 
        });
    }
    WS.close('tts');
    audioCache = {};
    inFlight = 0;
    sentenceDurations = {};
    _ttsQueue = [];
    _ttsBusy = false;
    _ttsPending = null;
    _ttsGen++;
    Object.keys(_ttsChunks).forEach(k => delete _ttsChunks[k]);
    Object.keys(_ttsChunkOwner).forEach(k => delete _ttsChunkOwner[k]);
    _ttsAcceptingBinaryFor = null;
    _clearTtsStallTimer();
    if (_ttsFetchTimer) { clearTimeout(_ttsFetchTimer); _ttsFetchTimer = null; }
    _ttsReconnectAttempts = 0;
    _ttsSocketClosed = false;
}

/* Keep the mobile FAB in sync with isPlaying (red stop square vs play icon). */
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
mobilePlayBtn.addEventListener('click', () => togglePlayback({ silentEmpty: true }));

/* ─── Cache badge (WebSocket‑only with fallback) ───
 * Shows how many sentences of the current page the server has cached.
 * Live updates arrive over the 'cache' socket; if no reply comes within 2s
 * we fall back to an HTTP status query. */
let cacheStatusTimeout = null;

/* Drop duration estimates affected by a cache change on one book page
 * (composite keys: exact page entry plus any chapter range of that book). */
function invalidateBookDurations(bookName, page) {
    if (!bookName) return;
    const pkey = `${bookName}::${page}`;
    delete pageDurationCache[pkey];
    delete pendingPageDurations[pkey];
    const cp = `${bookName}::`;
    Object.keys(chapterDurationCache).forEach(k => { if (k.indexOf(cp) === 0) delete chapterDurationCache[k]; });
    Object.keys(pendingChapterDurations).forEach(k => { if (k.indexOf(cp) === 0) delete pendingChapterDurations[k]; });
}

/* Subscribe to per-book cache updates for `bookName`. */
let _cacheSocketBook = null;
function openCacheSocket(bookName) {
    if (!bookName) { _cacheSocketBook = null; WS.close('cache'); return; }
    // Called on both book load and page render: don't tear down a healthy
    // socket for the same book — the close+reopen race is what produced
    // "WebSocket is closed before the connection is established".
    const cur = WS._sockets['cache'];
    if (_cacheSocketBook === bookName && cur) {
        if (cur.readyState === WebSocket.OPEN) { requestCacheStatus(); return; }
        if (cur.readyState === WebSocket.CONNECTING) {
            // Ask on open instead of warning now and never asking at all.
            // (WS.open assigns ws.onopen; addEventListener coexists with it.)
            cur.addEventListener('open', () => { if (_cacheSocketBook === bookName) requestCacheStatus(); }, { once: true });
            return;
        }
        // CLOSED/CLOSING: fall through to reopen below.
    }
    WS.close('cache');
    _cacheSocketBook = bookName;
    console.log('[Cache] Opening cache socket for', bookName);
    const ws = WS.open('cache', `/ws/cache/${encodeURIComponent(bookName)}`, msg => {
        if (!msg) return;
        if (msg.type === 'cache_update') {
            _dlog('[Cache] cache_update page', msg.page, 'lines', msg.cached_lines);
            if (msg.page === pageNum) {
                const lines = msg.cached_lines || [];
                if (lines.length > 0) {
                    cacheBadge.textContent = `${lines.length} cached`;
                    cacheBadge.classList.add('visible');
                } else {
                    cacheBadge.classList.remove('visible');
                }
                invalidateBookDurations(bookName, msg.page);
                if (cacheStatusTimeout) {
                    clearTimeout(cacheStatusTimeout);
                    cacheStatusTimeout = null;
                }
            }
        }
        if (msg.type === 'cache_cleared') {
            if (msg.page === pageNum) {
                cacheBadge.classList.remove('visible');
                invalidateBookDurations(bookName, msg.page);
            }
        }
    }, () => {
        console.log('[Cache] Socket opened for', bookName);
        if (currentFileName) {
            requestCacheStatus();
        }
    });
}

/* Ask the server for the current page's cache status; arms the 2s HTTP
 * fallback timer in case the socket answer never arrives. */
function requestCacheStatus() {
    const ws = WS._sockets['cache'];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[Cache] Cannot request status – socket not open');
        return;
    }
    _dlog('[Cache] Requesting cache status for page', pageNum);
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

/* Refresh the badge for the current page (called on page turns). Works for
 * PDF and EPUB: both use per-page server cache keys. */
function updateCacheBadge() {
    if (!currentFileName || (!pdfDoc && !(documentHandler instanceof EPUBHandler))) {
        cacheBadge.classList.remove('visible');
        return;
    }
    _dlog('[Cache] updateCacheBadge for page', pageNum);
    const ws = WS._sockets['cache'];
    if (ws && ws.readyState === WebSocket.OPEN) {
        requestCacheStatus();
    } else {
        _dlog('[Cache] Socket not open, re-opening');
        openCacheSocket(currentFileName);
    }
}

/* ─── Global Preferences (Save Toggle, Voice, Auto-Read) ───
 * Device-local prefs (not per-book server settings): voice choice,
 * auto-read-next and the save-audio toggle, persisted in localStorage. */
const PREFS_KEY = 'docreader-global-prefs';

/* Restore global prefs into their controls at startup. */
function loadGlobalPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        const voiceSel = document.getElementById('voice-selector');
        if (prefs.voice && voiceSel &&
            voiceSel.querySelector(`option[value="${prefs.voice}"]`)) {
            voiceSel.value = prefs.voice;
        }
        if (typeof prefs.autoReadNext === 'boolean' && document.getElementById('auto-read-next')) {
            document.getElementById('auto-read-next').checked = prefs.autoReadNext;
        }
        if (typeof prefs.saveAudio === 'boolean' && saveAudioToggle) {
            saveAudioToggle.checked = prefs.saveAudio;
            saveAudioEnabled = prefs.saveAudio;
            saveRangeRow.style.display = saveAudioEnabled ? 'flex' : 'none';
        }
    } catch(e) {
        console.warn('Failed to load global prefs', e);
    }
}

/* Persist the three global prefs (wired to change events below). */
function saveGlobalPrefs() {
    const prefs = {
        voice: document.getElementById('voice-selector')?.value ?? 'af_sarah',
        autoReadNext: document.getElementById('auto-read-next')?.checked ?? false,
        saveAudio: saveAudioToggle?.checked ?? false
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

document.getElementById('voice-selector')?.addEventListener('change', saveGlobalPrefs);
document.getElementById('auto-read-next')?.addEventListener('change', saveGlobalPrefs);

if (saveAudioToggle) {
    saveAudioToggle.addEventListener('change', e => {
        saveAudioEnabled = e.target.checked;
        saveRangeRow.style.display = saveAudioEnabled ? 'flex' : 'none';
        saveGlobalPrefs();
    });
}

loadGlobalPrefs();

/* Extract TTS sentences for one EPUB spine item without touching the live
 * rendition (works on a detached DOM). Mirrors _extractTextFromRendition's
 * line/paragraph reconstruction, then applies top/bottom line skips. */
async function extractEpubPageSentences(book, spineItem, skipTop = 0, skipBottom = 0) {
    const content = await book.load(spineItem.href);
    let doc;
    if (typeof content === 'string') {
        const parser = new DOMParser();
        doc = parser.parseFromString(content, 'application/xhtml+xml');
    } else if (content && typeof content === 'object') {
        doc = content;
    }
    if (!doc || !doc.body) return [];

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
    let lastParentBlock = null;
    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            if (!fullText.endsWith('\n')) fullText += '\n';
            continue;
        }
        const parent = node.parentElement;
        let t = node.textContent.replace(/\s+/g, ' ');
        if (t === '') continue;
        const nearestBlock = parent ? parent.closest('p,div,h1,h2,h3,h4,h5,h6,li,blockquote,section,article,pre') : null;
        if (nearestBlock && nearestBlock !== lastParentBlock) {
            if (fullText.length > 0 && !fullText.endsWith('\n')) fullText = fullText.trimEnd() + '\n';
            lastParentBlock = nearestBlock;
        }
        if (t === ' ' && (fullText.endsWith(' ') || fullText.endsWith('\n'))) continue;
        fullText += t;
    }

    const built = buildStructuredText(fullText);
    // Same skip semantics as the live extractor (shared helper).
    const trimmed = trimSkipLines(built.text, skipTop, skipBottom).text;
    return splitIntoTTSChunks(trimmed, 250);
}

/* ─── Batch download ───
 * "Download range" flow: extract sentences for a page/chapter range that the
 * server hasn't cached yet and queue them for server-side synthesis, with
 * live progress (extraction 0-40%, generation 70-99%).
 *
 * Race safety: dlBookName/dlPdfDoc/dlHandler are captured up front; every
 * worker re-checks `currentFileName !== dlBookName` so switching documents
 * mid-download aborts instead of writing the new book's cache keys. */
downloadRangeBtn.addEventListener('click', async () => {
    const isPdf = !!pdfDoc;
    const isEpub = documentHandler instanceof EPUBHandler;
    if (!currentFileName || isDownloadingRange || (!isPdf && !isEpub)) return;
    
    const rangeStr = pageRangeInput.value.trim();
    if (!rangeStr) { pageRangeInput.focus(); return; }

    // ─── Line-range mode (EPUB only): "100:200" = lines 100-200 of the
    // current chapter. 1-based human line numbers; ":200" means 1-200,
    // "100:" means 100-end. Page-range syntax below is unchanged. ───
    if (rangeStr.includes(':')) {
        if (!isEpub) {
            dlProgress.classList.add('active');
            dlProgressFill.style.width = '0%';
            dlStatusText.textContent = 'Line download (a:b) is EPUB-only.';
            setTimeout(() => {
                dlProgress.classList.remove('active');
                dlProgressFill.style.width = '0%';
            }, 2500);
            pageRangeInput.style.borderColor = 'var(--danger)';
            setTimeout(() => pageRangeInput.style.borderColor = '', 1500);
            return;
        }
        const lm = rangeStr.match(/^(\d*)\s*:\s*(\d*)$/);
        if (!lm || (lm[1] === '' && lm[2] === '')) {
            pageRangeInput.style.borderColor = 'var(--danger)';
            setTimeout(() => pageRangeInput.style.borderColor = '', 1500);
            return;
        }
        const chapterLines = (documentHandler && documentHandler.currentSentences && documentHandler.currentSentences.length)
            ? documentHandler.currentSentences
            : (sentences || []);
        const totalLines = chapterLines.length;
        if (!totalLines) {
            dlProgress.classList.add('active');
            dlStatusText.textContent = 'No lines loaded for this chapter yet.';
            setTimeout(() => dlProgress.classList.remove('active'), 2500);
            return;
        }
        let lineFrom = lm[1] === '' ? 1 : parseInt(lm[1], 10);
        let lineTo = lm[2] === '' ? totalLines : parseInt(lm[2], 10);
        if (!Number.isFinite(lineFrom) || !Number.isFinite(lineTo)) {
            pageRangeInput.style.borderColor = 'var(--danger)';
            setTimeout(() => pageRangeInput.style.borderColor = '', 1500);
            return;
        }
        lineFrom = Math.max(1, lineFrom);
        lineTo = Math.min(totalLines, lineTo);
        if (lineFrom > lineTo || lineFrom > totalLines) {
            dlProgress.classList.add('active');
            dlProgressFill.style.width = '0%';
            dlStatusText.textContent = `Invalid lines — this chapter has 1-${totalLines}.`;
            setTimeout(() => {
                dlProgress.classList.remove('active');
                dlProgressFill.style.width = '0%';
            }, 2500);
            pageRangeInput.style.borderColor = 'var(--danger)';
            setTimeout(() => pageRangeInput.style.borderColor = '', 1500);
            return;
        }

        const voice = document.getElementById('voice-selector').value;
        const dlBookName = currentFileName;
        const dlPage = pageNum;
        isDownloadingRange = true;
        downloadRangeBtn.disabled = true;
        dlProgress.classList.add('active');
        dlProgressFill.style.width = '10%';
        dlStatusText.textContent = `Scanning lines ${lineFrom}-${lineTo}…`;

        let cachedSet = new Set();
        try {
            const statusRes = await fetch(
                `/cache_status_bulk?book_name=${encodeURIComponent(dlBookName)}&page_from=${dlPage}&page_to=${dlPage}`
            );
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                const pages = statusData.pages || {};
                cachedSet = new Set(pages[String(dlPage)] || []);
            }
        } catch (e) {}

        if (currentFileName !== dlBookName) {
            dlStatusText.textContent = 'Cancelled';
            setTimeout(() => {
                dlProgress.classList.remove('active');
                dlProgressFill.style.width = '0%';
                isDownloadingRange = false;
                downloadRangeBtn.disabled = false;
            }, 2000);
            return;
        }

        const lineSentences = {};
        for (let si = lineFrom - 1; si <= lineTo - 1; si++) {
            if (cachedSet.has(si)) continue;
            const raw = chapterLines[si];
            if (!raw) continue;
            const text = normalizeTTSText(
                /^\d{1,2}$/.test(raw.trim()) ? `Page ${raw.trim()}.` : raw
            );
            lineSentences[`${dlPage}_${si}`] = text;
        }

        const newLineCount = Object.keys(lineSentences).length;
        if (newLineCount === 0) {
            dlProgressFill.style.width = '100%';
            dlStatusText.textContent = `Lines ${lineFrom}-${lineTo} already cached ✓`;
            setTimeout(() => {
                dlProgress.classList.remove('active');
                dlProgressFill.style.width = '0%';
                isDownloadingRange = false;
                downloadRangeBtn.disabled = false;
                updateCacheBadge();
            }, 2000);
            return;
        }

        dlStatusText.textContent = `Queuing ${newLineCount} chunks (lines ${lineFrom}-${lineTo})…`;
        dlProgressFill.style.width = '45%';
        // Failsafe: server 'done' may never arrive on a dead socket. Stored
        // so the real completion can cancel it (no double-finish).
        let dlFailsafe = null;
        const dlDone = (msg) => {
            if (dlFailsafe) { clearTimeout(dlFailsafe); dlFailsafe = null; }
            finishDownload(1, msg, dlBookName);
        };
        try {
            const res = await fetch('/preload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    book_name: dlBookName,
                    page_from: dlPage,
                    page_to: dlPage,
                    sentences: lineSentences,
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
                    if (currentFileName !== dlBookName) { WS.close(`preload:${jobId}`); return; }
                    const done = msg.done || 0;
                    const total = msg.total || newLineCount;
                    const pct = Math.min(99, Math.round(70 + (done / Math.max(1, total)) * 29));
                    dlProgressFill.style.width = pct + '%';
                    dlStatusText.textContent = `Server generating… ${done} / ${total} (lines ${lineFrom}-${lineTo})`;
                    if (msg.status === 'done') {
                        WS.close(`preload:${jobId}`);
                        dlDone(`Done! Lines ${lineFrom}-${lineTo} (chapter ${dlPage}) queued ✓`);
                    }
                });
                dlFailsafe = setTimeout(() => { dlFailsafe = null; WS.close(`preload:${jobId}`); dlDone(`Done! Lines ${lineFrom}-${lineTo} (chapter ${dlPage}) queued ✓`); }, 600000);
            } else {
                dlDone(`Done! Lines ${lineFrom}-${lineTo} (chapter ${dlPage}) queued ✓`);
            }
        } catch (e) {
            dlStatusText.textContent = `Error: ${e.message}`;
            setTimeout(() => {
                dlProgress.classList.remove('active');
                isDownloadingRange = false;
                downloadRangeBtn.disabled = false;
            }, 3000);
        }
        return;
    }

    const match = rangeStr.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!match) {
        pageRangeInput.style.borderColor = 'var(--danger)';
        setTimeout(() => pageRangeInput.style.borderColor = '', 1500);
        return;
    }
    
    const totalDocs = isPdf ? pdfDoc.numPages : documentHandler.pageCount;
    const fromPage = Math.max(1, parseInt(match[1], 10));
    const toPage = Math.min(totalDocs, parseInt(match[2] || match[1], 10));
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

    // Capture document identity so a mid-download switch can't poison the new book's cache
    const dlBookName = currentFileName;
    const dlPdfDoc = isPdf ? pdfDoc : null;
    const dlHandler = isEpub ? documentHandler : null;

    const extractPage = async (p) => {
        if (isPdf) {
            const page = await dlPdfDoc.getPage(p);
            const textContent = await page.getTextContent();
            return extractSentencesFromTextContent(textContent, page, topSkipLines, bottomSkipLines);
        }
        const item = dlHandler.spineItems[p - 1];
        return await extractEpubPageSentences(dlHandler.book, item, topSkipLines, bottomSkipLines);
    };

    // 4-worker extraction pool pulling page numbers from a shared cursor.
    const DL_CONCURRENCY = 4;
    const pageCount = toPage - fromPage + 1;
    let nextExtract = 0;
    const extractWorker = async () => {
        while (nextExtract < pageCount) {
            if (currentFileName !== dlBookName) return;
            const k = nextExtract++;
            const p = fromPage + k;
            try {
                const pageSentences = await extractPage(p);
                const alreadyCached = new Set(cachedByPage[String(p)] || []);
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
            dlStatusText.textContent = `Extracting ${isEpub ? 'chapter' : 'page'} ${p} / ${toPage}…`;
            dlProgressFill.style.width = Math.round((extractedPages / totalPages) * 40) + '%';
        }
    };
    await Promise.all(Array.from({ length: Math.min(DL_CONCURRENCY, pageCount) }, extractWorker));

    if (currentFileName !== dlBookName) {
        console.warn('[DL] Document switched mid-download, aborting.');
        dlStatusText.textContent = 'Cancelled';
        setTimeout(() => {
            dlProgress.classList.remove('active');
            dlProgressFill.style.width = '0%';
            isDownloadingRange = false;
            downloadRangeBtn.disabled = false;
        }, 2000);
        return;
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
                book_name: dlBookName,
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
            let pgFailsafe = null;
            const pgDone = () => {
                if (pgFailsafe) { clearTimeout(pgFailsafe); pgFailsafe = null; }
                finishDownload(totalPages, undefined, dlBookName);
            };
            WS.open(`preload:${jobId}`, `/ws/preload/${jobId}`, msg => {
                if (!msg) return;
                if (currentFileName !== dlBookName) { WS.close(`preload:${jobId}`); return; }
                const done = msg.done || 0;
                const total = msg.total || newSentenceCount;
                const pct = Math.min(99, Math.round(70 + (done / Math.max(1, total)) * 29));
                dlProgressFill.style.width = pct + '%';
                dlStatusText.textContent = `Server generating… ${done} / ${total}`;
                if (msg.status === 'done') {
                    WS.close(`preload:${jobId}`);
                    pgDone();
                }
            });
            pgFailsafe = setTimeout(() => { pgFailsafe = null; WS.close(`preload:${jobId}`); pgDone(); }, 600000);
        } else {
            finishDownload(totalPages, undefined, dlBookName);
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
/* Shared completion path for the batch download: show success, restore the
 * button, invalidate duration caches so estimates pick up the new audio.
 * bookName guards against a mid-generation book switch painting the old
 * job's completion onto the new book. */
function finishDownload(pageCount, customMsg, bookName) {
    if (bookName && bookName !== currentFileName) return;
    dlProgressFill.style.width = '100%';
    dlStatusText.textContent = customMsg || `Done! ${pageCount} page(s) queued for caching ✓`;
    setTimeout(() => {
        if (bookName && bookName !== currentFileName) return;
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
/* Standalone PDF page -> sentence extraction (no rendering). Same line
 * grouping + paragraph/list reconstruction as renderPage's inline version,
 * but operates on a raw textContent so batch download can use it without
 * touching the visible canvas. */
function extractSentencesFromTextContent(textContent, page, skipTop = 0, skipBottom = 0) {
    const viewport = page.getViewport({ scale: 1 });
    const fontSizes = textContent.items.map(i => Math.abs(i.transform[3])).filter(s => s > 0).sort((a, b) => a - b);
    const baseFontSize = fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12;
    const Y_TOL = 5;
    // Same quantized row sort as renderPage() — download keys must match
    // playback sentences exactly.
    const sorted = [...textContent.items].sort((a, b) => {
        const ba = Math.round(a.transform[5] / Y_TOL);
        const bb = Math.round(b.transform[5] / Y_TOL);
        if (ba !== bb) return bb - ba;
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
    const skipTopClamped = Math.max(0, Math.min(skipTop, lines.length));
    const skipBottomClamped = Math.max(0, Math.min(skipBottom, lines.length - skipTopClamped));
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
            structuredText += `\n${lineText}${/[.!?…]$/.test(lineText) ? '' : '.'}\n`;
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
/* Wipe the active-sentence highlight canvas (PDF mode). */
function clearHighlightCanvas() {
    const hlCanvas = document.getElementById('highlight-canvas');
    if (!hlCanvas) return;
    const ctx = hlCanvas.getContext('2d');
    ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
}

/* Highlight the active sentence. EPUB: delegate to the handler's class
 * toggling. PDF: draw rounded highlight rects on an overlay canvas.
 *
 * The tricky part is mapping sentence offsets (computed over *normalized*
 * text — lowercased, alphanumeric-only) back to raw DOM ranges:
 *  1. entry.{start,end} are indices in the page-wide normalized string.
 *  2. For each overlapping span, walk its rawText counting only
 *     alphanumeric chars to translate normalized boundaries into raw
 *     character offsets (punctuation is skipped but included in ranges).
 *  3. Extend `re` past trailing punctuation so highlights cover it.
 *  4. Distribute raw offsets across the span's child text nodes, build a
 *     DOM Range and merge its client rects per visual row.
 * Finally all rows are painted as rounded rects (dimming everything else
 * first when focus mode is on). */
/* Shared trailing-punctuation rule for sentence highlight extents (active
 * highlight and hover use the same set so extents agree). */
function _isHlPunct(ch) {
    return /[.,!?;:'"’”\]\)]/.test(ch);
}

/* Merge per-row rect boxes, joining only boxes that overlap or nearly touch
 * horizontally. Distant boxes on the same visual row (multi-column gutters,
 * margin notes) stay separate instead of one wide band across the gap. */
function _mergeRowBoxes(rows) {
    const merged = [];
    rows.forEach(boxes => {
        boxes.sort((a, b) => a.left - b.left);
        let cur = null;
        for (const b of boxes) {
            if (cur && b.left <= cur.right + 48) {
                cur.left = Math.min(cur.left, b.left);
                cur.right = Math.max(cur.right, b.right);
                cur.top = Math.min(cur.top, b.top);
                cur.bottom = Math.max(cur.bottom, b.bottom);
            } else {
                if (cur) merged.push(cur);
                cur = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
            }
        }
        if (cur) merged.push(cur);
    });
    return merged;
}
function highlightActiveSentence(sentenceIndex, allSentences) {
    if (documentHandler instanceof EPUBHandler) {
        documentHandler.highlightSentence(sentenceIndex);
        return;
    }
    
    clearHighlightCanvas();
    if (sentenceIndex < 0 || sentenceIndex >= allSentences.length) return;

    const hlCanvas = document.getElementById('highlight-canvas');
    const container = document.getElementById('pdf-container');
    if (!hlCanvas || !container) return;

    if (_pdfSentenceOffsets.size === 0 && sentences && sentences.length) {
        _rebuildPdfSentenceOffsets();
    }

    const { spanNorms } = _getPdfSpanData();

    const entry = _pdfSentenceOffsets.get(sentenceIndex);
    if (!entry) return;

    const dpr = window.devicePixelRatio || 1;
    const cRect = container.getBoundingClientRect();
    const rows = new Map();
    let firstSpan = null;

    spanNorms.forEach(map => {
        const os = Math.max(map.normStart, entry.start);
        const oe = Math.min(map.normEnd, entry.end);
        if (os >= oe) return;

        if (!firstSpan) firstSpan = map.span;

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
        while (re < map.rawText.length && _isHlPunct(map.rawText[re])) re++;

        // Find text node(s) inside span – handle child nodes (e.g., <mark>)
        const textNodes = [];
        const walk = document.createTreeWalker(map.span, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walk.nextNode())) {
            textNodes.push(node);
        }
        if (textNodes.length === 0) return;

        // Distribute character offset across text nodes
        let totalLen = 0;
        let startNode = null, endNode = null;
        let startOffset = 0, endOffset = 0;
        for (const tn of textNodes) {
            const len = tn.length;
            if (totalLen + len > rs && startNode === null) {
                startNode = tn;
                startOffset = rs - totalLen;
            }
            if (totalLen + len >= re && endNode === null) {
                endNode = tn;
                endOffset = re - totalLen;
                break;
            }
            totalLen += len;
        }
        if (!startNode || !endNode) return;

        try {
            const range = document.createRange();
            range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.length)));
            range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.length)));
            
            const rects = Array.from(range.getClientRects());
            rects.forEach(r => {
                if (r.width < 1 || r.height < 1) return;
                const left   = r.left - cRect.left;
                const top    = r.top  - cRect.top;
                const right  = r.right - cRect.left;
                const bottom = r.bottom - cRect.top;
                
                const rowKey = Math.round(top / 2) * 2;
                if (!rows.has(rowKey)) {
                    rows.set(rowKey, [{ left, right, top, bottom }]);
                } else {
                    rows.get(rowKey).push({ left, right, top, bottom });
                }
            });
        } catch(e) {}
    });

    const boxRows = _mergeRowBoxes(rows);
    if (boxRows.length === 0) return;

    const cw = Math.round(cRect.width * dpr);
    const ch = Math.round(cRect.height * dpr);
    if (hlCanvas.width !== cw) hlCanvas.width = cw;
    if (hlCanvas.height !== ch) hlCanvas.height = ch;
    hlCanvas.style.width = cRect.width + 'px';
    hlCanvas.style.height = cRect.height + 'px';
    const ctx = hlCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
    ctx.scale(dpr, dpr);

    const pad = hlPadding;
    const r   = hlRadius;

    const traceRowPath = (row) => {
        const x  = row.left  - pad;
        const y  = row.top;
        const w  = (row.right - row.left) + pad * 2;
        const h  = (row.bottom - row.top) + 1;
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
    };

    // Focus mode: dim the page, then carve the dim back out over the active
    // rows so their text stays at full brightness (instead of painting an
    // opaque band on top of the text layer).
    if (focusModeEnabled) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, cRect.width, cRect.height);
        ctx.globalCompositeOperation = 'destination-out';
        boxRows.forEach(row => { traceRowPath(row); ctx.fill(); });
        ctx.globalCompositeOperation = 'source-over';
    }

    ctx.fillStyle = `rgba(${hlBaseColor}, ${hlOpacity})`;
    if (hlOutline) { 
        ctx.strokeStyle = `rgba(${hlBaseColor}, ${Math.min(1, hlOpacity * 2.5)})`; 
        ctx.lineWidth = 1; 
    }

    boxRows.forEach(row => {
        traceRowPath(row);
        ctx.fill();
        if (hlOutline) ctx.stroke();
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    _scrollToHighlightedSentence(firstSpan);
}

/* Keep the highlighted sentence inside the viewer's central 20%..80% band,
 * centering it when it drifts out. Retries briefly while layout settles. */
let _autoScrollRetryTimer = null;
function _scrollToHighlightedSentence(span, attempt = 0) {
    if (!span || !viewerArea) return;
    clearTimeout(_autoScrollRetryTimer);
    const vr  = viewerArea.getBoundingClientRect();
    const hr  = span.getBoundingClientRect();
    if (vr.height < 10 || hr.width < 1) {
        if (attempt < 3) {
            _autoScrollRetryTimer = setTimeout(() => _scrollToHighlightedSentence(span, attempt + 1), 80);
        }
        return;
    }
    const elementTop    = hr.top    - vr.top;
    const elementBottom = hr.bottom - vr.top;
    const elementCenter = elementTop + hr.height / 2;
    const viewportCenter = vr.height / 2;
    const inBand = elementTop > vr.height * 0.2 && elementBottom < vr.height * 0.8;
    if (!inBand) {
        viewerArea.scrollTo({
            top: viewerArea.scrollTop + elementCenter - viewportCenter,
            behavior: 'smooth',
        });
    }
}

/* ─── PDF Sentence Span Map ───────────────────────────────────── */
let _pdfSentenceOffsets = new Map();

/* Per-render text-layer cache: built once per page render, reused by
   highlighting, hover and click-to-read instead of rescanning the DOM. */
let _pdfSpanCache = null;

/* Normalization for offset math: lowercase, strip everything except
 * [a-z0-9]. Both sentence text and span text are squeezed through this so
 * matching is immune to whitespace/punctuation differences between the TTS
 * text and pdf.js's text layer. */
function _normPdfText(s) {
    return (s ? String(s) : '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Drop the per-render span cache (called on every page render). */
function _invalidatePdfSpanCache() { _pdfSpanCache = null; }

/* Raw display text of a text-layer span (search <mark> wrapping stashes the
 * original in dataset.originalText). */
function _spanRawText(span) {
    return span.dataset.originalText !== undefined ? span.dataset.originalText : span.textContent;
}

/* Build (once per render) the normalized-text map of the current page's
 * text layer:
 *   normText  — all spans' normalized text concatenated
 *   spanNorms — per-span {span, rawText, normStart, normEnd}
 *   prefix    — per-span starting offset in normText (for point lookups)
 *   spanIndex — span element -> index (O(1) hit-test lookup) */
function _getPdfSpanData() {
    if (_pdfSpanCache) return _pdfSpanCache;
    const allSpans = Array.from(document.querySelectorAll('.textLayer span'));
    let fullNorm = '';
    const spanNorms = [];
    const prefix = new Array(allSpans.length);
    const spanIndex = new Map();
    allSpans.forEach((span, i) => {
        prefix[i] = fullNorm.length;
        spanIndex.set(span, i);
        const raw = _spanRawText(span);
        const n = _normPdfText(raw);
        spanNorms.push({ span, rawText: raw, normStart: fullNorm.length, normEnd: fullNorm.length + n.length });
        fullNorm += n;
    });
    _pdfSpanCache = { spans: allSpans, normText: fullNorm, spanNorms, prefix, spanIndex };
    return _pdfSpanCache;
}

/* Locate each TTS sentence within normText, recording {start,end} offsets.
 * Scans forward with a cursor (sentences are in order); a failed forward
 * match falls back to searching from the start (repeated sentences).
 * Result feeds highlightActiveSentence/_drawHoverHighlight/_sentenceIndexAtPoint. */
function _rebuildPdfSentenceOffsets() {
    _pdfSentenceOffsets = new Map();
    if (!sentences || !sentences.length) return;
    const { normText } = _getPdfSpanData();
    let cursor = 0;
    sentences.forEach((sent, i) => {
        const tn = _normPdfText(sent);
        if (!tn) return;
        let mi = normText.indexOf(tn, cursor);
        if (mi === -1) mi = normText.indexOf(tn, 0);
        if (mi !== -1) {
            _pdfSentenceOffsets.set(i, { start: mi, end: mi + tn.length });
            // Never regress: a fallback hit behind the cursor would drag every
            // later sentence onto early occurrences (repeated sentences).
            cursor = Math.max(cursor, mi + tn.length);
        }
    });
}

/* Find the sentence whose normalized range contains `normOffset`. */
function _pdfSentenceAtOffset(normOffset) {
    for (const [idx, s] of _pdfSentenceOffsets) {
        if (normOffset >= s.start && normOffset < s.end) return idx;
    }
    return -1;
}

/* ─── PDF Hover Canvas ─── */
let _hoverCanvas = null;
let _hoverSentenceIdx = -1;

/* Lazily create the transparent hover canvas layered over the PDF page. */
function _ensureHoverCanvas() {
    if (_hoverCanvas) return _hoverCanvas;
    const container = document.getElementById('pdf-container');
    if (!container) return null;
    _hoverCanvas = document.createElement('canvas');
    _hoverCanvas.id = 'hover-canvas';
    _hoverCanvas.style.cssText = `
        position:absolute; top:0; left:0; width:100%; height:100%;
        pointer-events:none; z-index:4;
    `;
    container.style.position = 'relative';
    container.appendChild(_hoverCanvas);
    return _hoverCanvas;
}

/* Draw the hover preview highlight for one sentence on its own canvas.
 * Same normalized-offset -> DOM-range mapping as highlightActiveSentence
 * (see that function for details), but with a fainter fill + outline. */
function _drawHoverHighlight(sentIdx) {
    const canvas = _ensureHoverCanvas();
    if (!canvas) return;
    const container = document.getElementById('pdf-container');
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const cRect = container.getBoundingClientRect();
    const cw = Math.round(cRect.width * dpr);
    const ch = Math.round(cRect.height * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    canvas.style.width = cRect.width + 'px';
    canvas.style.height = cRect.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (sentIdx < 0 || !sentences[sentIdx]) return;

    const entry = _pdfSentenceOffsets.get(sentIdx);
    if (!entry) return;

    const { spanNorms } = _getPdfSpanData();

    const rows = new Map();
    spanNorms.forEach(map => {
        const os = Math.max(map.normStart, entry.start);
        const oe = Math.min(map.normEnd, entry.end);
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
        while (re < map.rawText.length && _isHlPunct(map.rawText[re])) re++;

        const textNodes = [];
        const walk = document.createTreeWalker(map.span, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walk.nextNode())) {
            textNodes.push(node);
        }
        if (textNodes.length === 0) return;

        let totalLen = 0;
        let startNode = null, endNode = null;
        let startOffset = 0, endOffset = 0;
        for (const tn of textNodes) {
            const len = tn.length;
            if (totalLen + len > rs && startNode === null) {
                startNode = tn;
                startOffset = rs - totalLen;
            }
            if (totalLen + len >= re && endNode === null) {
                endNode = tn;
                endOffset = re - totalLen;
                break;
            }
            totalLen += len;
        }
        if (!startNode || !endNode) return;

        try {
            const range = document.createRange();
            range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.length)));
            range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.length)));
            
            const rects = Array.from(range.getClientRects());
            rects.forEach(r => {
                if (r.width < 1 || r.height < 1) return;
                const left   = r.left - cRect.left;
                const top    = r.top  - cRect.top;
                const right  = r.right - cRect.left;
                const bottom = r.bottom - cRect.top;
                
                const rowKey = Math.round(top / 2) * 2;
                if (!rows.has(rowKey)) {
                    rows.set(rowKey, [{ left, right, top, bottom }]);
                } else {
                    rows.get(rowKey).push({ left, right, top, bottom });
                }
            });
        } catch(e) {}
    });

    const boxRows = _mergeRowBoxes(rows);
    if (boxRows.length === 0) return;
    ctx.scale(dpr, dpr);
    const pad = hlPadding;
    const r   = hlRadius;
    const hoverOpacity = Math.min(1, hlOpacity * 0.55);
    ctx.fillStyle   = `rgba(${hlBaseColor}, ${hoverOpacity})`;
    ctx.strokeStyle = `rgba(${hlBaseColor}, ${Math.min(1, hlOpacity)})`;
    ctx.lineWidth   = 1;

    boxRows.forEach(row => {
        const x  = row.left  - pad;
        const y  = row.top;
        const w  = (row.right - row.left) + pad * 2;
        const h  = (row.bottom - row.top) + 1;
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
        ctx.stroke();
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* Clear hover canvas + remembered sentence. */
function _clearHoverCanvas() {
    if (!_hoverCanvas) return;
    const ctx = _hoverCanvas.getContext('2d');
    ctx.clearRect(0, 0, _hoverCanvas.width, _hoverCanvas.height);
    _hoverSentenceIdx = -1;
}

/* ─── Click-to-Read + Hover ─── */
const _textLayerEl = document.getElementById('text-layer');

/* Map a text-layer span back to its sentence index via the normalized
 * prefix table (span start offset -> containing sentence). */
function _spanSentenceIndex(spanEl) {
    if (!sentences || !sentences.length) return -1;
    const { prefix, spanIndex } = _getPdfSpanData();
    const si = spanIndex !== undefined ? (spanIndex.get(spanEl) ?? -1) : -1;
    if (si === -1) return -1;
    return _pdfSentenceAtOffset(prefix[si]);
}

/* Shared hover/click lookup: sentence index at a viewport point.
 * Uses caretRangeFromPoint to get the exact text node + character under the
 * cursor (falling back to elementFromPoint), then converts that raw offset
 * into normalized-text space and finds the containing sentence.
 * Returns -1 when the point isn't over sentence text. */
function _sentenceIndexAtPoint(clientX, clientY) {
    if (!sentences || !sentences.length || !_pdfSentenceOffsets.size) return -1;
    const cache = _getPdfSpanData();
    let span = null;
    let charOffset = 0;

    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(clientX, clientY);
        if (!range) return -1;
        const node = range.startContainer;
        charOffset = range.startOffset;
        span = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (span && span.tagName && span.tagName.toLowerCase() === 'mark') span = span.parentElement;
    } else {
        span = document.elementFromPoint(clientX, clientY);
        if (span && span.tagName && span.tagName.toLowerCase() === 'mark') span = span.parentElement;
        if (span && span.textContent !== null) {
            // No caret API: estimate the offset from the pointer's horizontal
            // position within the span instead of pinning to its end (which
            // biases every lookup to the next sentence at span boundaries).
            try {
                const r = span.getBoundingClientRect();
                const frac = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 1;
                charOffset = Math.floor(frac * span.textContent.length);
            } catch (e) {
                charOffset = span.textContent.length;
            }
        }
    }
    if (!(span && span.matches && span.matches('.textLayer span'))) return -1;

    const si = cache.spanIndex !== undefined ? (cache.spanIndex.get(span) ?? -1) : cache.spans.indexOf(span);
    if (si === -1) return -1;

    const spanRaw = _spanRawText(span);
    const normBefore = cache.prefix[si] + _normPdfText(spanRaw.slice(0, charOffset)).length;
    return _pdfSentenceAtOffset(normBefore);
}

let _hoverRafPending = false;
let _hoverLastEvent = null;

// Hover preview on the PDF text layer. mousemove is rAF-throttled: at most
// one hit-test + redraw per frame, always for the most recent cursor pos.
_textLayerEl.addEventListener('mousemove', e => {
    if (documentHandler instanceof EPUBHandler) return;
    _hoverLastEvent = { x: e.clientX, y: e.clientY };
    if (_hoverRafPending) return;
    _hoverRafPending = true;
    requestAnimationFrame(() => {
        _hoverRafPending = false;
        const ev = _hoverLastEvent;
        _hoverLastEvent = null;
        if (!ev) return;
        const idx = _sentenceIndexAtPoint(ev.x, ev.y);
        if (idx === _hoverSentenceIdx) return;
        _hoverSentenceIdx = idx;
        if (idx === -1) { _clearHoverCanvas(); return; }
        _drawHoverHighlight(idx);
    });
});

_textLayerEl.addEventListener('mouseleave', () => {
    _clearHoverCanvas();
});

// Click a sentence to start reading from it.
_textLayerEl.addEventListener('click', e => {
    if (documentHandler instanceof EPUBHandler) return;

    const found = _sentenceIndexAtPoint(e.clientX, e.clientY);

    if (found !== -1) {
        startReadingPage(found);
        requestAnimationFrame(() => {
            if (sentences && sentences.length && found < sentences.length) {
                highlightActiveSentence(found, sentences);
            }
        });
    }
});

/* ─── Delete Cache Range ─── */
/* Ask the server to drop cached audio for a page range, then invalidate the
 * local duration caches so estimates recompute. */
document.getElementById('delete-range-btn').onclick = async () => {
    if (!currentFileName || (!pdfDoc && !(documentHandler instanceof EPUBHandler))) return;
    const rangeStr = document.getElementById('delete-range-input').value.trim();
    if (!rangeStr) { 
        deleteStatus.textContent = 'Enter a page range (e.g. 5-10 or 5)'; 
        return; 
    }
    const match = rangeStr.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!match) { 
        deleteStatus.textContent = 'Invalid range format. Use e.g. 5-10 or 5'; 
        return; 
    }
    const fromPage = Math.max(1, parseInt(match[1], 10));
    const pageCount = pdfDoc ? pdfDoc.numPages : (documentHandler instanceof EPUBHandler ? documentHandler.pageCount : 9999);
    const toPage = Math.min(pageCount, parseInt(match[2] || match[1], 10));
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
        Object.keys(pageDurationCache).forEach(k => delete pageDurationCache[k]);
        Object.keys(chapterDurationCache).forEach(k => delete chapterDurationCache[k]);
        refreshTimeEstimates();
    } catch (err) {
        console.error("Delete Cache Error:", err);
        deleteStatus.textContent = `Error: ${err.message}`;
    } finally {
        deleteRangeBtn.disabled = false;
        document.getElementById('delete-range-input').value = '';
    }
};

/* ─── Upload Document to Server ─── */
/* Upload a local file to the server library (so it appears in the welcome
 * screen list and gets server-side caching). */
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

/* Seconds -> compact human string ("45s", "3m 12s", "6h 50m"). */
function formatDuration(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const total = Math.round(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/* Top/bottom skip-line inputs. Debounced: changing these invalidates the
 * current page's sentence extraction, so after 400ms we stop playback,
 * purge audio, and re-render the page with the new line filters. */
const skipTopInput = document.getElementById('skip-top-lines');
const skipBottomInput = document.getElementById('skip-bottom-lines');
let _skipChangeTimer = null;
function onSkipChange() {
    topSkipLines = parseInt(skipTopInput.value, 10) || 0;
    bottomSkipLines = parseInt(skipBottomInput.value, 10) || 0;
    saveSettingsThrottled(pageNum, scale, currentIndex);
    // EPUB: sentence ordinals now honor skips, so re-render the chapter to
    // re-extract with the new counts (same reset discipline as the PDF path).
    if (documentHandler instanceof EPUBHandler) {
        clearTimeout(_skipChangeTimer);
        _skipChangeTimer = setTimeout(() => {
            stopPipeline();
            clearPageAudioCache();
            currentIndex = 0;
            const h = documentHandler;
            if (!(h instanceof EPUBHandler)) return;
            h.renderPage(pageNum).then(result => {
                if (!result || documentHandler !== h) return;
                currentPageText = result.text;
                sentences = result.sentences;
                updatePageStats(pageNum, sentences);
            }).catch(() => {});
        }, 400);
        return;
    }
    if (!pdfDoc) return;
    clearTimeout(_skipChangeTimer);
    _skipChangeTimer = setTimeout(() => {
        stopPipeline();
        clearPageAudioCache();
        currentIndex = 0;
        sentences = [];
        currentPageText = '';
        delete searchAllPageTexts[pageNum];
        queueRenderPage(pageNum);
    }, 400);
}
skipTopInput.addEventListener('input', onSkipChange);
skipBottomInput.addEventListener('input', onSkipChange);

/* ─── Time display ─── */
/* Paint the cached page/chapter remaining estimates into the UI. Stored
 * values are 1x seconds; playback speed is applied here — the single place
 * — so dragging the speed slider rescales the numbers instantly and they
 * can never desync from the current speed. ≈ marks estimates that include
 * guesses for uncached audio. */
function updateTimeDisplay() {
    const speed = playbackSpeed > 0 ? playbackSpeed : 1;
    pageTimeEl.textContent = `Page: ${pageExact ? '' : '≈'}${formatDuration(pageRemaining / speed)}`;
    chapterTimeEl.textContent = `Chapter: ${chapterExact ? '' : '≈'}${formatDuration(chapterRemaining / speed)}`;
}

/* Coalesced time-estimate refresh. Nav paths call this fire-and-forget;
 * all callers within a 100ms window share one actual server round-trip and
 * every returned promise resolves when that run finishes. */
let refreshDebounce = null;
let refreshInFlight = false;
let refreshPendingResolvers = [];

async function refreshTimeEstimates() {
    // Coalesce: every caller's promise resolves once the next actual run completes
    return new Promise((resolve) => {
        refreshPendingResolvers.push(resolve);
        clearTimeout(refreshDebounce);
        refreshDebounce = setTimeout(_runTimeEstimateRefresh, 100);
    });
}

/* The single estimate pass: hybrid measured/guessed page remainder plus the
 * TOC-chapter remainder, then paint. One path for PDF and EPUB (EPUB spine
 * pages use the same server cache keys). If requests arrived while running,
 * re-run shortly. */
async function _runTimeEstimateRefresh() {
    if (refreshInFlight) return; // will re-run via finally when current pass finishes
    refreshInFlight = true;
    const gen = docGeneration;
    const staleEst = () => gen !== docGeneration;
    try {
        const isEpub = documentHandler instanceof EPUBHandler;
        if (!isEpub && !pdfDoc) return;
        await fetchSentenceDurationsForCurrentPage();
        if (staleEst()) return;
        updateChapterBoundaries();
        const rem = computeRemainingFrom(currentIndex);
        pageRemaining = rem.total;
        pageExact = rem.exact;
        let rest = { total: 0, exact: true };
        if (chapterStartPage !== null && chapterEndPage !== null && chapterStartPage <= chapterEndPage) {
            rest = await computeChapterRest();
            if (staleEst()) return;
        }
        chapterRemaining = pageRemaining + rest.total;
        chapterExact = rem.exact && rest.exact;
        updateTimeDisplay();
    } finally {
        refreshInFlight = false;
        const pending = refreshPendingResolvers;
        refreshPendingResolvers = [];
        pending.forEach(r => r());
        if (refreshPendingResolvers.length) { // new requests arrived mid-run
            clearTimeout(refreshDebounce);
            refreshDebounce = setTimeout(_runTimeEstimateRefresh, 50);
        }
    }
}

/* ─── startReadingPage ─── */
/* Begin (or restart) playback of the current page at `startIndex`.
 * Drops any queued-but-unfetched sentences, resets pipeline state, primes
 * duration estimates for the remaining page/chapter, and either starts
 * immediately (if the REQUIRED_START_BUFFER is ready) or shows a
 * "Generating…" countdown until _onTtsDone fills the buffer. */
async function startReadingPage(startIndex = 0) {
    if (!currentPageText.trim() || !sentences.length) {
        console.warn('[TTS] No sentences available for this page');
        return;
    }
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) return;
    // Clamp: a stale index (e.g. restored from a longer chapter) must not
    // produce an empty buffer that instantly "completes".
    startIndex = Math.max(0, Math.min(startIndex, sentences.length - 1));

    // Un-claim queued-but-unfetched sentences so they can be re-requested.
    // Ready blob URLs are kept (reusable); only 'fetching' placeholders and
    // the in-flight counter for them are rolled back.
    _ttsQueue.forEach(idx => {
        if (audioCache[idx] === 'fetching') {
            delete audioCache[idx];
            inFlight = Math.max(0, inFlight - 1);
        }
    });
    _ttsQueue = [];

    if (isPlaying) stopPipeline();

    // Reap orphaned in-flight state from the superseded session: its
    // response (if any) will be dropped as stale, so a lingering 'fetching'
    // marker would block that sentence forever — the "Generating… 4/5 with
    // no server traffic" deadlock. Finished blob URLs are kept.
    Object.keys(audioCache).forEach(k => { if (audioCache[k] === 'fetching') delete audioCache[k]; });
    Object.keys(_ttsChunks).forEach(k => delete _ttsChunks[k]);
    Object.keys(_ttsChunkOwner).forEach(k => delete _ttsChunkOwner[k]);
    _ttsAcceptingBinaryFor = null;
    inFlight = _ttsQueue.length + (_ttsPending ? 1 : 0);

    currentIndex = startIndex;
    isPlaying = true;
    hasStartedPlaying = false;
    playBtn.textContent = '⏹ Stop';
    ttsStatus.classList.add('active');
    syncMobilePlayBtn();

    await fetchSentenceDurationsForCurrentPage();
    // User hit Stop while we were fetching — bail without starting.
    if (!isPlaying) return;

    // Precompute remaining time (1x; speed is applied at display). Hybrid
    // measured/guessed so fully cached pages show exact numbers.
    updateChapterBoundaries();
    const rem = computeRemainingFrom(currentIndex);
    pageRemaining = rem.total;
    pageExact = rem.exact;
    if (chapterStartPage !== null && chapterEndPage !== null && chapterStartPage <= chapterEndPage) {
        const rest = await computeChapterRest();
        if (!isPlaying) return;
        chapterRemaining = pageRemaining + rest.total;
        chapterExact = rem.exact && rest.exact;
    } else {
        chapterRemaining = pageRemaining;
        chapterExact = rem.exact;
    }
    updateTimeDisplay();

    const required = Math.max(1, Math.min(REQUIRED_START_BUFFER, sentences.length - currentIndex));
    let readyCount = 0;
    for (let i = currentIndex; i < currentIndex + required; i++) {
        if (audioCache[i] !== undefined && audioCache[i] !== 'fetching') readyCount++;
    }
    if (readyCount >= required) {
        hasStartedPlaying = true;
        _clearTtsStallTimer();
        playNextChunk();
    } else {
        ttsStatusText.textContent = `Generating… ${readyCount}/${required}`;
        // Watchdog for the pre-start buffer: if the missing clip(s) never
        // complete, fail them through instead of showing Generating… forever.
        _armTtsStallTimer();
    }
    preloadQueue();
    // Re-run the debounced estimator last so a stopPipeline-triggered refresh
    // queued just above can't overwrite these per-currentIndex remainders.
    refreshTimeEstimates();
}

/* Fetch per-sentence measured durations (from previously cached audio) for
 * the current page; falls back to estimates when unavailable. PDF-only —
 * EPUB resets to estimates so stale PDF numbers can't leak across books. */
async function fetchSentenceDurationsForCurrentPage() {
    // Works for EPUB too: the server keys cache by spine-page number, the
    // same ordinal scheme playback and batch downloads use.
    if (!currentFileName) { sentenceDurations = {}; return; }
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) { sentenceDurations = {}; return; }
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

/* Main Play/Stop button: toggle playback, restarting from the top of the
 * page if we ran past the last sentence. Mobile passes silentEmpty to keep
 * its no-feedback behavior on empty pages. */
function togglePlayback({ silentEmpty = false } = {}) {
    if (isPlaying) { stopPipeline(); return; }
    if (!currentPageText.trim()) {
        if (!silentEmpty) alert('No text on this page.');
        return;
    }
    if (!pdfDoc && !(documentHandler instanceof EPUBHandler)) return;
    const si = currentIndex >= sentences.length ? 0 : currentIndex;
    startReadingPage(si);
}
playBtn.addEventListener('click', () => togglePlayback());

/* 'is-scrolling' body class while the PDF viewer scrolls (hides scrollbars
 * / fades chrome via CSS), same pattern as the EPUB iframe hook. */
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

const DR_BUILD = '2026-09-26i'; // bump on every script.js change (see index.html ?v=)
console.log(`DocReader Pro ready – build ${DR_BUILD}.`);
