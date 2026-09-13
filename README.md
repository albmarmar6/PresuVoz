# PresuVoz — Presupuestos Técnicos por Voz para Gremios y Reformas

Plataforma de generación automatizada de presupuestos técnicos y contratos de obra a partir de notas de voz en WhatsApp, con cálculo fiscal automático (IVA 10% vs 21%) y doble firma electrónica conforme al Reglamento Europeo eIDAS y RGPD.

---

## Características Principales

* **Entrada por Voz sin Fricción:** Diseñado para profesionales (fontaneros, electricistas, carpinteros, climatización y reformas) que necesitan generar ofertas vinculantes desde la furgoneta o a pie de obra.
* **Lógica Fiscal Automatizada:** Identificación inteligente del tipo de IVA aplicable según normativa española (10% reducido para reformas en vivienda habitual según Art. 91 Uno 2.10º Ley del IVA; 21% régimen general).
* **Doble Firma Vinculante (eIDAS):**
  * **Empresa emisora:** Sello oficial digital pre-estampado y vinculado a la entidad.
  * **Cliente final:** Lienzo interactivo en HTML5 Pointer Events optimizado para pantalla táctil móvil o ratón.
* **Prueba Probatoria:** Registro de fecha y hora fehaciente, trazabilidad de IP del firmante y remisión de copia certificada por correo electrónico a ambas partes.
* **Diseño Documental Sobrio (Estándar v2):** Documentación contable profesional, limpia y sin emojis, orientada al sector B2B.

---

## Estructura del Repositorio

```text
PresuVoz/
├── src/
│   ├── engine.js                      # Motor central de cálculo impositivo y financiero
│   ├── generator.js                   # Generador del documento formal v2 con firma táctil
│   └── test_run.js                    # Script ejecutable de prueba en consola
├── landing/
│   └── index.html                     # Landing page comercial con calculadora de ROI
├── studio/
│   └── index.html                     # Demostrador interactivo con grabación de micrófono en vivo
├── output/
│   ├── presupuesto_demo.html          # Documento oficial generado listo para firma
│   └── presupuesto_demo_v2.html       # Plantilla de referencia v2
├── estrategia_primeros_clientes.md    # Guía de prospección y cierre comercial en 7 días
├── faq_legal_para_cerrar_ventas.md    # Respuestas jurídicas (eIDAS, Código Civil y RGPD)
├── .env.example                       # Plantilla de variables de entorno para producción
├── .gitignore                         # Exclusiones de seguridad para Git
└── package.json                       # Configuración del paquete Node.js (ES Modules)
```

---

## Puesta en Marcha en Local

### Requisitos
* Node.js v18 o superior (probado en Node.js v22).

### Ejecución del Motor de Prueba
```bash
# Ejecutar simulación de presupuesto técnico
node src/test_run.js
```

El script procesará los conceptos de obra, calculará la base imponible y el IVA reducido, y generará el documento listo para firma en `output/presupuesto_demo.html`.

### Visualización de Herramientas Web
* **Landing Page comercial:** Abre `landing/index.html` en tu navegador.
* **Estudio con dictado en vivo:** Abre `studio/index.html` en tu navegador para dictar por voz usando el micrófono.
* **Presupuesto generado:** Abre `output/presupuesto_demo.html` para probar la firma digital.

---

## Seguridad y Cumplimiento Normativo

1. **Reglamento eIDAS (Reg. UE 910/2014):** Las firmas electrónicas recogen evidencias probatorias (timestamp, IP de origen, identificador de dispositivo y hash inalterable del documento).
2. **RGPD y LOPDGDD:** Tratamiento de datos limitado a la relación contractual de arrendamiento de servicios. Servidores dentro del espacio económico europeo en despliegue.
3. **Protección de Credenciales:** El proyecto utiliza archivos de entorno (`.env`) excluidos de control de versiones mediante `.gitignore`.

---

## Licencia
Uso exclusivo y propietario para PresuVoz. Todos los derechos reservados.
