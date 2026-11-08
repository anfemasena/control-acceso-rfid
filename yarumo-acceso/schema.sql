-- Yarumo Acceso: esquema separado, nunca ejecutarlo en la BD de NUSEFA original.
CREATE TABLE IF NOT EXISTS ya_organizations (
 id UUID PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ya_admins (
 id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES ya_organizations(id),
 name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass_salt TEXT NOT NULL,
 pass_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(id,org_id)
);
CREATE TABLE IF NOT EXISTS ya_sessions (
 token_hash TEXT PRIMARY KEY, admin_id UUID NOT NULL REFERENCES ya_admins(id) ON DELETE CASCADE,
 csrf_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ya_devices (
 id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES ya_organizations(id),
 name TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT 'alterno'
 CHECK(direction IN ('ingreso','salida','alterno')),
 token_hash TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT true,
 last_seen_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,org_id)
);
CREATE TABLE IF NOT EXISTS ya_people (
 id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES ya_organizations(id),
 name TEXT NOT NULL, code TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(id,org_id), UNIQUE(org_id,code)
);
CREATE TABLE IF NOT EXISTS ya_enrollments (
 id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES ya_organizations(id),
 device_id UUID NOT NULL, person_id UUID NOT NULL, slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 10),
 status TEXT NOT NULL CHECK(status IN ('pending','active','failed','removing')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(device_id,org_id) REFERENCES ya_devices(id,org_id),
 FOREIGN KEY(person_id,org_id) REFERENCES ya_people(id,org_id),
 UNIQUE(device_id,slot), UNIQUE(device_id,person_id)
);
CREATE TABLE IF NOT EXISTS ya_commands (
 id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES ya_organizations(id),
 device_id UUID NOT NULL, enrollment_id UUID NOT NULL REFERENCES ya_enrollments(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('enroll','delete')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','done','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), delivered_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
 FOREIGN KEY(device_id,org_id) REFERENCES ya_devices(id,org_id)
);
CREATE TABLE IF NOT EXISTS ya_events (
 id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES ya_organizations(id),
 device_id UUID NOT NULL, device_event_id UUID NOT NULL, person_id UUID,
 slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 10), confidence INTEGER,
 allowed BOOLEAN NOT NULL, movement TEXT NOT NULL CHECK(movement IN ('ingreso','salida','denegado')),
 occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(device_id,org_id) REFERENCES ya_devices(id,org_id),
 FOREIGN KEY(person_id,org_id) REFERENCES ya_people(id,org_id),
 UNIQUE(device_id,device_event_id)
);
CREATE INDEX IF NOT EXISTS ya_events_org_date ON ya_events(org_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS ya_events_device_date ON ya_events(device_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS ya_commands_device ON ya_commands(device_id,state,created_at);
