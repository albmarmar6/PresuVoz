import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const DEFAULT_LOCK_PATH = path.resolve(process.env.GATEWAY_LOCK_PATH || path.join(DATA_DIR, 'gateway.lock'));

/**
 * Comprueba si un proceso está actualmente activo en el sistema operativo.
 * Compatible con Windows y Linux.
 * @param {number} pid - Identificador del proceso
 * @returns {boolean} true si el proceso está vivo, false si no existe
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || isNaN(pid) || pid <= 0) {
    return false;
  }
  try {
    // Señal 0 verifica la existencia del proceso sin enviar ninguna señal real
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      // ESRCH = No such process (proceso inexistente o terminado)
      return false;
    }
    if (err.code === 'EPERM') {
      // EPERM = Operation not permitted (el proceso existe pero no tenemos permisos para señalizarlo)
      return true;
    }
    // Ante cualquier otro código de error, asumimos vivo por seguridad fail-closed
    return true;
  }
}

/**
 * Intenta adquirir el bloqueo exclusivo de instancia para el gateway.
 * @param {string} lockPath - Ruta al archivo de bloqueo
 * @returns {{ acquired: boolean, pid?: number, activePid?: number, reason?: string, message?: string }}
 */
export function acquireGatewayLock(lockPath = DEFAULT_LOCK_PATH) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 1. Si el archivo ya existe, comprobar si el poseedor sigue vivo
  if (fs.existsSync(lockPath)) {
    let existingData = null;
    let isStale = false;

    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      existingData = JSON.parse(raw);
    } catch (parseErr) {
      // Archivo corrupto o vacío
      try {
        const stats = fs.statSync(lockPath);
        const ageMs = Date.now() - stats.mtimeMs;
        // Si tiene más de 10 segundos y está corrupto, es un residuo de caída
        if (ageMs > 10000) {
          isStale = true;
        } else {
          return {
            acquired: false,
            reason: 'CORRUPTED_RECENT_LOCK',
            message: `Archivo de bloqueo presente pero corrupto y reciente (${Math.round(ageMs / 1000)}s). Bloqueo denegado por seguridad.`
          };
        }
      } catch (statErr) {
        // El archivo desapareció entre comprobaciones
        isStale = true;
      }
    }

    if (existingData && typeof existingData.pid === 'number') {
      // Si el PID coincide con el proceso actual (re-adquisición idempotente)
      if (existingData.pid === process.pid) {
        return { acquired: true, pid: process.pid };
      }

      // Protección contra reciclaje de PID tras reinicio del sistema:
      // Si el archivo fue creado antes del último arranque del SO, el PID es un residuo obsoleto
      const systemBootTimeMs = Date.now() - (os.uptime() * 1000);
      const lockCreatedAtMs = existingData.createdAt ? Date.parse(existingData.createdAt) : 0;
      if (lockCreatedAtMs > 0 && lockCreatedAtMs < (systemBootTimeMs - 5000)) {
        isStale = true;
      } else {
        const alive = isPidAlive(existingData.pid);
        if (alive) {
          return {
            acquired: false,
            reason: 'ALREADY_RUNNING',
            activePid: existingData.pid,
            message: `Ya existe otra instancia activa del bot ejecutándose (PID: ${existingData.pid}, Host: ${existingData.hostname || 'desconocido'}).`
          };
        } else {
          // El proceso murió sin limpiar el lockfile (stale lock)
          isStale = true;
        }
      }
    }

    if (isStale) {
      try {
        fs.unlinkSync(lockPath);
        console.log(`⚠️ [Lock] Limpiado archivo de bloqueo obsoleto de proceso anterior inactivo.`);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') {
          return {
            acquired: false,
            reason: 'CANNOT_REMOVE_STALE_LOCK',
            message: `No se pudo eliminar el lockfile obsoleto: ${unlinkErr.message}`
          };
        }
      }
    }
  }

  // 2. Intentar escribir el nuevo lockfile de forma atómica con flag 'wx' (falla si ya existe)
  const lockPayload = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    nodeVersion: process.version
  };

  try {
    fs.writeFileSync(lockPath, JSON.stringify(lockPayload, null, 2), { flag: 'wx' });
    return { acquired: true, pid: process.pid };
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Condición de carrera: otro proceso lo creó en este milisegundo
      return {
        acquired: false,
        reason: 'RACE_CONDITION_LOCK_EXISTS',
        message: 'Conflicto de concurrencia: otra instancia acaba de adquirir el bloqueo.'
      };
    }
    return {
      acquired: false,
      reason: 'LOCK_WRITE_ERROR',
      message: `Error al crear archivo de bloqueo: ${err.message}`
    };
  }
}

/**
 * Libera de forma segura el bloqueo de instancia si y solo si pertenece al proceso actual.
 * Evita eliminar bloqueos de otros procesos.
 * @param {string} lockPath - Ruta al archivo de bloqueo
 * @returns {boolean} true si se liberó, false si no se poseía o no existía
 */
export function releaseGatewayLock(lockPath = DEFAULT_LOCK_PATH) {
  try {
    if (!fs.existsSync(lockPath)) {
      return false;
    }

    let existingData = null;
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      existingData = JSON.parse(raw);
    } catch {
      // Si está corrupto no podemos confirmar propiedad de forma segura
      return false;
    }

    // Solo eliminamos si el PID del archivo coincide exactamente con el nuestro
    if (existingData && existingData.pid === process.pid) {
      fs.unlinkSync(lockPath);
      return true;
    } else {
      console.warn(`⚠️ [Lock] Intento de liberar lockfile perteneciente a otro proceso (PID en lock: ${existingData?.pid}, PID actual: ${process.pid}). No se elimina.`);
      return false;
    }
  } catch (err) {
    console.error('⚠️ [Lock] Error al liberar lockfile:', err.message);
    return false;
  }
}
