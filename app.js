// ── Firebase ──────────────────────────────────────────────────────────────
firebase.initializeApp({
  apiKey:            'AIzaSyD4-Bp-K3Eagpe-2dy1qs0j4F-k5ft24dY',
  authDomain:        'firebasics-99c9b.firebaseapp.com',
  databaseURL:       'https://firebasics-99c9b-default-rtdb.firebaseio.com',
  projectId:         'firebasics-99c9b',
  storageBucket:     'firebasics-99c9b.appspot.com',
  messagingSenderId: '673506510856',
  appId:             '1:673506510856:web:311f79be1aece0f424a9bd',
  measurementId:     'G-6HKG0NTS6N',
});
const auth      = firebase.auth();
const database  = firebase.database();
const storage   = firebase.storage();
const analytics = firebase.analytics();
let   fbUser   = null;
let   _fbReady = false; // true only after Firebase data has been loaded into `data`
let   userTier = 'free'; // 'free' | 'pro' — set after sign-in

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

function save(d, dirtyDeckId = null) {
  d.lastModified = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  // Never write to Firebase until we have successfully loaded from it first.
  // This prevents the initial empty `data = _sanitize({})` from overwriting
  // real data in Firebase before the async load completes.
  if (!fbUser || !_fbReady) return;
  // Track which decks are dirty.
  // null means ALL decks (structural change — safe fallback).
  // A Set means only those specific decks need to be written.
  if (dirtyDeckId) {
    if (save._dirtyDecks === null) {
      // A previous call already flagged all decks — keep it that way.
    } else {
      if (!save._dirtyDecks) save._dirtyDecks = new Set();
      save._dirtyDecks.add(dirtyDeckId);
    }
  } else {
    save._dirtyDecks = null; // all decks
  }
  // Debounce: batch rapid successive saves into one Firebase write
  clearTimeout(save._timer);
  save._pendingData = d;
  save._timer = setTimeout(save._flush, 2000);
}
save._dirtyDecks = null;
save._flush = function() {
  if (!fbUser || !save._pendingData) return;
  const d = save._pendingData;
  const dirtyDecks = save._dirtyDecks; // Set<id> | null (null = all)
  save._pendingData = null;
  save._dirtyDecks = null;
  // Meta is always written (lastModified, folders, lightWorkTotal)
  const updates = {};
  updates['users/' + fbUser.uid + '/meta'] = {
    folders: d.folders || [],
    lightWorkTotal: d.lightWorkTotal || 0,
    lastModified: d.lastModified,
  };
  // Only write decks that actually changed
  const allDecks = d.decks || [];
  const decksToWrite = dirtyDecks
    ? allDecks.filter(dk => dirtyDecks.has(dk.id))
    : allDecks;
  decksToWrite.forEach(dk => {
    dk.lastModified = d.lastModified;
    updates['users/' + fbUser.uid + '/decks/' + dk.id] = dk;
  });
  console.log('[SnapStack] 💾 SAVE flush →', decksToWrite.length, '/', allDecks.length, 'deck(s) + meta');
  database.ref().update(updates).catch(console.error);
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
    // ── Migration: move old single-blob to per-deck nodes ────────────────
    const oldSnap = await database.ref('users/' + fbUser.uid + '/data').get();
    if (oldSnap.exists()) {
      const old = _sanitize(oldSnap.val());
      console.log('[SnapStack] 🔄 MIGRATION: old single-blob detected');
      console.log('[SnapStack]   decks to migrate:', old.decks.length, old.decks.map(d => `"${d.name}" (${d.cards.length} cards)`));
      const ts = old.lastModified || Date.now();
      const updates = {};
      updates['users/' + fbUser.uid + '/meta'] = {
        folders: old.folders || [],
        lightWorkTotal: old.lightWorkTotal || 0,
        lastModified: ts,
      };
      old.decks.forEach(dk => {
        dk.lastModified = ts;
        updates['users/' + fbUser.uid + '/decks/' + dk.id] = dk;
        console.log('[SnapStack]   → writing deck node:', dk.id, `"${dk.name}"`);
      });
      updates['users/' + fbUser.uid + '/data'] = null; // remove old blob
      await database.ref().update(updates);
      console.log('[SnapStack] ✅ MIGRATION complete — old /data blob deleted');
      _fbReady = true;
      data = old;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(old));
      _attachListeners();
      return old;
    }

    // ── Normal load: meta + per-deck nodes ───────────────────────────────
    // First check only the lightweight lastModified timestamp. If local data
    // is already current, skip downloading all deck nodes (saves bandwidth).
    const tsSnap = await database.ref('users/' + fbUser.uid + '/meta/lastModified').get();
    if (tsSnap.exists() && local.lastModified && tsSnap.val() <= local.lastModified) {
      console.log('[SnapStack] ✅ Local data is current — skipping full fetch');
      _fbReady = true;
      data = local;
      _attachListeners();
      return local;
    }

    const [metaSnap, decksSnap] = await Promise.all([
      database.ref('users/' + fbUser.uid + '/meta').get(),
      database.ref('users/' + fbUser.uid + '/decks').get(),
    ]);

    let assembled;
    if (!metaSnap.exists()) {
      // First sign-in — push local data to Firebase in new format
      console.log('[SnapStack] 🆕 FIRST SIGN-IN: pushing local data to Firebase');
      console.log('[SnapStack]   local decks:', local.decks.length, local.decks.map(d => `"${d.name}" (${d.cards.length} cards)`));
      const ts = local.lastModified || Date.now();
      const updates = {};
      updates['users/' + fbUser.uid + '/meta'] = {
        folders: local.folders || [],
        lightWorkTotal: local.lightWorkTotal || 0,
        lastModified: ts,
      };
      local.decks.forEach(dk => {
        dk.lastModified = ts;
        updates['users/' + fbUser.uid + '/decks/' + dk.id] = dk;
      });
      await database.ref().update(updates);
      assembled = local;
      console.log('[SnapStack] ✅ First sign-in upload complete');
    } else {
      const meta = metaSnap.val();
      const decksRaw = decksSnap.exists() ? decksSnap.val() : {};
      const decks = Object.values(decksRaw).map(dk => {
        dk.cards = toArray(dk.cards);
        return dk;
      });
      assembled = _sanitize({
        folders: toArray(meta.folders),
        decks,
        lightWorkTotal: meta.lightWorkTotal || 0,
        lastModified: meta.lastModified || 0,
      });
      console.log('[SnapStack] 📦 LOADED (per-deck format):',
        assembled.decks.length, 'decks,',
        assembled.folders.length, 'folders,',
        assembled.decks.reduce((s, d) => s + d.cards.length, 0), 'total cards');
      assembled.decks.forEach(d =>
        console.log(`[SnapStack]   deck "${d.name}": ${d.cards.length} cards, node size ~${
          (new TextEncoder().encode(JSON.stringify(d)).length / 1024).toFixed(1)} KB`)
      );
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(assembled));
    _fbReady = true;
    data = assembled;
    _attachListeners();
    return assembled;
  } catch (err) {
    console.warn('Firebase unreachable, using localStorage:', err);
    _fbReady = true;
    return local;
  }
}

// Attach realtime listener to only meta/lastModified (a single integer) so we
// don't re-download all decks on every write. Only fetches the full data when
// a genuinely newer timestamp is detected, meaning a change came from another device.
function _attachListeners() {
  if (_fbListener) _fbListener(); // detach any previous listener
  const ref = database.ref('users/' + fbUser.uid + '/meta/lastModified');
  const cb = ref.on('value', async snap => {
    if (!_fbReady || save._pendingData) return;
    if (!snap.exists()) return;
    const remoteTs = snap.val() || 0;
    if (remoteTs <= (data.lastModified || 0)) return; // own write or stale, skip
    console.log('[SnapStack] 🔁 REALTIME UPDATE from another device — fetching data');
    try {
      const [metaSnap, decksSnap] = await Promise.all([
        database.ref('users/' + fbUser.uid + '/meta').get(),
        database.ref('users/' + fbUser.uid + '/decks').get(),
      ]);
      if (!metaSnap.exists()) return;
      const meta = metaSnap.val();
      const decksRaw = decksSnap.exists() ? decksSnap.val() : {};
      const decks = Object.values(decksRaw).map(dk => {
        dk.cards = toArray(dk.cards);
        return dk;
      });
      const remote = _sanitize({
        folders: toArray(meta.folders),
        decks,
        lightWorkTotal: meta.lightWorkTotal || 0,
        lastModified: meta.lastModified || 0,
      });
      data = remote;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
      if (views.home.classList.contains('active')) renderHome();
      if (views.deck.classList.contains('active')) renderDeck();
    } catch (err) {
      console.warn('[SnapStack] Failed to fetch cross-device update:', err);
    }
  }, err => console.warn('Firebase listener error:', err));
  _fbListener = () => ref.off('value', cb);
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Rate limiter (1 create per 10 s) ─────────────────────────────────────────
const RATE_LIMIT_MS = 10_000;
let _lastCreateTime = 0;

function canCreate() {
  return Date.now() - _lastCreateTime >= RATE_LIMIT_MS;
}
function markCreated() {
  _lastCreateTime = Date.now();
}
function showRateLimitToast() {
  const remaining = Math.ceil((RATE_LIMIT_MS - (Date.now() - _lastCreateTime)) / 1000);
  showGlobalToast(`⏳ Please wait ${remaining}s before creating another.`);
}
function showGlobalToast(msg) {
  let el = document.getElementById('global-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'global-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(showGlobalToast._t);
  showGlobalToast._t = setTimeout(() => el.classList.remove('visible'), 3000);
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
let dragDeckId    = null; // id of deck being dragged
let dragFolderId  = null; // id of folder being dragged

function renderHome() {
  showView('home');
  const list = $('deck-list');
  list.innerHTML = '';
  const total = data.decks.length + data.folders.length;
  $('no-decks').classList.toggle('hidden', total > 0);

  // Render root-level folders recursively
  const rootFolders = data.folders.filter(f => !f.parentFolderId);
  rootFolders.forEach(folder => list.appendChild(renderFolderBlock(folder)));

  // Root decks (no folder)
  const rootDecks = data.decks.filter(d => !d.folderId);
  rootDecks.forEach(deck => list.appendChild(makeDeckItem(deck)));

  // Stats bar
  renderStats();

  // Root drop zone (move deck/folder out of any folder back to root)
  if (data.folders.length > 0) {
    const rootDrop = document.createElement('div');
    rootDrop.id = 'root-drop-zone';
    rootDrop.textContent = 'Drop here to move to root';
    rootDrop.addEventListener('dragover', e => { e.preventDefault(); rootDrop.classList.add('drag-over'); });
    rootDrop.addEventListener('dragleave', () => rootDrop.classList.remove('drag-over'));
    rootDrop.addEventListener('drop', e => {
      e.preventDefault();
      rootDrop.classList.remove('drag-over');
      if (dragDeckId)   moveDeckToFolder(dragDeckId, null);
      if (dragFolderId) moveFolderIntoFolder(dragFolderId, null);
    });
    list.appendChild(rootDrop);
  }
}

function renderFolderBlock(folder) {
  const subFolders   = data.folders.filter(f => f.parentFolderId === folder.id);
  const decksInFolder = data.decks.filter(d => d.folderId === folder.id);
  const totalChildren = subFolders.length + decksInFolder.length;

  const block = document.createElement('div');
  block.className = 'folder-block';
  block.dataset.folderId = folder.id;

  // Header
  const header = document.createElement('div');
  header.className = 'folder-header';
  header.draggable = true;
  header.innerHTML = `
    <span class="folder-arrow ${folder.collapsed ? '' : 'open'}">&#9658;</span>
    <span class="folder-icon">&#128193;</span>
    <span class="folder-name">${escHtml(folder.name)}</span>
    <span class="folder-meta">${totalChildren} item${totalChildren !== 1 ? 's' : ''}</span>
    <div class="folder-actions">
      <button data-frename="${folder.id}">Rename</button>
      ${folder.parentFolderId ? '<button data-funparent>&#8593;</button>' : ''}
      <button class="btn-delete-desktop" data-fdelete="${folder.id}">&#10005;</button>
    </div>`;

  header.addEventListener('click', e => {
    if (e.target.closest('.folder-actions')) return;
    folder.collapsed = !folder.collapsed;
    save(data); renderHome();
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
    _deleteFolder(folder);
  });
  if (folder.parentFolderId) {
    header.querySelector('[data-funparent]').addEventListener('click', e => {
      e.stopPropagation();
      moveFolderIntoFolder(folder.id, null);
    });
  }

  // ── Desktop drag (folder as draggable) ───────────────────────────────────
  header.addEventListener('dragstart', e => {
    dragFolderId = folder.id;
    dragDeckId   = null;
    block.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  });
  header.addEventListener('dragend', () => {
    dragFolderId = null;
    block.classList.remove('dragging');
  });

  // ── Drop target: accepts decks AND folders ────────────────────────────────
  header.addEventListener('dragover', e => {
    if (dragFolderId === folder.id) return;
    if (dragFolderId && _isFolderDescendant(folder.id, dragFolderId)) return;
    e.preventDefault(); e.stopPropagation();
    header.classList.add('drag-over');
  });
  header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
  header.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    header.classList.remove('drag-over');
    if (dragDeckId)   moveDeckToFolder(dragDeckId, folder.id);
    if (dragFolderId && dragFolderId !== folder.id) moveFolderIntoFolder(dragFolderId, folder.id);
  });

  // ── Touch drag ───────────────────────────────────────────────────────────
  _attachFolderTouchDrag(header, block, folder);

  block.appendChild(header);

  // Children area: subfolders + decks
  const children = document.createElement('div');
  children.className = 'folder-children' + (folder.collapsed ? ' collapsed' : '');

  if (totalChildren === 0) {
    children.innerHTML = '<span class="folder-empty">Drop items here</span>';
  } else {
    subFolders.forEach(sub => children.appendChild(renderFolderBlock(sub)));
    decksInFolder.forEach(deck => children.appendChild(makeDeckItem(deck)));
  }

  children.addEventListener('dragover', e => { e.preventDefault(); children.classList.add('drag-over'); });
  children.addEventListener('dragleave', e => { if (!children.contains(e.relatedTarget)) children.classList.remove('drag-over'); });
  children.addEventListener('drop', e => {
    e.preventDefault();
    children.classList.remove('drag-over');
    if (dragDeckId) moveDeckToFolder(dragDeckId, folder.id);
    if (dragFolderId && dragFolderId !== folder.id) moveFolderIntoFolder(dragFolderId, folder.id);
  });

  block.appendChild(children);
  return block;
}

function moveDeckToFolder(deckId, folderId) {
  const deck = data.decks.find(d => d.id === deckId);
  if (deck) { deck.folderId = folderId; save(data, deckId); renderHome(); }
}

function moveFolderIntoFolder(srcId, destId) {
  if (srcId === destId) return;
  if (destId && _isFolderDescendant(destId, srcId)) return; // prevent circular nesting
  const folder = data.folders.find(f => f.id === srcId);
  if (folder) { folder.parentFolderId = destId || null; save(data); renderHome(); }
}

// Returns true if folderId is inside (a descendant of) ancestorId
function _isFolderDescendant(folderId, ancestorId) {
  let current = data.folders.find(f => f.id === folderId);
  while (current && current.parentFolderId) {
    if (current.parentFolderId === ancestorId) return true;
    current = data.folders.find(f => f.id === current.parentFolderId);
  }
  return false;
}

function _deleteFolder(folder) {
  if (!confirm(`Delete folder "${folder.name}"? Decks and subfolders inside will move to root.`)) return;
  // Move decks inside this folder to root
  data.decks.forEach(d => { if (d.folderId === folder.id) d.folderId = null; });
  // Move subfolders to root
  data.folders.forEach(f => { if (f.parentFolderId === folder.id) f.parentFolderId = null; });
  data.folders = data.folders.filter(f => f.id !== folder.id);
  save(data); renderHome();
}

// Swipe-left-to-delete (touch only). Reveals a red Delete button at ~80px.
function _attachSwipeDelete(el, onDelete) {
  let startX = null, startY = null, swiping = false;
  const THRESHOLD = 60;

  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (startX === null) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!swiping && Math.abs(dy) > Math.abs(dx)) { startX = null; return; } // vertical scroll
    swiping = true;
    if (dx < 0) {
      el.style.transform = `translateX(${Math.max(dx, -90)}px)`;
      el.style.transition = 'none';
    }
  }, { passive: true });

  el.addEventListener('touchend', e => {
    if (!swiping || startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (dx < -THRESHOLD) {
      // Snap to reveal delete button
      el.style.transition = 'transform 0.2s';
      el.style.transform  = 'translateX(-80px)';
      el._swipeOpen = true;
    } else {
      _closeSwipe(el);
    }
    startX = null;
  }, { passive: true });

  // Tap elsewhere closes open swipe
  document.addEventListener('touchstart', e => {
    if (el._swipeOpen && !el.contains(e.target) && !e.target.closest('.swipe-delete-btn')) {
      _closeSwipe(el);
    }
  }, { passive: true });

  // Inject delete button behind the element
  el.style.position = 'relative';
  el.style.overflow = 'visible';
  const btn = document.createElement('button');
  btn.className = 'swipe-delete-btn';
  btn.textContent = 'Delete';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    _closeSwipe(el);
    onDelete();
  });
  el.appendChild(btn);
}

function _closeSwipe(el) {
  el.style.transition = 'transform 0.2s';
  el.style.transform  = '';
  el._swipeOpen = false;
}

// Touch drag for folders (long-press to drag into another folder or root)
function _attachFolderTouchDrag(header, block, folder) {
  let _touchTimer = null, _touchGhost = null, _touchDragging = false, _lastDropTarget = null;

  function _clearDragOver() {
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }
  function _dropTargetAt(x, y) {
    if (_touchGhost) _touchGhost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (_touchGhost) _touchGhost.style.display = '';
    if (!el) return null;
    return el.closest('.folder-header, #root-drop-zone');
  }

  header.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    _touchTimer = setTimeout(() => {
      _touchDragging = true;
      dragFolderId = folder.id;
      dragDeckId   = null;
      block.classList.add('dragging');
      const rect = header.getBoundingClientRect();
      _touchGhost = header.cloneNode(true);
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

  header.addEventListener('touchmove', e => {
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
    if (_touchGhost) { _touchGhost.remove(); _touchGhost = null; }
    if (_touchDragging && _lastDropTarget) {
      const el = _lastDropTarget;
      _clearDragOver();
      if (el.id === 'root-drop-zone') {
        moveFolderIntoFolder(dragFolderId, null);
      } else {
        const targetBlock = el.closest('.folder-block');
        if (targetBlock) {
          const targetId = targetBlock.dataset.folderId;
          if (targetId && targetId !== folder.id) moveFolderIntoFolder(dragFolderId, targetId);
        }
      }
    } else {
      _clearDragOver();
    }
    block.classList.remove('dragging');
    _touchDragging = false;
    _lastDropTarget = null;
    dragFolderId = null;
  }

  header.addEventListener('touchend',    _endTouchDrag, { passive: true });
  header.addEventListener('touchcancel', _endTouchDrag, { passive: true });
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
      ${deck.folderId ? '<button data-unparent>&#8593;</button>' : ''}
      <button class="btn-delete-desktop" data-delete="${deck.id}">&#10005;</button>
    </div>`;

  item.querySelector('[data-open]').addEventListener('click', () => openDeck(deck.id));
  item.querySelector('[data-rename]').addEventListener('click', e => {
    e.stopPropagation();
    openModal({ title: 'Rename Deck', inputPlaceholder: 'Deck name', inputValue: deck.name }, value => {
      if (!value.trim()) return;
      deck.name = value.trim(); save(data, deck.id); renderHome();
    });
  });
  if (deck.folderId) {
    item.querySelector('[data-unparent]').addEventListener('click', e => {
      e.stopPropagation();
      moveDeckToFolder(deck.id, null);
    });
  }
  item.querySelector('[data-delete]').addEventListener('click', e => {
    e.stopPropagation();
    if (!confirm(`Delete "${deck.name}" and all its cards?`)) return;
    const deckIdToDelete = deck.id;
    _deleteStorageImagesForDeck(deck);
    data.decks = data.decks.filter(d => d.id !== deckIdToDelete);
    if (fbUser && _fbReady) {
      console.log('[SnapStack] 🗑️  DELETE deck node:', deckIdToDelete);
      database.ref('users/' + fbUser.uid + '/decks/' + deckIdToDelete).remove().catch(console.error);
    }
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
    </div>
    <div class="stat-divider" id="storage-stat-divider" style="display:none"></div>
    <div class="stat-item" id="storage-stat" style="display:none">
      <span class="stat-value" id="storage-stat-value">...</span>
      <span class="stat-label">of 1 GB used</span>
    </div>`;

  // Async: fetch total Storage usage by listing all user image files
  if (fbUser) {
    storage.ref('users/' + fbUser.uid + '/images').listAll()
      .then(res => Promise.all(res.items.map(item => item.getMetadata())))
      .then(metas => {
        const totalBytes = metas.reduce((s, m) => s + (m.size || 0), 0);
        const MB = totalBytes / (1024 * 1024);
        const display = MB >= 1 ? MB.toFixed(1) + ' MB' : (totalBytes / 1024).toFixed(0) + ' KB';
        const el = $('storage-stat-value');
        if (el) el.textContent = display;
        const stat = $('storage-stat');
        const div  = $('storage-stat-divider');
        if (stat) stat.style.display = '';
        if (div)  div.style.display  = '';
      })
      .catch(() => {}); // silently skip if Storage not set up
  }
}

$('btn-new-deck').addEventListener('click', () => {
  if (!canCreate()) { showRateLimitToast(); return; }
  openModal({ title: 'New Deck', inputPlaceholder: 'Deck name' }, value => {
    if (!value.trim()) return;
    markCreated();
    const newDeck = { id: uid(), name: value.trim(), cards: [], folderId: null };
    data.decks.push(newDeck);
    save(data, newDeck.id); renderHome();
  });
});

$('btn-new-folder').addEventListener('click', () => {
  openModal({ title: 'New Folder', inputPlaceholder: 'Folder name' }, value => {
    if (!value.trim()) return;
    data.folders.push({ id: uid(), name: value.trim(), collapsed: false, parentFolderId: null });
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
      // Snapshot Storage URLs before edit so we can delete any that are removed
      const oldUrls = _extractStorageUrls(card.front + (card.back || ''));
      openCardModal('Edit Card', card.front, card.back, (f, b, t, tags) => {
        const newUrls = _extractStorageUrls(f + (b || ''));
        oldUrls.forEach(url => {
          if (!newUrls.has(url)) {
            storage.refFromURL(url).delete()
              .catch(err => console.warn('[SnapStack] Could not delete replaced image:', err?.code || err?.message));
          }
        });
        card.front = f; card.back = b; card.type = t || 'normal'; card.tags = tags || [];
        save(data, currentDeckId); renderDeck();
      }, false, card.type || 'normal', card.tags || []);
    });
    item.querySelector('[data-del]').addEventListener('click', () => {
      _deleteStorageImagesForDeck({ cards: [card] });
      deck.cards = deck.cards.filter(c => c.id !== card.id);
      save(data, currentDeckId); renderDeck();
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
  if (!canCreate()) { showRateLimitToast(); return; }
  openCardModal('Add Cards', '', '', (front, back, type, tags) => {
    if (!canCreate()) { showRateLimitToast(); return; }
    markCreated();
    getDeck().cards.push({ id: uid(), front, back, type: type || 'normal', tags: tags || [], due: Date.now(), interval: 1, ease: 2.5 });
    save(data, currentDeckId); renderDeck();
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
    $('card-front-text').innerHTML = applyMathToHtml(sanitizeCardHtml(card.front));
    $('card-back-text').innerHTML  =
      `<div class="back-question">${applyMathToHtml(sanitizeCardHtml(card.front))}</div><div class="back-divider"></div><div class="back-answer">${applyMathToHtml(sanitizeCardHtml(card.back))}</div>`;
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
    // Only write the deck being studied — not all decks.
    save(data, currentDeckId);
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
      save(data, currentDeckId);
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
    // Basic markdown rendering — escape the full text first, then promote
    // code-block markers to real HTML (content is already escaped at this point).
    response.innerHTML = escHtml(fullText)
      .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => `<pre>${code.trim()}</pre>`)
      .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
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
  // revert any rendered math fields back to raw so they're clean next open
  ['modal-front','modal-back'].forEach(id => {
    const el = $(id);
    if (el && el.dataset.mathRaw) { el.textContent = el.dataset.mathRaw; el.dataset.mathRaw = ''; }
  });
  const panel = $('math-tips-panel');
  const btn   = $('btn-math-tips');
  if (panel) panel.classList.remove('open');
  if (btn)   btn.textContent = 'ƒ Math Tips';
}

function showCardToast(msg, isError) {
  const t = $('card-toast');
  if (msg) t.textContent = msg;
  else t.textContent = '\u2713 Card added';
  t.style.background = isError ? '#c0392b' : '';
  t.classList.remove('hidden');
  clearTimeout(showCardToast._timer);
  showCardToast._timer = setTimeout(() => {
    t.classList.add('hidden');
    t.style.background = '';
    t.textContent = '\u2713 Card added';
  }, isError ? 3500 : 1800);
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
      const front = mathFieldGetRaw($('modal-front'));
      const back  = mathFieldGetRaw($('modal-back'));
      _cardCallback(front, back, 'normal', [..._pendingTags]);
      if (_isNewCard) {
        $('modal-front').innerHTML = '';
        $('modal-front').dataset.mathRaw = '';
        $('modal-back').innerHTML  = '';
        $('modal-back').dataset.mathRaw  = '';
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

// ── Math inline render (blur = render, focus = raw text) ──────────────────────
// Returns the raw user text from a field (strips rendered state if present)
function mathFieldGetRaw(field) {
  return field.dataset.mathRaw !== undefined && field.dataset.mathRaw !== ''
    ? field.dataset.mathRaw
    : field.innerHTML.trim();
}

function mathFieldRender(field) {
  if (field.querySelector('img')) return; // skip if images present
  const raw = field.textContent;
  if (!raw.trim()) return;
  field.dataset.mathRaw = raw;
  field.innerHTML = renderMath(raw);
}

function mathFieldRevert(field) {
  const raw = field.dataset.mathRaw;
  if (!raw) return;
  field.textContent = raw;
  field.dataset.mathRaw = '';
  // move cursor to end
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

$('modal-front').addEventListener('blur',  () => mathFieldRender($('modal-front')));
$('modal-front').addEventListener('focus', () => mathFieldRevert($('modal-front')));
$('modal-back').addEventListener('blur',   () => mathFieldRender($('modal-back')));
$('modal-back').addEventListener('focus',  () => mathFieldRevert($('modal-back')));

// ── Math tips toggle ──────────────────────────────────────────────────────────
$('btn-math-tips').addEventListener('click', () => {
  $('math-tips-panel').classList.toggle('open');
  $('btn-math-tips').textContent = $('math-tips-panel').classList.contains('open')
    ? '✕ Hide Tips' : 'ƒ Math Tips';
});

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
        const front = mathFieldGetRaw($('modal-front'));
        const back  = mathFieldGetRaw($('modal-back'));
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
const _imageConversionMap = new Map(); // id → Promise
let _imgConvId = 0;

const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Resize + compress image to max 800px wide, JPEG quality 0.75.
// Returns a Promise<Blob>. Flashcards don't need full-resolution screenshots.
function _compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 600;
      let w = image.naturalWidth;
      let h = image.naturalHeight;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(image, 0, 0, w, h);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/jpeg', 0.60);
    };
    image.onerror = reject;
    image.src = url;
  });
}

// Extract all Firebase Storage URLs from an HTML string. Returns a Set.
function _extractStorageUrls(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const urls = new Set();
  tmp.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('https://firebasestorage.googleapis.com/')) urls.add(src);
  });
  return urls;
}

// Delete all Firebase Storage images referenced in a deck's cards.
function _deleteStorageImagesForDeck(deck) {
  if (!fbUser || !deck.cards) return;
  console.log('[SnapStack] 🗑️ Scanning deck for Storage images:', deck.name, '—', deck.cards.length, 'cards');
  const tmp = document.createElement('div');
  deck.cards.forEach(card => {
    ['front', 'back', 'template'].forEach(field => {
      if (!card[field]) return;
      tmp.innerHTML = card[field];
      tmp.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        console.log('[SnapStack]   found img src:', src.slice(0, 80));
        if (!src.startsWith('https://firebasestorage.googleapis.com/')) return;
        console.log('[SnapStack]   deleting from Storage:', src.slice(0, 80));
        try {
          storage.refFromURL(src).delete()
            .then(() => console.log('[SnapStack]   ✅ deleted'))
            .catch(err => console.warn('[SnapStack] Could not delete Storage image:', err?.code || err?.message));
        } catch (e) {
          console.warn('[SnapStack] Invalid Storage URL skipped:', src);
        }
      });
    });
  });
}

function _uploadToStorage(img, file, convId) {
  const ext  = 'jpg'; // always JPEG after compression
  const path = `users/${fbUser.uid}/images/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const ref  = storage.ref(path);
  return ref.put(file)
    .then(snap => snap.ref.getDownloadURL())
    .then(url => {
      img.src = url;
      img.classList.remove('img-uploading');
      _imageConversionMap.delete(convId);
    });
}

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
  img.classList.add('img-uploading');

  const MAX_IMG_BYTES = 200 * 1024; // 200 KB hard limit

  const conversionDone = _compressImage(file)
    .then(compressed => {
      if (compressed.size > MAX_IMG_BYTES) {
        img.remove();
        img.classList.remove('img-uploading');
        _imageConversionMap.delete(convId);
        showCardToast('Image too large (max 200 KB). Try a smaller screenshot.', true);
        return;
      }
      if (fbUser) {
        return _uploadToStorage(img, compressed, convId)
          .catch(err => {
            console.error('📸 Storage upload failed:', err?.code || err?.message || err);
            img.remove();
            img.classList.remove('img-uploading');
            _imageConversionMap.delete(convId);
            showCardToast('Image upload failed. Check Storage rules in Firebase.', true);
          });
      }
      // Not signed in — base64 fallback (expected during offline/guest use)
      return _fallbackToBase64(img, compressed, convId);
    })
    .catch(err => {
      console.error('📸 Image compression failed:', err);
      img.remove();
      img.classList.remove('img-uploading');
      _imageConversionMap.delete(convId);
      showCardToast('Could not process image.', true);
    });

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

// ─── Math rendering ──────────────────────────────────────────────────────────
// Converts shorthand like a^2, frac(1,2), sum(i=1,n,expr), sqrt(x),
// Greek letters, and operator symbols into rendered HTML.

const _MATH_SYMBOLS = [
  [/\bDelta\b/g,'Δ'],[/\bSigma\b/g,'Σ'],[/\btheta\b/g,'θ'],
  [/\balpha\b/g,'α'],[/\bbeta\b/g,'β'],[/\bgamma\b/g,'γ'],
  [/\bdelta\b/g,'δ'],[/\blambda\b/g,'λ'],[/\bmu\b/g,'μ'],
  [/\bsigma\b/g,'σ'],[/\bpi\b/g,'π'],[/\binf\b/g,'∞'],
  [/>=/g,'≥'],[/<=/g,'≤'],[/!=/g,'≠'],[/->/g,'→'],
  [/\+-/g,'±'],[/\b(times|xx)\b/g,'×'],[/\bdiv\b/g,'÷'],
];

// Renders math inside sum/frac/sqrt arguments (symbols + sup/sub only)
function _innerMath(text) {
  for (const [p,r] of _MATH_SYMBOLS) text = text.replace(p, r);
  text = text.replace(/\^(\{[^}]*\}|[^\s^_,(){}<>\x00]+)/g, (_,e) =>
    `<sup>${escHtml(e.startsWith('{') ? e.slice(1,-1) : e)}</sup>`);
  text = text.replace(/_(\{[^}]*\}|[^\s^_,(){}<>\x00]+)/g, (_,e) =>
    `<sub>${escHtml(e.startsWith('{') ? e.slice(1,-1) : e)}</sub>`);
  // Escape remaining plain-text parts (split on already-inserted tags)
  return text.split(/(<[^>]*>)/).map((p,i) => i%2===0 ? escHtml(p) : p).join('');
}

function renderMath(plainText) {
  let text = plainText;

  // Step 1 — pure symbol swaps (text → Unicode, no HTML produced)
  for (const [p,r] of _MATH_SYMBOLS) text = text.replace(p, r);

  // Step 2 — HTML-producing patterns; collect fragments via placeholder tokens
  const _frags = [];
  const _mark  = html => { _frags.push(html); return `\x00${_frags.length-1}\x00`; };

  // sum(lower, upper, expr)
  text = text.replace(/sum\(([^,)]+),([^,)]+),([^)]+)\)/g, (_,lo,hi,expr) =>
    _mark(
      `<span class="math-sum">` +
        `<span class="math-top">${_innerMath(hi)}</span>` +
        `<span class="math-sigma">Σ</span>` +
        `<span class="math-bot">${_innerMath(lo)}</span>` +
      `</span><span class="math-sum-expr">${_innerMath(expr)}</span>`
    ));

  // frac(num, den)
  text = text.replace(/frac\(([^,)]+),([^)]+)\)/g, (_,num,den) =>
    _mark(
      `<span class="math-frac">` +
        `<span class="math-num">${_innerMath(num)}</span>` +
        `<span class="math-den">${_innerMath(den)}</span>` +
      `</span>`
    ));

  // sqrt(x)
  text = text.replace(/sqrt\(([^)]+)\)/g, (_,x) =>
    _mark(`<span class="math-sqrt">√<span class="math-sqrt-inner">${_innerMath(x)}</span></span>`));

  // superscript: x^2 or x^{abc}
  text = text.replace(/\^(\{[^}]*\}|[^\s^_,(){}\x00<>]+)/g, (_,e) =>
    _mark(`<sup>${escHtml(e.startsWith('{') ? e.slice(1,-1) : e)}</sup>`));

  // subscript: x_2 or x_{abc}
  text = text.replace(/_(\{[^}]*\}|[^\s^_,(){}\x00<>]+)/g, (_,e) =>
    _mark(`<sub>${escHtml(e.startsWith('{') ? e.slice(1,-1) : e)}</sub>`));

  // Step 3 — restore HTML fragments; escape all remaining plain-text segments
  return text.replace(/\x00(\d+)\x00|([^\x00]+)/g, (_,idx,seg) =>
    idx !== undefined ? _frags[+idx] : escHtml(seg));
}

// Walks sanitized card HTML and applies renderMath to every text node
function applyMathToHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const rendered = renderMath(node.textContent);
      const wrap = document.createElement('span');
      wrap.innerHTML = rendered;
      node.parentNode.replaceChild(wrap, node);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() !== 'img') {
      [...node.childNodes].forEach(walk);
    }
  }
  [...div.childNodes].forEach(walk);
  return div.innerHTML;
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
  return sanitizeCardHtml(html).replace(/\{\{([^}]+)\}\}/g, (_, word) =>
    `<span class="cloze-blank">${escHtml(word)}</span>`);
}

// Cloze: replace {{word}} with highlighted answer (back of card)
function clozeToReveal(html) {
  return sanitizeCardHtml(html).replace(/\{\{([^}]+)\}\}/g, (_, word) =>
    `<span class="cloze-answer">${escHtml(word)}</span>`);
}

// Sanitize card HTML: allow only <img src="https://firebasestorage..."> and <span>.
// Everything else is text-escaped. Prevents XSS from imported/malicious decks.
function sanitizeCardHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  function clean(node) {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) return; // plain text — safe
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'img') {
          // Only allow firebasestorage or data: URIs (our own compressed blobs)
          const src = child.getAttribute('src') || '';
          if (!src.startsWith('https://firebasestorage.googleapis.com/') &&
              !src.startsWith('data:image/')) {
            child.remove();
            return;
          }
          // Strip all attributes except src and class
          [...child.attributes].forEach(attr => {
            if (attr.name !== 'src' && attr.name !== 'class') child.removeAttribute(attr.name);
          });
          return;
        }
        if (tag === 'span' || tag === 'div' || tag === 'br') {
          // Strip all event-handler attributes
          [...child.attributes].forEach(attr => {
            if (attr.name.startsWith('on')) child.removeAttribute(attr.name);
          });
          clean(child);
          return;
        }
        // Any other element — replace with its text content
        child.replaceWith(document.createTextNode(child.textContent));
      } else {
        child.remove(); // comments, processing instructions, etc.
      }
    });
  }
  clean(tmp);
  return tmp.innerHTML;
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

// ── Tier / Pro ────────────────────────────────────────────────────────────────
// LemonSqueezy checkout URL — replace with your actual product link after setup
const LEMON_CHECKOUT_URL = 'https://snapstack1267.lemonsqueezy.com/checkout/buy/db658ca6-02bd-464c-b63b-bafa05da9bfa';

function applyTier() {
  const isPro = userTier === 'pro';
  // Hide all ad placements for pro users
  document.querySelectorAll('.ad-banner-study, .ad-banner-modal, #ad-sidebar').forEach(el => {
    el.style.display = isPro ? 'none' : '';
  });
  // Show/hide upgrade button
  const btn = $('btn-upgrade');
  if (btn) btn.style.display = isPro ? 'none' : '';
}

$('btn-upgrade').addEventListener('click', () => {
  window.open(LEMON_CHECKOUT_URL + '?checkout[custom][uid]=' + encodeURIComponent(fbUser?.uid || ''), '_blank');
});

auth.onAuthStateChanged(async user => {
  if (user) {
    fbUser = user;
    const name = (user.displayName || user.email || '').split(' ')[0];
    $('sync-status').textContent = name;
    $('auth-overlay').classList.add('hidden');
    // Fetch tier from Firebase
    const tierSnap = await database.ref('users/' + user.uid + '/meta/tier').get();
    userTier = (tierSnap.exists() && tierSnap.val() === 'pro') ? 'pro' : 'free';
    applyTier();
    // Always fetch from Firebase — never trust the local cache
    $('deck-list').innerHTML = '<p class="muted" style="padding:16px">Loading…</p>';
    $('no-decks').classList.add('hidden');
    data = await loadFromFirebase();
    renderHome();
  } else {
    fbUser = null;
    userTier = 'free';
    _fbReady = false;
    if (_fbListener) { _fbListener(); _fbListener = null; }
    $('auth-overlay').classList.remove('hidden');
  }
});
