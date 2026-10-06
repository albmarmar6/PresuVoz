# Alcance actual: firma, datos y fiscalidad

Este documento describe lo que el código hace hoy. No es asesoramiento jurídico, fiscal ni de protección de datos, y no debe usarse para prometer resultados legales o tributarios.

## Aceptación electrónica

El cliente dibuja su firma en una página web. El servidor verifica que el presupuesto procede de un enlace firmado por el gateway, guarda un único registro de aceptación en Redis y genera un PDF que intenta enviar al cliente y a la empresa. El registro incluye la hora, el email indicado y el nombre, pero no recoge IP ni identificador de dispositivo y el PDF no lleva un sello electrónico cualificado ni un hash probatorio independiente.

Una firma electrónica dibujada puede ser relevante como evidencia, pero la fuerza probatoria depende de la operación, la identidad, el consentimiento y las pruebas disponibles. No afirmes que PresuVoz garantiza una reclamación o el resultado de un juicio. Pide revisión jurídica del flujo antes de comercializar esta función.

## Datos personales

El servicio procesa nombres, teléfonos, direcciones, presupuestos, citas, facturas, audios y otros datos enviados por WhatsApp. El flujo usa WhatsApp/Baileys, Google Gemini, Resend y Upstash, además de SQLite local. No hay en el repositorio base suficiente para afirmar ubicación europea de todos los datos, cifrado en reposo, acuerdos de encargo, política de conservación, borrado integral ni cumplimiento RGPD/LOPDGDD.

Antes de ofrecer el servicio, define responsable y encargados, base jurídica, avisos de privacidad, contratos con proveedores, medidas de seguridad, retención, exportación y borrado. Evita enviar información innecesaria a modelos de IA y revisa los términos de cada proveedor.

## IVA e IRPF

El IVA aplicado al presupuesto usa por defecto el tipo configurado por la empresa durante el onboarding; un tipo escrito de forma explícita puede prevalecer. El sistema no comprueba destino del inmueble, antigüedad, porcentaje de materiales, naturaleza de la operación ni otros requisitos para tipos reducidos o exenciones. El profesional debe verificar el tipo con su asesoría para cada operación.

Las funciones de facturas, anticipos, pagos y exportación fiscal son ayudas operativas. No sustituyen un sistema de facturación verificado ni la revisión de un asesor. No describas un informe de PresuVoz como libro oficial o declaración fiscal validada sin una revisión técnica y fiscal específica.

## Respuesta prudente para clientes

> “PresuVoz prepara presupuestos y registra una aceptación electrónica con copia PDF. Revisa siempre el importe, el IVA y las condiciones antes de enviarlo. La firma y la fiscalidad deben validarse según tu caso; el servicio no garantiza por sí solo un resultado legal ni sustituye a tu asesor.”
