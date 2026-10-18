// ==UserScript==
// @name         Qbit Booster
// @namespace    qbit-booster
// @version      13.1
// @homepageURL  https://github.com/Gusdezup/qbit-booster
// @supportURL   https://github.com/Gusdezup/qbit-booster/issues
// @downloadURL  https://raw.githubusercontent.com/Gusdezup/qbit-booster/main/qbit-booster.user.js
// @updateURL    https://raw.githubusercontent.com/Gusdezup/qbit-booster/main/qbit-booster.user.js
// @description  Améliore le WebUI qBittorrent : créateur de torrent (taille de pièce, privé par défaut, trackers enregistrés, champ source, navigateur de fichiers), éditeur de trackers en masse, réinitialisation des filtres en un clic et MediaInfo optionnel (via le sidecar qbit-booster-mediainfo). Réglages via le menu de l'extension.
// @match        http://localhost:8080/*
// @match        http://127.0.0.1:8080/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// ==/UserScript==

// INSTALLATION : ajoute l'adresse de TON WebUI qBittorrent dans les réglages du script de
// l'extension (Violentmonkey : onglet Paramètres > « @match » personnalisé ; Tampermonkey :
// Paramètres > « Correspondances utilisateur »), par ex. http://192.168.1.10:8080/*
// Ce réglage survit aux mises à jour du script. Aucun identifiant n'est nécessaire : le script
// tourne dans la page du WebUI et réutilise la session déjà ouverte.

(function () {
  'use strict';

  // ---------- Réglages (persistés via GM_setValue) ----------
  const DEFAULT_SETTINGS = {
    mediainfoApi: '',            // vide = bouton MediaInfo masqué
    pieceSize: 4194304,          // 4 MiB ('' = Auto)
    format: 'v1',
    private: true,
    startSeeding: true,
    hideQueueingButtons: false,
  };
  function getSettings() { return { ...DEFAULT_SETTINGS, ...GM_getValue('gtc_settings', {}) }; }
  function setSettings(s) { GM_setValue('gtc_settings', s); }
  function getMediaInfoApi() { return String(getSettings().mediainfoApi || '').trim().replace(/\/+$/, ''); }

  // Option : masquer les flèches de priorité de file d'attente natives (#queueingButtons).
  // qBittorrent ne les cache qu'un peu après le chargement (flash visible ~1-2s) : on pose
  // notre propre feuille de style dès le démarrage du script.
  function applyQueueingStyle() {
    let el = document.getElementById('gtc-hide-queueing');
    if (getSettings().hideQueueingButtons) {
      if (!el) {
        el = document.createElement('style');
        el.id = 'gtc-hide-queueing';
        el.textContent = '#queueingButtons { display: none !important; }';
        (document.head || document.documentElement).appendChild(el);
      }
    } else if (el) {
      el.remove();
    }
  }
  applyQueueingStyle();

  const PIECE_SIZES = [
    ['Auto', ''],
    ['16 KiB', 16384], ['32 KiB', 32768], ['64 KiB', 65536],
    ['128 KiB', 131072], ['256 KiB', 262144], ['512 KiB', 524288],
    ['1 MiB', 1048576], ['2 MiB', 2097152], ['4 MiB', 4194304],
    ['8 MiB', 8388608], ['16 MiB', 16777216], ['32 MiB', 33554432],
  ];
  const FORMATS = [
    ['v1', 'v1 uniquement (classique, ~2× plus rapide à créer)'],
    ['hybrid', 'Hybride (v1 + v2 — deux fois le calcul de hash, compatible partout)'],
    ['v2', 'v2 uniquement (BitTorrent v2, rarement nécessaire)'],
  ];
  function pieceSizeOptions(selected) {
    return PIECE_SIZES.map(([label, val]) =>
      `<option value="${val}"${String(val) === String(selected) ? ' selected' : ''}>${label}</option>`).join('');
  }
  function formatOptions(selected) {
    return FORMATS.map(([val, label]) =>
      `<option value="${val}"${val === selected ? ' selected' : ''}>${label}</option>`).join('');
  }

  // ---------- Thème sombre ----------
  const C = {
    bg: '#1e1e1e', bgAlt: '#262626', input: '#2b2b2b',
    border: '#3d3d3d', text: '#e6e6e6', muted: '#999',
    hover: '#333',
  };
  function panelStyle(width) {
    return `background:${C.bg};color:${C.text};padding:20px;border-radius:8px;width:${width};` +
      'font-family:sans-serif;font-size:13px;box-shadow:0 4px 24px rgba(0,0,0,.6);';
  }
  function inputStyle(extra = '') {
    return `background:${C.input};color:${C.text};border:1px solid ${C.border};border-radius:4px;padding:5px;${extra}`;
  }
  function btnStyle(extra = '') {
    return `background:${C.hover};color:${C.text};border:1px solid ${C.border};border-radius:4px;padding:5px 12px;cursor:pointer;${extra}`;
  }
  function iconBtnStyle() {
    return `border:none;background:none;cursor:pointer;color:${C.muted};font-size:13px;padding:2px 6px;`;
  }

  function computeTorrentFilename(sourcePath, isDirHint) {
    const base = sourcePath.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'torrent';
    const dotIndex = base.lastIndexOf('.');
    const looksLikeFile = dotIndex > 0;
    const isDir = (isDirHint === true) ? true : (isDirHint === false ? false : !looksLikeFile);
    return isDir ? (base + '.torrent') : (base.slice(0, dotIndex) + '.torrent');
  }

  function apiFetch(path, options = {}) {
    return fetch('/api/v2/' + path, { credentials: 'same-origin', ...options })
      .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r; });
  }

  // ---------- Persistance ----------
  function getSavedTrackers() {
    const raw = GM_getValue('gtc_trackers', []);
    return raw.map(t => {
      if (typeof t === 'string') return { name: t, url: t, source: '', enabled: true };
      return { source: '', enabled: true, ...t };
    });
  }
  function setSavedTrackers(list) { GM_setValue('gtc_trackers', list); }
  // Un tracker enregistré peut porter plusieurs URL d'announce (ex. V3X, C411 : deux domaines
  // pour le même tracker), séparées par des espaces. Elles partent toutes dans le même tier,
  // comme dans les .torrent de ces sites.
  function splitUrls(s) { return String(s || '').split(/\s+/).filter(Boolean); }
  function getDefaultPath() { return GM_getValue('gtc_default_path', '/media/downloads'); }
  function setDefaultPath(p) { GM_setValue('gtc_default_path', p); }

  // ---------- API app/getDirectoryContent (fallback POST puis GET) ----------
  async function fetchDirectoryContent(dirPath) {
    const attempts = [
      { method: 'POST', body: new URLSearchParams({ dirPath, withMetadata: 'true' }) },
      { method: 'GET', qs: '?dirPath=' + encodeURIComponent(dirPath) + '&withMetadata=true' },
    ];
    let lastError;
    for (const a of attempts) {
      try {
        const res = await fetch('/api/v2/app/getDirectoryContent' + (a.qs || ''), {
          method: a.method, credentials: 'same-origin', body: a.body,
        });
        if (res.ok) return await res.json();
        const bodyText = await res.text();
        lastError = new Error(a.method + ' -> ' + res.status + ' ' + res.statusText + (bodyText ? (' : ' + bodyText) : ''));
      } catch (e) { lastError = e; }
    }
    throw lastError;
  }

  function formatSize(bytes) {
    if (typeof bytes !== 'number') return '';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 1 : 0) + ' ' + units[i];
  }

  function normalizeEntries(data, currentPath) {
    if (!Array.isArray(data)) return [];
    const base = currentPath.replace(/\/+$/, '');
    return data.map(e => {
      // Ancien format (sans withMetadata) : simple chaîne = chemin complet d'un dossier
      if (typeof e === 'string') {
        const name = e.includes('/') ? e.split('/').filter(Boolean).pop() : e;
        const path = e.startsWith('/') ? e : (base + '/' + e);
        return { name, path, isDir: true };
      }
      // Format avec withMetadata=true : {name, size, type: "file" | autre}
      const name = e.name || '?';
      const path = base + '/' + name;
      const isDir = (e.type || '').toLowerCase() !== 'file';
      return { name, path, isDir, size: e.size };
    });
  }

  // ---------- Autocomplétion sur le champ chemin source ----------
  function attachAutocomplete(input) {
    let dropdown, debounceTimer;
    function closeDropdown() { if (dropdown) { dropdown.remove(); dropdown = null; } }

    input.addEventListener('input', () => {
      delete input.dataset.isDir;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const val = input.value;
        const lastSlash = val.lastIndexOf('/');
        const dir = lastSlash >= 0 ? (val.slice(0, lastSlash) || '/') : '/';
        const partial = lastSlash >= 0 ? val.slice(lastSlash + 1) : val;
        let data;
        try { data = await fetchDirectoryContent(dir); } catch (e) { closeDropdown(); return; }
        const entries = normalizeEntries(data, dir)
          .filter(e => e.name.toLowerCase().startsWith(partial.toLowerCase()));
        closeDropdown();
        if (!entries.length) return;

        const rect = input.getBoundingClientRect();
        dropdown = document.createElement('div');
        dropdown.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom}px;width:${rect.width}px;` +
          `background:${C.bgAlt};border:1px solid ${C.border};border-radius:4px;max-height:180px;overflow:auto;z-index:100002;`;
        entries.slice(0, 30).forEach(entry => {
          const item = document.createElement('div');
          const sizeLabel = (!entry.isDir && entry.size != null) ? `  ·  ${formatSize(entry.size)}` : '';
          item.textContent = (entry.isDir ? '\u{1F4C1} ' : '\u{1F4C4} ') + entry.name + sizeLabel;
          item.style.cssText = `padding:5px 8px;cursor:pointer;color:${C.text};`;
          item.onmouseenter = () => item.style.background = C.hover;
          item.onmouseleave = () => item.style.background = '';
          item.onmousedown = (ev) => {
            ev.preventDefault();
            input.value = entry.path + (entry.isDir ? '/' : '');
            input.dataset.isDir = entry.isDir ? '1' : '0';
            closeDropdown();
          };
          dropdown.appendChild(item);
        });
        document.body.appendChild(dropdown);
      }, 250);
    });
    input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
  }

  // ---------- Navigateur de fichiers/dossiers ----------
  function openDirectoryBrowser(startPath, onChoose) {
    let current = startPath || getDefaultPath() || '/';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('500px')}display:flex;flex-direction:column;max-height:70vh;">
        <h3 style="margin:0 0 8px;">Choisir un fichier ou un dossier</h3>
        <div id="gtc-db-path" style="font-family:monospace;background:${C.bgAlt};padding:6px;border-radius:4px;word-break:break-all;margin-bottom:8px;color:${C.text};"></div>
        <div id="gtc-db-list" style="flex:1;overflow:auto;border:1px solid ${C.border};border-radius:4px;"></div>
        <div style="text-align:right;margin-top:10px;">
          <button id="gtc-db-cancel" style="${btnStyle()}">Annuler</button>
          <button id="gtc-db-choose" style="${btnStyle()}">Sélectionner ce dossier</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-db-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#gtc-db-choose').onclick = () => { onChoose(current, true); overlay.remove(); };

    async function render() {
      overlay.querySelector('#gtc-db-path').textContent = current;
      const list = overlay.querySelector('#gtc-db-list');
      list.textContent = 'Chargement…';
      try {
        const data = await fetchDirectoryContent(current);
        const entries = normalizeEntries(data, current);
        list.innerHTML = '';

        const up = document.createElement('div');
        up.textContent = '⬆️  ..';
        up.style.cssText = `padding:6px 10px;cursor:pointer;border-bottom:1px solid ${C.border};color:${C.text};`;
        up.onmouseenter = () => up.style.background = C.hover;
        up.onmouseleave = () => up.style.background = '';
        up.onclick = () => { current = current.replace(/\/[^/]+\/?$/, '') || '/'; render(); };
        list.appendChild(up);

        const folders = entries.filter(e => e.isDir);
        const files = entries.filter(e => !e.isDir);
        [...folders, ...files].forEach(entry => {
          const row = document.createElement('div');
          const sizeLabel = (!entry.isDir && entry.size != null) ? `  ·  ${formatSize(entry.size)}` : '';
          row.textContent = (entry.isDir ? '\u{1F4C1} ' : '\u{1F4C4} ') + entry.name + sizeLabel;
          row.style.cssText = `padding:6px 10px;cursor:pointer;border-bottom:1px solid ${C.border};color:${C.text};`;
          row.onmouseenter = () => row.style.background = C.hover;
          row.onmouseleave = () => row.style.background = '';
          row.onclick = () => {
            if (entry.isDir) { current = entry.path; render(); }
            else { onChoose(entry.path, false); overlay.remove(); }
          };
          list.appendChild(row);
        });

        if (!entries.length) {
          const empty = document.createElement('div');
          empty.textContent = '(dossier vide)';
          empty.style.cssText = `padding:6px 10px;color:${C.muted};`;
          list.appendChild(empty);
        }
      } catch (e) {
        list.textContent = 'Erreur: ' + e.message;
      }
    }
    render();
  }

  // ---------- MediaInfo ----------

  function computeNfoFilename(sourcePath) {
    const base = sourcePath.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'mediainfo';
    const dotIndex = base.lastIndexOf('.');
    return (dotIndex > 0 ? base.slice(0, dotIndex) : base) + '.nfo';
  }

  function showTextModal(text, title) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100001;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('680px')}height:88vh !important;display:flex;flex-direction:column;">
        <h3 style="margin:0 0 8px;word-break:break-all;">${(title || 'MediaInfo').replace(/</g, '&lt;')}</h3>
        <pre style="flex:1;min-height:0;max-height:none;overflow:auto;background:${C.bgAlt};padding:10px;border-radius:4px;font-size:11px;white-space:pre-wrap;color:${C.text};margin:0;box-sizing:border-box;"></pre>
        <div style="text-align:right;margin-top:10px;display:flex;justify-content:flex-end;gap:6px;">
          <button id="gtc-mi-copy" style="${btnStyle()}">Copier le contenu</button>
          <button id="gtc-mi-download" style="${btnStyle()}">Télécharger en .nfo</button>
          <button id="gtc-mi-close" style="${btnStyle()}">Fermer</button>
        </div>
      </div>`;
    const pre = overlay.querySelector('pre');
    pre.textContent = text;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-mi-close').onclick = () => overlay.remove();

    const copyBtn = overlay.querySelector('#gtc-mi-copy');
    copyBtn.onclick = async () => {
      const content = pre.textContent;
      try {
        await navigator.clipboard.writeText(content);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = content;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copié ✔';
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    };

    overlay.querySelector('#gtc-mi-download').onclick = () => {
      const blob = new Blob([pre.textContent], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = computeNfoFilename(title || 'mediainfo');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    };

    return overlay;
  }

  // GM_xmlhttpRequest plutôt que fetch() : la page qBittorrent envoie une CSP
  // "default-src 'self'" sans connect-src explicite, qui bloque silencieusement (NetworkError)
  // tout fetch() vers une autre origine que le WebUI lui-même. GM_xmlhttpRequest s'exécute
  // dans le contexte de l'extension Violentmonkey et n'est pas soumis à cette CSP.
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) resolve(r.responseText);
          else reject(new Error(r.status + ' ' + r.statusText + (r.responseText ? (' : ' + r.responseText) : '')));
        },
        onerror: () => reject(new Error('Requête réseau échouée (sidecar injoignable ou CORS)')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  // Ne garde que le nom du fichier (sans le chemin conteneur) sur la ligne "Complete name",
  // pour pouvoir coller/joindre le MediaInfo tel quel. L'alignement des colonnes est conservé.
  function stripCompleteNamePath(text) {
    return text.replace(/^((?:Complete name|Nom complet)\s*:\s*).*\/(?=[^\/\n]*$)/gm, '$1');
  }

  async function runMediaInfo(path) {
    const modal = showTextModal('Analyse en cours…', path);
    const api = getMediaInfoApi();
    if (!api) {
      modal.querySelector('pre').textContent = 'Aucune URL de sidecar MediaInfo configurée (menu de l\'extension > Réglages…).';
      return;
    }
    try {
      const text = await gmGet(api + '/mediainfo?path=' + encodeURIComponent(path));
      modal.querySelector('pre').textContent = stripCompleteNamePath(text);
    } catch (e) {
      modal.querySelector('pre').textContent = 'Erreur: ' + e.message;
    }
  }

  async function openMediaInfoFilePicker(torrent) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('520px')}display:flex;flex-direction:column;max-height:70vh;">
        <h3 style="margin:0 0 8px;word-break:break-all;">${torrent.name.replace(/</g, '&lt;')}</h3>
        <div id="gtc-mi-files" style="flex:1;overflow:auto;border:1px solid ${C.border};border-radius:4px;"></div>
        <div style="text-align:right;margin-top:10px;">
          <button id="gtc-mi-back" style="${btnStyle()}">Retour</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-mi-back').onclick = () => { overlay.remove(); openMediaInfoTorrentPicker(); };

    const listEl = overlay.querySelector('#gtc-mi-files');
    listEl.textContent = 'Chargement…';
    try {
      const [propsRes, filesRes] = await Promise.all([
        apiFetch('torrents/properties?hash=' + torrent.hash),
        apiFetch('torrents/files?hash=' + torrent.hash),
      ]);
      const props = await propsRes.json();
      const files = await filesRes.json();
      const savePath = (props.save_path || '').replace(/\/+$/, '');
      listEl.innerHTML = '';
      files.forEach(f => {
        const row = document.createElement('div');
        row.textContent = '\u{1F4C4} ' + f.name + '  ·  ' + formatSize(f.size);
        row.style.cssText = `padding:6px 10px;cursor:pointer;border-bottom:1px solid ${C.border};color:${C.text};`;
        row.onmouseenter = () => row.style.background = C.hover;
        row.onmouseleave = () => row.style.background = '';
        row.onclick = () => {
          overlay.remove();
          runMediaInfo(savePath + '/' + f.name);
        };
        listEl.appendChild(row);
      });
      if (!files.length) {
        listEl.textContent = '(aucun fichier)';
      }
    } catch (e) {
      listEl.textContent = 'Erreur: ' + e.message;
    }
  }

  // Sélecteur de torrent générique (avec filtre texte), réutilisé par MediaInfo et l'éditeur
  // de tracker : appelle onSelect(torrent) au clic sur une ligne.
  async function openTorrentPicker(title, onSelect) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('520px')}display:flex;flex-direction:column;max-height:70vh;">
        <h3 style="margin:0 0 8px;">${title.replace(/</g, '&lt;')}</h3>
        <input id="gtc-tp-filter" style="${inputStyle('width:100%;box-sizing:border-box;margin-bottom:8px;')}" placeholder="Filtrer par nom…" autocomplete="off">
        <div id="gtc-tp-list" style="flex:1;overflow:auto;border:1px solid ${C.border};border-radius:4px;"></div>
        <div style="text-align:right;margin-top:10px;">
          <button id="gtc-tp-cancel" style="${btnStyle()}">Annuler</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-tp-cancel').onclick = () => overlay.remove();

    const listEl = overlay.querySelector('#gtc-tp-list');
    listEl.textContent = 'Chargement…';
    let torrents = [];
    try {
      const res = await apiFetch('torrents/info');
      torrents = await res.json();
      torrents.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      listEl.textContent = 'Erreur: ' + e.message;
      return;
    }

    function render(filter) {
      listEl.innerHTML = '';
      const f = filter.trim().toLowerCase();
      const filtered = f ? torrents.filter(t => t.name.toLowerCase().includes(f)) : torrents;
      filtered.slice(0, 200).forEach(t => {
        const row = document.createElement('div');
        row.textContent = t.name;
        row.style.cssText = `padding:6px 10px;cursor:pointer;border-bottom:1px solid ${C.border};color:${C.text};`;
        row.onmouseenter = () => row.style.background = C.hover;
        row.onmouseleave = () => row.style.background = '';
        row.onclick = () => { overlay.remove(); onSelect(t); };
        listEl.appendChild(row);
      });
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.textContent = '(aucun résultat)';
        empty.style.cssText = `padding:6px 10px;color:${C.muted};`;
        listEl.appendChild(empty);
      } else if (filtered.length > 200) {
        const more = document.createElement('div');
        more.textContent = '… ' + (filtered.length - 200) + ' de plus, affine ta recherche';
        more.style.cssText = `padding:6px 10px;color:${C.muted};`;
        listEl.appendChild(more);
      }
    }
    render('');
    const filterInput = overlay.querySelector('#gtc-tp-filter');
    filterInput.addEventListener('input', () => render(filterInput.value));
    filterInput.focus();
  }

  function openMediaInfoTorrentPicker() {
    openTorrentPicker('MediaInfo — choisir un torrent', t => openMediaInfoFilePicker(t));
  }

  // ---------- Éditeur de tracker en masse ----------

  // Construit la table {url tracker -> [{hash, name}, ...]} à partir de TOUS les trackers de
  // chaque torrent (pas seulement le premier actif — le champ "tracker" de torrents/info ne
  // donne que le PREMIER tracker actuellement actif, donc rate tout torrent où le tracker
  // cherché est secondaire ou momentanément en erreur : constaté en pratique).
  // Méthode principale : UN seul appel torrents/info?includeTrackers=true (qBittorrent 5.1+),
  // qui renvoie la liste complète des trackers de chaque torrent dans un champ "trackers".
  // Repli si le champ est absent (qBittorrent plus ancien) : un appel torrents/trackers par torrent.
  async function fetchTrackerGroups(hashes, hostFilter, onProgress) {
    const qs = new URLSearchParams({ includeTrackers: 'true' });
    if (hashes) qs.set('hashes', hashes.join('|'));
    const infos = await (await apiFetch('torrents/info?' + qs.toString())).json();
    const wantedHost = hostFilter ? hostFilter.toLowerCase() : null;

    const map = new Map();
    let errors = 0, trackersSeen = 0;
    function addTrackers(t, trackers) {
      (trackers || []).forEach(tr => {
        const url = tr && tr.url;
        if (!url || url.startsWith('** [')) return; // DHT / PeX / LSD
        trackersSeen++;
        if (wantedHost) {
          let h;
          try { h = new URL(url).hostname.toLowerCase(); } catch (e) { return; }
          if (h !== wantedHost) return;
        }
        if (!map.has(url)) map.set(url, []);
        const list = map.get(url);
        if (!list.some(x => x.hash === t.hash)) list.push({ hash: t.hash, name: t.name });
      });
    }

    const inline = infos.length > 0 && infos.every(t => Array.isArray(t.trackers));
    if (inline) {
      infos.forEach(t => addTrackers(t, t.trackers));
      if (onProgress) onProgress(infos.length, infos.length);
    } else {
      const CONCURRENCY = 15;
      let idx = 0, done = 0;
      async function worker() {
        while (idx < infos.length) {
          const t = infos[idx++];
          try {
            const res = await apiFetch('torrents/trackers?hash=' + encodeURIComponent(t.hash));
            addTrackers(t, await res.json());
          } catch (e) { errors++; }
          done++;
          if (onProgress) onProgress(done, infos.length);
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, infos.length) }, worker));
    }

    return { map, exact: true, scannedCount: infos.length, errorCount: errors };
  }

  // Détecte le filtre tracker natif sélectionné dans la sidebar (id = host du tracker ; les
  // filtres spéciaux "Tous"/"Sans tracker"/etc. ont un id au format UUID, à ignorer).
  function getSelectedTrackerHost() {
    const li = document.querySelector('#trackerFilterList li.selectedFilter');
    if (!li || !li.id) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(li.id)) return null;
    return li.id;
  }

  async function openBulkTrackerEditor(scope) {
    scope = scope || {};
    const title = scope.hashes ? 'Trackers des torrents sélectionnés'
      : scope.host ? 'Trackers correspondant à ' + scope.host
      : 'Trackers de toute la bibliothèque';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('560px')}display:flex;flex-direction:column;max-height:70vh;">
        <h3 style="margin:0 0 8px;">${title.replace(/</g, '&lt;')}</h3>
        <div id="gtc-bte-list" style="flex:1;overflow:auto;border:1px solid ${C.border};border-radius:4px;"></div>
        <div style="text-align:right;margin-top:10px;">
          <button id="gtc-bte-cancel" style="${btnStyle()}">Fermer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-bte-cancel').onclick = () => overlay.remove();

    const listEl = overlay.querySelector('#gtc-bte-list');
    listEl.textContent = 'Chargement…';
    let map, exact, scanInfo;
    try {
      scanInfo = await fetchTrackerGroups(scope.hashes || null, scope.host || null,
        (done, total) => { listEl.textContent = `Scan en cours… ${done}/${total} torrents`; });
      ({ map, exact } = scanInfo);
    } catch (e) {
      listEl.textContent = 'Erreur: ' + e.message;
      return;
    }

    if (map.size === 0) {
      listEl.textContent = `(aucun tracker trouvé — ${scanInfo.scannedCount} torrent(s) scanné(s), ${scanInfo.errorCount} erreur(s) de requête)`;
      return;
    }

    // Un seul tracker distinct en jeu (cas typique : sélection de torrents partageant le même
    // tracker, ou filtre natif par host) : on saute direct à l'écran de remplacement, comme les
    // deux autres boutons.
    if (map.size === 1) {
      overlay.remove();
      const [[url, torrents]] = map;
      openTrackerReplaceScreen(url, torrents, exact, scope);
      return;
    }

    const entries = [...map.entries()].sort((a, b) => b[1].length - a[1].length);
    listEl.innerHTML = '';
    entries.forEach(([url, torrents]) => {
      const row = document.createElement('div');
      row.style.cssText = `padding:6px 10px;cursor:pointer;border-bottom:1px solid ${C.border};color:${C.text};`;
      row.innerHTML = `<div style="word-break:break-all;">${url.replace(/</g, '&lt;')}</div>` +
        `<div style="color:${C.muted};font-size:11px;">${torrents.length} torrent(s)</div>`;
      row.onmouseenter = () => row.style.background = C.hover;
      row.onmouseleave = () => row.style.background = '';
      row.onclick = () => { overlay.remove(); openTrackerReplaceScreen(url, torrents, exact, scope); };
      listEl.appendChild(row);
    });
  }

  function openTrackerReplaceScreen(oldUrl, torrents, exact, scope) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('600px')}display:flex;flex-direction:column;max-height:80vh;">
        <h3 style="margin:0 0 8px;">Remplacer un tracker</h3>
        <label>Adresse actuelle</label>
        <div style="font-family:monospace;background:${C.bgAlt};padding:6px;border-radius:4px;word-break:break-all;margin:4px 0 10px;color:${C.text};">${oldUrl.replace(/</g, '&lt;')}</div>
        <label>Nouvelle adresse</label>
        <input id="gtc-bte-newurl" style="${inputStyle('width:100%;box-sizing:border-box;margin:4px 0 10px;')}" value="${oldUrl.replace(/"/g, '&quot;')}">
        <label>${torrents.length} torrent(s) concerné(s)</label>
        <div id="gtc-bte-torrents" style="flex:1;overflow:auto;border:1px solid ${C.border};border-radius:4px;margin:4px 0 10px;"></div>
        <div style="text-align:right;">
          <button id="gtc-bte-back" style="${btnStyle()}">Retour</button>
          <button id="gtc-bte-apply" style="${btnStyle()}">Remplacer partout</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-bte-back').onclick = () => {
      overlay.remove();
      openBulkTrackerEditor(scope);
    };

    const torrentRows = new Map(); // hash -> { row, statusEl }
    const listEl = overlay.querySelector('#gtc-bte-torrents');
    torrents.forEach(t => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex;justify-content:space-between;gap:8px;padding:5px 10px;border-bottom:1px solid ${C.border};font-size:12px;`;
      const name = document.createElement('span');
      name.textContent = t.name;
      name.style.cssText = `color:${C.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      const status = document.createElement('span');
      status.style.cssText = `color:${C.muted};flex-shrink:0;`;
      row.append(name, status);
      listEl.appendChild(row);
      torrentRows.set(t.hash, { row, status });
    });

    overlay.querySelector('#gtc-bte-apply').onclick = async () => {
      const newUrl = overlay.querySelector('#gtc-bte-newurl').value.trim();
      const applyBtn = overlay.querySelector('#gtc-bte-apply');
      if (!newUrl) return;
      applyBtn.disabled = true;
      applyBtn.textContent = 'En cours…';

      let ok = 0, skipped = 0, failed = 0;
      for (const t of torrents) {
        const { status } = torrentRows.get(t.hash);
        status.textContent = '…';
        try {
          if (newUrl === oldUrl) {
            status.textContent = 'inchangé';
            status.style.color = C.muted;
            skipped++;
            continue;
          }
          await apiFetch('torrents/editTracker', {
            method: 'POST',
            body: new URLSearchParams({ hash: t.hash, url: oldUrl, newUrl }),
          });
          status.textContent = '✔';
          status.style.color = '#81c995';
          ok++;
        } catch (e) {
          status.textContent = 'échec';
          status.style.color = '#e57373';
          failed++;
        }
      }
      applyBtn.textContent = `Terminé : ${ok} modifié(s), ${skipped} ignoré(s), ${failed} échec(s)`;
      applyBtn.disabled = false;
      applyBtn.onclick = () => overlay.remove();
    };
  }

  async function getSelectedTorrentSourceInfo() {
    const row = document.querySelector('tr.selected[data-row-id]');
    const hash = row ? row.getAttribute('data-row-id') : null;
    if (!hash) return null;
    try {
      const [propsRes, filesRes, infoRes] = await Promise.all([
        apiFetch('torrents/properties?hash=' + hash),
        apiFetch('torrents/files?hash=' + hash),
        apiFetch('torrents/info?hashes=' + hash),
      ]);
      const props = await propsRes.json();
      const files = await filesRes.json();
      const infoList = await infoRes.json();
      const name = infoList && infoList[0] && infoList[0].name;
      const path = props.content_path ||
        (name && props.save_path ? props.save_path.replace(/\/+$/, '') + '/' + name : null);
      if (!path) return null;
      return { path, isDir: files.length !== 1 };
    } catch (e) {
      return null;
    }
  }

  // ---------- Dialogue principal ----------
  function buildDialog() {
    const settings = getSettings();
    const overlay = document.createElement('div');
    overlay.id = 'gus-torrentcreator-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('500px')}">
        <h3 style="margin-top:0;">Créer un torrent</h3>

        <label>Chemin source (vu depuis le conteneur qBittorrent)</label>
        <div style="display:flex;gap:6px;margin:4px 0 10px;">
          <input id="gtc-source" style="${inputStyle('flex:1;box-sizing:border-box;')}" value="${getDefaultPath()}" autocomplete="off">
          <button id="gtc-browse" type="button" style="${btnStyle()}">Parcourir…</button>
        </div>

        <label>Taille des pièces</label>
        <select id="gtc-piecesize" style="${inputStyle('width:100%;margin:4px 0 10px;')}">
          ${pieceSizeOptions(settings.pieceSize)}
        </select>

        <label>Format</label>
        <select id="gtc-format" style="${inputStyle('width:100%;margin:4px 0 10px;')}">
          ${formatOptions(settings.format)}
        </select>

        <label>Trackers enregistrés</label>
        <div id="gtc-tracker-list" style="border:1px solid ${C.border};border-radius:4px;max-height:150px;overflow:auto;margin:4px 0 6px;"></div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <input id="gtc-tracker-name" style="${inputStyle('width:35%;box-sizing:border-box;')}" placeholder="Nom (ex: mon tracker perso)">
          <input id="gtc-tracker-new" style="${inputStyle('flex:1;box-sizing:border-box;')}" placeholder="URL d'announce (plusieurs : séparées par un espace)">
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;">
          <input id="gtc-tracker-source" style="${inputStyle('flex:1;box-sizing:border-box;')}" placeholder="Source (optionnel, ex: HD-Forever) — pour un hash identique au site">
          <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:12px;">
            <input type="checkbox" id="gtc-tracker-enabled" checked> Coché par défaut
          </label>
          <button id="gtc-tracker-add" type="button" style="${btnStyle()}">Enregistrer</button>
        </div>

        <label>Source</label>
        <input id="gtc-source-field" style="${inputStyle('width:100%;box-sizing:border-box;margin:4px 0 10px;')}" placeholder="Déduit automatiquement du tracker coché ci-dessus si un seul a une source">

        <label>Trackers additionnels ponctuels (un par ligne)</label>
        <textarea id="gtc-trackers-extra" style="${inputStyle('width:100%;box-sizing:border-box;height:45px;margin:4px 0 10px;')}"></textarea>

        <label><input type="checkbox" id="gtc-private"${settings.private ? ' checked' : ''}> Torrent privé</label><br>
        <label><input type="checkbox" id="gtc-seed"${settings.startSeeding ? ' checked' : ''}> Démarrer le seed immédiatement</label><br><br>

        <div id="gtc-status" style="min-height:36px;color:${C.muted};word-break:break-all;"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
          <button id="gtc-open-settings" type="button" style="${btnStyle()}" title="Réglages">⚙ Réglages</button>
          <div>
            <button id="gtc-cancel" style="${btnStyle()}">Fermer</button>
            <button id="gtc-create" style="${btnStyle()}">Créer</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Toutes les tâches lancées depuis cette fenêtre (on peut enchaîner plusieurs créations).
    const dialogTaskIDs = new Set();
    function closeDialog() {
      for (const taskID of dialogTaskIDs) {
        // "Fermer" supprime toujours la tâche côté serveur : si elle tourne encore, ça l'annule
        // (sinon elle bloque le slot de création unique) ; si elle est terminée, ça libère la
        // tâche et son .torrent temporaire, qui sinon s'accumulent jusqu'au redémarrage de
        // qBittorrent. Le torrent déjà ajouté en seed n'est pas affecté.
        apiFetch('torrentcreator/deleteTask', {
          method: 'POST', body: new URLSearchParams({ taskID }),
        }).catch(() => {});
      }
      overlay.remove();
    }
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });
    overlay.querySelector('#gtc-cancel').onclick = () => closeDialog();
    overlay.querySelector('#gtc-open-settings').onclick = () => openSettingsDialog();

    const sourceInput = overlay.querySelector('#gtc-source');
    attachAutocomplete(sourceInput);

    // Si un torrent est sélectionné dans la liste principale au moment de l'ouverture, on
    // préremplit le chemin source avec son contenu (content_path, ou à défaut save_path + nom
    // du torrent) plutôt que le dernier chemin utilisé. On ne l'applique que si le champ n'a
    // pas déjà été modifié entre-temps (garde-fou, très improbable vu la rapidité de l'appel).
    const initialValue = sourceInput.value;
    getSelectedTorrentSourceInfo().then(info => {
      if (info && sourceInput.value === initialValue) {
        sourceInput.value = info.path;
        sourceInput.dataset.isDir = info.isDir ? '1' : '0';
        setDefaultPath(info.path);
      }
    });

    overlay.querySelector('#gtc-browse').onclick = () => {
      openDirectoryBrowser(sourceInput.value || getDefaultPath(), (path, isDir) => {
        sourceInput.value = path;
        sourceInput.dataset.isDir = isDir ? '1' : '0';
        setDefaultPath(path);
      });
    };

    // ---- Trackers : rendu 100% DOM (pas d'innerHTML sur du contenu variable) ----
    function renderTrackerList() {
      const box = overlay.querySelector('#gtc-tracker-list');
      const trackers = getSavedTrackers();
      box.innerHTML = '';
      if (!trackers.length) {
        const empty = document.createElement('div');
        empty.textContent = '(aucun tracker enregistré)';
        empty.style.cssText = `padding:6px;color:${C.muted};`;
        box.appendChild(empty);
        recomputeSourceField();
        return;
      }
      trackers.forEach((t, i) => {
        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid ${C.border};`;

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.className = 'gtc-tracker-chk';
        chk.checked = t.enabled !== false;
        chk.dataset.url = t.url;
        chk.dataset.source = t.source || '';
        chk.addEventListener('change', recomputeSourceField);

        const label = document.createElement('span');
        label.textContent = t.name + (t.source ? ' (' + t.source + ')' : '');
        label.title = splitUrls(t.url).join('\n') + (t.source ? '\nSource: ' + t.source : '');
        label.style.cssText = `flex:1;cursor:pointer;color:${C.text};`;
        label.onclick = () => { chk.checked = !chk.checked; recomputeSourceField(); };

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.textContent = '✎';
        editBtn.style.cssText = iconBtnStyle();
        editBtn.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); startEdit(); };

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '✕';
        delBtn.style.cssText = iconBtnStyle();
        delBtn.onclick = (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const list = getSavedTrackers();
          list.splice(i, 1);
          setSavedTrackers(list);
          renderTrackerList();
        };

        function startEdit() {
          row.innerHTML = '';
          row.style.flexWrap = 'wrap';
          const nameInput = document.createElement('input');
          nameInput.value = t.name;
          nameInput.style.cssText = inputStyle('width:35%;box-sizing:border-box;padding:3px;');
          const urlInput = document.createElement('input');
          urlInput.value = t.url;
          urlInput.style.cssText = inputStyle('flex:1;box-sizing:border-box;padding:3px;min-width:150px;');
          const sourceInput = document.createElement('input');
          sourceInput.value = t.source || '';
          sourceInput.placeholder = 'Source (optionnel)';
          sourceInput.style.cssText = inputStyle('flex:1;box-sizing:border-box;padding:3px;min-width:120px;');
          const enabledLabel = document.createElement('label');
          enabledLabel.style.cssText = 'display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:12px;';
          const enabledInput = document.createElement('input');
          enabledInput.type = 'checkbox';
          enabledInput.checked = t.enabled !== false;
          enabledLabel.append(enabledInput, document.createTextNode('Coché par défaut'));
          const okBtn = document.createElement('button');
          okBtn.type = 'button'; okBtn.textContent = '✓'; okBtn.style.cssText = iconBtnStyle();
          okBtn.onclick = (ev) => {
            ev.preventDefault();
            const list = getSavedTrackers();
            const url = splitUrls(urlInput.value).join(' ');
            if (!url) return;
            list[i] = { name: nameInput.value.trim() || url, url, source: sourceInput.value.trim(), enabled: enabledInput.checked };
            setSavedTrackers(list);
            renderTrackerList();
          };
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button'; cancelBtn.textContent = '×'; cancelBtn.style.cssText = iconBtnStyle();
          cancelBtn.onclick = (ev) => { ev.preventDefault(); renderTrackerList(); };
          row.append(nameInput, urlInput, sourceInput, enabledLabel, okBtn, cancelBtn);
        }

        row.append(chk, label, editBtn, delBtn);
        box.appendChild(row);
      });
      recomputeSourceField();
    }

    // Déduit le champ Source des trackers cochés : si un seul tracker coché a une source non
    // vide (ou si tous ceux cochés partagent la même), on la propose automatiquement — sans
    // écraser une valeur que l'utilisateur aurait tapée/modifiée à la main entre-temps.
    let lastAutoSource = null;
    function recomputeSourceField() {
      const sourceField = overlay.querySelector('#gtc-source-field');
      if (!sourceField) return;
      const checked = [...overlay.querySelectorAll('.gtc-tracker-chk:checked')];
      const sources = [...new Set(checked.map(c => c.dataset.source).filter(Boolean))];
      const auto = sources.length === 1 ? sources[0] : '';
      if (lastAutoSource === null || sourceField.value === lastAutoSource) {
        sourceField.value = auto;
      }
      lastAutoSource = auto;
    }
    renderTrackerList();

    overlay.querySelector('#gtc-tracker-add').onclick = () => {
      const nameInput = overlay.querySelector('#gtc-tracker-name');
      const urlInput = overlay.querySelector('#gtc-tracker-new');
      const sourceInput = overlay.querySelector('#gtc-tracker-source');
      const enabledInput = overlay.querySelector('#gtc-tracker-enabled');
      const url = splitUrls(urlInput.value).join(' ');
      if (!url) return;
      const name = nameInput.value.trim() || url;
      const source = sourceInput.value.trim();
      const enabled = enabledInput.checked;
      const list = getSavedTrackers();
      if (!list.some(t => t.url === url)) { list.push({ name, url, source, enabled }); setSavedTrackers(list); }
      nameInput.value = ''; urlInput.value = ''; sourceInput.value = ''; enabledInput.checked = true;
      renderTrackerList();
    };

    overlay.querySelector('#gtc-create').onclick = async () => {
      const status = overlay.querySelector('#gtc-status');
      const sourcePath = sourceInput.value.trim();
      if (!sourcePath) { status.textContent = 'Chemin requis.'; return; }
      setDefaultPath(sourcePath);

      const checkedTrackers = [...overlay.querySelectorAll('.gtc-tracker-chk:checked')].flatMap(c => splitUrls(c.dataset.url));
      const extraTrackers = overlay.querySelector('#gtc-trackers-extra').value
        .split('\n').map(s => s.trim()).filter(Boolean);
      const trackers = [...checkedTrackers, ...extraTrackers].join('|');

      const pieceSize = overlay.querySelector('#gtc-piecesize').value;
      const format = overlay.querySelector('#gtc-format').value;

      const source = overlay.querySelector('#gtc-source-field').value.trim();
      const params = {
        sourcePath,
        format,
        private: overlay.querySelector('#gtc-private').checked,
        startSeeding: overlay.querySelector('#gtc-seed').checked,
      };
      if (pieceSize) params.pieceSize = pieceSize;
      if (source) params.source = source;
      const body = new URLSearchParams(params);
      if (trackers) body.set('trackers', trackers);

      status.textContent = 'Création en cours…';
      try {
        const res = await apiFetch('torrentcreator/addTask', { method: 'POST', body });
        const data = await res.json();
        const taskID = data.taskID || data.taskId;
        dialogTaskIDs.add(taskID);
        const isDirHint = sourceInput.dataset.isDir === '' || sourceInput.dataset.isDir === undefined
          ? undefined : (sourceInput.dataset.isDir === '1');
        await pollStatus(taskID, status, sourcePath, isDirHint);
        // La tâche reste dans dialogTaskIDs : closeDialog() la supprimera à la fermeture.
      } catch (e) {
        status.textContent = 'Erreur: ' + e.message;
      }
    };
  }

  function extractProgressText(info) {
    // Confirmé par test réel (curl sur torrentcreator/status pendant une création) : "progress"
    // est un entier en pourcentage direct 0-100, pas une fraction 0-1. Pas de mise à l'échelle.
    if (typeof info.progress === 'number') {
      return info.progress + ' %';
    }
    return null;
  }

  async function pollStatus(taskID, status, sourcePath, isDirHint) {
    const startedAt = Date.now();
    // Pas de limite de durée : on suit la tâche tant que la fenêtre est ouverte. Un gros dossier
    // sur HDD peut dépasser largement 5 min (hachage mono-thread côté libtorrent). Fermer la
    // fenêtre annule la tâche côté serveur (closeDialog → deleteTask), donc la boucle s'arrête.
    while (status.isConnected) {
      await new Promise(r => setTimeout(r, 1000));
      if (!status.isConnected) return;
      const res = await apiFetch('torrentcreator/status?taskID=' + encodeURIComponent(taskID));
      const list = await res.json();
      const info = Array.isArray(list) ? list[0] : list;
      if (!info) continue;

      const elapsed = Math.round((Date.now() - startedAt) / 1000) + 's';
      const pct = extractProgressText(info);
      status.textContent = 'Statut: ' + info.status + (pct ? ' — ' + pct : ' — ' + elapsed + ' écoulées');

      if (info.status === 'Finished' || info.status === 'Failed') {
        // "Failed" signifie souvent juste "l'ajout/démarrage automatique du seed a échoué"
        // (torrent déjà présent, cross-seed, tracker pas encore enregistré...), pas que la
        // génération du .torrent a échoué. Le fichier existe généralement quand même : on
        // propose toujours le téléchargement, quel que soit le statut final.
        const url = '/api/v2/torrentcreator/torrentFile?taskID=' + encodeURIComponent(taskID);
        const filename = computeTorrentFilename(sourcePath, isDirHint);
        status.innerHTML = '';
        const label = document.createElement('div');
        label.style.cssText = 'margin-bottom:6px;word-break:break-all;';
        label.textContent = (info.status === 'Finished'
          ? 'Terminé ✔ — '
          : 'Fichier généré, mais : ' + (info.errorMessage || 'échec du démarrage du partage (bénin, souvent un doublon ou tracker pas encore enregistré)') + ' — ') + filename;
        status.appendChild(label);
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.textContent = '⬇ Télécharger';
        dlBtn.title = filename;
        dlBtn.style.cssText = btnStyle();
        dlBtn.onclick = async () => {
          // Récupère le fichier en blob local : un lien vers l'URL de l'API directement
          // se fait souvent écraser par le nom suggéré par l'en-tête Content-Disposition
          // du serveur (Safari, Firefox), un blob local n'a pas ce problème.
          dlBtn.textContent = 'Téléchargement…';
          dlBtn.disabled = true;
          try {
            const res = await fetch(url, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
            dlBtn.textContent = '⬇ Télécharger';
            dlBtn.disabled = false;
          } catch (e) {
            dlBtn.textContent = 'Introuvable (' + e.message + ')';
            dlBtn.disabled = true;
          }
        };
        status.appendChild(dlBtn);
        return;
      }
    }
  }

  // Icône "fichier + plus" (style lucide), en data-URI pour un <img class="mochaToolButton"> natif
  const ICON_DATAURI = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" ' +
    'stroke="#c8c8c8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 2v6h6"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>'
  );

  // Détourne le bouton natif "Créateur de torrent" (#torrentCreatorButton) au lieu d'en ajouter
  // un à côté : même icône, même position, même style — y compris après un changement de thème,
  // puisque c'est le vrai élément natif (pas une copie) et son icône vient du thème actif.
  // L'écouteur est posé en phase de capture + stopImmediatePropagation pour empêcher le
  // gestionnaire natif de qBittorrent de s'exécuter, quelle que soit sa méthode d'attache.
  function hijackTorrentCreatorButton() {
    const el = document.getElementById('torrentCreatorButton');
    if (!el) return false;
    if (el.dataset.gtcHijacked) return true;
    el.dataset.gtcHijacked = '1';
    el.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      buildDialog();
    }, true);
    return true;
  }

  // Icône "info" en rond bleu plein avec un i blanc, dans le style des icônes natives
  // (cercle plein coloré + symbole blanc, comme le bouton bleu "Ajouter un fichier torrent…").
  const MEDIAINFO_ICON_DATAURI = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
    '<circle cx="12" cy="12" r="10" fill="#2f8fe0"/>' +
    '<rect x="11" y="10.2" width="2" height="7" rx="1" fill="#ffffff"/>' +
    '<rect x="11" y="6.3" width="2" height="2" rx="1" fill="#ffffff"/></svg>'
  );

  // Pas de bouton natif équivalent à détourner ici : on en insère un vrai, juste après le
  // bouton "Créateur de torrent" natif, avec la même structure <a><img class="mochaToolButton">.
  function insertMediaInfoButton() {
    const existing = document.getElementById('gtc-mediainfo-button');
    if (!getMediaInfoApi()) { if (existing) existing.remove(); return true; }
    if (existing) return true;
    const anchor = document.getElementById('torrentCreatorButton');
    if (!anchor) return false;
    const a = document.createElement('a');
    a.id = 'gtc-mediainfo-button';
    a.style.cursor = 'pointer';
    const img = document.createElement('img');
    img.className = 'mochaToolButton';
    img.title = 'MediaInfo';
    img.alt = 'MediaInfo';
    img.width = 24;
    img.height = 24;
    img.src = MEDIAINFO_ICON_DATAURI;
    a.appendChild(img);
    a.onclick = async () => {
      // Si un torrent est sélectionné dans la liste principale (tr.selected, hash dans
      // data-row-id), on saute direct à sa liste de fichiers plutôt que de repasser par le
      // sélecteur de torrent. Le bouton "Retour" du sélecteur de fichiers reste disponible
      // pour changer de torrent si besoin.
      const row = document.querySelector('tr.selected[data-row-id]');
      const hash = row ? row.getAttribute('data-row-id') : null;
      if (hash) {
        try {
          const res = await apiFetch('torrents/info?hashes=' + hash);
          const list = await res.json();
          if (list && list[0]) { openMediaInfoFilePicker(list[0]); return; }
        } catch (e) { /* repli sur le sélecteur ci-dessous */ }
      }
      openMediaInfoTorrentPicker();
    };
    anchor.after(a);
    return true;
  }

  // Icône "crayon en rond vert", pour le bouton Éditer un tracker
  const TRACKER_EDIT_ICON_DATAURI = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
    '<circle cx="12" cy="12" r="10" fill="#34a853"/>' +
    '<path d="M8 16l1-3.5L15 6l2 2-6 6.5z" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<path d="M8 16l3.3-.7" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/></svg>'
  );

  function insertTrackerEditorButton() {
    if (document.getElementById('gtc-trackereditor-button')) return true;
    const anchor = document.getElementById('gtc-mediainfo-button') || document.getElementById('torrentCreatorButton');
    if (!anchor) return false;
    const a = document.createElement('a');
    a.id = 'gtc-trackereditor-button';
    a.style.cursor = 'pointer';
    const img = document.createElement('img');
    img.className = 'mochaToolButton';
    img.title = 'Éditer un tracker';
    img.alt = 'Éditer un tracker';
    img.width = 24;
    img.height = 24;
    img.src = TRACKER_EDIT_ICON_DATAURI;
    a.appendChild(img);
    a.onclick = () => {
      const rows = [...document.querySelectorAll('tr.selected[data-row-id]')];
      const hashes = rows.map(r => r.getAttribute('data-row-id'));
      if (hashes.length) { openBulkTrackerEditor({ hashes }); return; }
      const host = getSelectedTrackerHost();
      openBulkTrackerEditor(host ? { host } : {});
    };
    anchor.after(a);
    return true;
  }

  // ---------- Réinitialisation des filtres de la barre latérale ----------
  // Les filtres (État, Catégories, Étiquettes, Trackers) sont des variables internes de
  // client.js, inaccessibles depuis le contexte isolé de l'extension. Mais le WebUI écoute les
  // clics délégués sur #Filters_pad : cliquer sur l'entrée « Tous » de chaque liste déclenche
  // exactement le comportement natif (mémorisation dans localPreferences, rafraîchissement).
  // L'entrée « Tous » est toujours la première <li> de chaque liste.
  // La case de recherche (#torrentsFilterInput) est aussi un filtre : client.js rafraîchit la
  // liste sur l'événement « input » ; on la vide puis on émet cet événement nous-mêmes (changer
  // .value par script ne le déclenche pas).
  const FILTER_LIST_IDS = ['statusFilterList', 'categoryFilterList', 'tagFilterList', 'trackerFilterList'];
  const SEARCH_INPUT_ID = 'torrentsFilterInput';

  function activeFilterLists() {
    const active = FILTER_LIST_IDS.filter(id => {
      const list = document.getElementById(id);
      if (!list) return false;
      const selected = list.querySelector('li.selectedFilter');
      return !!selected && selected !== list.querySelector('li');
    });
    const search = document.getElementById(SEARCH_INPUT_ID);
    if (search && search.value !== '') active.push(SEARCH_INPUT_ID);
    return active;
  }

  function resetAllFilters() {
    activeFilterLists().forEach(id => {
      if (id === SEARCH_INPUT_ID) {
        const search = document.getElementById(id);
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const allItem = document.getElementById(id).querySelector('li');
      if (allItem) allItem.click();
    });
    updateResetFiltersButton();
  }

  // Entonnoir barré : gris quand tout est sur « Tous », orange dès qu'un filtre est actif.
  function filterIconDataUri(color) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
      `<circle cx="12" cy="12" r="10" fill="${color}"/>` +
      '<path d="M7 7.5h10l-3.8 4.6v4.2l-2.4 1.2v-5.4z" fill="#ffffff"/>' +
      '<path d="M6.5 17.5L17.5 6.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/></svg>'
    );
  }
  const RESET_FILTERS_ICON_IDLE = filterIconDataUri('#6b6b6b');
  const RESET_FILTERS_ICON_ACTIVE = filterIconDataUri('#f29900');

  function updateResetFiltersButton() {
    const img = document.querySelector('#gtc-resetfilters-button img');
    if (!img) return;
    const active = activeFilterLists();
    const src = active.length ? RESET_FILTERS_ICON_ACTIVE : RESET_FILTERS_ICON_IDLE;
    if (img.src !== src) img.src = src;
    const names = { statusFilterList: 'État', categoryFilterList: 'Catégorie', tagFilterList: 'Étiquette', trackerFilterList: 'Tracker', [SEARCH_INPUT_ID]: 'Recherche' };
    img.title = active.length
      ? 'Réinitialiser les filtres (actifs : ' + active.map(id => names[id]).join(', ') + ')'
      : 'Réinitialiser les filtres (aucun actif)';
  }

  function insertResetFiltersButton() {
    if (document.getElementById('gtc-resetfilters-button')) return true;
    const anchor = document.getElementById('gtc-trackereditor-button');
    const pad = document.getElementById('Filters_pad');
    if (!anchor || !pad) return false;
    const a = document.createElement('a');
    a.id = 'gtc-resetfilters-button';
    a.style.cursor = 'pointer';
    const img = document.createElement('img');
    img.className = 'mochaToolButton';
    img.alt = 'Réinitialiser les filtres';
    img.width = 24;
    img.height = 24;
    img.src = RESET_FILTERS_ICON_IDLE;
    a.appendChild(img);
    a.onclick = resetAllFilters;
    anchor.after(a);
    // Suit les changements de sélection (clic manuel, listes reconstruites à chaque rafraîchissement).
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; updateResetFiltersButton(); });
    }).observe(pad, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    // La case de recherche est hors de #Filters_pad : on suit sa saisie séparément.
    const search = document.getElementById(SEARCH_INPUT_ID);
    if (search) search.addEventListener('input', updateResetFiltersButton);
    updateResetFiltersButton();
    return true;
  }

  function addFloatingFallback() {
    if (document.getElementById('gtc-open-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'gtc-open-btn';
    btn.title = 'Créer un torrent';
    btn.innerHTML = '<img src="' + ICON_DATAURI + '" width="18" height="18">';
    btn.style.cssText = 'position:fixed;top:10px;right:16px;z-index:9998;width:36px;height:36px;' +
      'display:flex;align-items:center;justify-content:center;border-radius:8px;' +
      `background:${C.hover};color:${C.text};border:1px solid ${C.border};cursor:pointer;` +
      'box-shadow:0 2px 6px rgba(0,0,0,.4);transition:background .15s;';
    btn.onmouseenter = () => { btn.style.background = C.input; };
    btn.onmouseleave = () => { btn.style.background = C.hover; };
    btn.onclick = buildDialog;
    document.body.appendChild(btn);
  }

  function addButton() {
    const hijacked = hijackTorrentCreatorButton();
    const mediaInfoAdded = insertMediaInfoButton();
    const trackerEditorAdded = insertTrackerEditorButton();
    const resetFiltersAdded = insertResetFiltersButton();
    if (hijacked && mediaInfoAdded && trackerEditorAdded && resetFiltersAdded) return;
    // #torrentCreatorButton n'existe pas encore (chargement JS de qBittorrent en cours) : on
    // réessaie brièvement, et seulement s'il n'apparaît vraiment jamais on bascule sur le
    // bouton flottant de secours (pour le créateur de torrent uniquement — les deux autres ont
    // besoin du bouton natif comme point d'ancrage et n'ont pas de repli).
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const a = hijackTorrentCreatorButton();
      const b = insertMediaInfoButton();
      const c = insertTrackerEditorButton();
      const d = insertResetFiltersButton();
      if ((a && b && c && d) || tries > 20) {
        clearInterval(iv);
        if (!document.getElementById('torrentCreatorButton')) addFloatingFallback();
      }
    }, 300);
  }

  // ---------- Écran de réglages ----------
  // Teste la joignabilité du sidecar : n'importe quelle réponse HTTP (même 400 sur un chemin
  // vide) prouve qu'il répond ; seul un échec réseau/timeout signifie « injoignable ».
  function gmProbe(url) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 5000,
        onload: r => resolve({ ok: true, status: r.status }),
        onerror: () => resolve({ ok: false }),
        ontimeout: () => resolve({ ok: false, timeout: true }),
      });
    });
  }

  function validateHttpUrl(value) {
    if (!value) return null;
    try {
      const u = new URL(value);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? null : 'L\'URL doit commencer par http:// ou https://';
    } catch (e) { return 'URL invalide'; }
  }

  function openSettingsDialog() {
    if (document.getElementById('gtc-settings-overlay')) return;
    const s = getSettings();
    const overlay = document.createElement('div');
    overlay.id = 'gtc-settings-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100003;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('480px')}">
        <h3 style="margin-top:0;">Réglages</h3>

        <label>URL du sidecar MediaInfo <span style="color:${C.muted};">(vide = bouton MediaInfo masqué)</span></label>
        <div style="display:flex;gap:6px;margin:4px 0 4px;">
          <input id="gtc-set-mi" style="${inputStyle('flex:1;box-sizing:border-box;')}" placeholder="http://192.168.1.10:8765" autocomplete="off">
          <button id="gtc-set-mi-test" type="button" style="${btnStyle()}">Tester</button>
        </div>
        <div id="gtc-set-mi-status" style="min-height:16px;font-size:12px;color:${C.muted};margin-bottom:10px;"></div>

        <label>Taille des pièces par défaut</label>
        <select id="gtc-set-piece" style="${inputStyle('width:100%;margin:4px 0 10px;')}">${pieceSizeOptions(s.pieceSize)}</select>

        <label>Format par défaut</label>
        <select id="gtc-set-format" style="${inputStyle('width:100%;margin:4px 0 10px;')}">${formatOptions(s.format)}</select>

        <label><input type="checkbox" id="gtc-set-private"${s.private ? ' checked' : ''}> Torrent privé par défaut</label><br>
        <label><input type="checkbox" id="gtc-set-seed"${s.startSeeding ? ' checked' : ''}> Démarrer le seed par défaut</label><br>
        <label><input type="checkbox" id="gtc-set-queue"${s.hideQueueingButtons ? ' checked' : ''}> Masquer les flèches de file d'attente dans la barre d'outils</label>

        <div id="gtc-set-error" style="color:#e57373;min-height:16px;margin-top:10px;"></div>
        <div style="text-align:right;margin-top:6px;">
          <button id="gtc-set-cancel" style="${btnStyle()}">Annuler</button>
          <button id="gtc-set-save" style="${btnStyle()}">Enregistrer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const miInput = overlay.querySelector('#gtc-set-mi');
    miInput.value = s.mediainfoApi || ''; // via .value : pas d'injection dans le HTML
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-set-cancel').onclick = () => overlay.remove();

    const miStatus = overlay.querySelector('#gtc-set-mi-status');
    overlay.querySelector('#gtc-set-mi-test').onclick = async () => {
      const url = miInput.value.trim().replace(/\/+$/, '');
      const err = url ? validateHttpUrl(url) : 'Renseigne une URL à tester';
      if (err) { miStatus.textContent = err; miStatus.style.color = '#e57373'; return; }
      miStatus.textContent = 'Test en cours…'; miStatus.style.color = C.muted;
      const r = await gmProbe(url + '/mediainfo?path=');
      if (r.ok) {
        miStatus.textContent = 'Sidecar joignable ✔ (réponse HTTP ' + r.status + ')';
        miStatus.style.color = '#81c995';
      } else {
        miStatus.textContent = r.timeout ? 'Injoignable (timeout 5 s)' : 'Injoignable (erreur réseau — adresse, port ou pare-feu ?)';
        miStatus.style.color = '#e57373';
      }
    };

    overlay.querySelector('#gtc-set-save').onclick = () => {
      const mediainfoApi = miInput.value.trim().replace(/\/+$/, '');
      const err = validateHttpUrl(mediainfoApi);
      if (err) { overlay.querySelector('#gtc-set-error').textContent = err; return; }
      const piece = overlay.querySelector('#gtc-set-piece').value;
      setSettings({
        mediainfoApi,
        pieceSize: piece === '' ? '' : Number(piece),
        format: overlay.querySelector('#gtc-set-format').value,
        private: overlay.querySelector('#gtc-set-private').checked,
        startSeeding: overlay.querySelector('#gtc-set-seed').checked,
        hideQueueingButtons: overlay.querySelector('#gtc-set-queue').checked,
      });
      applyQueueingStyle();
      insertMediaInfoButton();   // ajoute ou retire le bouton selon l'URL
      insertTrackerEditorButton();
      overlay.remove();
    };
  }

  // ---------- Import / export des trackers enregistrés (JSON) ----------
  // Permet de garder ses presets (avec passkeys) dans un fichier local hors dépôt, et de les
  // recharger sur un autre navigateur. Import = fusion par nom : un tracker du même nom est
  // remplacé, les autres sont conservés.
  function openTrackersImportExport() {
    if (document.getElementById('gtc-io-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'gtc-io-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100003;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('620px')}">
        <h3 style="margin-top:0;">Trackers enregistrés — import / export</h3>
        <div style="color:${C.muted};margin-bottom:6px;">Contenu actuel ci-dessous (à copier pour sauvegarder). Pour importer : colle un tableau JSON à la place, puis « Importer » (fusion par nom).</div>
        <textarea id="gtc-io-text" spellcheck="false" style="${inputStyle('width:100%;box-sizing:border-box;height:300px;font-family:monospace;font-size:12px;')}"></textarea>
        <div id="gtc-io-status" style="min-height:16px;margin-top:8px;color:${C.muted};"></div>
        <div style="text-align:right;margin-top:6px;">
          <button id="gtc-io-close" type="button" style="${btnStyle()}">Fermer</button>
          <button id="gtc-io-import" type="button" style="${btnStyle()}">Importer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const text = overlay.querySelector('#gtc-io-text');
    const status = overlay.querySelector('#gtc-io-status');
    text.value = JSON.stringify(getSavedTrackers(), null, 2);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-io-close').onclick = () => overlay.remove();
    overlay.querySelector('#gtc-io-import').onclick = () => {
      let data;
      try { data = JSON.parse(text.value); } catch (e) { status.textContent = 'JSON invalide : ' + e.message; return; }
      if (!Array.isArray(data)) { status.textContent = 'Il faut un tableau JSON [ {…}, {…} ].'; return; }
      const list = getSavedTrackers();
      let added = 0, replaced = 0;
      for (const t of data) {
        if (!t || typeof t !== 'object') continue;
        const url = splitUrls(Array.isArray(t.url) ? t.url.join(' ') : t.url).join(' ');
        if (!url) continue;
        const entry = { name: String(t.name || url).trim(), url, source: String(t.source || '').trim(), enabled: t.enabled !== false };
        const i = list.findIndex(x => x.name === entry.name);
        if (i >= 0) { list[i] = entry; replaced++; } else { list.push(entry); added++; }
      }
      setSavedTrackers(list);
      text.value = JSON.stringify(list, null, 2);
      status.textContent = `${added} ajouté(s), ${replaced} remplacé(s). Rouvre le créateur pour les voir.`;
    };
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Réglages…', openSettingsDialog);
    GM_registerMenuCommand('Trackers : importer / exporter…', openTrackersImportExport);
  }

  addButton();
})();
