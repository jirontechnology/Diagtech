// Flasheo Odin (Web Serial) - Diagtech
const $=id=>document.getElementById(id);
const enc=s=>new TextEncoder().encode(s), dec=new TextDecoder();
let port,reader,writer,buf=new Uint8Array(0),pit=null,pitRaw=null,pumping=false,proto=null,abort=false,busy=false;
const fw={BL:null,AP:null,CP:null,CSC:null}, idx={};

function log(m,c){const d=document.createElement('div');if(c)d.className=c;d.textContent=m;$('flog').appendChild(d);$('flog').scrollTop=1e9}
const hex=(u,n=24)=>[...u.slice(0,n)].map(b=>b.toString(16).padStart(2,'0')).join(' ');
const mb=n=>n>=1e9?(n/1e9).toFixed(2)+' GB':(n/1e6).toFixed(1)+' MB';
function status(t,c){$('st').textContent=t;$('st').className='st '+(c||'')}

/* ---- TRANSPORTE SERIE (LECTURA BLINDADA) ---- */
async function pump(){
  try{while(pumping){const{value,done}=await reader.read();if(done)break;
    if(value){const n=new Uint8Array(buf.length+value.length);n.set(buf);n.set(value,buf.length);buf=n}}}catch(e){}
}

// Esta función ahora espera a que los datos se junten, sin importar cómo lleguen
async function rd(n, ms=10000){
  const start = Date.now();
  let lastLen = -1;
  let lastChange = Date.now();

  while (buf.length < n) {
    if (Date.now() - start > ms) {
      throw new Error(`Tiempo agotado: esperaba ${n} bytes, pero solo llegaron ${buf.length}. Revisa el cable o reinicia el modo descarga.`);
    }
    // Si el buffer creció, reiniciamos el temporizador de inactividad
    if (buf.length !== lastLen) {
      lastLen = buf.length;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > 1500) {
      // Si pasan 1.5s sin recibir NADA nuevo, abortamos para no colgar la página
      throw new Error(`Flujo detenido: esperaba ${n} bytes, llegaron ${buf.length}. El teléfono dejó de enviar datos.`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
  const o = buf.slice(0, n);
  buf = buf.slice(n);
  return o;
}

const wr = d => writer.write(d);

function pkt(type,sub,...ints){
  const p=new Uint8Array(1024),v=new DataView(p.buffer);
  v.setInt32(0,type,true);v.setInt32(4,sub,true);ints.forEach((x,i)=>v.setInt32(8+4*i,x,true));return p;
}

async function resp(ms=10000,q=false){
  const r=await rd(8,ms),v=new DataView(r.buffer);
  if(!q)log('  ← '+hex(r,8),'h');
  const o={type:v.getInt32(0,true),data:v.getInt32(4,true)};
  if(o.type===0xFF)throw new Error('El equipo devolvió error (0xFF)');
  return o;
}

async function send(p,name){log('→ '+name+' ['+hex(p,12)+' …]','h');await wr(p)}

/* ---- PIT ---- */
function parsePit(u){
  const v=new DataView(u.buffer,u.byteOffset,u.byteLength);
  if(v.getUint32(0,true)!==0x12349876)throw new Error('PIT inválido (firma '+v.getUint32(0,true).toString(16)+')');
  const n=v.getUint32(4,true),s=o=>dec.decode(u.slice(o,o+32)).split('\0')[0],out=[];
  for(let i=0;i<n;i++){const o=28+i*132;
    out.push({bin:v.getUint32(o,true),dev:v.getUint32(o+4,true),id:v.getUint32(o+8,true),blocks:v.getUint32(o+24,true),name:s(o+36),file:s(o+68)})}
  return out;
}

/* ---- CONEXIÓN ---- */
async function conectar(){
  try{
    port=await navigator.serial.requestPort({filters:[{usbVendorId:0x04E8}]});
    const i=port.getInfo();
    log('Puerto: VID '+i.usbVendorId.toString(16).toUpperCase()+' PID '+(i.usbProductId||0).toString(16).toUpperCase());
    await port.open({baudRate:115200,bufferSize:1<<20});
    reader=port.readable.getReader();writer=port.writable.getWriter();buf=new Uint8Array(0);pumping=true;pump();

    await wr(enc('ODIN'));
    const h=dec.decode(await rd(4));
    if(h!=='LOKE')throw new Error('Respuesta al handshake: "'+h+'" (se esperaba LOKE). ¿Está en modo descarga?');
    log('Handshake ODIN → LOKE','g');status('Modo descarga','ok');

    await send(pkt(0x64,0,4),'Iniciar sesión');
    const s=await resp();
    
    // Ajuste de tamaño de secuencia para evitar rechazos
    const ver = s.data >> 16;
    proto={ver:ver, big:s.data!==0, lz4:(s.data&0x8000)!==0, ps:131072, sm:(ver<2?240:800)};
    
    if(proto.big){await send(pkt(0x64,5,1048576),'Tamaño de paquete 1 MiB');await resp();proto.ps=1048576;proto.sm=30}
    log('Sesión abierta: protocolo '+proto.ver+(proto.lz4?', acepta LZ4':', sin LZ4')+', paquete '+proto.ps/1024+' KiB','g');

    await send(pkt(0x65,1),'Pedir PIT');
    const r=await resp();const size=r.data;
    if(size<=0||size>1e6)throw new Error('Tamaño de PIT inesperado: '+size);
    
    const parts=Math.ceil(size/500),out=new Uint8Array(parts*500);
    
    // LECTURA DEL PIT CORREGIDA
    for(let k=0;k<parts;k++){
        await wr(pkt(0x65,2,k));
        await resp(10000, true); // Lee los 8 bytes del ACK
        out.set(await rd(500), k*500); // Lee los 500 bytes del bloque
    }
    
    await wr(pkt(0x65,3));await resp();
    pitRaw=out.slice(0,size);pit=parsePit(pitRaw);
    log('PIT recibido: '+size+' bytes, '+pit.length+' particiones','g');
    $('dev').textContent='Particiones en el equipo: '+pit.length;
    ['bInfo','bPit','bEnd'].forEach(b=>$(b).disabled=false);$('bCon').disabled=true;
    render();
  }catch(e){log('ERROR: '+e.message,'e');status('Error','err');await cerrar(true)}
}

async function info(){
  try{
    await send(pkt(0x69,0),'Pedir info (experimental)');
    await new Promise(r=>setTimeout(r,1500));
    const d=buf.slice(0);buf=new Uint8Array(0);
    if(!d.length){log('Sin respuesta a la info.','e');return}
    log('Bytes recibidos ('+d.length+'): '+hex(d,64),'h');
  }catch(e){log('ERROR: '+e.message,'e')}
}

async function cerrar(silent){
  try{if(writer&&!silent){await wr(pkt(0x67,0));await resp().catch(()=>{});log('Sesión cerrada')}}catch(e){}
  pumping=false;
  try{await reader?.cancel()}catch(e){} try{reader?.releaseLock()}catch(e){} try{writer?.releaseLock()}catch(e){}
  try{await port?.close();log('Puerto liberado')}catch(e){}
  port=reader=writer=null;status('Sin conexión');
  ['bInfo','bPit','bEnd'].forEach(b=>$(b).disabled=true);$('bCon').disabled=false;updGo();
}

function guardarPit(){
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([pitRaw]));
  a.download='dispositivo_'+Date.now()+'.pit';a.click();
}

/* ---- TAR ---- */
async function tarIndex(file){
  const out=[];let o=0;
  while(o+512<=file.size){
    const h=new Uint8Array(await file.slice(o,o+512).arrayBuffer());
    if(h[0]===0)break;
    const name=dec.decode(h.slice(0,100)).split('\0')[0];
    let size;
    if(h[124]&0x80){size=0;for(let i=125;i<136;i++)size=size*256+h[i]}
    else size=parseInt(dec.decode(h.slice(124,136)).replace(/\0/g,'').trim()||'0',8);
    if(!name||isNaN(size))break;
    out.push({name,size,off:o+512});o+=512+Math.ceil(size/512)*512;
  }
  return out;
}

document.querySelectorAll('input[data-k]').forEach(inp=>inp.onchange=async()=>{
  const k=inp.dataset.k,f=inp.files[0];fw[k]=f||null;idx[k]=[];
  if(f){try{idx[k]=await tarIndex(f);idx[k].forEach(e=>{e.file=f;e.k=k});log(k+': '+f.name+' → '+idx[k].length+' archivos ('+mb(f.size)+')','g');}
    catch(e){log(k+': '+e.message,'e')}}
  render();
});

/* ---- MAPA ---- */
const ORDER=['AP','BL','CP','CSC'];
const sel=()=>ORDER.flatMap(k=>(idx[k]||[]).filter(e=>e.sel&&e.p));
function updGo(){$('bGo').disabled=!(pit&&port&&!busy&&$('fok').checked&&sel().length)}

function render(){
  const tb=$('tb').querySelector('tbody');tb.innerHTML='';
  let total=0,ok=0,miss=0;
  for(const k of ORDER){
    for(const e of (idx[k]||[])){
      const base=e.name.replace(/\.lz4$/i,'').toLowerCase();
      e.p=(pit&&pit.find(x=>x.file&&(x.file.toLowerCase()===base||x.file.toLowerCase()===e.name.toLowerCase())))||null;
      total+=e.size;
      const tr=document.createElement('tr');
      const c=(t,cl)=>{const td=document.createElement('td');td.textContent=t;if(cl)td.className=cl;tr.appendChild(td)};
      const t0=document.createElement('td');
      if(e.p){const cb=document.createElement('input');cb.type='checkbox';cb.checked=!!e.sel;cb.onchange=()=>{e.sel=cb.checked;updGo()};t0.appendChild(cb)}
      tr.appendChild(t0);
      c(k);c(e.name);c(mb(e.size));
      if(!pit){c('(conecta el equipo)','no');c('')}
      else if(e.p){ok++;c(e.p.name);c('✓','ok')}
      else{miss++;c('sin coincidencia','no');c('!','no')}
      tb.appendChild(tr);
    }
  }
  $('sum').textContent=total?('Total del firmware: '+mb(total)+(pit?' · coinciden '+ok+' · sin coincidencia '+miss:'')):'Carga el firmware y conecta el equipo.';
  updGo();
}

const marcar=f=>{ORDER.forEach(k=>(idx[k]||[]).forEach(e=>{e.sel=!!e.p&&f(e)}));render()};

/* ---- FLASHEO ---- */
async function flashEntry(e,onBytes){
  const C=/\.lz4$/i.test(e.name),PS=proto.ps,seqMax=PS*proto.sm,p=e.p;
  await send(pkt(0x66,C?5:0),'Pedir flasheo'+(C?' (LZ4)':''));await resp();
  const nSeq=Math.ceil(e.size/seqMax);
  for(let q=0;q<nSeq;q++){
    const start=q*seqMax,len=Math.min(seqMax,e.size-start),parts=Math.ceil(len/PS),last=q===nSeq-1;
    await wr(pkt(0x66,C?6:2,parts*PS));await resp(30000,true);
    for(let i=0;i<parts;i++){
      if(abort)throw new Error('Cancelado por el usuario');
      const from=e.off+start+i*PS,to=e.off+start+Math.min((i+1)*PS,len);
      const chunk=new Uint8Array(PS);chunk.set(new Uint8Array(await e.file.slice(from,to).arrayBuffer()));
      await wr(chunk);
      const r=await resp(120000,true);
      if(r.data!==i)throw new Error('Índice de parte inesperado: '+r.data+' (esperado '+i+')');
      onBytes(to-from);
    }
    // Estructura final corregida
    const end=p.bin===1?pkt(0x66,C?7:3,1,len,p.bin,p.dev,last?1:0):pkt(0x66,C?7:3,0,len,p.id,0,0,last?1:0);
    await wr(end);await resp(120000);
  }
}

async function flashAll(){
  const list=sel();busy=true;abort=false;updGo();$('bStop').disabled=false;$('pb').style.width='0';
  try{
    if(list.some(e=>/\.lz4$/i.test(e.name))&&!proto.lz4)throw new Error('El equipo no acepta LZ4 directo; extrae los .lz4 antes de cargar');
    const total=list.reduce((a,e)=>a+e.size,0);let done=0;
    await send(pkt(0x64,2,total%4294967296,Math.floor(total/4294967296)),'Total de bytes');await resp();
    log('Total a enviar: '+mb(total),'g');
    for(const e of list){
      log('Flasheando '+e.p.name+' ('+e.name+', '+mb(e.size)+')…');$('pr').textContent=e.p.name;
      const t=Date.now();
      await flashEntry(e,n=>{done+=n;$('pb').style.width=(100*done/total).toFixed(1)+'%'});
      log('✓ '+e.p.name+' ('+((Date.now()-t)/1000).toFixed(0)+' s)','g');
    }
    log('Flasheo completo','g');status('Completado','ok');$('pr').textContent='Completado';
    await send(pkt(0x67,$('rb').checked?1:0),$('rb').checked?'Reiniciar':'Cerrar sesión');await resp().catch(()=>{});
    await cerrar(true);
  }catch(err){
    log('ERROR: '+err.message+'. No desconectes el equipo: sigue en modo descarga.','e');status('Error','err');$('pr').textContent='Error';
  }
  busy=false;$('bStop').disabled=true;updGo();
}

$('bCon').onclick=conectar;$('bInfo').onclick=info;$('bPit').onclick=guardarPit;$('bEnd').onclick=()=>cerrar(false);
$('bAll').onclick=()=>marcar(()=>true);$('bNone').onclick=()=>marcar(()=>false);
$('bTest').onclick=()=>marcar(e=>e.p.name.toUpperCase()==='RECOVERY');
$('fok').onchange=updGo;$('bGo').onclick=flashAll;$('bStop').onclick=()=>{abort=true;log('Cancelando al terminar la parte actual…')};

if(!('serial' in navigator)){status('Navegador no compatible','err');$('bCon').disabled=true;log('Este navegador no tiene Web Serial. Usa Chrome o Edge en la PC.','e')}
else navigator.serial.addEventListener('disconnect',()=>{log('Equipo desconectado');cerrar(true)});