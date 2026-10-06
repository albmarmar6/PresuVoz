# PresuVoz

Asistente de WhatsApp para profesionales de oficios. El flujo principal cubre el alta de cada empresa, presupuestos a partir de texto o voz, facturas, agenda y recordatorios de materiales, cobros y trabajos pendientes. La gestoría es secundaria y sus cálculos no sustituyen la revisión de un asesor.

## Estado del producto

El repositorio contiene un gateway de WhatsApp basado en Baileys, persistencia SQLite y páginas de demostración. **Todavía no está listo para un lanzamiento comercial multiempresa.** Baileys conecta una sesión de WhatsApp Web mediante QR; para operar como servicio comercial y escalar de forma fiable hay que integrar la WhatsApp Business Platform Cloud API oficial, con webhooks verificados, plantillas y gestión de límites. El transporte actual no debe tratarse como una integración oficial de Meta.

La aceptación electrónica disponible registra una aceptación del cliente y crea un PDF. No registra IP ni dispositivo, no aplica un sello cualificado, y no garantiza por sí sola efectos jurídicos concretos. El tipo de IVA procede del perfil de empresa salvo que el profesional lo indique expresamente; PresuVoz no verifica si se cumplen los requisitos fiscales de cada obra.

## Componentes

- `src/whatsapp_gateway.js`: recepción y gestión de conversaciones de WhatsApp.
- `src/onboarding_service.js`: preguntas de configuración de empresa y preferencias de trabajo.
- `src/engine.js` y `src/parser.js`: extracción y cálculo de presupuestos.
- `src/db_service.js` y `src/migrations/`: SQLite, identidad por empresa y evolución del esquema.
- `src/pdf_service.js` y `src/fiscal_service.js`: documentos, pagos y funciones de apoyo fiscal.
- `api/sign.js`: emisión del PDF de aceptación electrónica. Ver requisitos de configuración abajo.
- `api/gemini.js`: proxy para el simulador web; desactivado por defecto porque no debe exponerse una clave de IA a llamadas públicas sin autenticación de usuario.
- `studio/` y `landing/`: páginas de demostración y presentación.

## Configuración

1. Usa Node.js 22 y ejecuta `npm install`.
2. Copia `.env.example` a `.env` y completa las credenciales fuera del control de versiones.
3. Define `GEMINI_API_KEY`. El gateway usa `GEMINI_MODEL=gemini-3.8-flash` y prueba `gemini-3.5-flash-lite` como alternativa de menor coste ante saturación temporal.
4. Configura la sesión WhatsApp usada por Baileys y revisa `ALLOWED_NUMBERS` antes de arrancar el gateway.
5. Para aceptar firmas, configura el mismo secreto aleatorio `PRESUVOZ_SIGNING_SECRET` (mínimo 32 caracteres) en el gateway y en Vercel. Añade `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` y `PRESUVOZ_ALLOWED_ORIGINS` en Vercel. Sin el almacén Upstash, la firma falla de forma cerrada.
6. No habilites `GEMINI_PROXY_ENABLED` para uso público hasta implementar autenticación por usuario y límites de consumo compartidos entre instancias.

## Comandos locales

```bash
npm start       # Genera el presupuesto de demostración
npm run whatsapp # Inicia el gateway de WhatsApp (sin reinicio automático de node --watch)
npm test        # Ejecuta la suite del proyecto
npm run seed:manual # Añade datos manuales de prueba al tenant configurado (no borra datos)
```

La página de firma alojada en GitHub Pages debe poder llamar a `/api/sign`; añade su origen en `PRESUVOZ_ALLOWED_ORIGINS` si cambia. El registro de firmas usa `SET NX` en Redis para evitar dos aceptaciones concurrentes del mismo presupuesto.

## Próximo requisito para producción

El paso arquitectónico prioritario es migrar el transporte Baileys a WhatsApp Business Platform Cloud API y conectar sus webhooks con las colas actuales. Antes de venderlo también hacen falta despliegue multiinstancia, copias de seguridad y restauración de SQLite, gestión de secretos, retención/borrado de datos, límites de uso y revisión profesional de documentos y obligaciones fiscales/RGPD.
