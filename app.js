/* =========================================================
   Visor PDF PWA - app.js
   ========================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const state = {
  pdfDoc: null,
  scale: 1.5,
  rotation: 0,
  currentPage: 1,
  totalPages: 0,
  fileName: 'documento.pdf',
  selection: '',
  highlights: [],       // {page, x, y, w, h}
  searchMatches: [],
  searchIndex: -1,
  pages: [],            // {pageNum, container, canvas, textLayer, viewport}
};

/* ---------- Referencias DOM ---------- */
const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const viewerContainer = $('viewerContainer');
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const zoomLevel = $('zoomLevel');
const pageIndicator = $('pageIndicator');
const selectionMenu = $('selectionMenu');
const searchPanel = $('searchPanel');
const searchInput = $('searchInput');
const searchCount = $('searchCount');
const moreMenu = $('moreMenu');
const toast = $('toast');

/* ---------- Utilidades ---------- */
function showToast(msg, ms = 2000) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
}

function updateZoomLabel() {
  zoomLevel.textContent = Math.round(state.scale / 1.5 * 100) + '%';
}

function updatePageIndicator() {
  pageIndicator.textContent = `${state.currentPage} / ${state.totalPages}`;
}

/* =========================================================
   CARGA DE PDF
   ========================================================= */
async function loadPDF(source, name = 'documento.pdf') {
  try {
    let data;
    if (source instanceof ArrayBuffer) {
      data = { data: source };
    } else if (typeof source === 'string') {
      data = { url: source };
    } else if (source instanceof File) {
      data = { data: await source.arrayBuffer() };
      name = source.name.replace(/\.pdf$/i, '');
    }
    state.fileName = name;
    state.pdfDoc = await pdfjsLib.getDocument(data).promise;
    state.totalPages = state.pdfDoc.numPages;
    state.currentPage = 1;
    state.pages = [];
    state.highlights = [];
    state.searchMatches = [];
    state.searchIndex = -1;

    dropZone.classList.add('hidden');
    viewer.innerHTML = '';

    // Renderiza la primera página primero y luego el resto en background
    await renderPage(1);
    for (let i = 2; i <= state.totalPages; i++) {
      renderPage(i);
    }
    updatePageIndicator();
    showToast(`PDF cargado: ${state.totalPages} páginas`);
  } catch (err) {
    console.error(err);
    showToast('Error al cargar PDF');
  }
}

/* =========================================================
   RENDERIZADO DE PÁGINA
   ========================================================= */
async function renderPage(pageNum) {
  const page = await state.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: state.scale, rotation: state.rotation });

  const container = document.createElement('div');
  container.className = 'pdf-page';
  container.dataset.page = pageNum;
  container.style.width = viewport.width + 'px';
  container.style.height = viewport.height + 'px';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = viewport.width * dpr;
  canvas.height = viewport.height * dpr;
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  ctx.scale(dpr, dpr);

  container.appendChild(canvas);

  // Capa de texto
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.style.width = viewport.width + 'px';
  textLayerDiv.style.height = viewport.height + 'px';
  container.appendChild(textLayerDiv);

  // Insertar en orden
  const existing = viewer.querySelector(`[data-page="${pageNum}"]`);
  if (existing) existing.replaceWith(container);
  else {
    const pages = [...viewer.children];
    const next = pages.find(p => +p.dataset.page > pageNum);
    if (next) viewer.insertBefore(container, next);
    else viewer.appendChild(container);
  }

  // Render
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Texto
  const textContent = await page.getTextContent();
  await pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
    textDivs: [],
  }).promise;

  state.pages[pageNum - 1] = {
    pageNum, container, canvas, textLayer: textLayerDiv, viewport
  };

  // Re-aplicar highlights
  applyHighlights(pageNum);
}

/* =========================================================
   ZOOM
   ========================================================= */
async function setScale(newScale) {
  newScale = Math.max(0.25, Math.min(6, newScale));
  state.scale = newScale;
  updateZoomLabel();
  await reRenderAll();
}

async function reRenderAll() {
  if (!state.pdfDoc) return;
  // Guarda el scroll relativo
  const scrollRatio = viewerContainer.scrollTop / viewer.scrollHeight;
  const promises = [];
  for (let i = 1; i <= state.totalPages; i++) {
    promises.push(renderPage(i));
  }
  await Promise.all(promises);
  viewerContainer.scrollTop = scrollRatio * viewer.scrollHeight;
}

/* =========================================================
   ROTACIÓN
   ========================================================= */
async function rotate() {
  state.rotation = (state.rotation + 90) % 360;
  await reRenderAll();
}

/* =========================================================
   NAVEGACIÓN
   ========================================================= */
function scrollToPage(n) {
  if (n < 1 || n > state.totalPages) return;
  state.currentPage = n;
  updatePageIndicator();
  const el = viewer.querySelector(`[data-page="${n}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

viewerContainer.addEventListener('scroll', () => {
  const mid = viewerContainer.scrollTop + viewerContainer.clientHeight / 2;
  let best = 1, bestDist = Infinity;
  for (const p of state.pages) {
    if (!p) continue;
    const top = p.container.offsetTop;
    const bottom = top + p.container.offsetHeight;
    const center = (top + bottom) / 2;
    const d = Math.abs(center - mid);
    if (d < bestDist) { bestDist = d; best = p.pageNum; }
  }
  if (best !== state.currentPage) {
    state.currentPage = best;
    updatePageIndicator();
  }
});

/* =========================================================
   SELECCIÓN DE TEXTO
   ========================================================= */
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  const text = sel.toString().trim();
  state.selection = text;

  if (text && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0) {
      selectionMenu.style.left = Math.max(8, rect.left + rect.width / 2 - 100) + 'px';
      selectionMenu.style.top = Math.max(60, rect.top - 50 + window.scrollY) + 'px';
      selectionMenu.classList.remove('hidden');
    }
  } else {
    selectionMenu.classList.add('hidden');
  }
});

selectionMenu.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  selectionMenu.classList.add('hidden');

  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(state.selection);
      showToast('Texto copiado');
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = state.selection;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Texto copiado');
    }
  } else if (action === 'highlight') {
    highlightSelection();
  } else if (action === 'export-selection') {
    exportSelectionAsPDF();
  }
});

/* =========================================================
   RESALTADO
   ========================================================= */
function highlightSelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const pageEl = range.startContainer.parentElement.closest('.pdf-page');
  if (!pageEl) return;
  const pageNum = +pageEl.dataset.page;
  const pageRect = pageEl.getBoundingClientRect();

  for (const r of rects) {
    const hl = {
      page: pageNum,
      x: r.left - pageRect.left,
      y: r.top - pageRect.top,
      w: r.width,
      h: r.height,
    };
    state.highlights.push(hl);
    drawHighlight(pageEl, hl);
  }
  sel.removeAllRanges();
  showToast('Resaltado añadido');
}

function drawHighlight(pageEl, hl) {
  const div = document.createElement('div');
  div.className = 'highlight';
  div.style.left = hl.x + 'px';
  div.style.top = hl.y + 'px';
  div.style.width = hl.w + 'px';
  div.style.height = hl.h + 'px';
  pageEl.appendChild(div);
}

function applyHighlights(pageNum) {
  const pageEl = viewer.querySelector(`[data-page="${pageNum}"]`);
  if (!pageEl) return;
  pageEl.querySelectorAll('.highlight, .search-match').forEach(el => el.remove());
  state.highlights.filter(h => h.page === pageNum).forEach(h => drawHighlight(pageEl, h));
}

/* =========================================================
   SELECCIÓN DE IMÁGENES
   ========================================================= */
viewer.addEventListener('contextmenu', async (e) => {
  const pageEl = e.target.closest('.pdf-page');
  if (!pageEl) return;
  e.preventDefault();

  // Captura la zona bajo el cursor como imagen
  const canvas = pageEl.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);

  const size = 200;
  const tmp = document.createElement('canvas');
  tmp.width = size; tmp.height = size;
  tmp.getContext('2d').drawImage(
    canvas,
    Math.max(0, x - size / 2), Math.max(0, y - size / 2),
    size, size, 0, 0, size, size
  );

  const dataUrl = tmp.toDataURL('image/png');
  showImageMenu(e.clientX, e.clientY, dataUrl);
});

function showImageMenu(x, y, dataUrl) {
  const old = document.getElementById('imgMenu');
  if (old) old.remove();

  const menu = document.createElement('div');
  menu.id = 'imgMenu';
  menu.style.cssText = `
    position:fixed;left:${x}px;top:${y}px;background:#333;color:#fff;
    border-radius:8px;padding:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);z-index:300;
    display:flex;flex-direction:column;gap:2px;font-size:14px;
  `;
  menu.innerHTML = `
    <button data-a="copy" style="background:none;border:none;color:#fff;padding:8px 14px;text-align:left;cursor:pointer">📋 Copiar imagen</button>
    <button data-a="download" style="background:none;border:none;color:#fff;padding:8px 14px;text-align:left;cursor:pointer">💾 Descargar PNG</button>
    <button data-a="close" style="background:none;border:none;color:#fff;padding:8px 14px;text-align:left;cursor:pointer">✖</button>
  `;
  document.body.appendChild(menu);

  menu.addEventListener('click', async (e) => {
    const a = e.target.dataset.a;
    if (a === 'copy') {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Imagen copiada');
      } catch { showToast('No se pudo copiar imagen'); }
    } else if (a === 'download') {
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `captura-${Date.now()}.png`;
      link.click();
    }
    menu.remove();
  });

  setTimeout(() => {
    document.addEventListener('click', function close(ev) {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 100);
}

/* =========================================================
   BÚSQUEDA
   ========================================================= */
async function searchPDF(query) {
  state.searchMatches = [];
  state.searchIndex = -1;
  if (!query) { searchCount.textContent = '0/0'; return; }

  for (let i = 1; i <= state.totalPages; i++) {
    const page = await state.pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map(it => it.str).join(' ');
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let idx = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      state.searchMatches.push({ page: i, index: idx });
      idx += q.length;
    }
  }

  if (state.searchMatches.length) {
    state.searchIndex = 0;
    gotoMatch(0);
  }
  updateSearchCount();
}

function updateSearchCount() {
  searchCount.textContent =
    state.searchMatches.length ? `${state.searchIndex + 1}/${state.searchMatches.length}` : '0/0';
}

function gotoMatch(i) {
  if (!state.searchMatches.length) return;
  state.searchIndex = (i + state.searchMatches.length) % state.searchMatches.length;
  const m = state.searchMatches[state.searchIndex];
  scrollToPage(m.page);
  updateSearchCount();
}

/* =========================================================
   EXPORTAR PDF
   ========================================================= */
async function exportFullPDF() {
  if (!state.pdfDoc) return showToast('No hay PDF cargado');
  const bytes = await state.pdfDoc.getData();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  downloadBlob(blob, `${state.fileName}.pdf`);
}

async function exportSelectionAsPDF() {
  if (!state.selection) return showToast('Nada seleccionado');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  const lines = doc.splitTextToSize(state.selection, maxWidth);
  let y = margin;
  const lineHeight = 14;

  for (const line of lines) {
    if (y + lineHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(line, margin, y);
    y += lineHeight;
  }
  doc.save(`seleccion-${Date.now()}.pdf`);
  showToast('Selección exportada');
}

async function exportCurrentPageImage() {
  const page = state.pages[state.currentPage - 1];
  if (!page) return;
  const dataUrl = page.canvas.toDataURL('image/png');
  const { jsPDF } = window.jspdf;
  const pdfPage = await state.pdfDoc.getPage(state.currentPage);
  const vp = pdfPage.getViewport({ scale: 1 });
  const doc = new jsPDF({
    orientation: vp.width > vp.height ? 'l' : 'p',
    unit: 'pt',
    format: [vp.width, vp.height],
  });
  doc.addImage(dataUrl, 'PNG', 0, 0, vp.width, vp.height);
  doc.save(`pagina-${state.currentPage}.pdf`);
  showToast('Página exportada');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* =========================================================
   EVENTOS UI
   ========================================================= */
$('btnOpen').onclick = () => fileInput.click();
$('btnZoomIn').onclick = () => setScale(state.scale + 0.25);
$('btnZoomOut').onclick = () => setScale(state.scale - 0.25);
$('btnFit').onclick = () => {
  if (!state.pages[0]) return;
  const available = viewerContainer.clientWidth - 24;
  const pageWidth = state.pages[0].viewport.width / state.scale;
  setScale(available / pageWidth);
};
$('btnRotate').onclick = rotate;
$('btnPrev').onclick = () => scrollToPage(state.currentPage - 1);
$('btnNext').onclick = () => scrollToPage(state.currentPage + 1);
$('btnExport').onclick = exportFullPDF;
$('btnSearch').onclick = () => {
  searchPanel.classList.toggle('hidden');
  if (!searchPanel.classList.contains('hidden')) searchInput.focus();
};
$('btnMore').onclick = (e) => {
  e.stopPropagation();
  moreMenu.classList.toggle('hidden');
};

document.addEventListener('click', (e) => {
  if (!moreMenu.contains(e.target) && e.target.id !== 'btnMore') {
    moreMenu.classList.add('hidden');
  }
});

fileInput.onchange = (e) => {
  const f = e.target.files[0];
  if (f) loadPDF(f);
};

/* Búsqueda */
searchInput.addEventListener('input', (e) => searchPDF(e.target.value));
$('searchPrev').onclick = () => gotoMatch(state.searchIndex - 1);
$('searchNext').onclick = () => gotoMatch(state.searchIndex + 1);
$('searchClose').onclick = () => searchPanel.classList.add('hidden');

/* Menú más */
$('menuExportAll').onclick = () => { exportFullPDF(); moreMenu.classList.add('hidden'); };
$('menuExportPages').onclick = () => { exportCurrentPageImage(); moreMenu.classList.add('hidden'); };
$('menuPrint').onclick = () => { window.print(); moreMenu.classList.add('hidden'); };
$('menuFitWidth').onclick = () => {
  if (!state.pages[0]) return;
  const avail = viewerContainer.clientWidth - 24;
  const pw = state.pages[0].viewport.width / state.scale;
  setScale(avail / pw);
  moreMenu.classList.add('hidden');
};
$('menuFitPage').onclick = () => {
  if (!state.pages[0]) return;
  const availW = viewerContainer.clientWidth - 24;
  const availH = viewerContainer.clientHeight - 24;
  const pw = state.pages[0].viewport.width / state.scale;
  const ph = state.pages[0].viewport.height / state.scale;
  setScale(Math.min(availW / pw, availH / ph));
  moreMenu.classList.add('hidden');
};
$('menuTheme').onclick = () => {
  document.body.classList.toggle('dark');
  moreMenu.classList.add('hidden');
};

/* Drag & drop */
['dragenter','dragover'].forEach(ev =>
  document.addEventListener(ev, e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  })
);
['dragleave','drop'].forEach(ev =>
  document.addEventListener(ev, e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  })
);
document.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0];
  if (f && f.type === 'application/pdf') loadPDF(f);
});

/* Atajos de teclado */
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'o') { e.preventDefault(); fileInput.click(); }
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setScale(state.scale + 0.25); }
    if (e.key === '-') { e.preventDefault(); setScale(state.scale - 0.25); }
    if (e.key === 'f') { e.preventDefault(); searchPanel.classList.remove('hidden'); searchInput.focus(); }
    if (e.key === 's') { e.preventDefault(); exportFullPDF(); }
  }
  if (e.key === 'ArrowRight' || e.key === 'PageDown') scrollToPage(state.currentPage + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') scrollToPage(state.currentPage - 1);
});

/* =========================================================
   SERVICE WORKER
   ========================================================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.log(err));
  });
}

/* =========================================================
   PWA install prompt
   ========================================================= */
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Podrías mostrar un botón "Instalar"
  setTimeout(() => {
    if (deferredPrompt && confirm('¿Instalar Visor PDF en tu dispositivo?')) {
      deferredPrompt.prompt();
    }
  }, 3000);
});