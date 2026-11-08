# Yarumo Acceso — desarrollo independiente

**Plataforma multiadministrador de asistencia biométrica** con ESP32-S3-Touch-LCD-1.47 de Waveshare y sensor AS608.

## Abrir el nuevo proyecto

El código de Yarumo Acceso se encuentra en la carpeta **[yarumo-acceso/](./yarumo-acceso/)**.

- [Guía de instalación, arquitectura y seguridad](./yarumo-acceso/README.md)
- [Interfaz web](./yarumo-acceso/web/)
- [Servidor y API](./yarumo-acceso/server.js)
- [Esquema PostgreSQL](./yarumo-acceso/schema.sql)
- [Firmware ESP32-S3 + AS608](./yarumo-acceso/firmware/yarumo_lector_s3/)
- [Pruebas](./yarumo-acceso/tests/)

## Aislamiento obligatorio

Esta es la rama `feature/nusefa-v2-aislada`, **no la rama `main`**. El sistema RFID original para Nuestra Señora de Fátima permanece en `main`, sin cambios. Yarumo utiliza su propio código, tablas, credenciales de dispositivos, firmware y **una nueva base PostgreSQL**. Nunca conectar Yarumo a la base ni a la URL del sistema RFID original.

Para desplegar en Render: crear un Web Service separado y definir **Root Directory = `yarumo-acceso`**, con `npm install` y `npm start`, variables `YARUMO_DATABASE_URL` y `YARUMO_REGISTRATION_CODE` (ver guía). No existe todavía despliegue verificado de Yarumo.

La placa y el sensor no han sido validados físicamente; el proyecto es aún **prototipo para pruebas**.
