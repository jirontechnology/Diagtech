// DIAGTECH · flash.js — Flasheo Samsung (protocolo Odin) por Web Serial
// Ranuras: BL con BL, AP con AP, CP con CP, CSC con CSC. Solo Chrome/Edge de escritorio.
const $ = id => document.getElementById(id);
const LOG = $('flog');
const log = (m, c) => {
  const d = document.createElement('div');
  d.textContent = new Date().toLocaleTimeString() + '  ' + m;
  if (c) d.style.color = c;
  LOG.appendChild(d); LOG.scrollTop = LOG.scrollHeight;
};
const fmt = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

/* ---------- Pestañas ---------- */
const tabs = document.querySelectorAll('.tab-btn');
function showTab(id) {
  tabs.forEach(b => b.classList.toggle('active', b.dataset.target === id));
  document.querySelectorAll('.tab-content').forEach(s => {
    const on = s.id === id;
    s.classList.toggle('active', on);
    s.style.display = on ? 'block' : 'none';
  });
}
tabs.forEach(b => b.addEventListener('click', () => showTab(b.dataset.target)));
showTab('diag-section');

/* ---------- Capa serial ---------- */
let port, reader, writer, pend = null, rbuf = new Uint8Array(0);
let PART = 131072, SEQ_PARTS = 800, connected = false, running = false, cancel = false;
let pit = [], pitRaw = null;

async function fill(ms) {
  pend = pend || reader.read();
  let t; const to = new Promise((_, rej) => t = setTimeout(() => rej(new Error('Tiempo agotado esperando respuesta del equipo')), ms));
  try {
    const { value, done } = await Promise.race([pend, to]);
    pend = null;
    if (done) throw new Error('Puerto cerrado');
    const n = new Uint8Array(rbuf.length + value.length); n.set(rbuf); n.set(value, rbuf.length); rbuf = n;
  } finally { clearTimeout(t); }
}
async function readN(n, ms = 20000) {
  while (rbuf.length < n) await fill(ms);
  const o = rbuf.slice(0, n); rbuf = rbuf.slice(n); return o;
}
const send = u => writer.write(u);

// Paquete de control de 1024 bytes: enteros de 32 bits little-endian
function pkt(...v) {
  const u = new Uint8Array(1024), d = new DataView(u.buffer);
  v.forEach((x, i) => d.setUint32(i * 4, x >>> 0, true));
  return u;
}
async function cmd(v, ms) {
  await send(pkt(...v));
  const r = new DataView((await readN(8, ms)).buffer);
  const data = r.getInt32(4, true);
  return { type: r.getUint32(0, true), data };
}

/* ---------- PIT ---------- */
const dec = (b, o, l) => new TextDecoder().decode(b.slice(o, o + l)).replace(/\0.*$/s, '');
function parsePit(b) {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (d.getUint32(0, true) !== 0x12349876) throw new Error('PIT inválido');
  const n = d.getUint32(4, true), out = [];
  for (let i = 0; i < n; i++) {
    const o = 28 + i * 132;
    out.push({
      bin: d.getUint32(o, true), dev: d.getUint32(o + 4, true), id: d.getUint32(o + 8, true),
      name: dec(b, o + 36, 32), file: dec(b, o + 68, 32)
    });
  }
  return out;
}
const hex = u => [...u].map(x => x.toString(16).padStart(2, '0')).join(' ');
// Lee una ráfaga: espera el primer byte y sigue hasta que el equipo calla un momento
async function readBurst(first = 8000, quiet = 80) {
  while (rbuf.length === 0) await fill(first);
  for (;;) { try { await fill(quiet); } catch { break; } }
  const o = rbuf; rbuf = new Uint8Array(0); return o;
}
async function dumpPit() {
  const r = await cmd([0x65, 1]);
  const size = r.data;
  log(`PIT: respuesta tipo 0x${r.type.toString(16)}, tamaño ${size} bytes`);
  const chunks = []; let got = 0;
  for (let i = 0; got < size && i < Math.ceil(size / 500) + 4; i++) {
    await send(pkt(0x65, 2, i));
    let b;
    try { b = await readBurst(); }
    catch (e) { log(`PIT bloque ${i}: sin datos (llevo ${got} de ${size} bytes)`, '#ff6b6b'); throw e; }
    if (i < 2) log(`PIT bloque ${i}: ${b.length} bytes, inicio ${hex(b.slice(0, 16))}`);
    chunks.push(b); got += b.length;
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  log(`PIT recibido: ${got} bytes en ${chunks.length} bloques`);
  try { await cmd([0x65, 3], 5000); } catch (e) { log('Cierre de PIT: ' + e.message, '#ffb020'); }
  const pitData = out.slice(0, size);
  if (new DataView(pitData.buffer).getUint32(0, true) !== 0x12349876)
    throw new Error('PIT sin firma válida, inicio: ' + hex(pitData.slice(0, 16)));
  return pitData;
}

/* ---------- Conexión ---------- */
const st = t => $('st').textContent = t;
function setConn(on) {
  connected = on;
  ['bInfo', 'bPit', 'bEnd'].forEach(i => $(i).disabled = !on);
  $('bCon').disabled = on;
  st(on ? 'Conectado' : 'Sin conexión');
  gate();
}
async function connect() {
  if (!('serial' in navigator)) { log('Este navegador no soporta Web Serial. Usa Chrome/Edge en PC.', '#ff6b6b'); return; }
  try {
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04e8 }] });
    await port.open({ baudRate: 115200, bufferSize: 1 << 20 });
    reader = port.readable.getReader(); writer = port.writable.getWriter();
    rbuf = new Uint8Array(0); pend = null;
    await send(new TextEncoder().encode('ODIN'));
    const h = new TextDecoder().decode(await readN(4, 5000));
    if (h !== 'LOKE') throw new Error('Handshake inesperado: ' + h);
    log('Handshake ODIN → LOKE correcto', '#6ee7a8');
    const b = await cmd([0x64, 0, 4]);
    if (b.data !== 0) {
      await cmd([0x64, 5, 1 << 20]); PART = 1 << 20; SEQ_PARTS = 30;
      log('Protocolo extendido: bloques de 1 MB');
    } else { PART = 131072; SEQ_PARTS = 800; log('Protocolo clásico: bloques de 128 KB'); }
    pitRaw = await dumpPit(); pit = parsePit(pitRaw);
    log(`PIT leído: ${pit.length} particiones`, '#6ee7a8');
    setConn(true); buildRows();
  } catch (e) {
    log('Error al conectar: ' + e.message, '#ff6b6b'); await closePort();
  }
}
async function closePort() {
  try { reader && await reader.cancel(); } catch {}
  try { reader && reader.releaseLock(); writer && writer.releaseLock(); } catch {}
  try { port && await port.close(); } catch {}
  reader = writer = port = null; setConn(false);
}
async function endSession(reboot) {
  try { await cmd([0x67, 0]); if (reboot) await cmd([0x67, 1]); } catch (e) { log('Cierre: ' + e.message, '#ffb020'); }
}

$('bCon').onclick = connect;
$('bEnd').onclick = async () => { await endSession(false); await closePort(); log('Sesión cerrada'); };
$('bInfo').onclick = async () => {
  try { const r = await cmd([0x64, 1]); $('dev').textContent = `Respuesta tipo 0x${r.type.toString(16)}, dato ${r.data}`; log('Info: ' + $('dev').textContent); }
  catch (e) { log('Info: ' + e.message, '#ff6b6b'); }
};
$('bPit').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([pitRaw])); a.download = 'device.pit'; a.click();
};

/* ---------- Firmware (.tar.md5) ---------- */
const files = {};
document.querySelectorAll('.files input[type=file]').forEach(inp =>
  inp.addEventListener('change', async () => {
    const k = inp.dataset.k;
    if (!inp.files[0]) { delete files[k]; buildRows(); return; }
    try { files[k] = { file: inp.files[0], entries: await readTar(inp.files[0]) }; log(`${k}: ${files[k].entries.length} archivos en ${inp.files[0].name}`); }
    catch (e) { log(`${k}: ${e.message}`, '#ff6b6b'); delete files[k]; }
    buildRows();
  }));

async function readTar(f) {
  const out = []; let off = 0;
  while (off + 512 <= f.size) {
    const h = new Uint8Array(await f.slice(off, off + 512).arrayBuffer());
    const name = dec(h, 0, 100);
    if (!name) break;
    const sz = parseInt(dec(h, 124, 12).trim(), 8);
    if (isNaN(sz)) break; // llegó al MD5 final
    const type = String.fromCharCode(h[156] || 48);
    const prefix = dec(h, 345, 155);
    if ((type === '0' || type === '\0') && sz > 0)
      out.push({ name: (prefix ? prefix + '/' : '') + name, size: sz, start: off + 512 });
    off += 512 + Math.ceil(sz / 512) * 512;
  }
  if (!out.length) throw new Error('No es un tar válido (¿está comprimido?)');
  return out;
}

/* ---------- Tabla de particiones ---------- */
let rows = [];
function buildRows() {
  rows = [];
  for (const k of ['BL', 'AP', 'CP', 'CSC']) {
    if (!files[k]) continue;
    for (const e of files[k].entries) {
      const base = e.name.split('/').pop();
      const lz4 = /\.lz4$/i.test(base);
      const clean = base.replace(/\.lz4$/i, '');
      const p = pit.find(x => x.file === clean) || pit.find(x => x.file === base);
      let why = '';
      if (!pit.length) why = 'conecta para ver PIT';
      else if (!p) why = 'sin partición en PIT';
      else if (lz4) why = 'LZ4: aún no soportado';
      else if (/\.(txt|md5|pit)$/i.test(base)) why = 'no flasheable';
      rows.push({ k, f: files[k].file, e, base, p, ok: !why, why, on: false });
    }
  }
  render();
}
function render() {
  const tb = $('tb').querySelector('tbody'); tb.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" ${r.on ? 'checked' : ''} ${r.ok ? '' : 'disabled'}></td><td>${r.k}</td><td>${r.base}</td><td>${fmt(r.e.size)}</td><td>${r.p ? r.p.name : '—'}</td><td class="rs">${r.why}</td>`;
    tr.querySelector('input').onchange = ev => { r.on = ev.target.checked; render(); };
    r.td = tr.querySelector('.rs'); tb.appendChild(tr);
  });
  const sel = rows.filter(r => r.on);
  $('sum').textContent = rows.length ? `${rows.length} archivos · ${sel.length} seleccionados (${fmt(sel.reduce((a, r) => a + r.e.size, 0))})` : 'Carga el firmware y conecta el equipo para ver el mapa.';
  gate();
}
$('bAll').onclick = () => { rows.forEach(r => r.on = r.ok); render(); };
$('bNone').onclick = () => { rows.forEach(r => r.on = false); render(); };
$('bTest').onclick = () => { rows.forEach(r => r.on = r.ok && /^recovery/i.test(r.base)); render(); };
$('fok').onchange = gate;
function gate() {
  $('bGo').disabled = !(connected && !running && $('fok').checked && rows.some(r => r.on));
  $('bStop').disabled = !running;
}

/* ---------- Flasheo ---------- */
$('bStop').onclick = () => { cancel = true; log('Cancelando tras el bloque actual…', '#ffb020'); };
let done = 0, total = 0, t0 = 0;
function prog() {
  const pct = total ? done / total * 100 : 0;
  $('pb').style.width = pct.toFixed(1) + '%';
  const s = (Date.now() - t0) / 1000 || 1;
  $('pr').textContent = `${pct.toFixed(1)}% · ${(done / s / 1048576).toFixed(1)} MB/s`;
}

async function flashFile(r) {
  const size = r.e.size, p = r.p, seqBytes = PART * SEQ_PARTS;
  await cmd([0x66, 0]); // pedir flasheo
  let pos = 0;
  while (pos < size) {
    const seqLen = Math.min(seqBytes, size - pos);
    const parts = Math.ceil(seqLen / PART);
    await cmd([0x66, 2, parts * PART]);
    for (let i = 0; i < parts; i++) {
      if (cancel) throw new Error('Cancelado por el usuario');
      const a = r.e.start + pos + i * PART;
      const len = Math.min(PART, size - (pos + i * PART));
      const buf = new Uint8Array(PART); // relleno con ceros
      buf.set(new Uint8Array(await r.f.slice(a, a + len).arrayBuffer()));
      await send(buf);
      const rs = new DataView((await readN(8, 120000)).buffer);
      if (rs.getInt32(4, true) < 0) throw new Error(`El equipo rechazó el bloque ${i} de ${r.base}`);
      done += len; prog();
    }
    const last = pos + seqLen >= size ? 1 : 0;
    const end = p.bin === 1
      ? pkt(0x66, 3, 1, seqLen, 0, p.dev, last)
      : pkt(0x66, 3, 0, seqLen, 0, p.dev, p.id, last);
    await send(end);
    const er = new DataView((await readN(8, 120000)).buffer);
    if (er.getInt32(4, true) < 0) throw new Error(`Error al cerrar secuencia de ${r.base}`);
    pos += seqLen;
  }
}

$('bGo').onclick = async () => {
  const sel = rows.filter(r => r.on);
  if (!sel.length) return;
  running = true; cancel = false; gate();
  done = 0; total = sel.reduce((a, r) => a + r.e.size, 0); t0 = Date.now();
  try {
    const t = BigInt(total);
    await cmd([0x64, 2, Number(t & 0xffffffffn), Number(t >> 32n)]);
    for (const r of sel) {
      log(`Flasheando ${r.k}: ${r.base} → ${r.p.name} (${fmt(r.e.size)})`);
      r.td.textContent = '⏳';
      await flashFile(r);
      r.td.textContent = '✅'; log(`${r.base} OK`, '#6ee7a8');
    }
    await endSession($('rb').checked);
    log('FLASHEO TERMINADO', '#6ee7a8'); $('pr').textContent = 'Terminado';
    await closePort();
  } catch (e) {
    log('ERROR: ' + e.message, '#ff6b6b'); $('pr').textContent = 'Error';
    log('No desconectes el cable. Copia este monitor y envíamelo para ajustar el protocolo.', '#ffb020');
  } finally { running = false; gate(); }
};
