# Yarumo Acceso · plataforma biométrica multiadministrador

**Estado:** prototipo funcional de backend + panel web y firmware inicial para laboratorio. No se ha desplegado ni probado aún con la placa física. No sustituye el sistema existente de Nuestra Señora de Fátima.

## Diseño

- **Organizaciones aisladas:** al crear un espacio se genera un `org_id` exclusivo. Cada llamada administrativa filtra por el espacio autenticado. Los administradores de una misma organización comparten sus datos; otras organizaciones no pueden verlos.
- **Administradores:** correo/contraseña, sesiones de 12 horas, cookies HttpOnly/SameSite, CSRF, contraseñas protegidas con `scrypt`, creación de compañeros por el rol titular.
- **Dispositivos:** cada ESP32-S3 obtiene un token aleatorio propio (solo visible al registrarlo o rotarlo). En base de datos únicamente se guarda SHA-256 del token. Deshabilitar o rotar un token invalida el anterior.
- **Personas:** identificación textual (`name`, `code`), activación/desactivación y asignación a hasta 10 casillas AS608 por dispositivo.
- **Huellas:** el servidor manda la orden de enrolamiento al lector. El AS608 captura dos veces, crea y guarda el modelo en el propio sensor; el servidor solo conoce persona, dispositivo, casilla y estado. No se transmiten imágenes ni plantillas.
- **Eventos:** el AS608 busca coincidencia local, el ESP32-S3 envía `eventId` UUID, casilla, confianza y hora capturada. La API valida el token del lector y la asignación de la casilla. El historial es independiente por organización. Reintentos con el mismo `eventId` no duplican el registro en condiciones secuenciales.
- **Reportes:** filtros por fechas y lector, vista de 5000 registros máximo y exportación CSV con mitigación de fórmulas maliciosas.
- **Continuidad:** la memoria flash LittleFS guarda eventos pendientes cuando se interrumpe Internet; la cola reenvía en orden cuando vuelve la red.

### Capas

```text
[Administrador A] -- HTTPS --> [Yarumo Acceso Web/API] -- TLS --> [PostgreSQL YARUMO]
    organización A                 |
       |                           +--- tokens por dispositivo (SHA256)
       +--> lector A1 / AS608 <-- Wi-Fi / HTTPS --> API de dispositivo
       +--> lector A2 / AS608

[Administrador B] -- HTTPS --> [mismo servicio, otro org_id]
    organización B
       +--> lector B1 / AS608

    SIN ACCESO a usuarios, lectores ni reportes de la organización A.
```

## Ejecutar localmente (necesita PostgreSQL NUEVO)

```bash
cd yarumo-acceso
npm install
export YARUMO_DATABASE_URL='postgresql://USUARIO:NUEVA_CLAVE@localhost:5432/yarumo_acceso_dev'
export YARUMO_REGISTRATION_CODE='INVITACION-LARGA-Y-ALEATORIA-123'
npm test
npm start
```

En PowerShell:

```powershell
cd yarumo-acceso
npm install
$env:YARUMO_DATABASE_URL = "postgresql://usuario:clave@localhost:5432/yarumo_acceso_dev"
$env:YARUMO_REGISTRATION_CODE = "CODIGO-PRIVADO-CON-AL-MENOS-16-CARACTERES"
npm test
npm start
```

URL local: **http://localhost:3101**. El servidor crea automáticamente las tablas `ya_*` de este proyecto. El código de invitación permite crear nuevos espacios privados. **No reutilizar ninguna URL, clave, usuario o base de datos del servicio original.**

Variables:

| Variable | Requerida | Uso |
|---|---|---|
| `YARUMO_DATABASE_URL` | Sí | PostgreSQL NUEVO exclusivamente Yarumo Acceso |
| `YARUMO_REGISTRATION_CODE` | Sí | Invitación privada de 16+ caracteres para crear organizaciones |
| `PORT` | No | 3101 por defecto; Render la configura automáticamente |
| `YARUMO_DB_SSL` | No | `require` para validar TLS de PostgreSQL |
| `YARUMO_DB_CA_CERT` | Condicional | Certificado de autoridad emisora para validar TLS de la DB |

Para producción, desplegar un servicio nuevo y base PostgreSQL nueva. No existe ninguna conexión con la base ni con el lector del proyecto original de Fátima.

## Lector Waveshare + AS608

Placa: **Waveshare ESP32-S3-Touch-LCD-1.47**, pantalla IPS de 172×320 px, circuito táctil AXS5106L, control de visualización tipo ST7789/JD9853 según revisión y demos. **No confundir con ESP32-S3-LCD-1.47 sin touch**.

### Conexión UART propuesta para el AS608

| AS608 | ESP32-S3-Touch-LCD-1.47 |
|---|---|
| TX | GPIO1 (RX de Serial1) |
| RX | GPIO2 (TX de Serial1) |
| GND | GND común |
| Alimentación | Según la versión exacta del módulo AS608; comprobar rango y nivel lógico |

**No alimentar directamente el sensor desde VBAT ni suponer que VBUS estará disponible funcionando con batería.** Revisar tensión nominal y consumos del sensor adquirido. Si su UART TX trabaja a 5 V, utilizar adaptación de nivel a 3,3 V hacia el ESP32-S3. El firmware no necesita RTC para arrancar, pero sincroniza el reloj por NTP antes de enviar eventos HTTPS; un RTC DS3231 puede añadirse en otra etapa para funcionamiento prolongado sin red.

La pantalla usa GPIO21/38/39/40/45/46 y el táctil GPIO41/42/47/48, por eso se han elegido GPIO1 y GPIO2 libres para el AS608. Esta asignación se basó en el esquema y el pinout oficial, y se debe **comprobar en tu propia revisión de placa**.

### Preparación Arduino IDE

1. Instalar soporte `esp32` versión compatible con la placa Waveshare y seleccionar ESP32S3 Dev Module; activar USB CDC cuando proceda.
2. Instalar `ArduinoJson`, `Adafruit Fingerprint Sensor Library` y `GFX Library for Arduino`.
3. Abrir `firmware/yarumo_lector_s3/yarumo_lector_s3.ino`.
4. Copiar `config.example.h` a `config.h` en la misma carpeta. Introducir SSID de Wi-Fi 2,4 GHz, contraseña, URL del nuevo servicio, token creado en el panel y CA PEM real correspondiente al certificado HTTPS. **No subir config.h al repositorio.**
5. Compilar, validar el funcionamiento de la pantalla y las dos señales UART y cargar a un dispositivo de pruebas, nunca al lector existente.
6. En la plataforma crear una persona y un comando de enrolamiento asociando lector + casilla 1–10. El dispositivo consultará el comando, pedirá dos capturas y almacenará la plantilla únicamente en el AS608.

### Pantalla del lector (firmware de laboratorio actualizado)

La pantalla trabaja en **horizontal 320 × 172 píxeles**, rotación `1` de Arduino_GFX. El archivo `firmware/yarumo_lector_s3/yarumo_ui.h` implementa:

1. **Bienvenida:** isotipo de hojas vectorial en verde y naranja junto al nombre **YARUMO ACCESO** durante el inicio. Es un gráfico provisional dibujado en el firmware, **no una copia exacta del archivo oficial de Yarumo POS**; se puede sustituir por el icono y wordmark originales al contar con esos archivos.
2. **Sin red:** aparece **SIN CONEXIÓN WIFI** con el botón táctil **CONFIGURAR WIFI**.
3. **Configuración de red:** al pulsar, el equipo crea temporalmente una red WPA2 `Yarumo-XXXX`, con una contraseña aleatoria mostrada en pantalla. Desde un teléfono conectado a esa red, abrir **http://192.168.4.1** en el navegador. Introducir nombre de red de **2,4 GHz** y contraseña. Se guardan en la memoria NVS del ESP32, no en Render, y se restablecen tras reiniciar. El AP se apaga al iniciar la conexión.
4. **Reposo con red:** muestra el reloj grande **HH:MM:SS** y **ACERQUE SU HUELLA**. La hora se sincroniza por NTP con **America/Bogota (UTC−5)**; la pantalla marca `--:--` hasta obtener la primera hora válida. Un reloj DS3231 permitiría conservar la hora tras reinicios sin Internet, pero aún no está integrado.
5. **Configuración alternativa:** toque **RED** en la parte inferior derecha de la pantalla de reposo o mantenga el botón físico **BOOT** 1,2 segundos durante el funcionamiento normal. **No mantenga BOOT durante un reinicio**, porque es el pin de arranque del ESP32.
6. **Volver a operar:** se reconecta al Wi-Fi guardado sin bloquear el bucle del lector y conserva las funciones de eventos pendientes y huellas AS608.

Se utilizan los pines de pantalla y touch verificados para **Waveshare ESP32-S3-Touch-LCD-1.47**: LCD CS21, DC45, CLK38, MOSI39, RST40, BL46; AXS5106L SDA42, SCL41, RST47, INT48; AS608 UART RX1/TX2. El botón de configuración táctil requiere **validación de orientación y coordenadas con la placa física**. El portal es accesible solamente desde la red temporal protegida y se cierra por tiempo agotado tras 10 minutos.

**Esta interfaz no sustituye la obligación de configurar `DEVICE_TOKEN` y el certificado CA de HTTPS en `config.h` para enviar registros a Yarumo.** El panel y el reloj pueden operar sin el token, pero la lectura biométrica para la plataforma no debe activarse hasta contar con autenticación y validación TLS.

Se requiere instalar las bibliotecas Arduino_GFX y Adafruit Fingerprint, además de ArduinoJson. Las bibliotecas `WiFi`, `WebServer`, `Preferences` y `Wire` forman parte del paquete ESP32 Arduino. Todavía no se ha compilado ni probado el firmware con la placa física.

### Ejemplo de API de lector

```http
POST /api/device/events
Authorization: Bearer TOKEN_EXCLUSIVO_DEL_LECTOR
Content-Type: application/json

{"eventId":"2ef40424-acac-4efe-9551-2d2adcc7026f","slot":1,"confidence":120,"occurredAt":"2026-11-08T19:00:00Z"}
```

La API responde `{id, allowed, movement, duplicate}`. `slot:0` indica huella no reconocida y crea una incidencia de acceso denegado.

## Limitaciones pendientes antes de producción

- Backend web publicado en un servicio independiente de Render. Firmware no flasheado ni validado físicamente; compilación y calibración del táctil pendientes con la revisión Waveshare real.
- Hace falta auditoría de seguridad, monitoreo y tests integrados reales con PostgreSQL, ataques CSRF, roles y concurrencia entre lectores.
- La puesta en marcha de un nuevo administrador que ya tenga una organización depende de una contraseña temporal creada por el titular: implementar invitaciones de un solo uso y cambio obligatorio de contraseña.
- La aplicación aún requiere mejorar el reintento de enrolamiento fallido, la seguridad y la experiencia completa de administración. El firmware añade configuración de Wi-Fi con pantalla táctil y portal desde el celular, pendiente de validación física.
- Un lector con modo `alterno` calcula entrada/salida a partir del último evento recibido de la persona. Para operaciones estrictas es preferible configurar dispositivos exclusivos de ingreso/salida y evitar discrepancias de sincronización en red.
- Recomendado añadir monitoreo de ocupación de cola, restauración tras interrupciones eléctricas y pruebas de límites del sistema de archivos.
- Los datos biométricos se consideran sensibles en Colombia; antes de utilizar el sistema con personas reales, definir base jurídica, autorización cuando corresponda, política de tratamiento, retención y derechos de los titulares. No centralizar plantillas biométricas.

## Pruebas

```bash
npm test
npm run check
```

Las pruebas incluidas son **unitarias y estructurales**, no sustituyen pruebas integradas PostgreSQL ni una compilación real para la Waveshare.

## Referencias del fabricante

- https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-1.47
- https://files.waveshare.com/wiki/ESP32-S3-Touch-LCD-1.47/ESP32-S3-Touch-LCD-1.47-Schematic.pdf
- https://github.com/adafruit/Adafruit-Fingerprint-Sensor-Library
