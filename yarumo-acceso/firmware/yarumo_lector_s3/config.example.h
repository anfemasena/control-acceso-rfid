#pragma once
// Copiar este archivo a config.h y completar antes de compilar.
// No subir config.h a GitHub. No copiar credenciales ni enlaces del sistema antiguo.
const char *WIFI_SSID = "RED_WIFI_2_4_GHZ";
const char *WIFI_PASSWORD = "CLAVE_WIFI_PRIVADA";
const char *SERVER_BASE = "https://SERVICIO-YARUMO-NUEVO.onrender.com";
const char *DEVICE_TOKEN = "TOKEN_EXCLUSIVO_CREADO_DESDE_YARUMO";
// Certificado PEM de CA raíz que valide el servidor HTTPS elegido.
// Necesario para HTTPS con validación real (nunca usar setInsecure).
const char *ROOT_CA_PEM = R"PEM(
-----BEGIN CERTIFICATE-----
REEMPLAZAR_POR_CERTIFICADO_CA_VERIFICADO
-----END CERTIFICATE-----
)PEM";
