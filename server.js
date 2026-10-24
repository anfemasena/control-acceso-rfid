const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Fatima2026*";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const sessions = new Set();
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: ["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL).hostname) ? false : { rejectUnauthorized: false },
    })
  : null;
// Evitar perdida silenciosa de datos usando almacenamiento efimero en Render.
if ((process.env.RENDER || process.env.RENDER_SERVICE_ID) && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL obligatorio en Render: no se guardaran registros en /tmp");
}
let databaseReady = false;
let databaseMutationQueue = Promise.resolve();

function normalizeUid(value) {
  return String(value || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

function reverseUidBytes(uid) {
  const normalized = normalizeUid(uid);
  if (normalized.length % 2 !== 0) return normalized;
  return normalized.match(/../g).reverse().join("");
}

function uidVariants(uid) {
  return [...new Set([normalizeUid(uid), reverseUidBytes(uid)])].filter(Boolean);
}

function emptyDatabase() {
  return { personnel: [], cards: [], schedules: [], events: [] };
}

function migrateDatabase(database) {
  const migrated = { ...emptyDatabase(), ...database };
  if (Array.isArray(database.users) && migrated.personnel.length === 0 && migrated.cards.length === 0) {
    database.users.forEach((user) => {
      const personId = crypto.randomUUID();
      migrated.personnel.push({
        id: personId,
        document: "",
        name: user.name || "Funcionario",
        position: "",
        group: "",
        phone: "",
        email: "",
        address: "",
        photo: "",
        active: user.active !== false,
        createdAt: user.createdAt || new Date().toISOString(),
      });
      migrated.cards.push({
        id: crypto.randomUUID(),
        uid: normalizeUid(user.uid),
        personnelId: personId,
        active: user.active !== false,
        createdAt: user.createdAt || new Date().toISOString(),
      });
    });
  }
  delete migrated.users;
  return migrated;
}

async function ensureDatabase() {
  if (!pool || databaseReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO app_state (id, data)
     VALUES ('main', $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(emptyDatabase())]
  );
  databaseReady = true;
}

async function readDatabase() {
  if (pool) {
    await ensureDatabase();
    const result = await pool.query("SELECT data FROM app_state WHERE id = 'main'");
    return migrateDatabase(result.rows[0]?.data || emptyDatabase());
  }

  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(emptyDatabase(), null, 2));
  }
  const raw = fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, "");
  return migrateDatabase(JSON.parse(raw));
}

async function writeDatabase(database) {
  if (pool) {
    await ensureDatabase();
    await pool.query(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES ('main', $1::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(database)]
    );
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(database, null, 2));
  fs.renameSync(temporary, DB_FILE);
}

async function mutateDatabase(mutator) {
  if (pool) {
    // Un bloqueo de fila en PostgreSQL protege incluso entre instancias Node.
    // La mutacion y escritura forman una sola transaccion.
    await ensureDatabase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT data FROM app_state WHERE id = 'main' FOR UPDATE");
      if (locked.rowCount !== 1) throw new Error("No se encontro el estado principal");
      const database = migrateDatabase(locked.rows[0].data);
      const result = await mutator(database);
      await client.query(
        "UPDATE app_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 'main'",
        [JSON.stringify(database)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { console.error(rollbackError); }
      throw error;
    } finally {
      client.release();
    }
  }

  // El modo local mantiene una cola de escritura y reemplazo atomico.
  const operation = databaseMutationQueue.then(async () => {
    const database = await readDatabase();
    const result = await mutator(database);
    await writeDatabase(database);
    return result;
  });
  databaseMutationQueue = operation.catch(() => {});
  return operation;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || "")
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter((parts) => parts.length === 2 && parts[0])
  );
}

function isAuthenticated(request) {
  const token = parseCookies(request).access_session;
  return Boolean(token && sessions.has(token));
}

function requireAuthenticated(request, response) {
  if (isAuthenticated(request)) return true;
  sendJson(response, 401, { error: "Debe iniciar sesion" });
  return false;
}

function setSessionCookie(response, token) {
  response.setHeader("Set-Cookie", `access_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", "access_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_500_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON invalido"));
      }
    });
    request.on("error", reject);
  });
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) {
    sendJson(response, 403, { error: "Acceso denegado" });
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "No encontrado" });
      return;
    }
    const extensions = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    };
    response.writeHead(200, { "Content-Type": extensions[path.extname(filePath)] || "application/octet-stream" });
    response.end(content);
  });
}

function personName(database, personnelId) {
  return database.personnel.find((person) => person.id === personnelId)?.name || "Sin asignar";
}

function enrichCards(database) {
  return database.cards.map((card) => ({
    ...card,
    alternateUid: reverseUidBytes(card.uid),
    personnelName: personName(database, card.personnelId),
  }));
}

function findCardByUid(database, uid) {
  const variants = uidVariants(uid);
  return database.cards.find((card) => variants.includes(card.uid));
}

function assignedSchedules(database, person) {
  return database.schedules.filter((schedule) => {
    if (!schedule.active) return false;
    if (schedule.assignmentType === "person") return schedule.assignmentId === person.id;
    return schedule.assignmentId === person.group && Boolean(person.group);
  });
}

// Las fechas de acceso deben calcularse en el huso horario de Colombia.
const ATTENDANCE_TIME_ZONE = "America/Bogota";
const attendanceClock = new Intl.DateTimeFormat("en-US", {
  timeZone: ATTENDANCE_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function attendanceParts(date) {
  const parts = Object.fromEntries(attendanceClock.formatToParts(date)
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdayNumber = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdayNumber[parts.weekday],
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function isInsideSchedule(schedule, date) {
  const local = attendanceParts(date);
  const day = String(local.weekday);
  if (!schedule.days.includes(day)) return false;
  const minutes = local.hour * 60 + local.minute;
  const [startHour, startMinute] = schedule.startTime.split(":").map(Number);
  const [endHour, endMinute] = schedule.endTime.split(":").map(Number);
  return minutes >= startHour * 60 + startMinute && minutes <= endHour * 60 + endMinute;
}

function accessAllowed(database, person, now) {
  if (!person || !person.active) return false;
  const schedules = assignedSchedules(database, person);
  return schedules.length === 0 || schedules.some((schedule) => isInsideSchedule(schedule, now));
}

function nextMovement(database, personnelId, explicitMovement) {
  if (explicitMovement === "ingreso" || explicitMovement === "salida") return explicitMovement;
  const last = database.events.find((event) => event.personnelId === personnelId && event.allowed);
  return last?.movement === "ingreso" ? "salida" : "ingreso";
}

function dashboard(database) {
  const days = [];
  const today = new Date();
  for (let index = 6; index >= 0; index--) {
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    const key = attendanceParts(date).key;
    const label = date.toLocaleDateString("es-CO", { timeZone: ATTENDANCE_TIME_ZONE, weekday: "short", day: "2-digit" });
    const events = database.events.filter((event) => attendanceParts(new Date(event.createdAt)).key === key && event.allowed);
    days.push({
      label,
      ingreso: events.filter((event) => event.movement === "ingreso").length,
      salida: events.filter((event) => event.movement === "salida").length,
    });
  }

  const todayKey = attendanceParts(today).key;
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const events = database.events.filter((event) => {
      const date = new Date(event.createdAt);
      const local = attendanceParts(date);
      return local.key === todayKey && local.hour === hour && event.allowed;
    });
    return {
      label: `${String(hour).padStart(2, "0")}:00`,
      total: events.length,
    };
  });

  return {
    totals: {
      personnel: database.personnel.length,
      activeCards: database.cards.filter((card) => card.active).length,
      today: database.events.filter((event) => attendanceParts(new Date(event.createdAt)).key === todayKey && event.allowed).length,
      denied: database.events.filter((event) => !event.allowed).length,
    },
    days,
    hours,
    recent: database.events.slice(0, 12),
  };
}

async function handleApi(request, response, url) {
  const database = await readDatabase();

  if (request.method === "GET" && url.pathname === "/api/session") {
    sendJson(response, 200, { authenticated: isAuthenticated(request) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "control-acceso-rfid" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(request);
    if (String(body.username || "").trim() !== ADMIN_USER || String(body.password || "") !== ADMIN_PASSWORD) {
      sendJson(response, 401, { error: "Usuario o contrasena incorrectos" });
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.add(token);
    setSessionCookie(response, token);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    const token = parseCookies(request).access_session;
    if (token) sessions.delete(token);
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/access") {
    const body = await readJson(request);
    const uid = normalizeUid(body.uid);
    if (!uid) {
      sendJson(response, 400, { error: "UID requerido" });
      return;
    }
    // Compatibilidad con lectores existentes sin requestId.
    const requestId = String(body.requestId || "").trim().slice(0, 96);
    const device = String(body.device || "ESP32").slice(0, 100);
    const event = await mutateDatabase(async (currentDatabase) => {
      // Todos los reintentos de una misma lectura entregan la misma respuesta.
      if (requestId) {
        const existing = currentDatabase.events.find((entry) =>
          entry.requestId === requestId && entry.device === device
        );
        if (existing) {
          if (existing.uid !== uid) {
            const error = new Error("requestId reutilizado para otra tarjeta");
            error.statusCode = 409;
            throw error;
          }
          return existing;
        }
      }
      // Evitar marcaciones accidentales dobles en el mismo lector durante 4 s.
      const recent = currentDatabase.events.find((entry) =>
        entry.uid === uid && entry.device === device &&
        Date.now() - new Date(entry.createdAt).getTime() >= 0 &&
        Date.now() - new Date(entry.createdAt).getTime() < 4000
      );
      if (recent && (!body.movement || body.movement === recent.movement)) return recent;
      const card = findCardByUid(currentDatabase, uid);
      const person = card ? currentDatabase.personnel.find((item) => item.id === card.personnelId) : null;
      const now = new Date();
      const allowed = Boolean(card?.active && accessAllowed(currentDatabase, person, now));
      const accessEvent = {
        id: crypto.randomUUID(),
        uid,
        cardId: card?.id || "",
        personnelId: person?.id || "",
        name: person?.name || "Tarjeta desconocida",
        movement: allowed ? nextMovement(currentDatabase, person.id, body.movement) : "denegado",
        allowed,
        device,
        requestId,
        createdAt: now.toISOString(),
      };
      currentDatabase.events.unshift(accessEvent);
      // Conservar el historial completo (no truncar los eventos automaticamente).
      return accessEvent;
    });
    sendJson(response, 200, {
      allowed: event.allowed,
      name: event.name,
      movement: event.movement,
      eventId: event.id,
      createdAt: event.createdAt,
    });
    return;
  }

  if (!requireAuthenticated(request, response)) return;

  // Diagnostico administrativo del almacenamiento (sin mostrar credenciales).
  if (request.method === "GET" && url.pathname === "/api/storage-status") {
    sendJson(response, 200, {
      storage: pool ? "postgresql" : "archivo-local",
      persistent: Boolean(pool),
      personnel: database.personnel.length,
      cards: database.cards.length,
      events: database.events.length,
      lastEventAt: database.events[0]?.createdAt || null,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, dashboard(database));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    sendJson(response, 200, database.events.slice(0, 300));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/personnel") {
    sendJson(response, 200, database.personnel);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/cards") {
    sendJson(response, 200, enrichCards(database));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/schedules") {
    sendJson(response, 200, database.schedules);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/personnel") {
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    if (!name) {
      sendJson(response, 400, { error: "El nombre es obligatorio" });
      return;
    }
    const person = await mutateDatabase(async (currentDatabase) => {
      const newPerson = {
        id: crypto.randomUUID(),
        document: String(body.document || "").trim(),
        name,
        position: String(body.position || "").trim(),
        group: String(body.group || "").trim(),
        phone: String(body.phone || "").trim(),
        email: String(body.email || "").trim(),
        address: String(body.address || "").trim(),
        photo: String(body.photo || ""),
        active: body.active !== false,
        createdAt: new Date().toISOString(),
      };
      currentDatabase.personnel.unshift(newPerson);
      return newPerson;
    });
    sendJson(response, 201, person);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/cards") {
    const body = await readJson(request);
    const uid = normalizeUid(body.uid);
    const personnelId = String(body.personnelId || "");
    if (!uid || !database.personnel.some((person) => person.id === personnelId)) {
      sendJson(response, 400, { error: "UID y funcionario valido son obligatorios" });
      return;
    }
    const variants = uidVariants(uid);
    if (database.cards.some((card) => variants.includes(card.uid) || uidVariants(card.uid).includes(uid))) {
      sendJson(response, 409, { error: "La tarjeta ya esta registrada" });
      return;
    }
    const card = await mutateDatabase(async (currentDatabase) => {
      if (currentDatabase.cards.some((item) => variants.includes(item.uid) || uidVariants(item.uid).includes(uid))) {
        const error = new Error("La tarjeta ya esta registrada");
        error.statusCode = 409;
        throw error;
      }
      const newCard = { id: crypto.randomUUID(), uid, personnelId, active: body.active !== false, createdAt: new Date().toISOString() };
      currentDatabase.cards.unshift(newCard);
      return newCard;
    });
    sendJson(response, 201, { ...card, personnelName: personName(database, personnelId) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/schedules") {
    const body = await readJson(request);
    const assignmentType = body.assignmentType === "group" ? "group" : "person";
    const schedule = {
      id: crypto.randomUUID(),
      name: String(body.name || "").trim() || "Horario",
      assignmentType,
      assignmentId: String(body.assignmentId || "").trim(),
      startTime: String(body.startTime || "07:00"),
      endTime: String(body.endTime || "17:00"),
      days: Array.isArray(body.days) ? body.days.map(String) : ["1", "2", "3", "4", "5"],
      active: body.active !== false,
      createdAt: new Date().toISOString(),
    };
    if (!schedule.assignmentId) {
      sendJson(response, 400, { error: "Debe seleccionar funcionario o grupo" });
      return;
    }
    await mutateDatabase(async (currentDatabase) => {
      currentDatabase.schedules.unshift(schedule);
    });
    sendJson(response, 201, schedule);
    return;
  }

  const match = url.pathname.match(/^\/api\/(personnel|cards|schedules)\/([a-fA-F0-9-]+)$/);
  if (match && match[1] === "personnel" && request.method === "PUT") {
    const person = database.personnel.find((item) => item.id === match[2]);
    if (!person) {
      sendJson(response, 404, { error: "Funcionario no encontrado" });
      return;
    }
    const body = await readJson(request);
    ["document", "name", "position", "group", "phone", "email", "address", "photo"].forEach((field) => {
      if (typeof body[field] === "string") person[field] = body[field].trim ? body[field].trim() : body[field];
    });
    if (!person.name) {
      sendJson(response, 400, { error: "El nombre es obligatorio" });
      return;
    }
    if (typeof body.active === "boolean") person.active = body.active;
    await mutateDatabase(async (currentDatabase) => {
      const currentPerson = currentDatabase.personnel.find((item) => item.id === match[2]);
      if (!currentPerson) {
        const error = new Error("Funcionario no encontrado");
        error.statusCode = 404;
        throw error;
      }
      Object.assign(currentPerson, person);
    });
    sendJson(response, 200, person);
    return;
  }

  if (match && request.method === "DELETE") {
    const collection = match[1];
    const id = match[2];
    const key = collection === "personnel" ? "personnel" : collection;
    if (!database[key].some((item) => item.id === id)) {
      sendJson(response, 404, { error: "Registro no encontrado" });
      return;
    }
    await mutateDatabase(async (currentDatabase) => {
      currentDatabase[key] = currentDatabase[key].filter((item) => item.id !== id);
      if (collection === "personnel") {
        currentDatabase.cards = currentDatabase.cards.filter((card) => card.personnelId !== id);
        currentDatabase.schedules = currentDatabase.schedules.filter((schedule) => !(schedule.assignmentType === "person" && schedule.assignmentId === id));
      }
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Ruta no encontrada" });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else {
      serveStatic(response, url.pathname);
    }
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message || "Error interno" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Control de acceso disponible en http://localhost:${PORT}`);
});
