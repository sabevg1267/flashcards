// ── Firebase ──────────────────────────────────────────────────────────────
firebase.initializeApp({
  apiKey:            'AIzaSyD4-Bp-K3Eagpe-2dy1qs0j4F-k5ft24dY',
  authDomain:        'firebasics-99c9b.firebaseapp.com',
  databaseURL:       'https://firebasics-99c9b-default-rtdb.firebaseio.com',
  projectId:         'firebasics-99c9b',
  storageBucket:     'firebasics-99c9b.appspot.com',
  messagingSenderId: '673506510856',
  appId:             '1:673506510856:web:c49b561e89db01dd24a9bd',
});
const auth     = firebase.auth();
const database = firebase.database();
const storage  = firebase.storage();
let   fbUser   = null;
let   _fbReady = false; // true only after Firebase data has been loaded into `data`

// ── Storage ──────────────────────────────────────────────────────────────
const STORAGE_KEY = 'anki_data';

// Firebase Realtime DB stores arrays as objects with numeric keys.
// This converts them back to real JS arrays.
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  // Object with numeric keys → array
  return Object.keys(val).sort((a, b) => Number(a) - Number(b)).map(k => val[k]);
}

function _sanitize(d) {
  if (!d) d = {};
  d.folders        = toArray(d.folders);
  d.decks          = toArray(d.decks);
  // Also normalize cards inside each deck
  d.decks.forEach(deck => { deck.cards = toArray(deck.cards); });
  if (!d.lightWorkTotal) d.lightWorkTotal = 0;
  return d;
}

function loadLocal() {
  try { return _sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}); }
  catch { return _sanitize({}); }
}

function save(d) {
  d.lastModified = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  // Never write to Firebase until we have successfully loaded from it first.
  // This prevents the initial empty `data = _sanitize({})` from overwriting
  // real data in Firebase before the async load completes.
  if (!fbUser || !_fbReady) return;
  // Debounce: batch rapid successive saves into one Firebase write
  clearTimeout(save._timer);
  save._pendingData = d;
  save._timer = setTimeout(save._flush, 300);
}
save._flush = function() {
  if (!fbUser || !save._pendingData) return;
  database.ref('users/' + fbUser.uid + '/data').set(save._pendingData).catch(console.error);
  save._pendingData = null;
};
// Flush any pending debounced save on tab close
window.addEventListener('beforeunload', () => {
  clearTimeout(save._timer);
  save._flush();
});

// Targeted update — only write specific paths, no full-blob write
// Guard with _fbReady so this never fires before data is loaded from Firebase.
function fbPatch(patches) {
  if (!fbUser || !_fbReady) return;
  database.ref('users/' + fbUser.uid + '/data').update(patches).catch(console.error);
}

// Holds the active Firebase realtime listener so we can detach it on sign-out.
let _fbListener = null;

async function loadFromFirebase() {
  const local = loadLocal();
  try {
    const snap = await database.ref('users/' + fbUser.uid + '/data').get();
    let initial;
    if (snap.exists()) {
      initial = _sanitize(snap.val());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    } else {
      // First sign-in — push local data up.
      await database.ref('users/' + fbUser.uid + '/data').set(local);
      initial = local;
    }
    _fbReady = true;

    // ── Realtime listener: keep data in sync across tabs / devices ────────
    // Attaches AFTER the initial load so the first snapshot doesn't
    // double-process what we already fetched above.
    if (_fbListener) _fbListener(); // detach any previous listener
    _fbListener = database.ref('users/' + fbUser.uid + '/data').on('value', snap => {
      // Ignore if not yet ready (shouldn't happen, but be safe)
      if (!_fbReady) return;
      // Ignore if there's a pending local write in the debounce buffer
      // (we'd just be reading back what we're about to write)
      if (save._pendingData) return;
      if (!snap.exists()) return;
      const remote = _sanitize(snap.val());
      // Only apply if remote is strictly newer than what we have locally
      if ((remote.lastModified || 0) > (data.lastModified || 0)) {
        data = remote;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
        // Re-render only if on the home screen to avoid interrupting study
        if (views.home.classList.contains('active'))  renderHome();
        if (views.deck.classList.contains('active'))  renderDeck();
      }
    }, err => console.warn('Firebase listener error:', err));

    return initial;
  } catch (err) {
    console.warn('Firebase unreachable, using localStorage:', err);
    _fbReady = true;
    return local;
  }
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── State ─────────────────────────────────────────────────────────────────────
let data = _sanitize({}); // always populated from Firebase on sign-in
let currentDeckId = null;
let activeTags    = [];       // tags currently selected in the filter bar
let studyQueue   = [];   // remaining cards this session
let studyDone    = 0;    // cards marked Light work this session
let isFlipped    = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const views = {
  home:  document.getElementById('view-home'),
  deck:  document.getElementById('view-deck'),
  study: document.getElementById('view-study'),
};

const $ = id => document.getElementById(id);

// ── View switching ────────────────────────────────────────────────────────────
function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
}

// ── Home view ─────────────────────────────────────────────────────────────────
let dragDeckId = null; // id of deck being dragged

function renderHome() {
  showView('home');
  const list = $('deck-list');
  list.innerHTML = '';
  const total = data.decks.length + data.folders.length;
  $('no-decks').classList.toggle('hidden', total > 0);

  // Render folders
  data.folders.forEach(folder => {
    const decksInFolder = data.decks.filter(d => d.folderId === folder.id);
    const block = document.createElement('div');
    block.className = 'folder-block';

    // Header
    const header = document.createElement('div');
    header.className = 'folder-header';
    header.innerHTML = `
      <span class="folder-arrow ${folder.collapsed ? '' : 'open'}">&#9658;</span>
      <span class="folder-icon">&#128193;</span>
      <span class="folder-name">${escHtml(folder.name)}</span>
      <span class="folder-meta">${decksInFolder.length} deck${decksInFolder.length !== 1 ? 's' : ''}</span>
      <div class="folder-actions">
        <button data-frename="${folder.id}">Rename</button>
        <button data-fdelete="${folder.id}">Delete</button>
      </div>`;

    header.addEventListener('click', e => {
      if (e.target.closest('.folder-actions')) return;
      folder.collapsed = !folder.collapsed;
      save(data);
      renderHome();
    });
    header.querySelector(`[data-frename]`).addEventListener('click', e => {
      e.stopPropagation();
      openModal({ title: 'Rename Folder', inputPlaceholder: 'Folder name', inputValue: folder.name }, val => {
        if (!val.trim()) return;
        folder.name = val.trim(); save(data); renderHome();
      });
    });
    header.querySelector(`[data-fdelete]`).addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Delete folder "${folder.name}"? Decks inside will move to root.`)) return;
      data.decks.forEach(d => { if (d.folderId === folder.id) d.folderId = null; });
      data.folders = data.folders.filter(f => f.id !== folder.id);
      save(data); renderHome();
    });

    // Folder as a drop target (header)
    header.addEventListener('dragover', e => { e.preventDefault(); header.classList.add('drag-over'); });
    header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
    header.addEventListener('drop', e => {
      e.preventDefault();
      header.classList.remove('drag-over');
      if (dragDeckId) moveDeckToFolder(dragDeckId, folder.id);
    });

    block.appendChild(header);

    // Children
    const children = document.createElement('div');
    children.className = 'folder-children' + (folder.collapsed ? ' collapsed' : '');

    if (decksInFolder.length === 0) {
      children.innerHTML = '<span class="folder-empty">Drop decks here</span>';
    } else {
      decksInFolder.forEach(deck => children.appendChild(makeDeckItem(deck)));
    }

    // Children area as a drop target
    children.addEventListener('dragover', e => { e.preventDefault(); children.classList.add('drag-over'); });
    children.addEventListener('dragleave', e => { if (!children.contains(e.relatedTarget)) children.classList.remove('drag-over'); });
    children.addEventListener('drop', e => {
      e.preventDefault();
      children.classList.remove('drag-over');
      if (dragDeckId) moveDeckToFolder(dragDeckId, folder.id);
    });

    block.appendChild(children);
    list.appendChild(block);
  });

  // Root decks (no folder)
  const rootDecks = data.decks.filter(d => !d.folderId);
  rootDecks.forEach(deck => list.appendChild(makeDeckItem(deck)));

  // Stats bar
  renderStats();

  // Root drop zone (move deck out of folder back to root)
  if (data.folders.length > 0) {
    const rootDrop = document.createElement('div');
    rootDrop.id = 'root-drop-zone';
    rootDrop.addEventListener('dragover', e => { e.preventDefault(); rootDrop.classList.add('drag-over'); });
    rootDrop.addEventListener('dragleave', () => rootDrop.classList.remove('drag-over'));
    rootDrop.addEventListener('drop', e => {
      e.preventDefault();
      rootDrop.classList.remove('drag-over');
      if (dragDeckId) moveDeckToFolder(dragDeckId, null);
    });
    list.appendChild(rootDrop);
  }
}

function moveDeckToFolder(deckId, folderId) {
  const deck = data.decks.find(d => d.id === deckId);
  if (deck) { deck.folderId = folderId; save(data); renderHome(); }
}

function makeDeckItem(deck) {
  const item = document.createElement('div');
  item.className = 'deck-item';
  item.draggable = true;
  item.dataset.deckId = deck.id;

  const dueCount = deck.cards.filter(c => isDue(c)).length;

  item.innerHTML = `
    <div style="flex:1;cursor:pointer;min-width:0" data-open="${deck.id}">
      <div class="deck-name">${escHtml(deck.name)}</div>
      <div class="deck-meta">${deck.cards.length} card${deck.cards.length !== 1 ? 's' : ''}${dueCount ? ` · <span style="color:var(--accent)">${dueCount} due</span>` : ''}</div>
    </div>
    <div class="deck-actions">
      <button data-rename="${deck.id}">Rename</button>
      <button data-delete="${deck.id}">Delete</button>
    </div>`;

  item.querySelector('[data-open]').addEventListener('click', () => openDeck(deck.id));
  item.querySelector('[data-rename]').addEventListener('click', e => {
    e.stopPropagation();
    openModal({ title: 'Rename Deck', inputPlaceholder: 'Deck name', inputValue: deck.name }, value => {
      if (!value.trim()) return;
      deck.name = value.trim(); save(data); renderHome();
    });
  });
  item.querySelector('[data-delete]').addEventListener('click', e => {
    e.stopPropagation();
    if (!confirm(`Delete "${deck.name}" and all its cards?`)) return;
    data.decks = data.decks.filter(d => d.id !== deck.id);
    save(data); renderHome();
  });

  // ── Touch drag (iOS) ─────────────────────────────────────────────────────
  let _touchTimer    = null;
  let _touchGhost    = null;
  let _touchDragging = false;
  let _lastDropTarget = null;

  function _clearDragOver() {
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function _dropTargetAt(x, y) {
    // Temporarily hide the ghost so elementFromPoint sees the elements beneath
    if (_touchGhost) _touchGhost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (_touchGhost) _touchGhost.style.display = '';
    if (!el) return null;
    // Walk up until we find a recognised drop target
    return el.closest('.folder-header, .folder-children, #root-drop-zone');
  }

  item.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    _touchTimer = setTimeout(() => {
      _touchDragging = true;
      dragDeckId = deck.id;
      item.classList.add('dragging');

      // Build ghost
      const rect = item.getBoundingClientRect();
      _touchGhost = item.cloneNode(true);
      _touchGhost.style.cssText = `
        position:fixed; z-index:9999; pointer-events:none;
        width:${rect.width}px; opacity:0.85;
        left:${rect.left}px; top:${rect.top}px;
        box-shadow:0 8px 24px rgba(0,0,0,0.5);
        border-radius:var(--radius);
      `;
      document.body.appendChild(_touchGhost);
    }, 400);
  }, { passive: true });

  item.addEventListener('touchmove', e => {
    clearTimeout(_touchTimer);
    if (!_touchDragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    const rect = _touchGhost.getBoundingClientRect();
    _touchGhost.style.left = (touch.clientX - rect.width / 2) + 'px';
    _touchGhost.style.top  = (touch.clientY - 24) + 'px';

    _clearDragOver();
    const target = _dropTargetAt(touch.clientX, touch.clientY);
    if (target) target.classList.add('drag-over');
    _lastDropTarget = target;
  }, { passive: false });

  function _endTouchDrag() {
    clearTimeout(_touchTimer);
    if (_touchGhost)    { _touchGhost.remove();  _touchGhost = null; }
    if (_touchDragging && _lastDropTarget) {
      const el = _lastDropTarget;
      _clearDragOver();
      if (el.id === 'root-drop-zone') {
        moveDeckToFolder(dragDeckId, null);
      } else {
        // Find which folder this target belongs to
        const block = el.closest('.folder-block');
        if (block) {
          const headerName = block.querySelector('.folder-name')?.textContent;
          const folder = data.folders.find(f => f.name === headerName);
          if (folder) moveDeckToFolder(dragDeckId, folder.id);
        }
      }
    } else {
      _clearDragOver();
    }
    item.classList.remove('dragging');
    _touchDragging = false;
    _lastDropTarget = null;
    dragDeckId = null;
  }

  item.addEventListener('touchend',    _endTouchDrag, { passive: true });
  item.addEventListener('touchcancel', _endTouchDrag, { passive: true });

  // ── Mouse drag (desktop) ─────────────────────────────────────────────────
  item.addEventListener('dragstart', e => {
    dragDeckId = deck.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => {
    dragDeckId = null;
    item.classList.remove('dragging');
  });

  return item;
}

function formatCount(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(n % 1_000_000_000 === 0 ? 0 : 1) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + 'K';
  return n.toLocaleString();
}

function renderStats() {
  let bar = $('home-stats');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'home-stats';
    $('view-home').appendChild(bar);
  }
  const totalCards = data.decks.reduce((s, d) => s + d.cards.length, 0);
  bar.innerHTML = `
    <div class="stat-item">
      <span class="stat-value">${formatCount(data.lightWorkTotal)}</span>
      <span class="stat-label">Light works</span>
    </div>
    <div class="stat-divider"></div>
    <div class="stat-item">
      <span class="stat-value">${formatCount(totalCards)}</span>
      <span class="stat-label">Total cards</span>
    </div>
    <div class="stat-divider"></div>
    <div class="stat-item">
      <span class="stat-value">${formatCount(data.decks.length)}</span>
      <span class="stat-label">Decks</span>
    </div>`;
}

$('btn-new-deck').addEventListener('click', () => {
  openModal({ title: 'New Deck', inputPlaceholder: 'Deck name' }, value => {
    if (!value.trim()) return;
    data.decks.push({ id: uid(), name: value.trim(), cards: [], folderId: null });
    save(data); renderHome();
  });
});

$('btn-new-folder').addEventListener('click', () => {
  openModal({ title: 'New Folder', inputPlaceholder: 'Folder name' }, value => {
    if (!value.trim()) return;
    data.folders.push({ id: uid(), name: value.trim(), collapsed: false });
    save(data); renderHome();
  });
});

// ── Deck view ─────────────────────────────────────────────────────────────────
function openDeck(deckId) {
  currentDeckId = deckId;
  renderDeck();
}

function renderDeck() {
  const deck = getDeck();
  if (!deck) { renderHome(); return; }
  showView('deck');
  $('deck-title').textContent = deck.name;
  $('no-cards').classList.toggle('hidden', deck.cards.length > 0);

  // ── Data usage bar ────────────────────────────────────────────────────────
  const LIMIT_BYTES = 10 * 1024 * 1024; // Firebase 10 MB node limit
  const deckBytes   = new TextEncoder().encode(JSON.stringify(deck)).length;
  const pct         = Math.min(100, (deckBytes / LIMIT_BYTES) * 100);
  const bar  = $('deck-size-bar');
  const fill = $('deck-size-fill');
  const label = $('deck-size-label');

  // Track available width for the fill bar (total bar width minus label space)
  const BAR_TRACK = 120; // px — rough width allocated to the progress track
  fill.style.width = Math.max(2, (pct / 100) * BAR_TRACK) + 'px';

  function fmtBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
    if (b >= 1024)    return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }
  label.textContent = `${fmtBytes(deckBytes)} / 10 MB`;
  bar.classList.remove('warn', 'danger');
  if (pct >= 90)      bar.classList.add('danger');
  else if (pct >= 60) bar.classList.add('warn');

  // Build tag filter bar from all tags in this deck
  const allTags = [...new Set(deck.cards.flatMap(c => c.tags || []))];
  const filterBar = $('tag-filter-bar');
  filterBar.classList.toggle('hidden', allTags.length === 0);
  const filterChips = $('tag-filter-chips');
  filterChips.innerHTML = '';
  activeTags = activeTags.filter(t => allTags.includes(t)); // prune stale
  allTags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-filter-chip' + (activeTags.includes(tag) ? ' active' : '');
    chip.textContent = tag;
    chip.addEventListener('click', () => {
      const idx = activeTags.indexOf(tag);
      if (idx === -1) activeTags.push(tag); else activeTags.splice(idx, 1);
      renderDeck();
    });
    filterChips.appendChild(chip);
  });
  const list = $('card-list');
  list.innerHTML = '';

  const displayed = activeTags.length > 0
    ? deck.cards.filter(c => activeTags.every(t => (c.tags || []).includes(t)))
    : deck.cards;

  displayed.forEach(card => {
    const item = document.createElement('div');
    item.className = 'card-item';
    const tagsHtml = (card.tags || []).map(t => `<span class="card-tag">${escHtml(t)}</span>`).join('');
    const ratings = card.ratings || [0,0,0,0];
    const statsHtml = ratings.some(n => n > 0)
      ? `<div class="card-stats">${ratings.map((n, i) => n > 0
          ? `<span class="card-stat ${RATING_META[i].cls}" title="${RATING_META[i].label}">${n}</span>`
          : '').join('')}</div>`
      : '';
    item.innerHTML = `
      <div class="card-texts">
        <div class="card-q">${card.type === 'cloze' ? '<span class="badge-cloze">C</span>' : ''}${escHtml(htmlPreview(card.front))}</div>
        <div class="card-a">${card.type === 'cloze' ? '' : escHtml(htmlPreview(card.back))}</div>
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
        ${statsHtml}
      </div>
      <div class="card-actions">
        <button data-edit="${card.id}">Edit</button>
        <button data-del="${card.id}">✕</button>
      </div>`;

    item.querySelector('[data-edit]').addEventListener('click', () => {
      openCardModal('Edit Card', card.front, card.back, (f, b, t, tags) => {
        card.front = f; card.back = b; card.type = t || 'normal'; card.tags = tags || [];
        save(data); renderDeck();
      }, false, card.type || 'normal', card.tags || []);
    });
    item.querySelector('[data-del]').addEventListener('click', () => {
      deck.cards = deck.cards.filter(c => c.id !== card.id);
      save(data); renderDeck();
    });

    list.appendChild(item);
  });
}

$('btn-back-home').addEventListener('click', () => { currentDeckId = null; activeTags = []; renderHome(); });

$('btn-clear-tags').addEventListener('click', () => { activeTags = []; renderDeck(); });

$('btn-export').addEventListener('click', () => {
  const deck = getDeck();
  if (!deck || deck.cards.length === 0) {
    alert('No cards to export.');
    return;
  }

  function stripHtml(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent.trim();
  }

  function csvCell(str) {
    // Escape double-quotes and wrap in quotes if needed
    const s = str.replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  }

  const rows = [['Type', 'Front', 'Back']];
  deck.cards.forEach(card => {
    const type  = card.type === 'cloze' ? 'Cloze' : 'Normal';
    const front = stripHtml(card.front);
    const back  = card.type === 'cloze' ? front : stripHtml(card.back);
    rows.push([type, front, back]);
  });

  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${deck.name.replace(/[^\w\s-]/g, '').trim()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

$('btn-new-card').addEventListener('click', () => {
  openCardModal('Add Cards', '', '', (front, back, type, tags) => {
    getDeck().cards.push({ id: uid(), front, back, type: type || 'normal', tags: tags || [], due: Date.now(), interval: 1, ease: 2.5 });
    save(data); renderDeck();
  }, true /* keepOpen */);
});

// ── Import ────────────────────────────────────────────────────────────────────
function rewriteImgSrcs(html, baseUrl) {
  if (!baseUrl) return html;
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  // Replace src="..." where the value is a relative path (no protocol, not data:, not //)
  return html.replace(/(<img[^>]+src=")([^"]+)(")/gi, (match, pre, src, post) => {
    if (/^(https?:|data:|\/|\/\/)/.test(src)) return match; // already absolute
    return pre + base + src + post;
  });
}

// Anki TSV exports wrap fields in "..." and double internal quotes → unescape them
function unquoteTsvField(s) {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

// Detect and convert cloze formats to our {{word}} template format.
// Returns { front, type } where type is 'cloze' or 'normal'.
function convertCloze(front) {
  // ── Format 1: already our {{word}} format (plain, no c1::) ───────────────
  if (/\{\{[^}]+\}\}/.test(front) && !/\{\{c\d+::/.test(front)) {
    return { front, type: 'cloze' };
  }
  // ── Format 2: standard Anki cloze {{c1::word}} or {{c1::word::hint}} ─────
  if (/\{\{c\d+::/.test(front)) {
    const template = front.replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g, '{{$1}}');
    return { front: template, type: 'cloze' };
  }
  // ── Format 3: Anki HTML export cloze spans ────────────────────────────────
  // After TSV unquoting: <span class="cloze" data-cloze="word">[...]</span>
  if (/class="cloze[^"]*"/.test(front)) {
    // Active blank: replace with {{word}} using data-cloze value
    let template = front.replace(
      /<span[^>]+class="cloze"[^>]+data-cloze="([^"]+)"[^>]*>.*?<\/span>/gi,
      (_, clozeVal) => `{{${clozeVal.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/gi, (m, d) => String.fromCharCode(parseInt(d, 10)))}}}`
    );
    // Inactive spans: unwrap to plain text
    template = template.replace(/<span[^>]+class="cloze-inactive"[^>]*>(.*?)<\/span>/gi, '$1');
    return { front: template, type: 'cloze' };
  }
  return { front, type: 'normal' };
}

function parseImportText(text, baseUrl) {
  const cards = [];
  text.split('\n').forEach(line => {
    // Trim only leading whitespace + trailing newline chars — preserve trailing tab (empty back field)
    const trimmed = line.replace(/^[\s\uFEFF]+/, '').replace(/[\r\n]+$/, '');
    if (!trimmed || trimmed.startsWith('#')) return;
    const tabIdx = trimmed.indexOf('\t');
    let front, back;
    if (tabIdx === -1) {
      // No tab at all — only accept if it looks like a cloze card
      if (!/\{\{/.test(trimmed)) return;
      front = unquoteTsvField(trimmed);
      back  = '';
    } else {
      front = unquoteTsvField(trimmed.slice(0, tabIdx));
      back  = unquoteTsvField(trimmed.slice(tabIdx + 1));
    }
    if (!front) return;
    // Allow empty back only for cloze cards
    const looksLikeCloze = /\{\{/.test(front);
    if (!back && !looksLikeCloze) return;
    if (baseUrl) {
      front = rewriteImgSrcs(front, baseUrl);
      back  = rewriteImgSrcs(back, baseUrl);
    }
    const { front: convertedFront, type } = convertCloze(front);
    cards.push({ front: convertedFront, back: type === 'cloze' ? '' : back, type });
  });
  return cards;
}

function getImportPreviewText(cards, rawText) {
  if (!rawText.trim()) return '';
  const imgCount   = (rawText.match(/<img/gi) || []).length;
  const clozeCount = cards.filter(c => c.type === 'cloze').length;
  const parts = [];
  if (cards.length > 0) parts.push(`${cards.length} card${cards.length !== 1 ? 's' : ''} detected`);
  else parts.push('No valid cards detected yet — each line must have Question [tab] Answer');
  if (clozeCount > 0) parts.push(`${clozeCount} cloze`);
  if (imgCount > 0) parts.push(`${imgCount} image${imgCount !== 1 ? 's' : ''} found`);
  return parts.join(' · ');
}

$('btn-import').addEventListener('click', () => {
  $('import-textarea').value = '';
  $('import-img-base').value = '';
  $('import-preview').textContent = '';
  $('import-overlay').classList.remove('hidden');
  setTimeout(() => $('import-textarea').focus(), 50);
});

$('import-textarea').addEventListener('input', () => {
  const raw = $('import-textarea').value;
  const cards = parseImportText(raw, ''); // no img rewriting needed for preview count
  $('import-preview').textContent = getImportPreviewText(cards, raw);
});

$('import-confirm').addEventListener('click', () => {
  const raw     = $('import-textarea').value;
  const baseUrl = $('import-img-base').value.trim();
  const cards   = parseImportText(raw, baseUrl);
  if (cards.length === 0) {
    $('import-preview').textContent = 'No valid cards to import.';
    return;
  }
  const deck = getDeck();
  cards.forEach(({ front, back, type }) => {
    deck.cards.push({ id: uid(), front, back, type: type || 'normal', tags: [], due: Date.now(), interval: 1, ease: 2.5 });
  });
  save(data);
  $('import-overlay').classList.add('hidden');
  renderDeck();
});

$('import-cancel').addEventListener('click', () => {
  $('import-overlay').classList.add('hidden');
});

$('import-overlay').addEventListener('click', e => {
  if (e.target === $('import-overlay')) $('import-overlay').classList.add('hidden');
});

$('btn-study').addEventListener('click', startStudy);

// ── Study view ────────────────────────────────────────────────────────────────
function isDue(card) {
  return !card.due || card.due <= Date.now();
}

function startStudy() {
  const deck = getDeck();
  if (deck.cards.length === 0) {
    alert('No cards in this deck yet. Add some cards first.');
    return;
  }
  // If tag filter is active, restrict to matching cards
  const pool = activeTags.length > 0
    ? deck.cards.filter(c => activeTags.every(t => (c.tags || []).includes(t)))
    : deck.cards;
  if (pool.length === 0) {
    alert('No cards match the selected tags.');
    return;
  }
  // Use due cards first; if none are due, reset all and study everything
  let queue = pool.filter(isDue);
  if (queue.length === 0) queue = [...pool];
  studyQueue = queue.sort(() => Math.random() - 0.5);
  studyDone = 0;
  showView('study');
  showStudyCard();
}

function showStudyCard() {
  const done = studyQueue.length === 0;
  $('study-area').classList.toggle('hidden', done);
  $('study-done').classList.toggle('hidden', !done);
  if (done) return;

  const card = studyQueue[0];
  if ((card.type || 'normal') === 'cloze') {
    $('card-front-text').innerHTML = clozeToBlank(card.front);
    $('card-back-text').innerHTML  = clozeToReveal(card.front);
  } else {
    $('card-front-text').innerHTML = card.front;
    $('card-back-text').innerHTML  =
      `<div class="back-question">${card.front}</div><div class="back-divider"></div><div class="back-answer">${card.back}</div>`;
  }
  const total = studyDone + studyQueue.length;
  $('study-progress').textContent = `${studyDone} / ${total} done · ${studyQueue.length} remaining`;

  // Reset flip instantly (skip the animation so next card always starts on the front)
  const flipCard = $('flip-card');
  const faces = flipCard.querySelectorAll('.card-face');
  faces.forEach(f => f.style.transition = 'none');
  flipCard.classList.remove('flipped');
  flipCard.offsetHeight; // force reflow so the browser applies the instant reset
  faces.forEach(f => f.style.transition = '');
  isFlipped = false;
  $('btn-flip').classList.remove('hidden');
  $('rating-btns').classList.add('hidden');
  // Hide AI panel and button when moving to a new card
  $('btn-ask-ai').classList.add('hidden');
  $('btn-ask-ai').disabled = false;
  $('ai-panel').classList.add('hidden');
  $('ai-response').textContent = '';
}

function flipCard() {
  if (isFlipped) return;
  isFlipped = true;
  $('flip-card').classList.add('flipped');
  $('btn-flip').classList.add('hidden');
  $('rating-btns').classList.remove('hidden');
  // Show AI button once card is flipped
  if (getAiKey()) $('btn-ask-ai').classList.remove('hidden');
}

// rating: 0=difficult, 1=hard, 2=easy, 3=light
// Re-insert positions for non-light cards (how many cards ahead to put it back)
const REINSERT_POS = { 0: 1, 1: 3, 2: 6 };

// Rating index → { label, CSS class }
const RATING_META = [
  { label: 'Difficult', cls: 'stat-difficult' },
  { label: 'Hard',      cls: 'stat-hard'      },
  { label: 'Easy',      cls: 'stat-easy'      },
  { label: 'Light work',cls: 'stat-light'     },
];

function rateCard(rating) {
  const card = studyQueue.shift(); // remove from front

  if (rating === 3) {
    // Light work — mastered for today, schedule for future
    const dbCard = getDeck().cards.find(c => c.id === card.id);
    if (dbCard) {
      dbCard.ease     = Math.max(1.3, dbCard.ease + 0.15);
      dbCard.interval = Math.max(1, Math.round(dbCard.interval * dbCard.ease));
      dbCard.due      = Date.now() + dbCard.interval * 86400000;
      if (!dbCard.ratings) dbCard.ratings = [0,0,0,0];
      dbCard.ratings[rating]++;
    }
    studyDone++;
    data.lightWorkTotal++;
    // Use save() so lastModified is updated and the full correct state
    // is written to Firebase. fbPatch with numeric indices is unsafe after
    // deletions because toArray() re-compacts indices that Firebase does not.
    save(data);
    burstConfetti();
    playSuccessSound();
    // If this was the last card, delay the done screen so confetti is visible
    if (studyQueue.length === 0) {
      const total = studyDone;
      $('study-progress').textContent = `${total} / ${total} done · 0 remaining`;
      setTimeout(showStudyCard, 1400);
      return;
    }
  } else {
    // Not mastered — re-insert into queue at appropriate distance
    const dbCard = getDeck().cards.find(c => c.id === card.id);
    if (dbCard) {
      if (!dbCard.ratings) dbCard.ratings = [0,0,0,0];
      dbCard.ratings[rating]++;
      save(data);
    }
    const pos = Math.min(REINSERT_POS[rating], studyQueue.length);
    studyQueue.splice(pos, 0, card);
  }

  showStudyCard();
}

$('flip-card').addEventListener('click', flipCard);
$('btn-flip').addEventListener('click', e => { e.stopPropagation(); flipCard(); });
$('btn-difficult').addEventListener('click', e => { e.stopPropagation(); rateCard(0); });
$('btn-hard').addEventListener('click',      e => { e.stopPropagation(); rateCard(1); });
$('btn-easy').addEventListener('click',      e => { e.stopPropagation(); rateCard(2); });
$('btn-light').addEventListener('click',     e => { e.stopPropagation(); rateCard(3); });
$('btn-back-deck').addEventListener('click', renderDeck);
$('btn-finish-study').addEventListener('click', renderDeck);

// ── AI Study Helper ───────────────────────────────────────────────────────────
const AI_KEY_STORAGE = 'gemini_api_key';
const AI_KEY_DEFAULT = ''; // enter your key via the ⚙ button in the study view

function getAiKey() { return localStorage.getItem(AI_KEY_STORAGE) || AI_KEY_DEFAULT; }

$('btn-ai-key').addEventListener('click', () => {
  const current = getAiKey();
  const key = prompt('Enter your Gemini API key (stored locally):', current);
  if (key === null) return;
  if (key.trim()) {
    localStorage.setItem(AI_KEY_STORAGE, key.trim());
  } else {
    localStorage.removeItem(AI_KEY_STORAGE);
  }
});

$('btn-ask-ai').addEventListener('click', async (e) => {
  e.stopPropagation();
  const apiKey = getAiKey();
  if (!apiKey) {
    alert('No Gemini API key set. Click the ⚙ button to add your key.');
    return;
  }

  const card = studyQueue[0];
  if (!card) return;

  const stripHtml = html => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.trim(); };
  const front = stripHtml(card.type === 'cloze' ? card.front.replace(/\{\{([^}]+)\}\}/g, '[$1]') : card.front);
  const back  = stripHtml(card.back);

  const userPrompt = card.type === 'cloze'
    ? `I'm studying a cloze flashcard. The sentence with blanks is:\n"${front}"\n\nPlease explain the concept behind this sentence clearly and give a concrete example to help me remember it.`
    : `I'm studying a flashcard.\nQuestion: ${front}\nAnswer: ${back}\n\nPlease give me a deeper explanation of this concept and one or two concrete examples to help it stick.`;

  const panel = $('ai-panel');
  const response = $('ai-response');
  panel.classList.remove('hidden');
  response.innerHTML = '<span class="ai-thinking">Thinking…</span>';
  $('btn-ask-ai').disabled = true;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are a concise, friendly tutor. Give clear explanations with concrete examples. You may use markdown code blocks for code. Keep responses under 200 words.' }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { maxOutputTokens: 350 },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }

    response.textContent = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
          if (delta) { fullText += delta; response.textContent = fullText; }
        } catch { /* skip malformed chunks */ }
      }
    }
    // Basic markdown rendering
    response.innerHTML = fullText
      .replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => `<pre>${escHtml(code.trim())}</pre>`)
      .replace(/`([^`]+)`/g, (_, code) => `<code>${escHtml(code)}</code>`);
  } catch (err) {
    response.innerHTML = `<span style="color:#e74c3c">Error: ${escHtml(err.message)}</span>`;
  } finally {
    $('btn-ask-ai').disabled = false;
  }
});

// ── Modal ─────────────────────────────────────────────────────────────────────
let _modalCallback = null;
let _cardCallback  = null;
let _isCardModal   = false;
let _isNewCard     = false;  // true when adding new cards (stay-open mode)
let _cardType      = 'normal'; // 'normal' | 'cloze'
let _pendingTags   = [];       // tags being edited in the modal

// ── Tag modal helpers ─────────────────────────────────────────────────────────
function renderModalTags() {
  const container = $('tag-chips');
  container.innerHTML = '';
  _pendingTags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `${escHtml(tag)}<span class="tag-remove" data-i="${i}">✕</span>`;
    chip.querySelector('.tag-remove').addEventListener('click', () => {
      _pendingTags.splice(i, 1);
      renderModalTags();
    });
    container.appendChild(chip);
  });
}

function addPendingTag() {
  const input = $('modal-tags');
  const raw = input.value.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '');
  if (!raw) return;
  const tags = raw.split(',').map(t => t.trim()).filter(t => t && !_pendingTags.includes(t));
  _pendingTags.push(...tags);
  input.value = '';
  renderModalTags();
}

$('btn-add-tag').addEventListener('click', addPendingTag);
$('modal-tags').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addPendingTag(); }
});

function setCardType(type) {
  _cardType = type;
  $('type-btn-normal').classList.toggle('active', type === 'normal');
  $('type-btn-cloze').classList.toggle('active', type === 'cloze');
  $('row-front').classList.toggle('hidden', type !== 'normal');
  $('row-back').classList.toggle('hidden', type !== 'normal');
  $('row-cloze').classList.toggle('hidden', type !== 'cloze');
}

$('type-btn-normal').addEventListener('click', () => setCardType('normal'));
$('type-btn-cloze').addEventListener('click',  () => setCardType('cloze'));

// Wrap selected text in {{...}}
$('btn-wrap-cloze').addEventListener('click', () => {
  const field = $('modal-cloze');
  field.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  // Only wrap if selection is inside the cloze field
  if (!field.contains(range.commonAncestorContainer)) return;
  const selectedText = range.toString();
  if (!selectedText.trim()) return;
  const wrapper = document.createElement('span');
  wrapper.className = 'cloze-token';
  wrapper.dataset.cloze = selectedText;
  wrapper.textContent = `{{${selectedText}}}`;
  range.deleteContents();
  range.insertNode(wrapper);
  // Collapse selection after inserted node
  range.setStartAfter(wrapper);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
});

function openModal({ title, inputPlaceholder, inputValue = '' }, callback) {
  _isCardModal = false;
  _isNewCard   = false;
  _modalCallback = callback;
  $('modal-title').textContent = title;
  $('modal-input').placeholder = inputPlaceholder;
  $('modal-input').value = inputValue;
  $('modal-input').classList.remove('hidden');
  $('card-type-toggle').classList.add('hidden');
  $('row-front').classList.add('hidden');
  $('row-back').classList.add('hidden');
  $('row-cloze').classList.add('hidden');
  $('row-tags').classList.add('hidden');
  $('card-toast').classList.add('hidden');
  $('modal-cancel').classList.remove('hidden');
  $('modal-done').classList.add('hidden');
  $('modal-confirm').textContent = 'Save';
  $('modal-overlay').classList.remove('hidden');
  setTimeout(() => $('modal-input').focus(), 50);
}

function openCardModal(title, front, back, callback, keepOpen = false, editType = 'normal', editTags = []) {
  _isCardModal = true;
  _isNewCard   = keepOpen;
  _cardCallback = callback;
  _pendingTags  = [...editTags];
  $('modal-title').textContent = title;
  $('modal-input').classList.add('hidden');
  $('card-type-toggle').classList.remove('hidden');
  $('row-tags').classList.remove('hidden');
  $('modal-tags').value = '';
  renderModalTags();
  // Lock type on edit, allow toggle on new
  $('type-btn-normal').disabled = !keepOpen;
  $('type-btn-cloze').disabled  = !keepOpen;
  setCardType(editType);
  if (editType === 'normal') {
    $('modal-front').innerHTML = front;
    $('modal-back').innerHTML  = back;
  } else {
    $('modal-cloze').innerHTML = front; // cloze stores template in front
  }
  $('card-toast').classList.add('hidden');
  if (keepOpen) {
    $('modal-cancel').classList.add('hidden');
    $('modal-done').classList.remove('hidden');
    $('modal-confirm').textContent = 'Add Card';
  } else {
    $('modal-cancel').classList.remove('hidden');
    $('modal-done').classList.add('hidden');
    $('modal-confirm').textContent = 'Save';
  }
  $('modal-overlay').classList.remove('hidden');
  setTimeout(() => (_cardType === 'cloze' ? $('modal-cloze') : $('modal-front')).focus(), 50);
}

function closeModal() {
  $('modal-overlay').classList.add('hidden');
  _modalCallback = null;
  _cardCallback  = null;
}

function showCardToast() {
  const t = $('card-toast');
  t.classList.remove('hidden');
  clearTimeout(showCardToast._timer);
  showCardToast._timer = setTimeout(() => t.classList.add('hidden'), 1800);
}

function fieldIsEmpty(el) {
  const clone = el.cloneNode(true);
  return clone.textContent.trim() === '' && !clone.querySelector('img');
}

$('modal-confirm').addEventListener('click', async () => {
  if (_isCardModal) {
    if (_cardType === 'cloze') {
      const clozeField = $('modal-cloze');
      if (fieldIsEmpty(clozeField)) return;
      // Validate at least one {{...}} blank exists
      if (!clozeField.textContent.includes('{{')) {
        clozeField.style.borderColor = '#c0392b';
        setTimeout(() => clozeField.style.borderColor = '', 1200);
        return;
      }
      await waitForPendingImages(clozeField);
      const template = clozeField.innerHTML.trim();
      _cardCallback(template, '', 'cloze', [..._pendingTags]);
      if (_isNewCard) {
        clozeField.innerHTML = '';
        _pendingTags = [];
        renderModalTags();
        showCardToast();
        clozeField.focus();
      } else {
        closeModal();
      }
    } else {
      if (fieldIsEmpty($('modal-front')) || fieldIsEmpty($('modal-back'))) return;
      await waitForPendingImages($('modal-front'), $('modal-back'));
      const front = $('modal-front').innerHTML.trim();
      const back  = $('modal-back').innerHTML.trim();
      _cardCallback(front, back, 'normal', [..._pendingTags]);
      if (_isNewCard) {
        $('modal-front').innerHTML = '';
        $('modal-back').innerHTML  = '';
        _pendingTags = [];
        renderModalTags();
        showCardToast();
        $('modal-front').focus();
      } else {
        closeModal();
      }
    }
  } else {
    const value = $('modal-input').value;
    if (_modalCallback) _modalCallback(value);
    closeModal();
  }
});

$('modal-cancel').addEventListener('click', closeModal);

// "Done" should save the current card (if filled) before closing,
// so clicking Done without first clicking "Add Card" doesn't silently lose work.
$('modal-done').addEventListener('click', async () => {
  if (_isCardModal && _isNewCard) {
    if (_cardType === 'cloze') {
      const clozeField = $('modal-cloze');
      if (!fieldIsEmpty(clozeField) && clozeField.textContent.includes('{{')) {
        await waitForPendingImages(clozeField);
        _cardCallback(clozeField.innerHTML.trim(), '', 'cloze', [..._pendingTags]);
      }
    } else {
      const frontEmpty = fieldIsEmpty($('modal-front'));
      const backEmpty  = fieldIsEmpty($('modal-back'));
      if (!frontEmpty && !backEmpty) {
        await waitForPendingImages($('modal-front'), $('modal-back'));
        const front = $('modal-front').innerHTML.trim();
        const back  = $('modal-back').innerHTML.trim();
        _cardCallback(front, back, 'normal', [..._pendingTags]);
      }
    }
  }
  closeModal();
});

$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) closeModal();
});

$('modal-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !_isCardModal) $('modal-confirm').click();
});

// ── Image insertion ───────────────────────────────────────────────────────────
// Tracks pending upload/conversion promises keyed by a numeric ID on the img
// element so the confirm handler can await them before reading innerHTML.
const _imageConversionMap = new Map(); // id → Promise
let _imgConvId = 0;

// 1×1 transparent GIF placeholder — inserted synchronously so fieldIsEmpty()
// sees an <img> immediately while the upload/conversion runs in the background.
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function _fallbackToBase64(img, file, convId) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = ev => {
      img.src = ev.target.result;
      img.classList.remove('img-uploading');
      _imageConversionMap.delete(convId);
      resolve();
    };
    reader.onerror = () => {
      img.classList.remove('img-uploading');
      _imageConversionMap.delete(convId);
      resolve();
    };
    reader.readAsDataURL(file);
  });
}

function insertImageIntoField(field, file) {
  if (!file) return;

  const img = document.createElement('img');
  const convId = ++_imgConvId;
  img.dataset.convId = convId;
  img.src = BLANK_IMG;
  img.classList.add('img-uploading'); // shows spinner overlay via CSS

  let conversionDone;

  if (fbUser) {
    // Upload to Firebase Storage — image lives outside the database
    const ext  = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const path = `users/${fbUser.uid}/images/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const ref  = storage.ref(path);

    conversionDone = ref.put(file)
      .then(snap => snap.ref.getDownloadURL())
      .then(url => {
        img.src = url;
        img.classList.remove('img-uploading');
        _imageConversionMap.delete(convId);
      })
      .catch(() => _fallbackToBase64(img, file, convId)); // network error → base64
  } else {
    // Not signed in — store as base64 locally
    conversionDone = _fallbackToBase64(img, file, convId);
  }

  _imageConversionMap.set(convId, conversionDone);

  field.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    field.appendChild(img);
  }
}

// Wait for all pending image conversions inside the given fields
function waitForPendingImages(...fields) {
  const promises = [];
  fields.forEach(field => {
    field.querySelectorAll('img[data-conv-id]').forEach(img => {
      const p = _imageConversionMap.get(Number(img.dataset.convId));
      if (p) promises.push(p);
    });
  });
  return Promise.all(promises);
}

['modal-front', 'modal-back'].forEach(id => {
  const field = $(id);
  // Paste image from clipboard
  field.addEventListener('paste', e => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(it => it.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        e.preventDefault();
        insertImageIntoField(field, file);
        return;
      }
    }
    // Plain text paste — strip HTML tags
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });
});

// Image pick buttons
$('img-btn-front').addEventListener('click', e => { e.stopPropagation(); $('img-file-front').click(); });
$('img-btn-back').addEventListener('click',  e => { e.stopPropagation(); $('img-file-back').click(); });
$('img-file-front').addEventListener('change', e => {
  if (e.target.files[0]) insertImageIntoField($('modal-front'), e.target.files[0]);
  e.target.value = '';
});
$('img-file-back').addEventListener('change', e => {
  if (e.target.files[0]) insertImageIntoField($('modal-back'), e.target.files[0]);
  e.target.value = '';
});

// ── Sound ─────────────────────────────────────────────────────────────────────
function playSuccessSound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  // Three ascending notes: C5, E5, G5
  const notes = [523.25, 659.25, 783.99];
  notes.forEach((freq, i) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = ctx.currentTime + i * 0.12;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
    osc.start(start);
    osc.stop(start + 0.35);
  });
}

// ── Confetti ──────────────────────────────────────────────────────────────────
function burstConfetti() {
  const canvas = $('confetti-canvas');
  const ctx = canvas.getContext('2d');
  // Use the parent card element's dimensions — canvas.offsetWidth is 0 inside
  // a 3D perspective rendering context
  const card = $('flip-card');
  canvas.width  = card.offsetWidth;
  canvas.height = card.offsetHeight;
  const cx = canvas.width  / 2;
  const cy = canvas.height / 2;

  const COLORS = ['#f94144','#f3722c','#f9c74f','#43aa8b','#4cc9f0','#7b2ff7','#fb5607'];
  const COUNT  = 80;
  const particles = Array.from({ length: COUNT }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2.5 + Math.random() * 4;
    return {
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.25,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: 1,
    };
  });

  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach(p => {
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.12; // gravity
      p.rot += p.rotV;
      p.alpha -= 0.018;
      if (p.alpha <= 0) return;
      alive = true;
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (alive) { frame = requestAnimationFrame(draw); }
    else        { ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }
  cancelAnimationFrame(frame);
  draw();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDeck() {
  return data.decks.find(d => d.id === currentDeckId);
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Extract plain-text preview from stored HTML (may contain <img> tags)
function htmlPreview(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  const text = d.textContent.trim();
  const hasImg = !!d.querySelector('img');
  if (text && hasImg) return text + ' [img]';
  if (hasImg) return '[image]';
  return text;
}

// Cloze: replace {{word}} with black blank boxes (front of card)
function clozeToBlank(html) {
  return html.replace(/\{\{([^}]+)\}\}/g, (_, word) =>
    `<span class="cloze-blank">${escHtml(word)}</span>`);
}

// Cloze: replace {{word}} with highlighted answer (back of card)
function clozeToReveal(html) {
  return html.replace(/\{\{([^}]+)\}\}/g, (_, word) =>
    `<span class="cloze-answer">${escHtml(word)}</span>`);
}

// ── Init & Auth ───────────────────────────────────────────────────────────────
$('btn-google-signin').addEventListener('click', () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider).catch(err => {
    console.error(err);
    alert('Sign-in failed: ' + err.message);
  });
});

$('btn-signout').addEventListener('click', () => {
  if (confirm('Sign out?')) auth.signOut();
});

auth.onAuthStateChanged(async user => {
  if (user) {
    fbUser = user;
    const name = (user.displayName || user.email || '').split(' ')[0];
    $('sync-status').textContent = name;
    $('auth-overlay').classList.add('hidden');
    // Always fetch from Firebase — never trust the local cache
    $('deck-list').innerHTML = '<p class="muted" style="padding:16px">Loading…</p>';
    $('no-decks').classList.add('hidden');
    data = await loadFromFirebase();
    renderHome();
  } else {
    fbUser = null;
    _fbReady = false;
    if (_fbListener) { _fbListener(); _fbListener = null; }
    $('auth-overlay').classList.remove('hidden');
  }
});
