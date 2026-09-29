/**
 * PresuVoz — Test Environment Bootstrap
 * 
 * Configura las variables de entorno de ejecución de tests ANTES de que
 * cualquier otro módulo o servicio de datos sea importado o evaluado.
 * 
 * Barrera de Seguridad:
 * - Fuerza NODE_ENV = 'test'
 * - Redirige la base de datos a 'data/presuvoz_test.db'
 * - Impide físicamente que cualquier suite de tests apunte o altere 'data/presuvoz.db'
 */

import path from 'node:path';

process.env.NODE_ENV = 'test';

if (!process.env.PRESUVOZ_DB_PATH) {
  process.env.PRESUVOZ_DB_PATH = path.resolve('data', 'presuvoz_test.db');
}

// Autorizar formalmente las migraciones exclusivas en entorno de testing
process.env.ALLOW_DATABASE_MIGRATIONS = 'true';

// Barrera Técnica de Seguridad en tiempo de carga
const resolvedPath = path.resolve(process.env.PRESUVOZ_DB_PATH);
const prodPath = path.resolve('data', 'presuvoz.db');

if (resolvedPath === prodPath) {
  console.error('🛑 [BARRERA DE SEGURIDAD CRÍTICA] Se ha detectado un intento de ejecutar tests contra la base de datos real (data/presuvoz.db)!');
  console.error('La ejecución ha sido abortada para evitar contaminación o pérdida de datos.');
  process.exit(1);
}
