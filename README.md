# Control de acceso NUSEFA V2 — entorno independiente de pruebas

> **IMPORTANTE:** esta rama es un laboratorio de desarrollo. No es la plataforma activa de Nuestra Señora de Fátima. No se debe conectar a la base de datos, servicios ni lectores de la versión actual. No desplegar como producción sin pruebas y revisión de seguridad.

## Separación respecto a la aplicación actual

- **Versión actual:** rama [main](https://github.com/anfemasena/control-acceso-rfid/tree/main). Permanece sin cambios.
- **Versión V2:** rama `feature/nusefa-v2-aislada`, creada desde `main`.
- **Archivo de datos local:** `data-v2/database.json` (nunca `data/database.json`).
- **PostgreSQL:** solo toma la conexión desde `V2_DATABASE_URL`; ignora `DATABASE_URL` usada por la versión anterior. La tabla de esta rama se llama `nusefa_v2_state`, con clave `nusefa-v2`.
- **Credenciales de administrador:** `V2_ADMIN_PASSWORD` obligatoria y `V2_ADMIN_USER` opcional.
- **Puerto local:** 3100, salvo que se establezca `PORT`.
- **Firmware:** apunta por defecto a `nusefa-v2.invalid`, que intencionalmente NO funciona. Configurar su URL V2 solamente después de crear el servicio de pruebas.
- **Pantalla web:** muestra "V2 - PRUEBAS" para evitar confundirla con el servicio actual.

La separación por rama no sustituye el aislamiento del despliegue. Un despliegue independiente debe contar con **otro servicio Render y otra base de datos PostgreSQL**, con nuevas claves. No copiar ni reutilizar las variables secretas del entorno actual.

## Ejecutar localmente (PowerShell)

Instalar Node.js 18 o superior y ejecutar desde la carpeta del repositorio:

```powershell
npm install
$env:V2_ADMIN_USER = "admin-v2"
$env:V2_ADMIN_PASSWORD = "COLOQUE_AQUI_UNA_CLAVE_NUEVA_Y_LARGA"
npm test
npm start
```

La interfaz local estará disponible en `http://localhost:3100`. Si ya funciona una instancia en ese puerto, configurar `$env:PORT = "3101"`. No definir `DATABASE_URL`; para pruebas locales se crea automáticamente una carpeta `data-v2`, excluida de Git.

## Despliegue futuro en Render (todavía NO realizado)

1. Crear una base PostgreSQL **nueva**, vacía e independiente. Nunca usar la de producción.
2. Crear otro Web Service vinculado a esta rama, **sin reutilizar ni modificar el servicio vigente**.
3. Configurar `V2_DATABASE_URL` con la URL de la **nueva base**, `V2_ADMIN_PASSWORD` con una clave exclusiva y, si se desea, `V2_ADMIN_USER`.
4. Configurar `npm install` como compilación y `npm start` como arranque; `/api/health` como comprobación de salud.
5. Hacer pruebas con tarjetas ficticias y un ESP32 distinto, sin intervenir el lector activo.
6. Actualizar `SERVER_URL` dentro de `firmware/control_acceso/control_acceso.ino` para que apunte exclusivamente al nuevo servicio.

El proceso se negará a iniciar en Render cuando falte `V2_DATABASE_URL`, y también se negará a iniciar sin `V2_ADMIN_PASSWORD`.

## Seguridad antes de cualquier operación real

Esta rama sigue siendo un punto de partida. Pendientes antes de utilizarla en un acceso físico real:

- Autenticar cada dispositivo ESP32 con credenciales individuales y revocables. La API `/api/access` del código heredado todavía acepta solicitudes sin autenticación de dispositivo.
- Reemplazar `secureClient.setInsecure()` por validación TLS real en el firmware.
- Revisar reglas de autorización, sesiones de administradores, auditoría y concurrencia.
- Validar continuidad operativa cuando falle la red y confirmar que la cerradura se comporta de forma segura.

## Referencia de hardware y API

Para conexiones de ESP32, RC522, LCD 20×4 I2C y relé, consultar el [README de la versión original](https://github.com/anfemasena/control-acceso-rfid/blob/main/README.md). **No reutilizar los parámetros de servidor ni credenciales indicados allí.**

El firmware V2 sigue siendo una variante inicial para laboratorio. No reprogramar el ESP32 instalado actualmente.
