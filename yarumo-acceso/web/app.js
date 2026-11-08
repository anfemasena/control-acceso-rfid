'use strict';
const $=id=>document.getElementById(id);
const state={me:null,people:[],devices:[],enrollments:[],admins:[],report:[]};
const pages={dashboard:'Resumen general',people:'Personas',devices:'Dispositivos',enrollments:'Gestión de huellas',reports:'Reportes y registros',admins:'Administradores'};
function cookie(n){return document.cookie.split('; ').find(x=>x.startsWith(n+'='))?.slice(n.length+1)||'';}
async function api(url,opts={}){
 const headers={'Accept':'application/json',...(opts.body?{'Content-Type':'application/json'}:{}),...(!['GET','HEAD'].includes(opts.method||'GET')?{'X-CSRF-Token':cookie('ya_csrf')}:{}),...opts.headers};
 const res=await fetch(url,{credentials:'same-origin',...opts,headers});
 if(opts.binary){if(!res.ok)throw Error('No fue posible descargar el reporte');return res.blob();}
 const value=await res.json().catch(()=>({error:'Respuesta inválida del servidor'}));
 if(!res.ok)throw Error(value.error||`Error HTTP ${res.status}`);return value;
}
function notify(message,bad=false){const el=$('message');el.textContent=message;el.hidden=false;el.classList.toggle('success',!bad);window.scrollTo({top:0,behavior:'smooth'});}
function authNotify(message,bad=false){const el=$('auth-notice');el.textContent=message;el.classList.toggle('success',!bad);}
function td(text){const node=document.createElement('td');node.textContent=String(text??'');return node;}
function table(target,headers,rows){
 const container=$(target);container.replaceChildren();if(!rows.length){const p=document.createElement('div');p.className='table-empty';p.textContent='Todavía no hay registros para mostrar.';container.append(p);return;}
 const wrap=document.createElement('div');wrap.className='table-wrap';const el=document.createElement('table');el.className='data-table';
 const trh=document.createElement('tr');headers.forEach(h=>{const th=document.createElement('th');th.textContent=h;trh.append(th)});
 const thead=document.createElement('thead');thead.append(trh);el.append(thead);const tbody=document.createElement('tbody');
 rows.forEach(values=>{const tr=document.createElement('tr');values.forEach(v=>{
  if(v instanceof HTMLElement){const cell=document.createElement('td');cell.append(v);tr.append(cell);}else tr.append(td(v));
 });tbody.append(tr)});el.append(tbody);wrap.append(el);container.append(wrap);
}
function status(text,kind=''){const e=document.createElement('span');e.className='pill '+kind;e.textContent=text;return e;}
function action(label,onClick,critical=false){const b=document.createElement('button');b.type='button';b.className='small-button'+(critical?' danger':'');b.textContent=label;b.addEventListener('click',()=>Promise.resolve(onClick()).catch(e=>notify(e.message,true)));return b;}
function datetime(x){return x?new Date(x).toLocaleString('es-CO',{timeZone:'America/Bogota',dateStyle:'medium',timeStyle:'short'}):'—';}
function formBody(form){return Object.fromEntries(new FormData(form).entries());}
function fillOptions(id,values,first){const select=$(id);select.replaceChildren();if(first){const o=document.createElement('option');o.value='';o.textContent=first;select.append(o)}values.forEach(item=>{const o=document.createElement('option');o.value=item.id;o.textContent=item.name;select.append(o)});}
function showAuth(){state.me=null;$('application').hidden=true;$('auth').hidden=false;}
async function openApp(){state.me=await api('/api/me');$('auth').hidden=true;$('application').hidden=false;
 $('organization-label').textContent=state.me.organization.toUpperCase()+' / ESPACIO PRIVADO';$('account-name').textContent=state.me.name;$('account-email').textContent=state.me.email;$('avatar').textContent=state.me.name[0]?.toUpperCase()||'A';
 $('create-admin').hidden=state.me.role!=='owner';await navigate('dashboard');}
async function navigate(id){$('page-title').textContent=pages[id];document.querySelectorAll('.page').forEach(p=>p.hidden=p.id!==`page-${id}`);
 document.querySelectorAll('[data-page]').forEach(p=>p.classList.toggle('current',p.dataset.page===id));
 const loaders={dashboard:loadDashboard,people:loadPeople,devices:loadDevices,enrollments:loadEnrollments,reports:loadReports,admins:loadAdmins};
 try{await loaders[id]();}catch(e){notify(e.message,true)}
}
async function loadDashboard(){const d=await api('/api/dashboard');['people','devices','today','denied'].forEach(k=>$(`metric-${k}`).textContent=d[k]);
 table('latest-events',['Fecha','Persona','Dispositivo','Movimiento','Resultado'],d.recent.map(x=>[datetime(x.occurred_at),x.person||'No identificado',x.device,x.movement,status(x.allowed?'Permitido':'Denegado',x.allowed?'':'off')]));}
async function loadPeople(){const d=await api('/api/people');state.people=d.items;
 table('people-list',['Persona','Código','Estado','Registro','Acción'],d.items.map(x=>[x.name,x.code,status(x.active?'Activo':'Inactivo',x.active?'':'off'),datetime(x.created_at),action(x.active?'Desactivar':'Activar',async()=>{
  if(!confirm(`${x.active?'Desactivar':'Activar'} a ${x.name}?`))return;
  await api(`/api/people/${x.id}`,{method:'PATCH',body:JSON.stringify({active:!x.active})});await loadPeople();
 })]));}
async function loadDevices(){const d=await api('/api/devices');state.devices=d.items;
 table('devices-list',['Dispositivo','Ubicación','Modo','Huellas','Última conexión','Estado','Acciones'],d.items.map(x=>[
 x.name,x.location,x.direction,x.enrolled+'/10',datetime(x.last_seen_at),status(x.active?'Habilitado':'Deshabilitado',x.active?'':'off'),
 x.active?(()=>{const cell=document.createElement('div');cell.style.display='flex';cell.style.gap='6px';cell.append(action('Rotar clave',async()=>{
  if(!confirm('La clave anterior dejará de funcionar. ¿Continuar?'))return;
  const r=await api(`/api/devices/${x.id}/rotate`,{method:'POST'});showToken(r.token);notify('Clave rotada; actualiza el firmware del lector.');
 }),action('Deshabilitar',async()=>{
  if(!confirm('Se bloquearán los registros de este lector. ¿Continuar?'))return;
  await api(`/api/devices/${x.id}/disable`,{method:'POST'});await loadDevices();
 },true));return cell;})():'—']));}
async function loadEnrollments(){const [p,d,e]=await Promise.all([api('/api/people'),api('/api/devices'),api('/api/enrollments')]);
 state.people=p.items;state.devices=d.items;state.enrollments=e.items;
 fillOptions('enroll-person',p.items.filter(x=>x.active));fillOptions('enroll-device',d.items.filter(x=>x.active));
 table('enrollments-list',['Persona','Dispositivo','Casilla AS608','Estado','Fecha','Acción'],e.items.map(x=>[
 x.person_name,x.device_name,x.slot,status(x.status,x.status==='active'?'':x.status==='pending'?'warn':'off'),datetime(x.created_at),
 x.status==='removing'?'Pendiente':action('Retirar huella',async()=>{
  if(!confirm('El lector borrará la plantilla biométrica de esta casilla. ¿Continuar?'))return;
  await api(`/api/enrollments/${x.id}/remove`,{method:'POST'});await loadEnrollments();notify('Orden de borrado enviada al lector.');
 },true)]));}
function reportsUrl(csv=false){const f=new FormData($('filter-reports'));const params=new URLSearchParams();
 for(const [k,v] of f)if(v)params.set(k,v);if(csv)params.set('format','csv');return '/api/reports?'+params;}
async function loadReports(){const [d,r]=await Promise.all([api('/api/devices'),api(reportsUrl())]);state.devices=d.items;state.report=r.items;
 const current=$('report-device').value;fillOptions('report-device',d.items,'Todos mis dispositivos');$('report-device').value=current;
 table('report-results',['Fecha','Persona','Código','Lector','Movimiento','Autorización','Confianza'],r.items.map(x=>[
 datetime(x.occurred_at),x.person,x.code,x.device,x.movement,status(x.allowed?'Sí':'No',x.allowed?'':'off'),x.confidence??'—']));
 if(r.truncated)notify('Se muestran los últimos 5000 registros; reduzca el rango de fechas.',true);
}
async function loadAdmins(){const r=await api('/api/admins');state.admins=r.items;
 table('admins-list',['Nombre','Correo','Rol','Desde'],r.items.map(x=>[x.name,x.email,x.role,datetime(x.created_at)]));}
function showToken(token){$('device-token').textContent=token;$('one-time-token').hidden=false;}
function wireForm(id,fn){$(id).addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;try{await fn(form);}catch(err){if(id==='login-form'||id==='register-form')authNotify(err.message,true);else notify(err.message,true);}finally{button.disabled=false;}})}
function setup(){
 wireForm('login-form',async form=>{const value=await api('/api/login',{method:'POST',body:JSON.stringify(formBody(form))});if(!value.csrf)throw Error('Falta código CSRF');await openApp();});
 wireForm('register-form',async form=>{await api('/api/register',{method:'POST',body:JSON.stringify(formBody(form))});authNotify('Espacio creado. Ahora inicia sesión.',false);$('switch-auth').click();});
 $('switch-auth').addEventListener('click',()=>{const switching=$('register-form').hidden;$('register-form').hidden=!switching;$('login-form').hidden=switching;
 $('auth-title').textContent=switching?'Crear organización':'Ingresa a tu espacio';$('auth-subtitle').textContent=switching?'Tus usuarios y registros estarán separados de los demás.':'Accede a tus dispositivos y reportes.';
 $('switch-auth').textContent=switching?'Ya tengo una cuenta':'Crear un espacio de trabajo nuevo';authNotify('');});
 $('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});}finally{showAuth();}});
 document.querySelectorAll('[data-page]').forEach(x=>x.addEventListener('click',()=>navigate(x.dataset.page)));
 $('refresh-dashboard').addEventListener('click',()=>loadDashboard().catch(e=>notify(e.message,true)));
 wireForm('create-person',async form=>{await api('/api/people',{method:'POST',body:JSON.stringify(formBody(form))});form.reset();await loadPeople();notify('Persona registrada correctamente.');});
 wireForm('create-device',async form=>{const value=await api('/api/devices',{method:'POST',body:JSON.stringify(formBody(form))});form.reset();await loadDevices();showToken(value.token);notify('Dispositivo creado; conserve su token.');});
 $('copy-token').addEventListener('click',async()=>{await navigator.clipboard.writeText($('device-token').textContent);notify('Token copiado. Almacénelo de forma segura.');});
 wireForm('create-enrollment',async form=>{const b=formBody(form);b.slot=Number(b.slot);await api('/api/enrollments',{method:'POST',body:JSON.stringify(b)});await loadEnrollments();notify('Solicitud enviada. El lector capturará la huella dos veces.');});
 wireForm('filter-reports',async()=>{await loadReports()});
 $('export-reports').addEventListener('click',async()=>{try{const b=await api(reportsUrl(true),{binary:true});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='yarumo-acceso-reporte.csv';a.click();URL.revokeObjectURL(u);}catch(e){notify(e.message,true)}});
 wireForm('create-admin',async form=>{await api('/api/admins',{method:'POST',body:JSON.stringify(formBody(form))});form.reset();await loadAdmins();notify('Administrador añadido a tu organización.');});
 api('/api/me').then(()=>openApp()).catch(()=>showAuth());
}
document.addEventListener('DOMContentLoaded',setup);
