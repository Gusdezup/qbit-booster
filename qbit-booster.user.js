// ==UserScript==
// @name         Qbit Booster
// @namespace    qbit-booster
// @version      13.8
// @homepageURL  https://github.com/Gusdezup/qbit-booster
// @supportURL   https://github.com/Gusdezup/qbit-booster/issues
// @downloadURL  https://raw.githubusercontent.com/Gusdezup/qbit-booster/main/qbit-booster.user.js
// @updateURL    https://raw.githubusercontent.com/Gusdezup/qbit-booster/main/qbit-booster.user.js
// @description  Améliore le WebUI qBittorrent : créateur de torrent (taille de pièce, privé par défaut, trackers enregistrés, champ source, navigateur de fichiers), éditeur de trackers en masse, réinitialisation des filtres en un clic, MediaInfo optionnel (via le sidecar qbit-booster-mediainfo) et liens de partage Synology DSM optionnels. Réglages via le menu de l'extension.
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
// (WebUI sous un sous-chemin, ex. seedbox : https://xxx.usbx.me/qbittorrent/*)
// Ce réglage survit aux mises à jour du script. Aucun identifiant n'est nécessaire : le script
// tourne dans la page du WebUI et réutilise la session déjà ouverte.

(function () {
  'use strict';

  // Chemin de l'API RELATIF à la page (comme le WebUI natif) : fonctionne aussi quand le WebUI
  // est servi sous un sous-chemin derrière un reverse proxy (seedbox, ex. /qbittorrent/).
  // Un chemin absolu « /api/v2/ » partirait à la racine du domaine, hors de qBittorrent.
  const API_BASE = 'api/v2/';

  // ---------- Réglages (persistés via GM_setValue) ----------
  const DEFAULT_SETTINGS = {
    mediainfoApi: '',            // vide = bouton MediaInfo masqué
    defaultPath: '/media/downloads', // dossier de départ tant qu'aucun chemin n'a été utilisé
    pieceSize: 4194304,          // 4 MiB ('' = Auto)
    format: 'v1',
    private: true,
    startSeeding: true,
    hideQueueingButtons: false,
    dsmUrl: '',                  // vide = bouton « Lien de partage » masqué
    dsmUser: '',
    dsmPass: '',
    dsmPublicUrl: '',            // adresse publique des liens (vide = celle renvoyée par DSM)
    dsmPathMap: '',              // lignes « chemin qBittorrent => chemin File Station »
    dsmExpireDays: '',           // expiration par défaut des liens, en jours ('' = jamais)
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
    return fetch(API_BASE + path, { credentials: 'same-origin', ...options })
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
  // Dernier chemin utilisé, sinon le dossier de départ des Réglages.
  function getDefaultPath() { return GM_getValue('gtc_default_path', '') || getSettings().defaultPath || '/'; }
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
        const res = await fetch(API_BASE + 'app/getDirectoryContent' + (a.qs || ''), {
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
    // Tri : dossiers d'abord, puis ordre alphabétique (insensible à la casse, numérique : « S2 » avant « S10 »).
    const byName = (a, b) => (b.isDir - a.isDir) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
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
    }).sort(byName);
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
    let current = (startPath || getDefaultPath() || '/').replace(/(.)\/+$/, '$1');
    // Tant qu'aucun dossier n'a pu être lu, un chemin illisible (fichier, dossier supprimé…)
    // remonte au parent au lieu d'afficher une erreur. Cas typique : chemin source prérempli
    // avec un torrent mono-fichier (.mkv).
    let climbing = true;
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
        climbing = false;
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
        if (climbing && current !== '/') {
          current = current.replace(/\/[^/]+\/?$/, '') || '/';
          render();
          return;
        }
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

  async function copyText(content) {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { /* ignoré */ }
      ta.remove();
      return ok;
    }
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
      await copyText(pre.textContent);
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
        // Selon la version, une entrée est un objet {url, …} ou directement une chaîne.
        const url = String(typeof tr === 'string' ? tr : (tr && tr.url) || '').trim();
        // Seules les vraies URL d'announce comptent (exclut « ** [DHT] », « [PeX] », « [LSD] ** »).
        if (!/^(https?|udp|wss?):\/\//i.test(url)) return;
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

    // Le champ « trackers » inline n'est utilisé que s'il contient vraiment des URL : certaines
    // versions renvoient un champ absent, vide ou d'un autre format. Sinon, scan torrent par torrent.
    if (infos.length > 0 && infos.every(t => Array.isArray(t.trackers))) {
      infos.forEach(t => addTrackers(t, t.trackers));
    }
    if (trackersSeen > 0) {
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
  // En 5.0.x, l'id n'est pas le host mais un hash numérique de celui-ci : on lit alors le host
  // dans le libellé (« tracker.example.org (16) »). Les filtres spéciaux (« Tous », « Sans
  // tracker »…) ne ressemblent pas à un nom de domaine et renvoient null.
  function getSelectedTrackerHost() {
    const li = document.querySelector('#trackerFilterList li.selectedFilter');
    if (!li) return null;
    const isHost = s => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
    if (li.id && isHost(li.id)) return li.id;
    const label = li.textContent.trim().replace(/\s*\(\d+\)\s*$/, '');
    return isHost(label) ? label : null;
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

  // ---------- Liens de partage Synology DSM (optionnel) ----------
  // Appelle l'API Web de DSM (SYNO.API.Auth + SYNO.FileStation.Sharing) via GM_xmlhttpRequest :
  // pas de CSP ni de CORS, et « anonymous » pour ne pas mêler la session DSM éventuellement
  // ouverte dans le navigateur. Le compte DSM est stocké dans le stockage local de l'extension :
  // utilise un compte dédié, sans 2FA, limité à File Station et aux dossiers à partager.
  function getDsmUrl() { return String(getSettings().dsmUrl || '').trim().replace(/\/+$/, ''); }

  function gmRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, timeout: 20000, anonymous: true,
        headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {},
        data: body ? body.toString() : undefined,
        onload: r => resolve(r),
        onerror: () => reject(new Error('DSM injoignable (adresse, port, ou certificat HTTPS invalide pour cette adresse ?)')),
        ontimeout: () => reject(new Error('DSM : timeout')),
      });
    });
  }

  const DSM_COMMON_ERRORS = {
    100: 'erreur inconnue', 101: 'paramètre invalide', 102: 'API inexistante', 103: 'méthode inexistante',
    104: 'version d\'API non supportée', 105: 'permission refusée (droits du compte DSM)',
    106: 'session expirée', 107: 'session interrompue', 119: 'session invalide',
  };
  const DSM_AUTH_ERRORS = {
    400: 'identifiant ou mot de passe incorrect', 401: 'compte désactivé', 402: 'permission refusée',
    403: 'ce compte a la double authentification (2FA) : utilise un compte dédié sans 2FA',
    404: 'code 2FA refusé', 406: 'la 2FA est imposée à ce compte : utilise un compte qui en est exempté',
    407: 'adresse IP bloquée par DSM après trop d\'échecs (Panneau de configuration > Sécurité > Protection)',
    408: 'mot de passe expiré', 409: 'mot de passe expiré', 410: 'mot de passe à changer',
  };
  const DSM_FS_ERRORS = {
    400: 'paramètre invalide', 402: 'NAS trop occupé', 403: 'utilisateur invalide',
    407: 'opération non permise (le compte a-t-il le droit de partager ? File Station > Paramètres)',
    408: 'fichier ou dossier introuvable côté File Station (vérifie la correspondance des chemins)',
  };
  function dsmError(code, table) {
    const msg = (table && table[code]) || DSM_COMMON_ERRORS[code] || 'erreur';
    const e = new Error('DSM : ' + msg + ' (code ' + code + ')');
    e.dsmCode = code;
    return e;
  }

  // Session DSM en mémoire (le temps de l'onglet) ; reconnexion automatique si elle expire.
  const dsm = { base: null, apis: null, sid: null };
  function dsmReset() { dsm.base = null; dsm.apis = null; dsm.sid = null; }

  async function dsmApis() {
    const base = getDsmUrl();
    if (!base) throw new Error('Aucune adresse DSM configurée (Réglages…).');
    if (dsm.apis && dsm.base === base) return dsm.apis;
    const url = base + '/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth,SYNO.FileStation.Sharing';
    const r = await gmRequest('GET', url);
    let j;
    try { j = JSON.parse(r.responseText); } catch (e) { throw new Error('Réponse inattendue de ' + base + ' (HTTP ' + r.status + ') : est-ce bien l\'adresse de DSM ?'); }
    if (!j.success) throw dsmError(j.error && j.error.code);
    const auth = j.data['SYNO.API.Auth'], share = j.data['SYNO.FileStation.Sharing'];
    if (!auth || !share) throw new Error('DSM : API File Station absente (File Station est-il installé ?)');
    dsm.base = base;
    dsm.sid = null;
    dsm.apis = {
      auth: { path: auth.path, version: Math.min(auth.maxVersion, 6) },
      share: { path: share.path, version: Math.min(share.maxVersion, 3) },
    };
    return dsm.apis;
  }

  async function dsmPost(api, apiName, method, params, errTable) {
    const body = new URLSearchParams({ api: apiName, version: String(api.version), method, ...params });
    const r = await gmRequest('POST', dsm.base + '/webapi/' + api.path, body);
    let j;
    try { j = JSON.parse(r.responseText); } catch (e) { throw new Error('DSM : réponse illisible (HTTP ' + r.status + ')'); }
    if (!j.success) throw dsmError(j.error && j.error.code, errTable);
    return j.data;
  }

  async function dsmLogin() {
    const apis = await dsmApis();
    const s = getSettings();
    if (!s.dsmUser || !s.dsmPass) throw new Error('Compte DSM non renseigné (Réglages…).');
    const data = await dsmPost(apis.auth, 'SYNO.API.Auth', 'login', {
      account: s.dsmUser, passwd: s.dsmPass, session: 'FileStation', format: 'sid',
    }, DSM_AUTH_ERRORS);
    dsm.sid = data.sid;
    return dsm.sid;
  }

  // Appel authentifié, avec une reconnexion si la session a expiré (106/107/119).
  async function dsmAuthed(apiKey, apiName, method, params, errTable) {
    const apis = await dsmApis();
    if (!dsm.sid) await dsmLogin();
    try {
      return await dsmPost(apis[apiKey], apiName, method, { ...params, _sid: dsm.sid }, errTable);
    } catch (e) {
      if (![106, 107, 119].includes(e.dsmCode)) throw e;
      await dsmLogin();
      return dsmPost(apis[apiKey], apiName, method, { ...params, _sid: dsm.sid }, errTable);
    }
  }

  async function dsmCreateShareLink(path, password, dateExpired) {
    // DSM lit les paramètres en JSON quand c'est possible : une date brute (2026-11-11, JSON
    // invalide) est ignorée et un mot de passe tout en chiffres deviendrait un nombre. On les
    // envoie donc en chaînes JSON ("…"), comme le fait l'interface de File Station.
    const params = {};
    if (password) params.password = JSON.stringify(password);
    if (dateExpired) params.date_expired = JSON.stringify(dateExpired);
    let data;
    try {
      // Tableau JSON : évite que DSM découpe un nom contenant une virgule (séparateur de la
      // forme simple). Repli sur la forme simple si cette version de DSM refuse le tableau.
      data = await dsmAuthed('share', 'SYNO.FileStation.Sharing', 'create',
        { ...params, path: JSON.stringify([path]) }, DSM_FS_ERRORS);
    } catch (e) {
      if (![101, 400].includes(e.dsmCode)) throw e;
      data = await dsmAuthed('share', 'SYNO.FileStation.Sharing', 'create',
        { ...params, path }, DSM_FS_ERRORS);
    }
    const link = data && data.links && data.links[0];
    if (!link || !link.url) throw new Error('DSM n\'a renvoyé aucun lien');
    if (link.error) throw dsmError(link.error, DSM_FS_ERRORS);
    // Relit le lien pour afficher ce que DSM a réellement enregistré (la réponse de « create »
    // ne reflète pas toujours l'expiration ni le mot de passe).
    let saved = link;
    if (link.id) {
      try {
        const info = await dsmAuthed('share', 'SYNO.FileStation.Sharing', 'getinfo',
          { id: JSON.stringify(link.id) }, DSM_FS_ERRORS);
        if (info && info.url) saved = { ...link, ...info };
      } catch (e) { /* on garde la réponse de create */ }
    }
    return { ...saved, url: publicShareUrl(saved) };
  }

  // DSM construit l'URL du lien avec son propre nom d'hôte (souvent l'IP locale, ou gofile.me
  // via QuickConnect). Si une adresse publique est réglée, on reconstruit le lien dessus :
  // https://domaine/sharing/<id> (l'id est le même quel que soit l'hôte renvoyé par DSM).
  function publicShareUrl(link) {
    const pub = String(getSettings().dsmPublicUrl || '').trim().replace(/\/+$/, '');
    if (!pub) return link.url;
    let id = link.id;
    if (!id) {
      try { id = new URL(link.url).pathname.split('/').filter(Boolean).pop(); } catch (e) { /* ignoré */ }
    }
    return id ? pub + '/sharing/' + id : link.url;
  }

  // Correspondance des chemins : « /media => /usbshare/media », une règle par ligne, la plus
  // longue l'emporte. Le chemin vu par qBittorrent (conteneur) devient le chemin File Station
  // (/dossier-partagé/…).
  function parsePathMap(text) {
    return String(text || '').split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        const parts = l.split(/\s*=>\s*/);
        if (parts.length !== 2 || !parts[0].startsWith('/') || !parts[1].startsWith('/')) return null;
        return { from: parts[0].replace(/\/+$/, ''), to: parts[1].replace(/\/+$/, '') };
      })
      .filter(Boolean)
      .sort((a, b) => b.from.length - a.from.length);
  }
  function mapToDsmPath(qbtPath) {
    const p = String(qbtPath || '').replace(/(.)\/+$/, '$1');
    for (const r of parsePathMap(getSettings().dsmPathMap)) {
      if (p === r.from || p.startsWith(r.from + '/')) return (r.to + p.slice(r.from.length)) || '/';
    }
    return null;
  }

  function isoDateInDays(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function torrentContentPath(t) {
    if (t.content_path) return t.content_path;
    const props = await (await apiFetch('torrents/properties?hash=' + t.hash)).json();
    return (props.save_path || '').replace(/\/+$/, '') + '/' + t.name;
  }

  async function openShareDialog(torrent) {
    const s = getSettings();
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="${panelStyle('560px')}">
        <h3 style="margin:0 0 8px;">Lien de partage DSM</h3>
        <div id="gtc-sh-name" style="color:${C.muted};word-break:break-all;margin-bottom:10px;"></div>
        <label>Chemin File Station <span style="color:${C.muted};">(/dossier-partagé/…)</span></label>
        <input id="gtc-sh-path" style="${inputStyle('width:100%;box-sizing:border-box;margin:4px 0 4px;font-family:monospace;')}" autocomplete="off">
        <div id="gtc-sh-qbt" style="color:${C.muted};font-size:11px;word-break:break-all;margin-bottom:10px;"></div>
        <div style="display:flex;gap:10px;margin-bottom:10px;">
          <div style="flex:1;">
            <label>Mot de passe <span style="color:${C.muted};">(optionnel)</span></label>
            <input id="gtc-sh-pass" type="text" style="${inputStyle('width:100%;box-sizing:border-box;margin-top:4px;')}" autocomplete="off">
          </div>
          <div style="flex:1;">
            <label>Expire le <span style="color:${C.muted};">(vide = jamais)</span></label>
            <input id="gtc-sh-exp" type="date" style="${inputStyle('width:100%;box-sizing:border-box;margin-top:4px;color-scheme:dark;')}">
          </div>
        </div>
        <div id="gtc-sh-status" style="min-height:18px;color:${C.muted};word-break:break-all;"></div>
        <div id="gtc-sh-result" style="display:none;gap:6px;margin-top:6px;">
          <input id="gtc-sh-url" readonly style="${inputStyle('flex:1;box-sizing:border-box;font-family:monospace;')}">
          <button id="gtc-sh-copy" type="button" style="${btnStyle()}">Copier</button>
        </div>
        <div style="text-align:right;margin-top:12px;">
          <button id="gtc-sh-close" type="button" style="${btnStyle()}">Fermer</button>
          <button id="gtc-sh-create" type="button" style="${btnStyle()}">Créer le lien</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gtc-sh-close').onclick = () => overlay.remove();
    overlay.querySelector('#gtc-sh-name').textContent = torrent.name;
    const pathInput = overlay.querySelector('#gtc-sh-path');
    const qbtLine = overlay.querySelector('#gtc-sh-qbt');
    const status = overlay.querySelector('#gtc-sh-status');
    const days = parseInt(s.dsmExpireDays, 10);
    if (days > 0) overlay.querySelector('#gtc-sh-exp').value = isoDateInDays(days);

    try {
      const qbtPath = await torrentContentPath(torrent);
      const mapped = mapToDsmPath(qbtPath);
      qbtLine.textContent = 'Chemin qBittorrent : ' + qbtPath;
      if (mapped) pathInput.value = mapped;
      else {
        pathInput.value = qbtPath;
        status.textContent = 'Aucune règle de correspondance ne couvre ce chemin : corrige-le à la main ou ajoute une règle dans les Réglages.';
        status.style.color = '#f29900';
      }
    } catch (e) {
      status.textContent = 'Erreur qBittorrent : ' + e.message;
    }

    const createBtn = overlay.querySelector('#gtc-sh-create');
    createBtn.onclick = async () => {
      const path = pathInput.value.trim().replace(/(.)\/+$/, '$1');
      if (!path.startsWith('/')) { status.textContent = 'Chemin absolu requis.'; status.style.color = '#e57373'; return; }
      createBtn.disabled = true;
      status.textContent = 'Création du lien…'; status.style.color = C.muted;
      try {
        const link = await dsmCreateShareLink(path,
          overlay.querySelector('#gtc-sh-pass').value,
          overlay.querySelector('#gtc-sh-exp').value);
        const result = overlay.querySelector('#gtc-sh-result');
        const urlInput = overlay.querySelector('#gtc-sh-url');
        urlInput.value = link.url;
        result.style.display = 'flex';
        const copied = await copyText(link.url);
        const wantedPass = !!overlay.querySelector('#gtc-sh-pass').value;
        const wantedExp = overlay.querySelector('#gtc-sh-exp').value;
        const exp = link.date_expired && link.date_expired !== '0' ? String(link.date_expired) : '';
        const extras = [link.has_password ? 'protégé par mot de passe' : 'sans mot de passe',
          exp ? 'expire le ' + exp : 'sans expiration'];
        const warn = [];
        if (wantedPass && !link.has_password) warn.push('DSM n\'a pas enregistré le mot de passe');
        if (wantedExp && !exp) warn.push('DSM n\'a pas enregistré l\'expiration');
        status.textContent = 'Lien créé ✔ (' + extras.join(', ') + ')' + (copied ? ' — copié dans le presse-papiers' : '') +
          (warn.length ? ' ⚠ ' + warn.join(', ') + ' : vérifie dans File Station > Liens partagés' : '');
        status.style.color = warn.length ? '#f29900' : '#81c995';
        overlay.querySelector('#gtc-sh-copy').onclick = async () => {
          const btn = overlay.querySelector('#gtc-sh-copy');
          await copyText(urlInput.value);
          btn.textContent = 'Copié ✔';
          setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
        };
        urlInput.onfocus = () => urlInput.select();
      } catch (e) {
        status.textContent = e.message;
        status.style.color = '#e57373';
      }
      createBtn.disabled = false;
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
        const url = API_BASE + 'torrentcreator/torrentFile?taskID=' + encodeURIComponent(taskID);
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

  // Point d'ancrage des boutons ajoutés : le bouton natif « Créateur de torrent » s'il existe,
  // sinon notre propre bouton créateur (WebUI sans créateur natif, ex. qBittorrent 5.0.x).
  function creatorAnchor() {
    return document.getElementById('torrentCreatorButton') || document.getElementById('gtc-creator-button');
  }

  // Détourne le bouton natif "Créateur de torrent" (#torrentCreatorButton) au lieu d'en ajouter
  // un à côté : même icône, même position, même style — y compris après un changement de thème,
  // puisque c'est le vrai élément natif (pas une copie) et son icône vient du thème actif.
  // L'écouteur est posé en phase de capture + stopImmediatePropagation pour empêcher le
  // gestionnaire natif de qBittorrent de s'exécuter, quelle que soit sa méthode d'attache.
  // Si le WebUI n'a pas de bouton natif, on insère le nôtre dans la barre d'outils.
  function hijackTorrentCreatorButton() {
    const el = document.getElementById('torrentCreatorButton');
    if (el) {
      const own = document.getElementById('gtc-creator-button');
      if (own) own.remove();
      if (!el.dataset.gtcHijacked) {
        el.dataset.gtcHijacked = '1';
        el.addEventListener('click', (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
          buildDialog();
        }, true);
      }
      return true;
    }
    if (document.getElementById('gtc-creator-button')) return true;
    const toolbar = document.getElementById('mochaToolbar');
    if (!toolbar) return false;
    const a = document.createElement('a');
    a.id = 'gtc-creator-button';
    a.style.cursor = 'pointer';
    const img = document.createElement('img');
    img.className = 'mochaToolButton';
    img.title = 'Créer un torrent';
    img.alt = 'Créer un torrent';
    img.width = 24;
    img.height = 24;
    img.src = ICON_DATAURI;
    a.appendChild(img);
    a.onclick = buildDialog;
    const ref = document.getElementById('preferencesButton');
    if (ref) ref.before(a); else toolbar.appendChild(a);
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
  // bouton "Créateur de torrent", avec la même structure <a><img class="mochaToolButton">.
  function insertMediaInfoButton() {
    const existing = document.getElementById('gtc-mediainfo-button');
    if (!getMediaInfoApi()) { if (existing) existing.remove(); return true; }
    if (existing) return true;
    const anchor = creatorAnchor();
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
    const anchor = document.getElementById('gtc-mediainfo-button') || creatorAnchor();
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

  // Icône « maillon de chaîne » en rond violet, pour le bouton Lien de partage DSM
  const SHARE_ICON_DATAURI = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
    '<circle cx="12" cy="12" r="10" fill="#8e5cd9"/>' +
    '<path d="M10.6 13.4a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>' +
    '<path d="M13.4 10.6a2.6 2.6 0 0 0-3.7 0l-2.2 2.2a2.6 2.6 0 0 0 3.7 3.7l.8-.8" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/></svg>'
  );

  function insertShareButton() {
    const existing = document.getElementById('gtc-share-button');
    if (!getDsmUrl()) { if (existing) existing.remove(); return true; }
    if (existing) return true;
    const anchor = document.getElementById('gtc-resetfilters-button') || document.getElementById('gtc-trackereditor-button');
    if (!anchor) return false;
    const a = document.createElement('a');
    a.id = 'gtc-share-button';
    a.style.cursor = 'pointer';
    const img = document.createElement('img');
    img.className = 'mochaToolButton';
    img.title = 'Créer un lien de partage DSM';
    img.alt = 'Lien de partage DSM';
    img.width = 24;
    img.height = 24;
    img.src = SHARE_ICON_DATAURI;
    a.appendChild(img);
    a.onclick = async () => {
      const row = document.querySelector('tr.selected[data-row-id]');
      const hash = row ? row.getAttribute('data-row-id') : null;
      if (hash) {
        try {
          const list = await (await apiFetch('torrents/info?hashes=' + hash)).json();
          if (list && list[0]) { openShareDialog(list[0]); return; }
        } catch (e) { /* repli sur le sélecteur ci-dessous */ }
      }
      openTorrentPicker('Lien de partage — choisir un torrent', t => openShareDialog(t));
    };
    anchor.after(a);
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
    const shareAdded = insertShareButton();
    if (hijacked && mediaInfoAdded && trackerEditorAdded && resetFiltersAdded && shareAdded) return;
    // La barre d'outils n'est pas encore prête (chargement JS de qBittorrent en cours) : on
    // réessaie brièvement, et seulement si aucun point d'ancrage n'apparaît jamais (ni bouton
    // natif, ni barre d'outils) on bascule sur le bouton flottant de secours (pour le créateur
    // de torrent uniquement — les autres boutons ont besoin d'un ancrage et n'ont pas de repli).
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const a = hijackTorrentCreatorButton();
      const b = insertMediaInfoButton();
      const c = insertTrackerEditorButton();
      const d = insertResetFiltersButton();
      const e = insertShareButton();
      if ((a && b && c && d && e) || tries > 20) {
        clearInterval(iv);
        if (!creatorAnchor()) addFloatingFallback();
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
      <div style="${panelStyle('480px')}max-height:90vh;overflow:auto;box-sizing:border-box;">
        <h3 style="margin-top:0;">Réglages</h3>

        <label>URL du sidecar MediaInfo <span style="color:${C.muted};">(vide = bouton MediaInfo masqué)</span></label>
        <div style="display:flex;gap:6px;margin:4px 0 4px;">
          <input id="gtc-set-mi" style="${inputStyle('flex:1;box-sizing:border-box;')}" placeholder="http://192.168.1.10:8765" autocomplete="off">
          <button id="gtc-set-mi-test" type="button" style="${btnStyle()}">Tester</button>
        </div>
        <div id="gtc-set-mi-status" style="min-height:16px;font-size:12px;color:${C.muted};margin-bottom:10px;"></div>

        <label>Dossier de départ du créateur <span style="color:${C.muted};">(chemin vu par qBittorrent)</span></label>
        <input id="gtc-set-path" style="${inputStyle('width:100%;box-sizing:border-box;margin:4px 0 10px;')}" placeholder="/media/downloads" autocomplete="off">

        <label>Taille des pièces par défaut</label>
        <select id="gtc-set-piece" style="${inputStyle('width:100%;margin:4px 0 10px;')}">${pieceSizeOptions(s.pieceSize)}</select>

        <label>Format par défaut</label>
        <select id="gtc-set-format" style="${inputStyle('width:100%;margin:4px 0 10px;')}">${formatOptions(s.format)}</select>

        <label><input type="checkbox" id="gtc-set-private"${s.private ? ' checked' : ''}> Torrent privé par défaut</label><br>
        <label><input type="checkbox" id="gtc-set-seed"${s.startSeeding ? ' checked' : ''}> Démarrer le seed par défaut</label><br>
        <label><input type="checkbox" id="gtc-set-queue"${s.hideQueueingButtons ? ' checked' : ''}> Masquer les flèches de file d'attente dans la barre d'outils</label>

        <h4 style="margin:16px 0 6px;border-top:1px solid ${C.border};padding-top:12px;">Liens de partage Synology DSM <span style="color:${C.muted};font-weight:normal;">(optionnel)</span></h4>
        <label>Adresse de DSM <span style="color:${C.muted};">(vide = bouton masqué)</span></label>
        <input id="gtc-set-dsm-url" style="${inputStyle('width:100%;box-sizing:border-box;margin:4px 0 10px;')}" placeholder="https://nas.exemple.fr ou http://192.168.1.10:5000" autocomplete="off">
        <div style="display:flex;gap:6px;margin-bottom:4px;">
          <input id="gtc-set-dsm-user" style="${inputStyle('flex:1;box-sizing:border-box;')}" placeholder="Compte DSM (dédié, sans 2FA)" autocomplete="off">
          <input id="gtc-set-dsm-pass" type="password" style="${inputStyle('flex:1;box-sizing:border-box;')}" placeholder="Mot de passe" autocomplete="new-password">
          <button id="gtc-set-dsm-test" type="button" style="${btnStyle()}">Tester</button>
        </div>
        <div id="gtc-set-dsm-status" style="min-height:16px;font-size:12px;color:${C.muted};margin-bottom:10px;"></div>
        <label>Adresse publique des liens <span style="color:${C.muted};">(vide = celle choisie par DSM)</span></label>
        <input id="gtc-set-dsm-pub" style="${inputStyle('width:100%;box-sizing:border-box;margin:4px 0 10px;')}" placeholder="https://nas.exemple.fr" autocomplete="off">
        <label>Correspondance des chemins <span style="color:${C.muted};">(qBittorrent => File Station, une par ligne)</span></label>
        <textarea id="gtc-set-dsm-map" spellcheck="false" style="${inputStyle('width:100%;box-sizing:border-box;height:60px;margin:4px 0 10px;font-family:monospace;font-size:12px;')}" placeholder="/media => /video&#10;/downloads => /usbshare/downloads"></textarea>
        <label>Expiration par défaut des liens <span style="color:${C.muted};">(jours, vide = jamais)</span></label>
        <input id="gtc-set-dsm-exp" type="number" min="1" style="${inputStyle('width:100px;box-sizing:border-box;margin:4px 0 4px;display:block;')}">

        <div id="gtc-set-error" style="color:#e57373;min-height:16px;margin-top:10px;"></div>
        <div style="text-align:right;margin-top:6px;">
          <button id="gtc-set-cancel" style="${btnStyle()}">Annuler</button>
          <button id="gtc-set-save" style="${btnStyle()}">Enregistrer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const miInput = overlay.querySelector('#gtc-set-mi');
    miInput.value = s.mediainfoApi || ''; // via .value : pas d'injection dans le HTML
    const pathInput = overlay.querySelector('#gtc-set-path');
    pathInput.value = s.defaultPath || '';
    const dsmUrlInput = overlay.querySelector('#gtc-set-dsm-url');
    const dsmUserInput = overlay.querySelector('#gtc-set-dsm-user');
    const dsmPassInput = overlay.querySelector('#gtc-set-dsm-pass');
    const dsmMapInput = overlay.querySelector('#gtc-set-dsm-map');
    const dsmPubInput = overlay.querySelector('#gtc-set-dsm-pub');
    dsmPubInput.value = s.dsmPublicUrl || '';
    const dsmExpInput = overlay.querySelector('#gtc-set-dsm-exp');
    dsmUrlInput.value = s.dsmUrl || '';
    dsmUserInput.value = s.dsmUser || '';
    dsmPassInput.value = s.dsmPass || '';
    dsmMapInput.value = s.dsmPathMap || '';
    dsmExpInput.value = s.dsmExpireDays || '';
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

    // Test DSM : connexion avec les valeurs saisies (pas encore enregistrées), puis on remet la
    // session à zéro pour que les vrais réglages soient utilisés ensuite.
    const dsmStatus = overlay.querySelector('#gtc-set-dsm-status');
    overlay.querySelector('#gtc-set-dsm-test').onclick = async () => {
      const url = dsmUrlInput.value.trim().replace(/\/+$/, '');
      const err = url ? validateHttpUrl(url) : 'Renseigne l\'adresse de DSM';
      if (err) { dsmStatus.textContent = err; dsmStatus.style.color = '#e57373'; return; }
      dsmStatus.textContent = 'Connexion…'; dsmStatus.style.color = C.muted;
      const saved = getSettings();
      setSettings({ ...saved, dsmUrl: url, dsmUser: dsmUserInput.value.trim(), dsmPass: dsmPassInput.value });
      dsmReset();
      try {
        await dsmLogin();
        dsmStatus.textContent = 'Connexion DSM réussie ✔';
        dsmStatus.style.color = '#81c995';
      } catch (e) {
        dsmStatus.textContent = e.message;
        dsmStatus.style.color = '#e57373';
      } finally {
        setSettings(saved);
        dsmReset();
      }
    };

    overlay.querySelector('#gtc-set-save').onclick = () => {
      const mediainfoApi = miInput.value.trim().replace(/\/+$/, '');
      const err = validateHttpUrl(mediainfoApi);
      if (err) { overlay.querySelector('#gtc-set-error').textContent = err; return; }
      const piece = overlay.querySelector('#gtc-set-piece').value;
      const defaultPath = pathInput.value.trim();
      if (defaultPath && !defaultPath.startsWith('/')) {
        overlay.querySelector('#gtc-set-error').textContent = 'Le dossier de départ doit être un chemin absolu (commence par /)';
        return;
      }
      // Nouveau dossier de départ : il remplace aussi le dernier chemin mémorisé, pour prendre
      // effet dès la prochaine ouverture du créateur.
      if (defaultPath !== (s.defaultPath || '')) setDefaultPath(defaultPath);
      const dsmUrl = dsmUrlInput.value.trim().replace(/\/+$/, '');
      const dsmErr = validateHttpUrl(dsmUrl);
      if (dsmErr) { overlay.querySelector('#gtc-set-error').textContent = 'DSM : ' + dsmErr; return; }
      const dsmPublicUrl = dsmPubInput.value.trim().replace(/\/+$/, '');
      const pubErr = validateHttpUrl(dsmPublicUrl);
      if (pubErr) { overlay.querySelector('#gtc-set-error').textContent = 'Adresse publique : ' + pubErr; return; }
      const dsmPathMap = dsmMapInput.value.trim();
      const badLine = dsmPathMap.split('\n').map(l => l.trim())
        .find(l => l && !l.startsWith('#') && !parsePathMap(l).length);
      if (badLine) {
        overlay.querySelector('#gtc-set-error').textContent = 'Règle de chemin invalide : « ' + badLine + ' » (format : /chemin/qbit => /dossier-partagé/…)';
        return;
      }
      const expDays = parseInt(dsmExpInput.value, 10);
      setSettings({
        mediainfoApi,
        defaultPath,
        pieceSize: piece === '' ? '' : Number(piece),
        format: overlay.querySelector('#gtc-set-format').value,
        private: overlay.querySelector('#gtc-set-private').checked,
        startSeeding: overlay.querySelector('#gtc-set-seed').checked,
        hideQueueingButtons: overlay.querySelector('#gtc-set-queue').checked,
        dsmUrl,
        dsmUser: dsmUserInput.value.trim(),
        dsmPass: dsmPassInput.value,
        dsmPublicUrl,
        dsmPathMap,
        dsmExpireDays: expDays > 0 ? expDays : '',
      });
      dsmReset();
      applyQueueingStyle();
      insertMediaInfoButton();   // ajoute ou retire le bouton selon l'URL
      insertTrackerEditorButton();
      insertShareButton();
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
