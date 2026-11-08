'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;

  // В приложении API даёт preload.js; заглушка — чтобы страница работала и в обычном браузере
  const api = window.qr || {
    openDialog: async () => {}, openPath: async () => {}, pathForFile: () => '',
    readClipboard: async () => (navigator.clipboard ? navigator.clipboard.readText() : ''),
    getLast: async () => '', saveText: async () => {},
    info: async () => ({ hotkey: '⌃⌘R', hotkeyOk: true }),
    ready: () => {}, onLoad: () => {}, onCommand: () => {}, onError: () => {},
  };

  const el = {
    docName: $('docName'), stage: $('stage'), empty: $('empty'), rsvp: $('rsvp'),
    word: $('word'), wl: $('wl'), wp: $('wp'), wr: $('wr'), context: $('context'),
    progress: $('progress'), pos: $('pos'), dot1: $('dot1'), left: $('left'),
    play: $('btnPlay'), wpmVal: $('wpmVal'), chunkSeg: $('chunkSeg'),
    editor: $('editor'), textarea: $('textarea'), edCount: $('edCount'),
    settings: $('settings'), btnSettings: $('btnSettings'), btnText: $('btnText'),
    wpmRange: $('wpmRange'), wpmRangeVal: $('wpmRangeVal'), fontRange: $('fontRange'), fontVal: $('fontVal'),
    fontSeg: $('fontSeg'), themeSeg: $('themeSeg'), smart: $('smartToggle'), ctx: $('contextToggle'),
    toast: $('toast'),
  };

  // ---------- настройки ----------
  const DEFAULTS = { wpm: 350, chunk: 1, fontSize: 64, font: 'sans', theme: 'auto', smart: true, context: true };
  const S = (() => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('qr.settings') || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); }
  })();
  const saveSettings = () => { try { localStorage.setItem('qr.settings', JSON.stringify(S)); } catch (_) {} };

  // ---------- состояние ----------
  let text = '';
  let words = [];
  let starts = [];
  let paraEnds = new Set();
  let index = 0;
  let playing = false;
  let timer = null;
  let warmup = 0;
  let sinceSave = 0;

  // ---------- текст ----------
  function tokenize(t) {
    const w = []; const st = []; const pe = new Set();
    const re = /\S+/g;
    let m; let prevEnd = 0;
    while ((m = re.exec(t))) {
      if (w.length && /\n[^\S\n]*\n/.test(t.slice(prevEnd, m.index))) pe.add(w.length - 1);
      w.push(m[0]); st.push(m.index);
      prevEnd = m.index + m[0].length;
    }
    return { w, st, pe };
  }

  function applyText(t) {
    text = t;
    const tk = tokenize(t);
    words = tk.w; starts = tk.st; paraEnds = tk.pe;
    index = 0;
  }

  function loadText(t, name, opts = {}) {
    pause(false);
    applyText(t || '');
    if (el.textarea.value !== text) el.textarea.value = text;
    setDocName(name || '');
    api.saveText(text);
    savePos();
    updateCount();
    if (opts.hideEditor || opts.autoplay) closeEditor();
    render();
    if (opts.autoplay && words.length) play();
  }

  function syncFromEditor() {
    if (el.textarea.value === text) return false;
    applyText(el.textarea.value);
    setDocName(text ? 'Свой текст' : '');
    api.saveText(text);
    return true;
  }

  function setDocName(n) {
    el.docName.textContent = n;
    try { localStorage.setItem('qr.name', n); } catch (_) {}
  }

  function savePos() {
    sinceSave = 0;
    try { localStorage.setItem('qr.pos', JSON.stringify({ len: text.length, head: text.slice(0, 80), index })); } catch (_) {}
  }

  function restorePos() {
    try {
      const p = JSON.parse(localStorage.getItem('qr.pos') || 'null');
      if (p && p.len === text.length && p.head === text.slice(0, 80)) index = Math.min(Math.max(0, p.index | 0), Math.max(0, words.length - 1));
    } catch (_) {}
  }

  // ---------- опорная буква ----------
  const LETTER = /[\p{L}\p{N}]/u;
  function splitORP(s, multi) {
    const chars = Array.from(s);
    if (!chars.length) return ['', '', ''];
    const letters = [];
    for (let i = 0; i < chars.length; i++) if (LETTER.test(chars[i])) letters.push(i);
    if (!letters.length) return ['', chars[0], chars.slice(1).join('')];
    const n = letters.length;
    let k;
    if (multi) k = Math.floor(n * 0.35);
    else if (n <= 1) k = 0;
    else if (n <= 5) k = 1;
    else if (n <= 9) k = 2;
    else if (n <= 13) k = 3;
    else k = 4;
    const p = letters[Math.min(k, n - 1)];
    return [chars.slice(0, p).join(''), chars[p], chars.slice(p + 1).join('')];
  }

  // ---------- паузы ----------
  const lastSig = (w) => { const s = w.replace(/["'»”’)\]}]+$/u, ''); return s ? s[s.length - 1] : ''; };

  function pauseFactor(from, to) {
    let f = 1;
    for (let i = from; i < to; i++) {
      const w = words[i];
      if (paraEnds.has(i)) f = Math.max(f, 2.6);
      const c = lastSig(w);
      if ('.!?…'.includes(c) && c) f = Math.max(f, 2.1);
      else if (',;:'.includes(c) && c) f = Math.max(f, 1.5);
      else if (w.length === 1 && '—–-'.includes(w)) f = Math.max(f, 1.4);
      if (w.length >= 9) f = Math.max(f, 1 + Math.min(w.length - 8, 8) * 0.06);
    }
    return f;
  }

  // ---------- отрисовка ----------
  const fmtNum = (n) => n.toLocaleString('ru-RU');
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function fmtLeft(wordsLeft) {
    const mins = wordsLeft / S.wpm * (S.smart ? 1.15 : 1);
    if (mins < 1) return 'меньше минуты';
    const m = Math.round(mins);
    if (m < 60) return `≈ ${m} мин`;
    return `≈ ${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
  }

  function renderWord() {
    const end = Math.min(index + S.chunk, words.length);
    const [l, p, r] = splitORP(words.slice(index, end).join(' '), S.chunk > 1);
    el.wl.textContent = l; el.wp.textContent = p; el.wr.textContent = r;
    // Длинное слово не влезает — уменьшаем шрифт только для него
    el.word.style.fontSize = '';
    const over = Math.max(
      el.wl.scrollWidth / Math.max(1, el.wl.clientWidth),
      el.wr.scrollWidth / Math.max(1, el.wr.clientWidth),
    );
    if (over > 1.001) el.word.style.fontSize = `${Math.floor(S.fontSize / over * 0.96)}px`;
  }

  function render() {
    const has = words.length > 0;
    el.empty.hidden = has;
    el.rsvp.hidden = !has;
    if (has) renderWord();

    const max = Math.max(0, words.length - 1);
    el.progress.max = String(max);
    el.progress.value = String(index);
    const pct = max ? index / max * 100 : 0;
    el.progress.style.setProperty('--p', `${pct}%`);

    if (has) {
      el.pos.textContent = `${fmtNum(index + 1)} из ${fmtNum(words.length)} · ${Math.round(pct)}%`;
      el.left.textContent = `осталось ${fmtLeft(words.length - index)}`;
      el.dot1.hidden = false;
    } else {
      el.pos.textContent = ''; el.left.textContent = ''; el.dot1.hidden = true;
    }
    renderContext();
  }

  function renderContext() {
    const box = el.context;
    if (playing || !S.context || !words.length || !el.editor.hidden) {
      box.classList.remove('show');
      return;
    }
    box.textContent = '';
    const from = Math.max(0, index - 28);
    const to = Math.min(words.length, index + S.chunk + 28);
    const frag = document.createDocumentFragment();
    if (from > 0) frag.append('… ');
    for (let i = from; i < to; i++) {
      const s = document.createElement('span');
      s.textContent = words[i];
      s.dataset.i = String(i);
      if (i >= index && i < index + S.chunk) s.className = 'cur';
      frag.append(s, ' ');
      if (paraEnds.has(i) && i < to - 1) frag.append(document.createElement('br'));
    }
    if (to < words.length) frag.append('…');
    box.append(frag);
    box.classList.add('show');
  }

  // ---------- воспроизведение ----------
  function schedule() {
    clearTimeout(timer);
    if (!playing || index >= words.length) return;
    const end = Math.min(index + S.chunk, words.length);
    let ms = 60000 / S.wpm * (end - index);
    if (S.smart) ms *= pauseFactor(index, end);
    if (warmup > 0) { ms *= 1 + 0.25 * warmup; warmup--; }
    timer = setTimeout(advance, ms);
  }

  function advance() {
    const next = index + S.chunk;
    if (next >= words.length) {
      pause();
      toast('Дочитано до конца');
      return;
    }
    index = next;
    render();
    if (++sinceSave >= 25) savePos();
    schedule();
  }

  function play() {
    syncFromEditor();
    if (!words.length) {
      openEditor();
      toast('Вставьте текст или откройте файл');
      return;
    }
    if (index + S.chunk >= words.length) index = 0;
    if (!el.editor.hidden) closeEditor();
    closeSettings();
    if (document.activeElement && document.activeElement !== body) document.activeElement.blur();
    playing = true;
    body.classList.add('playing');
    warmup = 4;
    render();
    schedule();
  }

  function pause(doRender = true) {
    const was = playing;
    playing = false;
    clearTimeout(timer);
    body.classList.remove('playing');
    if (was) savePos();
    if (doRender) render();
  }

  const toggle = () => (playing ? pause() : play());

  function moved() {
    render();
    if (playing) { warmup = 2; schedule(); } else savePos();
  }

  function step(d) {
    syncFromEditor();
    if (!words.length) return;
    index = Math.max(0, Math.min(words.length - 1, index + d));
    moved();
  }

  function seek(i) {
    if (!words.length) return;
    index = Math.max(0, Math.min(words.length - 1, i | 0));
    moved();
  }

  function restart() {
    syncFromEditor();
    index = 0;
    moved();
  }

  function jumpSentence(dir) {
    syncFromEditor();
    if (!words.length) return;
    const ends = (i) => paraEnds.has(i) || '.!?…'.includes(lastSig(words[i]) || 'x');
    const start = (i) => { let s = i; while (s > 0 && !ends(s - 1)) s--; return s; };
    if (dir < 0) {
      index = start(Math.max(index - 1, 0));
    } else {
      let j = index + 1;
      while (j < words.length && !ends(j - 1)) j++;
      index = Math.min(j, words.length - 1);
    }
    moved();
  }

  function setWpm(v) {
    S.wpm = Math.max(100, Math.min(1500, Math.round(v / 5) * 5));
    saveSettings();
    syncControls();
    render();
    if (playing) schedule();
  }

  function setChunk(n) {
    S.chunk = n;
    saveSettings();
    syncControls();
    render();
  }

  function setFont(px) {
    S.fontSize = Math.max(28, Math.min(150, px));
    saveSettings();
    syncControls();
    render();
  }

  // ---------- редактор ----------
  function wordIndexAt(pos) {
    if (!starts.length) return 0;
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function openEditor() {
    pause();
    el.editor.hidden = false;
    body.classList.add('editing');
    el.btnText.classList.add('on');
    updateCount();
    el.textarea.focus();
    if (words.length && el.textarea.value === text) {
      const p = starts[index] || 0;
      el.textarea.setSelectionRange(p, p + (words[index] || '').length);
      // прокручиваем к текущему слову
      const lineH = 15 * 1.65;
      const before = text.slice(0, p);
      const approxLines = before.length / Math.max(30, el.textarea.clientWidth / 8) + (before.match(/\n/g) || []).length * 0.5;
      el.textarea.scrollTop = Math.max(0, approxLines * lineH - el.textarea.clientHeight / 3);
    }
    render();
  }

  function closeEditor() {
    if (el.editor.hidden) return;
    el.editor.hidden = true;
    body.classList.remove('editing');
    el.btnText.classList.remove('on');
    el.textarea.blur();
    render();
  }

  const toggleEditor = () => (el.editor.hidden ? openEditor() : closeEditor());

  function readFromCursor() {
    const pos = el.textarea.selectionStart || 0;
    syncFromEditor();
    savePos();
    index = wordIndexAt(pos);
    if (index >= words.length - 1 && pos === el.textarea.value.length) index = 0;
    play();
  }

  let countTimer = null;
  function updateCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const v = el.textarea.value;
      const n = v === text ? words.length : (v.match(/\S+/g) || []).length;
      el.edCount.textContent = n ? `${fmtNum(n)} ${plural(n, 'слово', 'слова', 'слов')}` : '';
    }, 150);
  }

  // ---------- настройки (поповер) ----------
  function syncControls() {
    root.style.setProperty('--fs', `${S.fontSize}px`);
    root.dataset.font = S.font;
    if (S.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = S.theme;
    el.wpmVal.textContent = S.wpm;
    el.wpmRange.value = S.wpm;
    el.wpmRangeVal.textContent = `${S.wpm} слов/мин`;
    el.fontRange.value = S.fontSize;
    el.fontVal.textContent = `${S.fontSize} px`;
    el.smart.checked = S.smart;
    el.ctx.checked = S.context;
    for (const b of el.chunkSeg.children) b.classList.toggle('on', Number(b.dataset.chunk) === S.chunk);
    for (const b of el.fontSeg.children) b.classList.toggle('on', b.dataset.font === S.font);
    for (const b of el.themeSeg.children) b.classList.toggle('on', b.dataset.themeOpt === S.theme);
  }

  function openSettings() { el.settings.hidden = false; el.btnSettings.classList.add('on'); }
  function closeSettings() { el.settings.hidden = true; el.btnSettings.classList.remove('on'); }
  const toggleSettings = () => (el.settings.hidden ? openSettings() : closeSettings());

  // ---------- действия ----------
  async function readClipboard() {
    const t = await api.readClipboard();
    if (t && t.trim()) loadText(t, 'Буфер обмена', { autoplay: true });
    else toast('В буфере обмена нет текста');
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  function command(c) {
    switch (c) {
      case 'open': api.openDialog(); break;
      case 'clipboard': readClipboard(); break;
      case 'toggle': toggle(); break;
      case 'restart': restart(); break;
      case 'back': step(-S.chunk); break;
      case 'fwd': step(S.chunk); break;
      case 'prevSentence': jumpSentence(-1); break;
      case 'nextSentence': jumpSentence(1); break;
      case 'faster': setWpm(S.wpm + 25); break;
      case 'slower': setWpm(S.wpm - 25); break;
      case 'editor': toggleEditor(); break;
      case 'settings': toggleSettings(); break;
      case 'font+': setFont(S.fontSize + 6); break;
      case 'font-': setFont(S.fontSize - 6); break;
      default: break;
    }
  }

  // ---------- события ----------
  // Кнопки не забирают фокус — чтобы пробел всегда управлял чтением
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });

  $('btnOpen').addEventListener('click', () => api.openDialog());
  $('btnClip').addEventListener('click', readClipboard);
  el.btnText.addEventListener('click', toggleEditor);
  el.btnSettings.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
  el.play.addEventListener('click', toggle);
  $('btnBack').addEventListener('click', () => step(-S.chunk));
  $('btnFwd').addEventListener('click', () => step(S.chunk));
  $('btnPrevS').addEventListener('click', () => jumpSentence(-1));
  $('btnNextS').addEventListener('click', () => jumpSentence(1));
  $('slower').addEventListener('click', () => setWpm(S.wpm - 25));
  $('faster').addEventListener('click', () => setWpm(S.wpm + 25));
  el.chunkSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setChunk(Number(b.dataset.chunk)); });

  for (const b of el.empty.querySelectorAll('[data-act]')) {
    b.addEventListener('click', (e) => { e.stopPropagation(); command(b.dataset.act); });
  }

  $('edClear').addEventListener('click', () => { loadText('', ''); el.textarea.focus(); });
  $('edStart').addEventListener('click', () => { syncFromEditor(); index = 0; play(); });
  $('edCursor').addEventListener('click', readFromCursor);
  el.textarea.addEventListener('input', updateCount);

  el.progress.addEventListener('input', () => seek(Number(el.progress.value)));
  el.progress.addEventListener('change', () => el.progress.blur());

  el.wpmRange.addEventListener('input', () => setWpm(Number(el.wpmRange.value)));
  el.fontRange.addEventListener('input', () => setFont(Number(el.fontRange.value)));
  for (const r of [el.wpmRange, el.fontRange]) r.addEventListener('change', () => r.blur());
  el.fontSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.font = b.dataset.font; saveSettings(); syncControls(); render(); } });
  el.themeSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.theme = b.dataset.themeOpt; saveSettings(); syncControls(); } });
  el.smart.addEventListener('change', () => { S.smart = el.smart.checked; saveSettings(); render(); el.smart.blur(); });
  el.ctx.addEventListener('change', () => { S.context = el.ctx.checked; saveSettings(); render(); el.ctx.blur(); });

  el.settings.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!el.settings.hidden) closeSettings(); });

  // клик по слову — старт/пауза; клик по слову в контексте — перейти к нему
  el.stage.addEventListener('click', (e) => {
    const s = e.target.closest('.context span[data-i]');
    if (s) { e.stopPropagation(); seek(Number(s.dataset.i)); return; }
    if (e.target.closest('.empty')) return;
    if (!el.settings.hidden) return;
    if (words.length) toggle();
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t === el.textarea;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (!el.settings.hidden) closeSettings();
      else if (typing) closeEditor();
      else if (playing) pause();
      return;
    }
    if (typing) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); readFromCursor(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.code) {
      case 'Space': toggle(); break;
      case 'ArrowLeft': if (e.shiftKey) jumpSentence(-1); else step(-S.chunk); break;
      case 'ArrowRight': if (e.shiftKey) jumpSentence(1); else step(S.chunk); break;
      case 'ArrowUp': setWpm(S.wpm + 25); break;
      case 'ArrowDown': setWpm(S.wpm - 25); break;
      case 'Home': restart(); break;
      default: return;
    }
    e.preventDefault();
  });

  // перетаскивание файлов и текста
  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!isFileDrag(e)) return;
    dragDepth++;
    body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    body.classList.remove('dragging');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      e.preventDefault();
      if (api.openFile) { api.openFile(files[0]); return; }
      const p = api.pathForFile(files[0]);
      if (p) api.openPath(p); else toast('Не удалось открыть этот файл');
      return;
    }
    if (e.target === el.textarea) return; // текст в редактор вставляется как обычно
    e.preventDefault();
    const t = e.dataTransfer && e.dataTransfer.getData('text/plain');
    if (t && t.trim()) loadText(t, 'Перетащенный текст');
  });

  // при изменении размера окна пересчитываем длинные слова
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (words.length) renderWord(); }, 60); });

  window.addEventListener('beforeunload', savePos);

  api.onLoad((d) => loadText(d.text, d.name, { autoplay: !!d.autoplay, hideEditor: true }));
  api.onCommand(command);
  api.onError((m) => toast(m, 4200));

  // ---------- старт ----------
  (async () => {
    syncControls();
    try {
      const info = await api.info();
      if (info && info.hotkey) for (const k of document.querySelectorAll('.hotkey')) k.textContent = info.hotkey;
      if (info && info.hotkeyOk === false) $('hotkeyInfo').textContent = 'Глобальная клавиша занята другой программой — используйте ⇧⌘V в окне QuickRead.';
    } catch (_) {}
    try {
      const last = await api.getLast();
      if (last) {
        applyText(last);
        el.textarea.value = last;
        restorePos();
        let name = '';
        try { name = localStorage.getItem('qr.name') || ''; } catch (_) {}
        el.docName.textContent = name;
      }
    } catch (_) {}
    render();
    api.ready();
  })();
})();
