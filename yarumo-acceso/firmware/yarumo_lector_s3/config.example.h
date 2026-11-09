#pragma once
// Copie a config.h. Nunca publique config.h: contiene credenciales privadas.
// Wi-Fi es OPCIONAL: al encender, la pantalla permite configurar la red
// desde un celular conectado al punto de acceso temporal del ESP32-S3.
const char *WIFI_SSID = "";
const char *WIFI_PASSWORD = "";

// Plataforma YARUMO ACCESO (independiente del control RFID de NUSEFA).
const char *SERVER_BASE = "https://yarumo-acceso-92u0.onrender.com";
// Pegue el token propio del dispositivo creado desde Yarumo Acceso:
const char *DEVICE_TOKEN = "TOKEN_EXCLUSIVO_CREADO_DESDE_YARUMO";

// CA raíz real del servidor HTTPS. No deshabilitar la validación TLS.
const char *ROOT_CA_PEM = R"PEM(
-----BEGIN CERTIFICATE-----
REEMPLAZAR_POR_CERTIFICADO_CA_VERIFICADO
-----END CERTIFICATE-----
)PEM";

// SOLO primer montaje en memoria nueva sin LittleFS: cambiar a 1,
// cargar firmware una vez, luego volver a 0 y cargar de nuevo.
// No utilizar 1 con registros reales, porque un fallo de montaje
// podria reformatear y eliminar eventos pendientes.
#define YARUMO_ALLOW_INITIAL_FS_FORMAT 0
