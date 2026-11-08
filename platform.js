'use strict';
// Веб-платформа QuickRead: открытие файлов в браузере, хранение, буфер обмена, установка на главный экран
(() => {
  const LIBS = {
    pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  };
  const loaded = {};
  function script(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('нет интернета для загрузки модуля чтения')); document.head.append(s); });
    return loaded[src];
  }

  // ---------- извлечение текста ----------
  function decode(buf) {
    const u = new Uint8Array(buf);
    if (u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf) return new TextDecoder('utf-8').decode(u.subarray(3));
    if (u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u.subarray(2));
    if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u.subarray(2));
    const head = new TextDecoder('latin1').decode(u.subarray(0, 1024));
    const m = /encoding=["']([\w-]+)["']/i.exec(head) || /charset=["']?([\w-]+)/i.exec(head);
    if (m) {
      try { return new TextDecoder(m[1].toLowerCase()).decode(u); } catch (_) { m[1] = ''; } // неизвестная кодировка — пробуем дальше
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (_) { return new TextDecoder('windows-1251').decode(u); }
  }
  function htmlToText(html) {
    const s = html
      .replace(/<binary\b[\s\S]*?<\/binary>/gi, '').replace(/<description\b[\s\S]*?<\/description>/gi, '')
      .replace(/<(script|style|head|svg)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|title|subtitle|v|stanza|blockquote|article)>/gi, '\n\n')
      .replace(/<empty-line\s*\/>/gi, '\n\n').replace(/<\/(td|th)>/gi, ' ').replace(/<[^>]+>/g, '');
    const t = document.createElement('textarea');
    return s.replace(/&[#\w]+;/g, (e) => { t.innerHTML = e; return t.value; });
  }
  async function fromPdf(buf) {
    await script(LIBS.pdf);
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      let line = ''; const lines = [];
      for (const it of c.items) { if (typeof it.str !== 'string') continue; line += it.str; if (it.hasEOL) { lines.push(line); line = ''; } }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
    }
    return pages.join('\n').replace(/(\p{L})[-\u00ad]\s*\n\s*(\p{Ll})/gu, '$1$2');
  }
  async function fromEpub(buf) {
    await script(LIBS.jszip);
    const zip = await window.JSZip.loadAsync(buf);
    const container = await zip.file('META-INF/container.xml').async('string');
    const opfPath = /full-path=["']([^"']+)["']/i.exec(container)[1];
    const opf = await zip.file(opfPath).async('string');
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const man = {};
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const id = (/\bid=["']([^"']+)["']/i.exec(m[0]) || [])[1], href = (/\bhref=["']([^"']+)["']/i.exec(m[0]) || [])[1];
      if (id && href) man[id] = href;
    }
    const parts = [];
    for (const m of opf.matchAll(/<itemref\b[^>]*\bidref=["']([^"']+)["']/gi)) {
      const href = man[m[1]]; if (!href) continue;
      const parts2 = (base + href.split('#')[0]).split('/'); const norm = [];
      for (const p of parts2) { if (p === '..') norm.pop(); else if (p && p !== '.') norm.push(p); }
      const f = zip.file(norm.join('/')) || zip.file(decodeURIComponent(norm.join('/')));
      if (f) parts.push(htmlToText(await f.async('string')));
    }
    return parts.join('\n\n');
  }
  function normalize(t) {
    return t.replace(/\r\n?/g, '\n').replace(/[\u00a0\t ]+/g, ' ').replace(/ {0,}\n {0,}/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  async function extract(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const buf = await file.arrayBuffer();
    let text;
    if (ext === 'pdf') text = await fromPdf(buf);
    else if (ext === 'docx') { await script(LIBS.mammoth); text = (await window.mammoth.extractRawText({ arrayBuffer: buf })).value; }
    else if (ext === 'epub') text = await fromEpub(buf);
    else if (['fb2', 'html', 'htm', 'xhtml'].includes(ext)) text = htmlToText(decode(buf));
    else if (['doc', 'rtf', 'pages'].includes(ext)) throw new Error('этот формат не поддерживается — сохраните файл как .docx, .txt или .pdf');
    else {
      if (new Uint8Array(buf.slice(0, 8000)).includes(0)) throw new Error('файл не похож на текстовый');
      text = decode(buf);
    }
    text = normalize(text);
    if (!text) throw new Error(ext === 'pdf' ? 'в PDF нет текстового слоя (похоже на скан)' : 'в файле не найден текст');
    return text;
  }

  // ---------- хранение последнего текста (IndexedDB: книги бывают больше 5 МБ) ----------
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('quickread', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kv(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => { const tx = db.transaction('kv', mode); const req = fn(tx.objectStore('kv')); tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error); });
  }

  // ---------- мост для читалки ----------
  const cbs = { load: [], command: [], error: [] };
  const emit = (k, v) => cbs[k].forEach((f) => f(v));
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.text,.md,.markdown,.pdf,.docx,.epub,.fb2,.html,.htm,.xhtml,.csv,.log,text/plain,application/pdf,application/epub+zip';
  input.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.append(input));
  async function openFile(file) {
    if (!file) return;
    emit('error', `Открываю «${file.name}»…`);
    try { emit('load', { name: file.name, text: await extract(file), autoplay: false }); }
    catch (e) { emit('error', `Не удалось открыть «${file.name}»: ${e.message}`); }
  }
  input.addEventListener('change', () => { openFile(input.files[0]); input.value = ''; });

  window.qr = {
    openDialog: async () => input.click(),
    openFile,
    openPath: async () => {},
    pathForFile: () => '',
    readClipboard: async () => {
      try { return await navigator.clipboard.readText(); }
      catch (_) { emit('error', 'Браузер не дал прочитать буфер. Вставьте текст в редактор (⌘E или кнопка с полосками).'); return ''; }
    },
    getLast: async () => { try { return (await kv('readonly', (s) => s.get('last'))) || ''; } catch (_) { return ''; } },
    saveText: async (t) => { try { await kv('readwrite', (s) => s.put(t, 'last')); } catch (_) { return null; } }, // приватный режим
    info: async () => ({ hotkey: '', hotkeyOk: true }),
    ready: () => {},
    onLoad: (f) => cbs.load.push(f),
    onCommand: (f) => cbs.command.push(f),
    onError: (f) => cbs.error.push(f),
  };

  // клавиши, которые в приложении были в меню
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const map = { o: 'open', e: 'editor', '=': 'font+', '+': 'font+', '-': 'font-', ',': 'settings' };
    if (e.shiftKey && (k === 'v' || e.code === 'KeyV')) { e.preventDefault(); emit('command', 'clipboard'); return; }
    if (e.shiftKey) return;
    if (map[k]) { e.preventDefault(); emit('command', map[k]); }
  });

  // ---------- установка на главный экран ----------
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('touch', matchMedia('(pointer: coarse)').matches);
  document.documentElement.classList.toggle('standalone', standalone);
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; const b = document.getElementById('installBtn'); if (b) b.hidden = false; });
  function dismissed() { try { return localStorage.getItem('qr.installHidden') === '1'; } catch (_) { return false; } }
  function showGuide(force) {
    const g = document.getElementById('installGuide');
    if (!g || standalone || (!force && dismissed())) return;
    const safari = isIOS && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|YaBrowser/.test(navigator.userAgent);
    document.getElementById('installNote').textContent = safari ? '' : 'Если пункта нет — откройте эту страницу в Safari.';
    g.hidden = false;
  }
  document.addEventListener('DOMContentLoaded', () => {
    const g = document.getElementById('installGuide');
    g.querySelector('.ig-close').addEventListener('click', () => { g.hidden = true; try { localStorage.setItem('qr.installHidden', '1'); } catch (_) {} });
    g.addEventListener('click', (e) => { if (e.target === g) g.hidden = true; });
    document.getElementById('installBtn').addEventListener('click', async () => {
      if (deferred) { deferred.prompt(); deferred = null; document.getElementById('installBtn').hidden = true; } else showGuide(true);
    });
    if (isIOS && !standalone) { document.getElementById('installBtn').hidden = false; setTimeout(() => showGuide(false), 900); }
  });

  // работа без интернета
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
