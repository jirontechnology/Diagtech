import { Adb, AdbDaemonTransport } from 'https://cdn.jsdelivr.net/npm/@yume-chan/adb@2.6.4/+esm';
import { AdbDaemonWebUsbDeviceManager } from 'https://cdn.jsdelivr.net/npm/@yume-chan/adb-daemon-webusb@2.3.2/+esm';
import AdbWebCredentialStore from 'https://cdn.jsdelivr.net/npm/@yume-chan/adb-credential-web@2.1.0/+esm';

const $ = id => document.getElementById(id);

// ==========================================
// 1. LÓGICA DE PESTAÑAS (TABS)
// ==========================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.target).classList.add('active');
  });
});

// ==========================================
// 2. LÓGICA DE DIAGNÓSTICO (ADB / WebUSB)
// ==========================================
const automatic = [
  ['system', 'Software', 'Versión de Android'], ['battery', 'Batería', 'Nivel, Temp, Voltaje, Corriente'],
  ['ram', 'Memoria RAM', 'Total y disponible'],
  ['storage', 'Almacenamiento', 'Espacio interno'], ['display', 'Pantalla', 'Resolución'],
  ['imei', 'IMEI / Serie', 'Identificador'], ['nfc', 'NFC', 'Función declarada'],
  ['sim', 'SIM', 'Estado de SIM'], ['mobile', 'Red Móvil', 'Operador'],
  ['sdcard', 'Tarjeta SD', 'Volumen externo'], ['sensors', 'Sensores', 'Inventario'],
  ['location', 'Ubicación', 'Proveedor'], ['wifi', 'Wi-Fi', 'Servicio'], ['bluetooth', 'Bluetooth', 'Adaptador']
];
const manual = [
  ['buttons', 'Botones', 'Encendido/Volumen'], ['vibration', 'Vibración', 'Motor'],
  ['speaker', 'Altavoz', 'Audio'], ['camera', 'Cámara', 'Lentes/Flash'],
  ['fingerprint', 'Huellas', 'Lector'], ['face', 'Rostro', 'Reconocimiento'],
  ['touch', 'Táctil', 'Zonas muertas'], ['headphones', 'Auriculares', 'Jack/USB-C']
];

let results = {}, adbDevice = null;

function draw(items, target) {
  $(target).innerHTML = items.map(([id, name, desc]) => `
    <article class="test" id="c-${id}">
      <h3>${name}</h3><p>${desc}</p><small id="s-${id}">Sin probar</small>
      <button data-id="${id}">${target === 'manual' ? 'Registrar' : 'Consultar'}</button>
    </article>`).join('');
}
draw(automatic, 'auto'); draw(manual, 'manual');
summary();

function summary() {
  let v = Object.values(results), ok = v.filter(x => x === 'normal').length, bad = v.filter(x => x === 'problema').length, done = v.filter(x => ['normal', 'problema', 'no disponible'].includes(x)).length;
  $('done').textContent = done; $('ok').textContent = ok; $('bad').textContent = bad;
  $('unavailable').textContent = v.filter(x => x === 'no disponible').length;
  const total = automatic.length + manual.length;
  $('pending').textContent = total - done;
  const tot = document.querySelector('#done + small'); if (tot) tot.textContent = '/' + total;
}
function log(t) { $('log').textContent = new Date().toLocaleTimeString() + ' · ' + t + '\n' + $('log').textContent; }

function setResult(id, status, detail) {
  results[id] = status;
  const smallElement = $('s-' + id);
  if (smallElement) {
    if (detail && detail !== 'OK' && detail !== '—') {
        smallElement.textContent = detail;
        smallElement.style.color = status === 'normal' ? '#20a879' : status === 'problema' ? '#d65b51' : '#d49b42';
    } else {
        smallElement.textContent = status.charAt(0).toUpperCase() + status.slice(1);
        smallElement.style.color = '#a6abb6';
    }
  }
  const cardElement = $('c-' + id);
  if (cardElement) cardElement.className = 'test ' + (status === 'normal' ? 'ok' : status === 'problema' ? 'bad' : status === 'no disponible' ? 'unavailable' : '');
  log(id + ': ' + (detail || status)); summary();
}

$('connectBtn').onclick = async () => {
  try {
    $('connectBtn').disabled = true; $('connectBtn').textContent = '⏳ Buscando...';
    log('Abriendo selector de USB...');
    results = {};
    $('manufacturer').textContent = '—'; $('model').textContent = '—'; $('os').textContent = '—'; $('serial').textContent = '—';
    document.querySelectorAll('#diag-section .test').forEach(el => el.className = 'test');
    document.querySelectorAll('small[id^="s-"]').forEach(el => { el.textContent = 'Sin probar'; el.style.color = '#a6abb6'; });
    summary(); log('Interfaz limpiada...');

    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager) throw new Error('WebUSB no soportado. Usa Chrome o Edge.');

    const device = await manager.requestDevice();
    if (!device) throw new Error('No seleccionaste ningún dispositivo.');

    log('Conectando a ' + (device.name || 'Android') + '...');
    let connection;
    try { connection = await device.connect(); } catch (error) { connection = await device.connect(1); }

    log('Autenticando. ¡Revisa la pantalla de tu teléfono y acepta el RSA!');
    const credentialStore = new AdbWebCredentialStore('JironTech');
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial, connection: connection, credentialStore: credentialStore
    });

    adbDevice = new Adb(transport);
    $('connectBtn').style.display = 'none';
    $('disconnectBtn').style.display = 'block';
    $('conn').textContent = 'Android Conectado'; $('conn').className = 'tag connected';
    $('runAll').disabled = false;

    await refreshDeviceInfo();
    log('¡Dispositivo conectado exitosamente!');
  } catch (e) {
    log('Error: ' + e.message);
    alert('⚠️ ATENCIÓN:\n' + e.message);
    $('connectBtn').disabled = false; $('connectBtn').textContent = '🔌 CONECTAR POR USB';
  }
};

$('disconnectBtn').onclick = () => {
  if (adbDevice) { adbDevice.transport.dispose(); adbDevice = null; }
  $('connectBtn').style.display = 'block'; $('connectBtn').disabled = false;
  $('connectBtn').textContent = '🔌 CONECTAR POR USB';
  $('disconnectBtn').style.display = 'none';
  $('conn').textContent = 'Desconectado'; $('conn').className = 'tag';
  $('runAll').disabled = true;
  log('Dispositivo liberado.');
  alert('Puerto liberado. Ya puedes usar otras herramientas.');
};

async function refreshDeviceInfo() {
  if (!adbDevice) return;
  try {
    const get = async (prop) => (await adbDevice.subprocess.noneProtocol.spawnWaitText(['getprop', prop])).trim();
    $('manufacturer').textContent = await get('ro.product.manufacturer') || '—';
    $('model').textContent = await get('ro.product.model') || '—';
    $('os').textContent = 'Android ' + (await get('ro.build.version.release') || '—');
    $('serial').textContent = await get('ro.serialno') || '—';
  } catch (e) { log('Error leyendo info: ' + e.message); }
}

async function runCmd(args) {
  try { return (await adbDevice.subprocess.noneProtocol.spawnWaitText(args)).trim(); } catch (e) { return null; }
}

async function runOne(id) {
  if (!adbDevice) return setResult(id, 'no disponible', 'Sin dispositivo');
  let out = null, status = 'normal', detail = '—';
  try {
    switch (id) {
      case 'system':
        out = await runCmd(['getprop', 'ro.build.version.release']);
        status = out ? 'normal' : 'no disponible';
        detail = out ? `Android ${out}` : 'No leído';
        break;
      case 'battery': {
        out = await runCmd(['dumpsys', 'battery']);
        if (out && out.includes('level')) {
          const level = out.match(/^\s*level:\s*(\d+)/m)?.[1] || '?';
          const temp = out.match(/^\s*temperature:\s*(\d+)/m)?.[1];
          const volt = out.match(/^\s*voltage:\s*(\d+)/m)?.[1];
          let current = out.match(/CURRENT_NOW:\s*(-?\d+)/)?.[1];
          if (!current) { const c = await runCmd(['cat', '/sys/class/power_supply/battery/current_now']); if (c && /^-?\d+$/.test(c.trim())) current = c.trim(); }
          const vv = volt ? (parseInt(volt) > 100000 ? parseInt(volt) / 1e6 : parseInt(volt) / 1000) : null;
          detail = `${level}%, ${temp ? (parseInt(temp)/10).toFixed(1) : '?'}°C, ${vv ? vv.toFixed(2) : '?'}V, ${current ? (Math.abs(parseInt(current))/1000).toFixed(0) : '?'}mA`;
          status = parseInt(level) < 15 ? 'problema' : 'normal';
        } else { status = 'no disponible'; detail = 'No leído'; }
        break;
      }
      case 'ram': {
        out = await runCmd(['cat', '/proc/meminfo']);
        status = 'no disponible'; detail = 'No leído';
        if (out) {
          const t = out.match(/MemTotal:\s*(\d+)/), f = out.match(/MemAvailable:\s*(\d+)/);
          if (t && f) { status = 'normal'; detail = `${(f[1] / 1048576).toFixed(1)} GB libres de ${(t[1] / 1048576).toFixed(1)} GB`; }
        }
        break;
      }
      case 'storage': {
        out = await runCmd(['df', '-h', '/data']);
        status = 'no disponible'; detail = 'No leído';
        if (out) {
          const line = out.split('\n').find(l => l.includes('/data'));
          if (line) { const p = line.trim().split(/\s+/); status = 'normal'; detail = `${p[3]} libres de ${p[1]}`; }
        }
        break;
      }
      case 'display': out = await runCmd(['wm', 'size']); detail = out ? out.match(/(\d+x\d+)/)?.[0] : '?'; status = out?'normal':'no disponible'; break;
      case 'imei': out = await runCmd(['getprop', 'ro.serialno']); detail = out || 'Restringido'; status = out?'normal':'no disponible'; break;
      case 'nfc': out = await runCmd(['pm', 'list', 'features']); status = (out && out.includes('nfc'))?'normal':'no disponible'; detail=status==='normal'?'Soporta NFC':'Sin NFC'; break;
      case 'sim': out = await runCmd(['getprop', 'gsm.sim.state']); status = (out && /READY|LOADED/.test(out)) ? 'normal' : 'no disponible'; detail = out || 'Sin SIM'; break;
      case 'mobile': out = await runCmd(['getprop', 'gsm.operator.alpha']); if(!out) out=await runCmd(['getprop', 'gsm.sim.operator.alpha']); status=(out&&out!=='')?'normal':'no disponible'; detail=out?out.split(',')[0]:'Sin red'; break;
      case 'sdcard': out = await runCmd(['ls', '/storage']); status = (out&&out.includes('sdcard1'))?'normal':'no disponible'; detail=status==='normal'?'SD Detectada':'Sin SD'; break;
      case 'sensors': out = await runCmd(['dumpsys', 'sensorservice']); status=(out&&out.includes('Sensor List'))?'normal':'no disponible'; detail=status==='normal'?'Activos':'No leído'; break;
      case 'location': out = await runCmd(['settings', 'get', 'secure', 'location_mode']); status = (out && ['1', '2', '3'].includes(out)) ? 'normal' : 'no disponible'; detail = ({ '3': 'Alta precisión', '2': 'Ahorro de batería', '1': 'Solo dispositivo' })[out] || 'Apagado'; break;
      case 'wifi': out = await runCmd(['dumpsys', 'wifi']); status=(out&&out.includes('Wi-Fi is enabled'))?'normal':'no disponible'; detail=status==='normal'?'Activo':'Apagado'; break;
      case 'bluetooth': out = await runCmd(['settings', 'get', 'global', 'bluetooth_on']); status=(out==='1')?'normal':'no disponible'; detail=out==='1'?'Activo':'Apagado'; break;
      default: status = 'no disponible'; detail = 'No implementado';
    }
    setResult(id, status, detail);
  } catch (e) { setResult(id, 'no disponible', e.message); }
}

function guardarEnHistorial() {
  try {
    const fab = $('manufacturer').textContent.trim(), mod = $('model').textContent.trim(), ser = $('serial').textContent.trim();
    if (fab === '—' || mod === '—') return;
    const nuevo = { fecha: new Date().toLocaleString(), equipo: `${fab},${mod},${ser}`, resultados: { ...results } };
    let h = JSON.parse(localStorage.getItem('jiron_historial')) || [];
    h.unshift(nuevo); if (h.length > 50) h = h.slice(0, 50);
    localStorage.setItem('jiron_historial', JSON.stringify(h)); actualizarTablaHistorial();
  } catch (e) { log('Error guardando: ' + e.message); }
}
function actualizarTablaHistorial() {
  const c = $('tablaHistorial'); if(!c) return;
  let h = JSON.parse(localStorage.getItem('jiron_historial')) || [];
  if (!h.length) { c.innerHTML = '<p class="muted">No hay equipos registrados.</p>'; return; }
  c.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:10px;"><thead><tr style="border-bottom:2px solid #3979ff;text-align:left;"><th style="padding:8px;">Fecha</th><th style="padding:8px;">Equipo</th></tr></thead><tbody>${h.map((i,x)=>`<tr style="border-bottom:1px solid #282b33;cursor:pointer;" onclick="verDetalle(${x})"><td style="padding:8px;color:#a6abb6;">${i.fecha}</td><td style="padding:8px;font-weight:bold;color:#78a0ff;">${i.equipo}</td></tr>`).join('')}</tbody></table>`;
}
window.verDetalle = function(x) {
  let h = JSON.parse(localStorage.getItem('jiron_historial')) || []; const r = h[x];
  if (!r || !r.resultados) return alert('Sin detalles.');
  let d = `EQUIPO: ${r.equipo}\nFECHA: ${r.fecha}\n\n--- RESULTADOS ---\n`;
  for (const [k, v] of Object.entries(r.resultados)) d += `• ${k.toUpperCase()}: ${v.toUpperCase()}\n`;
  alert(d);
}
$('btnCopiarHistorial').onclick = () => { let h = JSON.parse(localStorage.getItem('jiron_historial')) || []; if (!h.length) return alert('Vacío.'); let t = "FECHA / HORA\tEQUIPO\n" + h.map(i => `${i.fecha}\t${i.equipo}`).join('\n'); navigator.clipboard.writeText(t).then(() => alert('¡Copiado!')); };
$('btnBorrarHistorial').onclick = () => { if (confirm('¿Borrar todo el historial?')) { localStorage.removeItem('jiron_historial'); actualizarTablaHistorial(); log('Historial borrado.'); } };
$('btnLimpiarLog').onclick = () => { $('log').textContent = 'Registro limpio...'; };

$('btnRebootDownload').onclick = async () => { if(!adbDevice) return alert('Conecta un dispositivo.'); if(!confirm('¿Modo Descarga?')) return; await runCmd(['reboot', 'download']); alert('Reiniciando...'); };
$('btnRebootRecovery').onclick = async () => { if(!adbDevice) return alert('Conecta un dispositivo.'); if(!confirm('¿Modo Recovery?')) return; await runCmd(['reboot', 'recovery']); alert('Reiniciando...'); };
$('btnTestPantalla').onclick = async () => { if(!adbDevice) return alert('Conecta un dispositivo.'); await runCmd(['am', 'start', '-a', 'android.settings.DISPLAY_SETTINGS']); alert('Ajustes de pantalla abiertos.'); };
$('btnTestMicro').onclick = async () => { if(!adbDevice) return alert('Conecta un dispositivo.'); alert('Habla ahora...'); await runCmd(['am', 'start', '-a', 'android.provider.MediaStore.RECORD_SOUND']); await new Promise(r => setTimeout(r, 4000)); await runCmd(['input', 'keyevent', 'KEYCODE_BACK']); await runCmd(['am', 'start', '-a', 'android.intent.action.VIEW', '-t', 'audio/*', '-d', 'content://media/external/audio/media/1']); };
$('btnTestSonido').onclick = async () => { if(!adbDevice) return alert('Conecta un dispositivo.'); await runCmd(['am', 'start', '-a', 'android.settings.SOUND_SETTINGS']); alert('Ajustes de sonido abiertos.'); };
$('btnTestCamara').onclick = async () => { if(!adbDevice) return alert('Conecta un dispositivo.'); await runCmd(['am', 'start', '-a', 'android.media.action.STILL_IMAGE_CAMERA']); alert('Cámara abierta.'); };
async function abrirMarcador(codigo, nombre) { if(!adbDevice) return alert('Conecta un dispositivo.'); const cmd = `am start -a android.intent.action.DIAL -d tel:${codigo.replace(/#/g, '%23')}`; await adbDevice.subprocess.noneProtocol.spawnWaitText(cmd.split(' ')); alert(`Marcador abierto. Presiona "Llamar" para el test ${nombre}.`); }
$('btnTestSamsung').onclick = () => abrirMarcador('*#0*#', 'Samsung');
$('btnTestTecno').onclick = () => abrirMarcador('*#85#', 'Tecno/Infinix');

$('auto').onclick = async e => { const b = e.target.closest('button[data-id]'); if (b) await runOne(b.dataset.id); };
$('runAll').onclick = async () => { if(!adbDevice) return alert('Conecta un dispositivo.'); $('runAll').disabled = true; for (let [id] of automatic) { await runOne(id); } guardarEnHistorial(); $('runAll').disabled = false; log('Pruebas finalizadas.'); };
$('manual').onclick = e => { const b = e.target.closest('button[data-id]'); if (!b) return; const item = manual.find(x => x[0] === b.dataset.id); const v = confirm(`¿La prueba ${item[1]} funciona?\nAceptar = Normal\nCancelar = Problema`); setResult(item[0], v ? 'normal' : 'problema', v ? 'Confirmado' : 'Problema'); };
$('export').onclick = () => { const rep = { app: 'DIAGTECH', date: new Date().toISOString(), device: { manufacturer: $('manufacturer').textContent, model: $('model').textContent, os: $('os').textContent, serial: $('serial').textContent }, results }; const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'informe-diagtech.json'; a.click(); };

actualizarTablaHistorial();

// ==========================================
// 3. REGISTRO DE SERVICE WORKER (ACTUALIZADO A V7)
// ==========================================
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/sw.js?v=8').then(reg => reg.update()).catch(() => {});
}