# Suite manual de PresuVoz desde WhatsApp

Esta guía sirve para probar el bot desde el teléfono del profesional registrado. Habla con el número único de PresuVoz; el sistema identifica la empresa por el número de WhatsApp del remitente.

## Preparación

1. Comprueba que el teléfono desde el que vas a probar pertenece a una empresa ya dada de alta y autorizada en el entorno conectado.
2. Haz una copia de seguridad de la base de datos antes de mezclar registros de prueba con datos reales.
3. Ejecuta `npm run seed:manual`. El script añade registros con referencias `PVTEST-AAAAMMDD-*` al tenant indicado por `PRESUVOZ_DEMO_PHONE` o por el primer `ALLOWED_NUMBERS`. No borra ni sobrescribe registros existentes.
4. Arranca el gateway con `npm run whatsapp`, completa la conexión del número compartido y confirma que el móvil recibe y puede responder mensajes.
5. Si el `.env` no tiene `ALLOWED_NUMBERS`, define `PRESUVOZ_DEMO_PHONE` explícitamente. No apuntes la prueba a una empresa real de clientes.

## Casos de prueba

Marca cada resultado como **Pasa**, **Falla** o **No probado** y anota el mensaje exacto recibido.

### A. Identidad y aislamiento

1. Envía `hola`: debe iniciar onboarding únicamente para un número nuevo.
2. Desde una empresa ya registrada, envía `mis presupuestos`: solo deben aparecer presupuestos de esa empresa.
3. Envía `facturas pendientes`: solo deben aparecer facturas de esa empresa.
4. Desde un segundo número autorizado y vinculado a otra empresa, repite las consultas: no debe aparecer ningún dato del primer tenant.
5. Intenta referirte al ID de un presupuesto de la otra empresa: debe responder como inexistente/no disponible sin revelar su contenido.

### B. Presupuestos por texto y voz

6. Envía: `Presupuesto para Paula Díaz, Calle Luna 18. Pintar salón, 30 m² a 18 euros el metro. IVA 21%. Validez 20 días.` Debe calcular base 540 €, IVA 113,40 € y total 653,40 €.
7. Envía un audio equivalente. Contrasta cliente, dirección, partidas, cantidades, unidad, precio e impuestos con lo dicho.
8. Envía un audio con varias partidas, palabras de relleno y una partida sin precio. Debe conservar lo valorado, dejar la otra claramente pendiente y no inventar importes.
9. Completa la pendiente con `pon 240 euros al alicatado`. Debe actualizar esa partida y recalcular los totales una vez.
10. Menciona `vivienda habitual` sin decir un tipo de IVA. Debe usar el IVA configurado para tu empresa, no deducirlo de esa frase.
11. Indica `IVA 10%` expresamente. Debe calcular el 10% y mostrarlo en el presupuesto.
12. Indica `IVA exento` o `IVA 0%`. Debe mantener el 0% en los totales, PDF y resumen.
13. Dicta un descuento porcentual y otro importe fijo en dos presupuestos distintos. Comprueba subtotal, descuento, base imponible e IVA; un descuento mayor que el subtotal debe rechazarse o pedir corrección.
14. Pide modificar un presupuesto aceptado o con pagos/facturas asociados. Debe proteger los datos económicos ya comprometidos.
15. Pide reenviar el PDF y abrir el enlace de firma. Comprueba que ID, partidas, condiciones y cifras coinciden con el presupuesto original.

### C. Aceptación y entrega de copia

16. Abre un presupuesto pendiente desde el enlace, revisa todos los datos, firma en móvil e introduce un email válido. Debe registrarse una aceptación y enviar la copia.
17. Vuelve a abrir el mismo enlace y trata de aceptarlo otra vez. No debe crear una segunda aceptación.
18. Prueba un correo mal formado y una firma vacía. El servidor debe rechazar la solicitud sin registrar una aceptación nueva.
19. Para probar un fallo real de entrega, hazlo solo en staging con una clave de Resend presente pero temporalmente inválida/revocada. Si falta `RESEND_API_KEY`, el servidor rechaza la firma antes de registrarla. Con una respuesta de error del proveedor, debe quedar la aceptación registrada, mostrar que la copia sigue pendiente y ofrecer **Reintentar envío de la copia** en el mismo navegador.
20. Restaura la configuración de correo, pulsa reintentar y confirma que llega el PDF sin volver a firmar. Comprueba además que un presupuesto ya enviado no ofrece una nueva firma ni otro reenvío accidental.

### D. Facturas y cobros

21. Consulta `facturas pendientes` y `facturas pagadas`: el estado debe corresponder a las facturas de prueba.
22. Emite una factura final desde un presupuesto aceptado. Comprueba numeración, cliente, base, tipo de IVA, cuota y total.
23. Emite una factura de anticipo y registra un pago parcial. El saldo debe disminuir por el importe pagado y no superar el total facturado.
24. Intenta duplicar una factura final o un anticipo idéntico. El bot debe evitar duplicados o pedir una decisión clara.
25. Descarga el PDF de cada factura y verifica que los datos impresos coinciden con el resumen de WhatsApp.

### E. Agenda, materiales y secretaría

26. Envía `agenda de mañana`: deben aparecer las citas seed `PVTEST` con hora, dirección y notas.
27. Añade una cita nueva por voz con fecha y hora; consulta `mis citas` y confirma que aparece una sola vez.
28. Reagenda una cita por nombre y comprueba fecha/hora nuevas; cancela otra y confirma que ya no se recuerda como confirmada.
29. Envía `lista de la compra`: deben salir materiales pendientes. Marca uno como comprado y verifica que desaparece de la lista pendiente.
30. Pregunta qué tienes mañana y qué queda por cobrar. La respuesta debe separar citas y facturas pendientes, sin confundir presupuestos aceptados con pagos realizados.

### F. Recordatorios automáticos

31. Mantén el gateway funcionando durante la ventana de las 19:30 (hora de Madrid) con una cita confirmada para mañana. Debe llegar un recordatorio de víspera.
32. Mantén el gateway funcionando durante la ventana de las 07:30 con una cita confirmada para hoy. Debe llegar el resumen matinal.
33. Deja una cita de hoy sin marcar como realizada y mantén el gateway hasta las 20:30. Debe llegar la pregunta de cierre de jornada.
34. Reinicia el gateway dentro de las ventanas de recuperación (mañana antes de las 14:00; recordatorio de víspera desde las 19:30; cierre desde las 20:30). Debe reconciliar el aviso pendiente sin duplicarlo.
35. Reinicia dos veces dentro de una misma ventana. Cada aviso debe llegar una sola vez.
36. Responde `sí, hecha` a la revisión diaria; luego prueba `no pude, pásala al jueves a las 17`. Comprueba estado y nueva fecha.

## Cómo probar recordatorios sin el ordenador encendido

El planificador actual es un temporizador dentro del proceso del gateway: consulta SQLite cada minuto. SQLite conserva las citas y las marcas de envío, pero **no despierta el bot cuando el ordenador está apagado**. Si el gateway está apagado durante una ventana, puede recuperar algunos avisos al arrancar dentro de sus ventanas de reconciliación; fuera de ellas no hay garantía de envío puntual.

Para recibirlos de forma fiable durante todo el día, el proceso debe ejecutarse en una máquina siempre encendida (VPS/servidor) o hay que trasladar los trabajos programados a un scheduler alojado que consulte una base de datos persistente y despache mensajes mediante la API oficial. No dejes el portátil personal como único servidor de producción.

## Limpieza

El script de seed no elimina registros. Los presupuestos y citas llevan prefijo `PVTEST-`; los documentos/facturas incluyen el mismo prefijo de fecha. Para retirar datos, haz una copia de seguridad y elimina solo filas cuyo ID empiece por `PVTEST-` y pertenezca a la empresa de pruebas. No uses el reset general de la base de datos para limpiar esta suite.
