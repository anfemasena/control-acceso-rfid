'use strict';
// Yarumo Acceso: aplicación nueva. NO importar la base de datos del control RFID original.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const PORT = Number(process.env.PORT || 3101);
const DATABASE_URL = process.env.YARUMO_DATABASE_URL;
const REGISTRATION_CODE = process.env.YARUMO_REGISTRATION_CODE;
const WEB_DIR = path.join(__dirname, 'web');
const PG_SSL = process.env.YARUMO_DB_SSL === 'require' ? { rejectUnauthorized: true, ca: process.env.YARUMO_DB_CA_CERT || undefined } : undefined;
const pool = DATABASE_URL ? new (require('pg').Pool)({connectionString:DATABASE_URL, ssl:PG_SSL}) : null;
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURES = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const uuid = () => crypto.randomUUID();
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const safeEq = (a,b) => {
  const x=Buffer.from(String(a)); const y=Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x,y);
};
function passhash(password, salt=crypto.randomBytes(16).toString('hex')) {
  return {salt, hash:crypto.scryptSync(password,salt,64).toString('hex')};
}
function validEmail(v) {return String(v||'').trim().toLowerCase();}
function take(v,max=120) {return String(v||'').trim().slice(0,max);}
function fail(status,message){ const e=new Error(message); e.status=status; throw e; }
function uuidValue(v){if(typeof v!=='string'||!UUID_RE.test(v)) fail(400,'Identificador inválido');return v;}
function requireLength(v,min,max,label){const s=take(v,max+1); if(s.length<min||s.length>max)fail(400,`${label}: longitud no válida`);return s;}
function personCode(v){const s=take(v,50);if(!s || !/^[\p{L}\p{N}._-]+$/u.test(s))fail(400,'Código de persona inválido');return s;}
function json(res,status,data,headers={}) {const b=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(b);}
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')).filter(x=>x.length===2));}
function secureCookie(req){return req.socket.encrypted || req.headers['x-forwarded-proto']==='https' ? '; Secure' : '';}
function sessionCookie(req,token,maxAge){return `ya_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie(req)}`;}
function csrfCookie(req,token,maxAge){return `ya_csrf=${token}; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie(req)}`;}
function guardOrigin(req){
  const origin=req.headers.origin;
  if(!origin)return;
  const host=req.headers.host;
  const parsed=new URL(origin);
  if(parsed.host!==host || !['http:','https:'].includes(parsed.protocol)) fail(403,'Origen no permitido');
}
function body(req,limit=16000) {return new Promise((resolve,reject)=>{
  let s='';let stopped=false;
  req.on('data',c=>{s+=c;if(s.length>limit&&!stopped){stopped=true;reject(Object.assign(new Error('Solicitud demasiado grande'),{status:413}));req.destroy();}});
  req.on('end',()=>{if(stopped)return;try{resolve(s?JSON.parse(s):{});}catch{reject(Object.assign(new Error('JSON no válido'),{status:400}));}});
  req.on('error',reject);
});}
function publicError(err){ if(err.status)return err.status;
  if(err.code==='23505')return 409;
  if(err.code==='23503'||err.code==='23514'||err.code==='22P02')return 400;
  return 500;
}
async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function initialize(){
  if(!DATABASE_URL)throw Error('YARUMO_DATABASE_URL obligatorio: use PostgreSQL NUEVO, no el de Fátima');
  if(!REGISTRATION_CODE || REGISTRATION_CODE.length<16)throw Error('YARUMO_REGISTRATION_CODE: código de invitación de 16+ caracteres obligatorio');
  const schema=fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8');
  await pool.query(schema);
}
function checkLoginIP(req){
  const ip=req.socket.remoteAddress||'unknown';const item=LOGIN_FAILURES.get(ip);
  if(item && item.until>Date.now())fail(429,'Demasiados intentos, pruebe más tarde');
  return ip;
}
function badLogin(ip){const old=LOGIN_FAILURES.get(ip);const count=(old&&old.expiry>Date.now()?old.count:0)+1;
  LOGIN_FAILURES.set(ip,{count,expiry:Date.now()+15*60000,until:count>=8?Date.now()+15*60000:0});
}
function releaseLogin(ip){LOGIN_FAILURES.delete(ip);}
async function session(req){
  const token=cookies(req).ya_session;if(!token)return null;
  const q=await pool.query(`SELECT s.csrf_hash,a.id AS admin_id,a.org_id,a.name,a.email,a.role,o.name AS organization
    FROM ya_sessions s JOIN ya_admins a ON a.id=s.admin_id JOIN ya_organizations o ON o.id=a.org_id
    WHERE s.token_hash=$1 AND s.expires_at>now()`,[sha256(token)]);
  return q.rows[0]||null;
}
async function auth(req){const s=await session(req);if(!s)fail(401,'Sesión no válida');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){
    const csrf=req.headers['x-csrf-token'];if(!csrf || !safeEq(sha256(csrf),s.csrf_hash))fail(403,'Token de seguridad ausente o inválido');
  }return s;
}
async function deviceAuth(req){
  const token=(req.headers.authorization||'').match(/^Bearer ([A-Za-z0-9_-]{40,})$/)?.[1];
  if(!token)fail(401,'Identificador de dispositivo requerido');
  const q=await pool.query('SELECT id,org_id,name,direction FROM ya_devices WHERE token_hash=$1 AND active=true',[sha256(token)]);
  if(!q.rowCount)fail(401,'Dispositivo sin autorización');
  return q.rows[0];
}
function key(){return crypto.randomBytes(32).toString('base64url');}
function dateBound(v,end=false){
  if(!v)return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v))fail(400,'Fecha inválida, use AAAA-MM-DD');
  const date=new Date(`${v}${end?'T23:59:59.999':'T00:00:00.000'}-05:00`);
  if(!Number.isFinite(date.getTime()) || new Date(date.getTime()-5*60*60000).toISOString().slice(0,10)!==v)fail(400,'Fecha inválida');
  return date.toISOString();
}
function csvCell(v){let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;}
async function serveStatic(req,res,pathname){
  const files={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
  const file=files[pathname];if(!file)return json(res,404,{error:'No encontrado'});
  const b=fs.readFileSync(path.join(WEB_DIR,file));
  const mime=file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(b);
}
async function handle(req,res){
  const u=new URL(req.url,'http://localhost'); const method=req.method,route=u.pathname;
  if(!route.startsWith('/api/'))return serveStatic(req,res,route);
  if(method==='GET'&&route==='/api/health')return json(res,200,{ok:true,service:'yarumo-acceso',version:'0.1.0'});
  // Previene peticiones cross-origin antes de procesar credenciales o mutaciones.
  if(!['GET','HEAD'].includes(method))guardOrigin(req);
  if(method==='POST'&&route==='/api/register'){
    const b=await body(req);
    if(!safeEq(take(b.registrationCode,256),REGISTRATION_CODE))fail(403,'Código de invitación incorrecto');
    const orgName=requireLength(b.organization,3,100,'Organización');
    const name=requireLength(b.name,3,100,'Nombre');const email=validEmail(b.email);
    if(!EMAIL_RE.test(email)||email.length>200)fail(400,'Correo inválido');
    if(typeof b.password!=='string'||b.password.length<12||b.password.length>128)fail(400,'Use una contraseña de 12 a 128 caracteres');
    const hash=passhash(b.password), orgId=uuid(),adminId=uuid();
    await tx(async c=>{
      await c.query('INSERT INTO ya_organizations(id,name) VALUES($1,$2)',[orgId,orgName]);
      await c.query(`INSERT INTO ya_admins(id,org_id,name,email,pass_salt,pass_hash,role)
        VALUES($1,$2,$3,$4,$5,$6,'owner')`,[adminId,orgId,name,email,hash.salt,hash.hash]);
    });
    return json(res,201,{ok:true,message:'Organización y administrador creados'});
  }
  if(method==='POST'&&route==='/api/login'){
    const ip=checkLoginIP(req),b=await body(req);
    const email=validEmail(b.email),pass=String(b.password||'');
    const q=await pool.query('SELECT id,pass_salt,pass_hash FROM ya_admins WHERE email=$1',[email]);
    const expected=q.rows[0]?q.rows[0].pass_hash:passhash('secreto-dummy','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').hash;
    const actual=passhash(pass,q.rows[0]?.pass_salt||'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').hash;
    if(!q.rows[0]||!safeEq(actual,expected)){badLogin(ip);fail(401,'Credenciales incorrectas');}
    releaseLogin(ip);
    const token=key(),csrf=key();
    await pool.query('INSERT INTO ya_sessions(token_hash,admin_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)',
      [sha256(token),q.rows[0].id,sha256(csrf),new Date(Date.now()+SESSION_MS).toISOString()]);
    return json(res,200,{ok:true,csrf},{'Set-Cookie':[sessionCookie(req,token,SESSION_MS/1000),csrfCookie(req,csrf,SESSION_MS/1000)]});
  }
  if(method==='GET'&&route==='/api/me'){
    const s=await session(req);if(!s)return json(res,401,{error:'Sin sesión'});
    return json(res,200,{name:s.name,email:s.email,role:s.role,organization:s.organization});
  }
  if(route.startsWith('/api/device/')){
    const dev=await deviceAuth(req);
    if(method==='GET'&&route==='/api/device/commands'){
      const r=await tx(async c=>{
        const q=await c.query(`SELECT c.id,c.kind,e.slot,p.name AS person
          FROM ya_commands c JOIN ya_enrollments e ON c.enrollment_id=e.id
          JOIN ya_people p ON p.id=e.person_id
          WHERE c.device_id=$1 AND c.org_id=$2 AND
          (c.state='pending' OR (c.state='processing' AND c.delivered_at<now()-interval '2 minutes'))
          ORDER BY c.created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,[dev.id,dev.org_id]);
        if(q.rowCount)await c.query(`UPDATE ya_commands SET state='processing',attempts=attempts+1,delivered_at=now() WHERE id=$1`,[q.rows[0].id]);
        return q.rows;
      });
      await pool.query('UPDATE ya_devices SET last_seen_at=now() WHERE id=$1',[dev.id]);
      return json(res,200,{commands:r});
    }
    const cm=route.match(/^\/api\/device\/commands\/([0-9a-f-]+)\/result$/i);
    if(method==='POST'&&cm){
      const id=uuidValue(cm[1]),b=await body(req);
      if(typeof b.success!=='boolean')fail(400,'Estado de comando inválido');
      const outcome=await tx(async c=>{
        const q=await c.query('SELECT id,enrollment_id,kind,state FROM ya_commands WHERE id=$1 AND device_id=$2 AND org_id=$3 FOR UPDATE',[id,dev.id,dev.org_id]);
        if(!q.rowCount)fail(404,'Comando no encontrado');
        const command=q.rows[0];if(['done','failed'].includes(command.state))return command.state;
        const state=b.success?'done':'failed';
        await c.query('UPDATE ya_commands SET state=$2,error=$3,completed_at=now() WHERE id=$1',[id,state,take(b.error,200)]);
        if(command.kind==='delete'){
          if(b.success)await c.query('DELETE FROM ya_enrollments WHERE id=$1 AND org_id=$2',[command.enrollment_id,dev.org_id]);
          else await c.query(`UPDATE ya_enrollments SET status='active' WHERE id=$1 AND org_id=$2`,[command.enrollment_id,dev.org_id]);
        }else{
          await c.query(`UPDATE ya_enrollments SET status=$2 WHERE id=$1 AND org_id=$3`,
            [command.enrollment_id,b.success?'active':'failed',dev.org_id]);
        }
        return state;
      });
      return json(res,200,{ok:true,state:outcome});
    }
    if(method==='POST'&&route==='/api/device/events'){
      const b=await body(req); const eventId=uuidValue(b.eventId);const slot=Number(b.slot);
      if(!Number.isInteger(slot)||slot<0||slot>10)fail(400,'Casilla de huella inválida');
      const confidence=b.confidence==null?null:Number(b.confidence);
      if(confidence!==null && (!Number.isInteger(confidence)||confidence<0||confidence>65535))fail(400,'Confianza inválida');
      const when=b.occurredAt?new Date(b.occurredAt):new Date();
      if(!Number.isFinite(when.getTime())||when>Date.now()+300000||when<Date.now()-30*86400000)fail(400,'Marca de tiempo fuera de rango');
      const out=await tx(async c=>{
        // Serializa duplicados del mismo lector y la alternancia de movimientos.
        await c.query('SELECT id FROM ya_devices WHERE id=$1 FOR UPDATE',[dev.id]);
        const previous=await c.query('SELECT id,allowed,movement FROM ya_events WHERE device_id=$1 AND device_event_id=$2',[dev.id,eventId]);
        if(previous.rowCount)return {...previous.rows[0],duplicate:true};
        const q=await c.query(`SELECT e.person_id,p.active FROM ya_enrollments e JOIN ya_people p ON p.id=e.person_id AND p.org_id=e.org_id
            WHERE e.org_id=$1 AND e.device_id=$2 AND e.slot=$3 AND e.status='active'`,[dev.org_id,dev.id,slot]);
        const person=q.rows[0],allowed=Boolean(person?.active);
        let movement='denegado';
        if(allowed){
          if(dev.direction==='alterno'){
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[dev.org_id+':'+person.person_id]);
            const last=await c.query(`SELECT movement FROM ya_events WHERE org_id=$1 AND person_id=$2 AND allowed=true ORDER BY occurred_at DESC,received_at DESC LIMIT 1`,[dev.org_id,person.person_id]);
            movement=last.rows[0]?.movement==='ingreso'?'salida':'ingreso';
          }else{movement=dev.direction;}
        }
        const id=uuid();
        await c.query(`INSERT INTO ya_events(id,org_id,device_id,device_event_id,person_id,slot,confidence,allowed,movement,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,dev.org_id,dev.id,eventId,person?.person_id||null,slot,confidence,allowed,movement,when.toISOString()]);
        return {id,allowed,movement,duplicate:false};
      });
      await pool.query('UPDATE ya_devices SET last_seen_at=now() WHERE id=$1',[dev.id]);
      return json(res,200,out);
    }
    fail(404,'Ruta de dispositivo desconocida');
  }
  if(method==='POST'&&route==='/api/logout'){
    const s=await auth(req);await pool.query('DELETE FROM ya_sessions WHERE admin_id=$1 AND token_hash=$2',[s.admin_id,sha256(cookies(req).ya_session)]);
    return json(res,200,{ok:true},{'Set-Cookie':[sessionCookie(req,'',0),csrfCookie(req,'',0)]});
  }
  const s=await auth(req); const org=s.org_id;
  if(method==='GET'&&route==='/api/dashboard'){
    const [people,devices,today,denied,latest]=await Promise.all([
      pool.query('SELECT count(*)::int AS n FROM ya_people WHERE org_id=$1 AND active=true',[org]),
      pool.query('SELECT count(*)::int AS n FROM ya_devices WHERE org_id=$1 AND active=true',[org]),
      pool.query(`SELECT count(*)::int AS n FROM ya_events WHERE org_id=$1 AND allowed=true AND (occurred_at AT TIME ZONE 'America/Bogota')::date=(now() AT TIME ZONE 'America/Bogota')::date`,[org]),
      pool.query('SELECT count(*)::int AS n FROM ya_events WHERE org_id=$1 AND allowed=false',[org]),
      pool.query(`SELECT e.occurred_at,e.movement,e.allowed,p.name AS person,d.name AS device FROM ya_events e LEFT JOIN ya_people p ON e.person_id=p.id JOIN ya_devices d ON e.device_id=d.id WHERE e.org_id=$1 ORDER BY e.occurred_at DESC LIMIT 12`,[org])
    ]);
    return json(res,200,{people:people.rows[0].n,devices:devices.rows[0].n,today:today.rows[0].n,denied:denied.rows[0].n,recent:latest.rows});
  }
  if(method==='GET'&&route==='/api/admins'){
    const r=await pool.query('SELECT id,name,email,role,created_at FROM ya_admins WHERE org_id=$1 ORDER BY created_at',[org]);return json(res,200,{items:r.rows});
  }
  if(method==='POST'&&route==='/api/admins'){
    if(s.role!=='owner')fail(403,'Solo el titular puede invitar administradores');
    const b=await body(req),name=requireLength(b.name,3,100,'Nombre'),email=validEmail(b.email);
    if(!EMAIL_RE.test(email)||email.length>200)fail(400,'Correo inválido');
    if(typeof b.password!=='string'||b.password.length<12)fail(400,'Contraseña de mínimo 12 caracteres');
    const p=passhash(b.password);
    await pool.query(`INSERT INTO ya_admins(id,org_id,name,email,pass_salt,pass_hash,role) VALUES($1,$2,$3,$4,$5,$6,'admin')`,[uuid(),org,name,email,p.salt,p.hash]);
    return json(res,201,{ok:true});
  }
  if(method==='GET'&&route==='/api/people'){
    const r=await pool.query('SELECT id,name,code,active,created_at FROM ya_people WHERE org_id=$1 ORDER BY created_at DESC',[org]);return json(res,200,{items:r.rows});
  }
  if(method==='POST'&&route==='/api/people'){
    const b=await body(req),name=requireLength(b.name,2,120,'Nombre'),code=personCode(b.code);
    const id=uuid();await pool.query('INSERT INTO ya_people(id,org_id,name,code) VALUES($1,$2,$3,$4)',[id,org,name,code]);
    return json(res,201,{id,name,code,active:true});
  }
  const pm=route.match(/^\/api\/people\/([0-9a-f-]+)$/i);
  if(method==='PATCH'&&pm){const id=uuidValue(pm[1]),b=await body(req);
    if(typeof b.active!=='boolean')fail(400,'Estado inválido');
    const r=await pool.query('UPDATE ya_people SET active=$1 WHERE id=$2 AND org_id=$3 RETURNING id,active',[b.active,id,org]);
    if(!r.rowCount)fail(404,'Persona no encontrada');return json(res,200,r.rows[0]);
  }
  if(method==='GET'&&route==='/api/devices'){
    const r=await pool.query(`SELECT d.id,d.name,d.location,d.direction,d.active,d.last_seen_at,d.created_at,
      (SELECT count(*)::int FROM ya_enrollments e WHERE e.device_id=d.id AND e.status='active') AS enrolled
      FROM ya_devices d WHERE d.org_id=$1 ORDER BY d.created_at DESC`,[org]);return json(res,200,{items:r.rows});
  }
  if(method==='POST'&&route==='/api/devices'){
    const b=await body(req),name=requireLength(b.name,3,100,'Dispositivo');
    const direction=['ingreso','salida','alterno'].includes(b.direction)?b.direction:'alterno';
    const token=key(),id=uuid();
    await pool.query(`INSERT INTO ya_devices(id,org_id,name,location,direction,token_hash) VALUES($1,$2,$3,$4,$5,$6)`,[id,org,name,take(b.location,150),direction,sha256(token)]);
    return json(res,201,{id,name,direction,token,warning:'Conserve el token: se muestra una sola vez'});
  }
  const dm=route.match(/^\/api\/devices\/([0-9a-f-]+)\/(rotate|disable)$/i);
  if(method==='POST'&&dm){const id=uuidValue(dm[1]);
    if(dm[2]==='rotate'){
      const token=key();const r=await pool.query('UPDATE ya_devices SET token_hash=$1 WHERE id=$2 AND org_id=$3 AND active=true RETURNING id',[sha256(token),id,org]);
      if(!r.rowCount)fail(404,'Dispositivo no encontrado');return json(res,200,{id,token,warning:'Clave anterior invalidada'});
    }
    const r=await pool.query('UPDATE ya_devices SET active=false WHERE id=$1 AND org_id=$2 RETURNING id',[id,org]);
    if(!r.rowCount)fail(404,'Dispositivo no encontrado');return json(res,200,{id,active:false});
  }
  if(method==='GET'&&route==='/api/enrollments'){
    const r=await pool.query(`SELECT e.id,e.device_id,e.person_id,e.slot,e.status,e.created_at,
      p.name AS person_name,d.name AS device_name FROM ya_enrollments e
      JOIN ya_people p ON p.id=e.person_id JOIN ya_devices d ON d.id=e.device_id
      WHERE e.org_id=$1 ORDER BY e.created_at DESC`,[org]);return json(res,200,{items:r.rows});
  }
  if(method==='POST'&&route==='/api/enrollments'){
    const b=await body(req),deviceId=uuidValue(b.deviceId),personId=uuidValue(b.personId),slot=Number(b.slot);
    if(!Number.isInteger(slot)||slot<1||slot>10)fail(400,'El AS608 admite 10 casillas en este proyecto (1–10)');
    const out=await tx(async c=>{
      const dev=await c.query('SELECT id FROM ya_devices WHERE id=$1 AND org_id=$2 AND active=true FOR UPDATE',[deviceId,org]);
      const person=await c.query('SELECT id FROM ya_people WHERE id=$1 AND org_id=$2 AND active=true',[personId,org]);
      if(!dev.rowCount||!person.rowCount)fail(404,'Dispositivo o persona no disponible');
      const count=await c.query(`SELECT count(*)::int AS n FROM ya_enrollments WHERE device_id=$1 AND status IN ('active','pending')`,[deviceId]);
      if(count.rows[0].n>=10)fail(409,'Máximo 10 huellas por dispositivo');
      const id=uuid(),cmd=uuid();
      await c.query(`INSERT INTO ya_enrollments(id,org_id,device_id,person_id,slot,status) VALUES($1,$2,$3,$4,$5,'pending')`,[id,org,deviceId,personId,slot]);
      await c.query(`INSERT INTO ya_commands(id,org_id,device_id,enrollment_id,kind) VALUES($1,$2,$3,$4,'enroll')`,[cmd,org,deviceId,id]);
      return {id,commandId:cmd,status:'pending'};
    });return json(res,201,out);
  }
  const em=route.match(/^\/api\/enrollments\/([0-9a-f-]+)\/remove$/i);
  if(method==='POST'&&em){
    const id=uuidValue(em[1]);
    const out=await tx(async c=>{
      const q=await c.query(`SELECT e.device_id,e.status FROM ya_enrollments e JOIN ya_devices d ON e.device_id=d.id
        WHERE e.id=$1 AND e.org_id=$2 AND d.active=true FOR UPDATE OF e`,[id,org]);
      if(!q.rowCount)fail(404,'Huella no encontrada o dispositivo deshabilitado');
      if(q.rows[0].status==='removing')fail(409,'Eliminación en curso');
      await c.query(`UPDATE ya_commands SET state='failed',error='Cancelado por administración',completed_at=now()
        WHERE enrollment_id=$1 AND state IN ('pending','processing')`,[id]);
      await c.query(`UPDATE ya_enrollments SET status='removing' WHERE id=$1`,[id]);
      const commandId=uuid();
      await c.query(`INSERT INTO ya_commands(id,org_id,device_id,enrollment_id,kind)
        VALUES($1,$2,$3,$4,'delete')`,[commandId,org,q.rows[0].device_id,id]);
      return {commandId,status:'removing'};
    });
    return json(res,202,out);
  }
  if(method==='GET'&&route==='/api/reports'){
    const from=dateBound(u.searchParams.get('from'));const to=dateBound(u.searchParams.get('to'),true);
    if(from&&to&&from>to)fail(400,'Rango de fechas inválido');
    const deviceId=u.searchParams.get('deviceId');if(deviceId)uuidValue(deviceId);
    const args=[org,from,to,deviceId];
    const where=`e.org_id=$1 AND ($2::timestamptz IS NULL OR e.occurred_at >= $2) AND ($3::timestamptz IS NULL OR e.occurred_at <= $3) AND ($4::uuid IS NULL OR e.device_id=$4)`;
    const q=await pool.query(`SELECT e.occurred_at,e.received_at,e.movement,e.allowed,e.slot,e.confidence,
      coalesce(p.name,'No identificado') AS person, coalesce(p.code,'') AS code,d.name AS device
      FROM ya_events e LEFT JOIN ya_people p ON p.id=e.person_id JOIN ya_devices d ON d.id=e.device_id
      WHERE ${where} ORDER BY e.occurred_at DESC LIMIT 5000`,args);
    if(u.searchParams.get('format')==='csv'){
      const rows=[['Fecha evento','Fecha recepción','Persona','Código','Dispositivo','Movimiento','Autorizado','Casilla','Confianza'],
        ...q.rows.map(x=>[x.occurred_at?.toISOString(),x.received_at?.toISOString(),x.person,x.code,x.device,x.movement,x.allowed?'Sí':'No',x.slot,x.confidence])];
      const csv='\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="yarumo-acceso-reporte.csv"','Cache-Control':'no-store'});return res.end(csv);
    }
    return json(res,200,{items:q.rows,truncated:q.rowCount===5000});
  }
  fail(404,'Ruta no encontrada');
}
async function start(){await initialize();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{await handle(req,res);}catch(e){const status=publicError(e);if(status>=500)console.error(e);
      if(!res.headersSent)json(res,status,{error:status===500?'Error interno de la plataforma':e.message});
    }
  });
  server.listen(PORT,()=>console.log(`Yarumo Acceso (laboratorio) en puerto ${PORT}`));return server;
}
if(require.main===module)start().catch(e=>{console.error(e.message);process.exitCode=1;pool?.end()});
module.exports={start,passhash,safeEq,sha256,dateBound,csvCell};
