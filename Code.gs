/**
 * Fichajes: control horario sobre Google Apps Script + Google Sheets.
 *
 * Publicación: aplicación web ejecutada como el propietario. Cada persona
 * entra con usuario y contraseña. La cuenta de administrador gestiona al
 * equipo, corrige fichajes y recibe los avisos; las cuentas de empleado las
 * genera el administrador desde la propia aplicación.
 *
 * Además de la interfaz web (doGet), la aplicación Android habla con este
 * mismo servidor mediante peticiones JSON (doPost).
 */

const TZ = 'Europe/Madrid';

const CONFIG = {
  nombreLibro: 'Fichajes - Control horario',

  // Cuenta de administrador. La contraseña la elige su titular al activarla.
  adminUsuario: 'brillo magico',
  adminNombre: 'Brillo Mágico',

  // Si es true, no se admite un fichaje sin coordenadas.
  ubicacionObligatoria: true,

  // Seguimiento de ubicación durante la jornada. Los puntos se guardan en un
  // libro aparte, con una pestaña por día.
  nombreLibroUbicaciones: 'Fichajes - Ubicaciones',
  segundosEntreUbicaciones: 30,   // cadencia de registro
  segundosEntreEnvios: 60,        // cada cuánto envía la app los puntos acumulados
  seguimientoEnPausas: false,     // true = también se registra durante las pausas
  diasConservarUbicaciones: 60,   // los recorridos más antiguos se borran solos

  // Filas recientes que se leen de la hoja Avisos.
  maxFilasAvisos: 500,

  // Sesiones y protección frente a intentos de contraseña.
  diasSesion: 30,
  intentosAntesDeBloqueo: 5,
  minutosBloqueo: 15,

  // Avisos al administrador. Cada tipo se puede desactivar entero (activo)
  // o dejarlo solo dentro de la aplicación (correo: false).
  correoAvisos: '',            // vacío = cuenta de Google propietaria
  horasMaxJornada: 10,         // a partir de aquí se avisa de salida olvidada
  horaResumenDiario: 22,       // hora (0-23) del resumen diario
  avisos: {
    FICHAJE: { activo: true, correo: true },
    OLVIDO: { activo: true, correo: true },
    ACCESO: { activo: true, correo: true },
    RESUMEN: { activo: true, correo: true }
  }
};

const HOJAS = {
  FICHAJES: 'Fichajes',
  USUARIOS: 'Usuarios',
  AUDITORIA: 'Auditoria',
  RESUMEN: 'Resumen',
  AVISOS: 'Avisos'
};

const CABECERAS = {
  Fichajes: ['Id', 'FechaHora', 'Usuario', 'Tipo', 'Latitud', 'Longitud', 'PrecisionM', 'Origen', 'Estado', 'Nota'],
  Usuarios: ['Usuario', 'Nombre', 'Rol', 'Activo', 'Sal', 'Hash', 'HoraEntrada', 'HoraSalida', 'Dias'],
  Auditoria: ['FechaHora', 'Administrador', 'Accion', 'IdFichaje', 'Empleado', 'ValorAnterior', 'ValorNuevo', 'Motivo'],
  Resumen: ['Fecha', 'Usuario', 'Nombre', 'Entrada', 'Salida', 'PausasMin', 'HorasTrabajadas', 'Jornada', 'CorregidaPorAdmin'],
  Avisos: ['Id', 'FechaHora', 'Tipo', 'Usuario', 'Texto', 'Leido', 'Clave']
};

// Libro de ubicaciones: pestaña con la última posición de cada persona y una pestaña por día (yyyy-MM-dd).
const HOJA_ULTIMAS = 'Ultimas';
const CABECERA_ULTIMAS = ['Usuario', 'FechaHora', 'Latitud', 'Longitud', 'PrecisionM'];
const CABECERA_DIA = ['FechaHora', 'Usuario', 'Latitud', 'Longitud', 'PrecisionM'];

const TIPOS = ['ENTRADA', 'PAUSA_INICIO', 'PAUSA_FIN', 'SALIDA'];

const ETIQUETAS = {
  ENTRADA: 'Entrada',
  PAUSA_INICIO: 'Inicio de pausa',
  PAUSA_FIN: 'Fin de pausa',
  SALIDA: 'Salida'
};

// Fichajes admitidos desde la aplicación según el estado actual de la persona.
const TRANSICIONES = {
  FUERA: ['ENTRADA'],
  TRABAJANDO: ['PAUSA_INICIO', 'SALIDA'],
  EN_PAUSA: ['PAUSA_FIN']
};

const ESTADOS_TEXTO = {
  FUERA: 'fuera de jornada',
  TRABAJANDO: 'trabajando',
  EN_PAUSA: 'en pausa'
};

/* ------------------------------------------------------------------ */
/* Entrada web                                                         */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Fichajes')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Entrada de la aplicación Android. Recibe JSON { accion, ... } y responde
 * JSON { ok, datos } o { ok: false, error }. Solo expone lo que necesita un
 * empleado; la administración se hace desde la web.
 */
function doPost(e) {
  let salida;
  try {
    const p = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}') || {};
    salida = { ok: true, datos: api_(p) };
  } catch (err) {
    salida = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(salida)).setMimeType(ContentService.MimeType.JSON);
}

function api_(p) {
  switch (String(p.accion)) {
    case 'login': {
      const r = iniciarSesion(p.usuario, p.clave);
      if (r.usuario.rol !== 'EMPLEADO') throw new Error('La cuenta de administrador se usa desde la web.');
      return r;
    }
    case 'estado': {
      const ss = ss_();
      return estadoUsuario_(ss, empleado_(ss, p.token));
    }
    case 'fichar':
      return fichar(p.token, p.tipo, p.pos);
    case 'ubicaciones':
      return registrarUbicaciones(p.token, p.puntos);
    default:
      throw new Error('Acción no reconocida.');
  }
}

/* ------------------------------------------------------------------ */
/* Funciones del propietario (se ejecutan desde el editor)             */
/* ------------------------------------------------------------------ */

/**
 * Crea (o repara) el libro de Google Sheets, la cuenta de administrador y
 * los disparadores de los avisos. Escribe en el registro de ejecución la
 * dirección del libro y, si la cuenta de administrador está sin activar,
 * su código de activación.
 */
function instalar() {
  soloPropietario_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty('SPREADSHEET_ID');
    const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create(CONFIG.nombreLibro);
    ss.setSpreadsheetTimeZone(TZ);

    Object.keys(CABECERAS).forEach(function (nombre) {
      const hoja = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
      // La cabecera se reescribe siempre: así una instalación anterior recibe las columnas nuevas.
      hoja.getRange(1, 1, 1, CABECERAS[nombre].length).setValues([CABECERAS[nombre]]).setFontWeight('bold');
      hoja.setFrozenRows(1);
    });
    ss.getSheetByName(HOJAS.FICHAJES).getRange('B2:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    // Horario como texto, para que Sheets no convierta "08:00" en una hora ni "12345" en un número.
    ss.getSheetByName(HOJAS.USUARIOS).getRange('G2:I').setNumberFormat('@');
    ss.getSheetByName(HOJAS.AUDITORIA).getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    ss.getSheetByName(HOJAS.AVISOS).getRange('B2:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');

    // Retira la hoja vacía que Sheets crea por defecto.
    ss.getSheets().forEach(function (hoja) {
      if (!CABECERAS[hoja.getName()] && hoja.getLastRow() === 0 && ss.getSheets().length > 1) {
        ss.deleteSheet(hoja);
      }
    });

    if (!props.getProperty('SECRETO')) {
      props.setProperty('SECRETO', Utilities.getUuid() + Utilities.getUuid());
    }

    const admin = normalizarUsuario_(CONFIG.adminUsuario);
    let cuenta = leerUsuarios_(ss).filter(function (u) { return u.usuario === admin; })[0];
    if (!cuenta) {
      ss.getSheetByName(HOJAS.USUARIOS).appendRow([admin, CONFIG.adminNombre, 'ADMIN', true, '', '', '', '', '']);
      cuenta = { hash: '' };
    }
    if (!cuenta.hash && !props.getProperty('ACTIVACION')) {
      props.setProperty('ACTIVACION', generarCodigo_());
    }

    // Libro aparte para los recorridos: crecen mucho y se purgan por días.
    const idUbic = props.getProperty('UBICACIONES_ID');
    const libro = idUbic ? SpreadsheetApp.openById(idUbic) : SpreadsheetApp.create(CONFIG.nombreLibroUbicaciones);
    libro.setSpreadsheetTimeZone(TZ);
    const ultimas = libro.getSheetByName(HOJA_ULTIMAS) || libro.insertSheet(HOJA_ULTIMAS);
    ultimas.getRange(1, 1, 1, CABECERA_ULTIMAS.length).setValues([CABECERA_ULTIMAS]).setFontWeight('bold');
    ultimas.setFrozenRows(1);
    ultimas.getRange('B2:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    libro.getSheets().forEach(function (hoja) {
      if (hoja.getName() !== HOJA_ULTIMAS && hoja.getLastRow() === 0 && libro.getSheets().length > 1) libro.deleteSheet(hoja);
    });
    props.setProperty('UBICACIONES_ID', libro.getId());

    props.setProperty('SPREADSHEET_ID', ss.getId());
    programarDisparadores_();

    Logger.log('Libro de fichajes: ' + ss.getUrl());
    Logger.log('Libro de ubicaciones: ' + libro.getUrl());
    if (props.getProperty('ACTIVACION')) {
      Logger.log('Cuenta de administrador "' + admin + '" pendiente de activar.');
      Logger.log('Código de activación: ' + props.getProperty('ACTIVACION'));
    }
    return ss.getUrl();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Deja la cuenta de administrador sin contraseña y genera un código de
 * activación nuevo. Para cuando se olvida la contraseña.
 */
function restablecerAdmin() {
  soloPropietario_();
  const ss = ss_();
  const admin = normalizarUsuario_(CONFIG.adminUsuario);
  const cuenta = leerUsuarios_(ss).filter(function (u) { return u.usuario === admin; })[0];
  if (!cuenta) throw new Error('No existe la cuenta de administrador. Ejecuta instalar.');
  ss.getSheetByName(HOJAS.USUARIOS).getRange(cuenta.fila, 5, 1, 2).setValues([['', '']]);
  const codigo = generarCodigo_();
  PropertiesService.getScriptProperties().setProperty('ACTIVACION', codigo);
  Logger.log('Contraseña de administrador eliminada. Código de activación: ' + codigo);
}

/** Solo el propietario, con su sesión de Google, puede ejecutar estas funciones. */
function soloPropietario_() {
  const activo = String(Session.getActiveUser().getEmail() || '');
  if (!activo || activo !== String(Session.getEffectiveUser().getEmail() || '')) {
    throw new Error('Esta función solo puede ejecutarla el propietario desde el editor de Apps Script.');
  }
}

function programarDisparadores_() {
  const funciones = ['revisarJornadasAbiertas', 'enviarResumenDiario', 'purgarUbicaciones'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (funciones.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('revisarJornadasAbiertas').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('enviarResumenDiario').timeBased()
    .atHour(CONFIG.horaResumenDiario).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('purgarUbicaciones').timeBased().atHour(3).everyDays(1).inTimezone(TZ).create();
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error('La aplicación no está instalada. Ejecuta la función instalar desde el editor de Apps Script.');
  }
  return SpreadsheetApp.openById(id);
}

/* ------------------------------------------------------------------ */
/* Acceso                                                              */
/* ------------------------------------------------------------------ */

/** Estado público de la instalación, para que la interfaz sepa qué pantalla mostrar. */
function getInicio() {
  const props = PropertiesService.getScriptProperties();
  return {
    instalada: !!props.getProperty('SPREADSHEET_ID'),
    adminPendiente: !!props.getProperty('ACTIVACION'),
    adminUsuario: normalizarUsuario_(CONFIG.adminUsuario)
  };
}

/**
 * Primera entrada del administrador: con el código de activación que
 * escribe instalar en el registro, elige su contraseña.
 */
function activarAdmin(codigo, clave) {
  const ss = ss_();
  const props = PropertiesService.getScriptProperties();
  const esperado = props.getProperty('ACTIVACION');
  if (!esperado) throw new Error('La cuenta de administrador ya está activada.');
  comprobarBloqueo_('activacion');
  if (normalizarCodigo_(codigo) !== normalizarCodigo_(esperado)) {
    anotarFallo_('activacion');
    throw new Error('Código de activación incorrecto.');
  }
  clave = String(clave === null || clave === undefined ? '' : clave);
  if (clave.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');

  const admin = normalizarUsuario_(CONFIG.adminUsuario);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cuenta = leerUsuarios_(ss).filter(function (u) { return u.usuario === admin; })[0];
    if (!cuenta) throw new Error('No existe la cuenta de administrador. Ejecuta instalar.');
    const sal = nuevaSal_();
    ss.getSheetByName(HOJAS.USUARIOS).getRange(cuenta.fila, 5, 1, 2).setValues([[sal, hashClave_(clave, sal)]]);
    props.deleteProperty('ACTIVACION');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  limpiarFallos_('activacion');
  const u = leerUsuarios_(ss).filter(function (x) { return x.usuario === admin; })[0];
  return { token: emitirToken_(u), usuario: publico_(u) };
}

function iniciarSesion(usuario, clave) {
  const ss = ss_();
  const nombre = normalizarUsuario_(usuario);
  clave = String(clave === null || clave === undefined ? '' : clave);
  if (!nombre || !clave) throw new Error('Introduce usuario y contraseña.');
  comprobarBloqueo_('u:' + nombre);

  const u = leerUsuarios_(ss).filter(function (x) { return x.usuario === nombre; })[0];
  // Se calcula el hash aunque la cuenta no exista, para no delatarlo por el tiempo de respuesta.
  const calculado = hashClave_(clave, u && u.sal ? u.sal : 'sin-cuenta');
  if (!u || !u.activo || !u.hash || calculado !== u.hash) {
    const fallos = anotarFallo_('u:' + nombre);
    if (u && fallos === CONFIG.intentosAntesDeBloqueo) {
      avisar_(ss, 'ACCESO', u.usuario,
        'Cuenta de ' + u.nombre + ' bloqueada ' + CONFIG.minutosBloqueo + ' minutos por intentos de acceso fallidos.',
        'bloqueo:' + u.usuario + ':' + fecha_(Date.now()),
        'Se han producido ' + fallos + ' intentos seguidos con contraseña incorrecta para el usuario "' + u.usuario + '".');
    }
    throw new Error('Usuario o contraseña incorrectos.');
  }
  limpiarFallos_('u:' + nombre);
  return { token: emitirToken_(u), usuario: publico_(u) };
}

/* ------------------------------------------------------------------ */
/* API del empleado                                                    */
/* ------------------------------------------------------------------ */

function getEstado(token) {
  const ss = ss_();
  const u = usuario_(ss, token);
  if (u.rol === 'ADMIN') {
    return { usuario: u, avisosSinLeer: leerAvisos_(ss).filter(function (a) { return !a.leido; }).length };
  }
  return estadoUsuario_(ss, u);
}

function fichar(token, tipo, pos) {
  const ss = ss_();
  const u = empleado_(ss, token);
  if (TIPOS.indexOf(tipo) < 0) throw new Error('Tipo de fichaje no válido.');
  const p = posicion_(pos);
  if (CONFIG.ubicacionObligatoria && !p) {
    throw new Error('Para fichar es necesario permitir el acceso a la ubicación.');
  }

  const ahora = new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const estado = estadoDe_(activosDe_(leerFichajes_(ss), u.usuario));
    if (TRANSICIONES[estado].indexOf(tipo) < 0) {
      throw new Error('No puedes registrar "' + ETIQUETAS[tipo] + '" ahora: estás ' + ESTADOS_TEXTO[estado] + '.');
    }
    ss.getSheetByName(HOJAS.FICHAJES).appendRow([
      Utilities.getUuid(), ahora, u.usuario, tipo,
      p ? p.lat : '', p ? p.lng : '', p ? p.prec : '',
      'APP', 'ACTIVO', ''
    ]);
    SpreadsheetApp.flush();
    actualizarResumen_(ss);
  } finally {
    lock.releaseLock();
  }

  avisar_(ss, 'FICHAJE', u.usuario,
    u.nombre + ': ' + ETIQUETAS[tipo].toLowerCase() + ' a las ' + hora_(ahora.getTime()),
    '',
    p ? 'Ubicación: https://www.google.com/maps?q=' + p.lat + ',' + p.lng : 'Sin ubicación.');
  return estadoUsuario_(ss, u);
}

/**
 * Puntos de seguimiento, de uno en uno (web) o por lotes (app). Cada punto
 * lleva la hora en que se tomó (ts); sin ella se usa la de recepción. Solo
 * se guardan los que caen dentro de la jornada de la persona, y nunca dos
 * veces el mismo. Devuelve el estado actual para que la app sepa si debe
 * seguir registrando.
 */
function registrarUbicaciones(token, puntos) {
  const ss = ss_();
  const u = empleado_(ss, token);
  const ahora = Date.now();
  const eventos = activosDe_(leerFichajes_(ss), u.usuario);
  const tramos = tramosSeguimiento_(eventos, ahora);

  const validos = [];
  (Array.isArray(puntos) ? puntos : []).slice(0, 200).forEach(function (p) {
    const pos = posicion_(p);
    if (!pos) return;
    const ts = p.ts === undefined || p.ts === null ? ahora : Math.round(Number(p.ts));
    if (!isFinite(ts) || ts > ahora + 120000) return;
    if (!tramos.some(function (t) { return ts >= t[0] - 5000 && ts <= t[1] + 5000; })) return;
    validos.push({ ts: ts, lat: pos.lat, lng: pos.lng, prec: pos.prec });
  });
  validos.sort(function (a, b) { return a.ts - b.ts; });

  let guardados = 0;
  if (validos.length) {
    const libro = libroUbicaciones_();
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      guardados = guardarPuntos_(libro, u.usuario, validos);
    } finally {
      lock.releaseLock();
    }
  }
  return { guardados: guardados, estado: estadoDe_(eventos) };
}

function getMisJornadas(token) {
  const ss = ss_();
  const u = empleado_(ss, token);
  const desde = fecha_(Date.now() - 31 * 24 * 3600 * 1000);
  return calcularJornadas_(activosDe_(leerFichajes_(ss), u.usuario))
    .filter(function (j) { return j.fecha >= desde; })
    .reverse()
    .map(function (j) {
      return {
        fecha: j.fecha,
        entrada: hora_(j.entrada),
        salida: j.salida ? hora_(j.salida) : '',
        trabajoMs: j.trabajoMs,
        pausaMs: j.pausaMs,
        abierta: j.abierta,
        corregida: j.corregida
      };
    });
}

/* ------------------------------------------------------------------ */
/* API del administrador                                               */
/* ------------------------------------------------------------------ */

function getPanel(token, fecha) {
  const ss = ss_();
  admin_(ss, token);
  return panel_(ss, fechaValida_(fecha) || fecha_(Date.now()));
}

function getUbicaciones(token, usuario, fecha) {
  const ss = ss_();
  admin_(ss, token);
  usuario = normalizarUsuario_(usuario);
  fecha = fechaValida_(fecha) || fecha_(Date.now());

  const puntos = [];
  const hoja = libroUbicaciones_().getSheetByName(fecha);
  if (hoja) {
    leer_(hoja, CABECERA_DIA.length).filas.forEach(function (f) {
      if (!(f[0] instanceof Date) || normalizarUsuario_(f[1]) !== usuario) return;
      const ts = f[0].getTime();
      puntos.push({ ts: ts, hora: horaSeg_(ts), lat: f[2], lng: f[3], prec: f[4], origen: 'Seguimiento' });
    });
  }
  leerFichajes_(ss).forEach(function (f) {
    if (f.usuario === usuario && f.estado === 'ACTIVO' && f.lat !== '' && fecha_(f.ts) === fecha) {
      puntos.push({ ts: f.ts, hora: horaSeg_(f.ts), lat: f.lat, lng: f.lng, prec: f.prec, origen: ETIQUETAS[f.tipo] || f.tipo });
    }
  });
  puntos.sort(function (a, b) { return a.ts - b.ts; });
  return { usuario: usuario, fecha: fecha, ahora: Date.now(), puntos: puntos };
}

/**
 * Horario de un empleado: hora de entrada, hora de salida y días de la
 * semana (1 = lunes ... 7 = domingo). La app lo usa para avisar de que es
 * la hora de fichar. h = { entrada: 'HH:mm', salida: 'HH:mm', dias: '12345', fechaPanel }
 */
function guardarHorario(token, usuario, h) {
  const ss = ss_();
  const a = admin_(ss, token);
  usuario = normalizarUsuario_(usuario);
  h = h || {};
  const entrada = horaValida_(h.entrada);
  const salida = horaValida_(h.salida);
  const dias = diasValidos_(h.dias);
  if ((entrada || salida) && !dias) throw new Error('Elige al menos un día de la semana.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const e = leerUsuarios_(ss).filter(function (x) { return x.usuario === usuario && x.rol === 'EMPLEADO'; })[0];
    if (!e) throw new Error('La persona indicada no figura en la hoja de usuarios.');
    ss.getSheetByName(HOJAS.USUARIOS).getRange(e.fila, 7, 1, 3).setValues([[entrada, salida, entrada || salida ? dias : '']]);
    auditar_(ss, a.usuario, 'HORARIO', '', usuario, horarioTexto_(e), horarioTexto_({ horaEntrada: entrada, horaSalida: salida, dias: dias }), 'Horario desde el panel');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return panel_(ss, fechaValida_(h.fechaPanel) || fecha_(Date.now()));
}

/**
 * Alta o corrección de un fichaje por parte del administrador. El valor
 * anterior y el motivo quedan en la hoja de auditoría.
 * d = { id?, usuario, tipo, fechaHora: 'yyyy-MM-ddTHH:mm', motivo, fechaPanel }
 */
function guardarFichaje(token, d) {
  const ss = ss_();
  const a = admin_(ss, token);
  d = d || {};
  const motivo = String(d.motivo || '').trim();
  if (motivo.length < 5) throw new Error('Indica el motivo de la corrección (mínimo 5 caracteres).');
  if (TIPOS.indexOf(d.tipo) < 0) throw new Error('Tipo de fichaje no válido.');
  const cuando = fechaHora_(d.fechaHora);
  if (cuando.getTime() > Date.now() + 60000) throw new Error('No se puede registrar un fichaje en el futuro.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = ss.getSheetByName(HOJAS.FICHAJES);
    const nuevo = ETIQUETAS[d.tipo] + ' ' + fechaHoraTexto_(cuando.getTime());
    if (d.id) {
      const f = buscarFichaje_(ss, d.id);
      hoja.getRange(f.fila, 2).setValue(cuando);
      hoja.getRange(f.fila, 4).setValue(d.tipo);
      hoja.getRange(f.fila, 8).setValue('ADMIN');
      hoja.getRange(f.fila, 10).setValue(motivo);
      auditar_(ss, a.usuario, 'MODIFICAR', f.id, f.usuario, (ETIQUETAS[f.tipo] || f.tipo) + ' ' + fechaHoraTexto_(f.ts), nuevo, motivo);
    } else {
      const usuario = normalizarUsuario_(d.usuario);
      const existe = leerUsuarios_(ss).some(function (e) { return e.usuario === usuario && e.rol === 'EMPLEADO'; });
      if (!existe) throw new Error('La persona indicada no figura en la hoja de usuarios.');
      const id = Utilities.getUuid();
      hoja.appendRow([id, cuando, usuario, d.tipo, '', '', '', 'ADMIN', 'ACTIVO', motivo]);
      auditar_(ss, a.usuario, 'CREAR', id, usuario, '', nuevo, motivo);
    }
    SpreadsheetApp.flush();
    actualizarResumen_(ss);
  } finally {
    lock.releaseLock();
  }
  return panel_(ss, fechaValida_(d.fechaPanel) || fecha_(cuando.getTime()));
}

/** Anula un fichaje sin borrarlo: la fila se conserva marcada como ANULADO. */
function anularFichaje(token, id, motivo, fechaPanel) {
  const ss = ss_();
  const a = admin_(ss, token);
  motivo = String(motivo || '').trim();
  if (motivo.length < 5) throw new Error('Indica el motivo de la anulación (mínimo 5 caracteres).');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let f;
  try {
    f = buscarFichaje_(ss, id);
    const hoja = ss.getSheetByName(HOJAS.FICHAJES);
    hoja.getRange(f.fila, 9).setValue('ANULADO');
    hoja.getRange(f.fila, 10).setValue(motivo);
    auditar_(ss, a.usuario, 'ANULAR', f.id, f.usuario, (ETIQUETAS[f.tipo] || f.tipo) + ' ' + fechaHoraTexto_(f.ts), 'ANULADO', motivo);
    SpreadsheetApp.flush();
    actualizarResumen_(ss);
  } finally {
    lock.releaseLock();
  }
  return panel_(ss, fechaValida_(fechaPanel) || fecha_(f.ts));
}

function getResumenPeriodo(token, desde, hasta) {
  const ss = ss_();
  admin_(ss, token);
  desde = fechaValida_(desde);
  hasta = fechaValida_(hasta);
  if (!desde || !hasta || desde > hasta) throw new Error('Rango de fechas no válido.');

  const todos = leerFichajes_(ss);
  return empleados_(ss).map(function (e) {
    const r = { usuario: e.usuario, nombre: e.nombre, dias: 0, trabajoMs: 0, pausaMs: 0, incompletas: 0 };
    calcularJornadas_(activosDe_(todos, e.usuario)).forEach(function (j) {
      if (j.fecha < desde || j.fecha > hasta) return;
      r.dias++;
      r.trabajoMs += j.trabajoMs;
      r.pausaMs += j.pausaMs;
      if (j.abierta) r.incompletas++;
    });
    return r;
  });
}

/**
 * Alta de un empleado. Genera su usuario y su contraseña; la contraseña se
 * devuelve una sola vez y en la hoja solo queda su hash.
 */
function crearEmpleado(token, nombre) {
  const ss = ss_();
  const a = admin_(ss, token);
  nombre = String(nombre || '').trim().slice(0, 80);
  if (nombre.length < 2) throw new Error('Indica el nombre de la persona.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let usuario, clave;
  try {
    const existentes = leerUsuarios_(ss).map(function (e) { return e.usuario; });
    const base = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'persona';
    usuario = base;
    for (let n = 2; existentes.indexOf(usuario) >= 0; n++) usuario = base + '.' + n;
    clave = generarClave_();
    const sal = nuevaSal_();
    ss.getSheetByName(HOJAS.USUARIOS).appendRow([usuario, nombre, 'EMPLEADO', true, sal, hashClave_(clave, sal), '', '', '']);
    auditar_(ss, a.usuario, 'ALTA_EMPLEADO', '', usuario, '', 'EMPLEADO', 'Alta desde el panel');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { usuario: usuario, nombre: nombre, clave: clave, panel: panel_(ss, fecha_(Date.now())) };
}

/** Genera una contraseña nueva para un empleado; la anterior deja de valer. */
function restablecerClave(token, usuario) {
  const ss = ss_();
  const a = admin_(ss, token);
  usuario = normalizarUsuario_(usuario);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let e, clave;
  try {
    e = leerUsuarios_(ss).filter(function (x) { return x.usuario === usuario && x.rol === 'EMPLEADO'; })[0];
    if (!e) throw new Error('La persona indicada no figura en la hoja de usuarios.');
    clave = generarClave_();
    const sal = nuevaSal_();
    ss.getSheetByName(HOJAS.USUARIOS).getRange(e.fila, 5, 1, 2).setValues([[sal, hashClave_(clave, sal)]]);
    auditar_(ss, a.usuario, 'RESTABLECER_CLAVE', '', usuario, '', '', 'Contraseña nueva desde el panel');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  limpiarFallos_('u:' + usuario);
  return { usuario: e.usuario, nombre: e.nombre, clave: clave };
}

function getAvisos(token) {
  const ss = ss_();
  admin_(ss, token);
  return avisosPanel_(ss);
}

function marcarAvisosLeidos(token) {
  const ss = ss_();
  admin_(ss, token);
  const hoja = ss.getSheetByName(HOJAS.AVISOS);
  leerAvisos_(ss).forEach(function (a) {
    if (!a.leido) hoja.getRange(a.fila, 6).setValue(true);
  });
  SpreadsheetApp.flush();
  return avisosPanel_(ss);
}

/* ------------------------------------------------------------------ */
/* Avisos al administrador                                             */
/* ------------------------------------------------------------------ */

/**
 * Registra un aviso en la hoja Avisos y, si procede, lo envía por correo.
 * Con clave, el aviso no se repite si ya existe uno con la misma clave.
 * Nunca lanza errores: un aviso fallido no debe estropear un fichaje.
 */
function avisar_(ss, tipo, usuario, texto, clave, detalle) {
  try {
    const cfg = CONFIG.avisos[tipo];
    if (!cfg || !cfg.activo) return false;
    if (clave && leerAvisos_(ss).some(function (a) { return a.clave === clave; })) return false;
    ss.getSheetByName(HOJAS.AVISOS).appendRow([Utilities.getUuid(), new Date(), tipo, usuario || '', texto, false, clave || '']);
    if (cfg.correo) enviarCorreo_(texto, texto + (detalle ? '\n\n' + detalle : ''));
    return true;
  } catch (e) {
    Logger.log('Aviso no registrado: ' + e);
    return false;
  }
}

function enviarCorreo_(asunto, cuerpo) {
  try {
    const para = CONFIG.correoAvisos || Session.getEffectiveUser().getEmail();
    if (!para || MailApp.getRemainingDailyQuota() < 1) return;
    MailApp.sendEmail(para, '[Fichajes] ' + asunto, cuerpo);
  } catch (e) {
    Logger.log('Correo no enviado: ' + e);
  }
}

/** Disparador horario: avisa de las jornadas que siguen abiertas demasiadas horas. */
function revisarJornadasAbiertas() {
  if (!PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')) return;
  const ss = ss_();
  const ahora = Date.now();
  const limite = CONFIG.horasMaxJornada * 3600000;
  const todos = leerFichajes_(ss);
  empleados_(ss).forEach(function (e) {
    const jornadas = calcularJornadas_(activosDe_(todos, e.usuario));
    const ultima = jornadas[jornadas.length - 1];
    if (!ultima || !ultima.abierta || ahora - ultima.entrada < limite) return;
    avisar_(ss, 'OLVIDO', e.usuario,
      e.nombre + ' lleva más de ' + CONFIG.horasMaxJornada + ' horas sin fichar la salida.',
      'olvido:' + ultima.eventos[0].id,
      'Entrada registrada el ' + fechaHoraTexto_(ultima.entrada) + '. Puedes corregir la jornada desde el panel de administrador.');
  });
}

/** Disparador diario: resumen de horas del día. Solo se envía una vez por fecha. */
function enviarResumenDiario() {
  if (!PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')) return;
  const ahora = Date.now();
  if (Number(Utilities.formatDate(new Date(ahora), TZ, 'H')) < CONFIG.horaResumenDiario) return;
  const ss = ss_();
  const hoy = fecha_(ahora);
  const todos = leerFichajes_(ss);

  let personas = 0, totalMs = 0, abiertas = 0;
  const lineas = [];
  empleados_(ss).forEach(function (e) {
    let ms = 0, pausa = 0, abierta = false, hay = false;
    calcularJornadas_(activosDe_(todos, e.usuario)).forEach(function (j) {
      if (j.fecha !== hoy) return;
      hay = true;
      ms += j.trabajoMs + (j.abierta && j.inicioTramo !== null ? ahora - j.inicioTramo : 0);
      pausa += j.pausaMs + (j.abierta && j.inicioPausa !== null ? ahora - j.inicioPausa : 0);
      if (j.abierta) abierta = true;
    });
    if (!hay) {
      lineas.push(e.nombre + ': sin fichajes');
      return;
    }
    personas++;
    totalMs += ms;
    if (abierta) abiertas++;
    lineas.push(e.nombre + ': ' + horasTexto_(ms) + ' trabajadas, ' + Math.round(pausa / 60000) + ' min de pausa' +
      (abierta ? ' (jornada sin cerrar)' : ''));
  });

  avisar_(ss, 'RESUMEN', '',
    'Resumen del ' + Utilities.formatDate(new Date(ahora), TZ, 'dd/MM') + ': ' + personas +
      (personas === 1 ? ' persona ha fichado, ' : ' personas han fichado, ') + horasTexto_(totalMs) + ' en total' +
      (abiertas ? ', ' + abiertas + (abiertas === 1 ? ' jornada sin cerrar' : ' jornadas sin cerrar') : '') + '.',
    'resumen:' + hoy,
    lineas.join('\n'));
}

/** Disparador diario: borra los recorridos más antiguos que CONFIG.diasConservarUbicaciones. */
function purgarUbicaciones() {
  const id = PropertiesService.getScriptProperties().getProperty('UBICACIONES_ID');
  if (!id) return;
  const libro = SpreadsheetApp.openById(id);
  const limite = fecha_(Date.now() - CONFIG.diasConservarUbicaciones * 24 * 3600 * 1000);
  libro.getSheets().forEach(function (hoja) {
    const nombre = hoja.getName();
    if (/^\d{4}-\d{2}-\d{2}$/.test(nombre) && nombre < limite) libro.deleteSheet(hoja);
  });
}

function leerAvisos_(ss) {
  const datos = leer_(ss.getSheetByName(HOJAS.AVISOS), CABECERAS.Avisos.length, CONFIG.maxFilasAvisos);
  const salida = [];
  datos.filas.forEach(function (f, i) {
    if (!f[0] || !(f[1] instanceof Date)) return;
    salida.push({
      fila: datos.inicio + i,
      id: String(f[0]),
      ts: f[1].getTime(),
      tipo: String(f[2]),
      usuario: String(f[3]),
      texto: String(f[4]),
      leido: f[5] === true || String(f[5]).toUpperCase() === 'TRUE',
      clave: String(f[6] || '')
    });
  });
  return salida;
}

function avisosPanel_(ss) {
  const todos = leerAvisos_(ss).sort(function (a, b) { return b.ts - a.ts; });
  return {
    sinLeer: todos.filter(function (a) { return !a.leido; }).length,
    avisos: todos.slice(0, 60).map(function (a) {
      return { id: a.id, cuando: fechaHoraTexto_(a.ts), tipo: a.tipo, texto: a.texto, leido: a.leido };
    })
  };
}

/* ------------------------------------------------------------------ */
/* Cálculo de jornadas                                                 */
/* ------------------------------------------------------------------ */

/**
 * Agrupa en jornadas los fichajes activos de una persona, ya ordenados por
 * hora. Cada jornada empieza en una ENTRADA y se asigna al día de esa
 * entrada. Una jornada sin SALIDA queda marcada como abierta.
 */
function calcularJornadas_(eventos) {
  const jornadas = [];
  let j = null;

  eventos.forEach(function (e) {
    if (e.tipo === 'ENTRADA') {
      if (j) {
        // Entrada nueva sin salida previa: la jornada anterior queda incompleta.
        j.inicioTramo = null;
        j.inicioPausa = null;
        jornadas.push(j);
      }
      j = {
        fecha: fecha_(e.ts), entrada: e.ts, salida: null,
        trabajoMs: 0, pausaMs: 0, abierta: true, corregida: false,
        inicioTramo: e.ts, inicioPausa: null, eventos: []
      };
    } else if (!j) {
      return; // fichaje suelto sin entrada previa: no computa
    } else if (e.tipo === 'PAUSA_INICIO') {
      if (j.inicioTramo !== null) {
        j.trabajoMs += e.ts - j.inicioTramo;
        j.inicioTramo = null;
        j.inicioPausa = e.ts;
      }
    } else if (e.tipo === 'PAUSA_FIN') {
      if (j.inicioPausa !== null) {
        j.pausaMs += e.ts - j.inicioPausa;
        j.inicioPausa = null;
        j.inicioTramo = e.ts;
      }
    } else if (e.tipo === 'SALIDA') {
      if (j.inicioTramo !== null) j.trabajoMs += e.ts - j.inicioTramo;
      if (j.inicioPausa !== null) j.pausaMs += e.ts - j.inicioPausa;
      j.inicioTramo = null;
      j.inicioPausa = null;
      j.salida = e.ts;
      j.abierta = false;
    }
    j.eventos.push(e);
    if (e.origen === 'ADMIN') j.corregida = true;
    if (e.tipo === 'SALIDA') {
      jornadas.push(j);
      j = null;
    }
  });
  if (j) jornadas.push(j);
  return jornadas;
}

function estadoDe_(eventos) {
  if (!eventos.length) return 'FUERA';
  const ultimo = eventos[eventos.length - 1].tipo;
  if (ultimo === 'ENTRADA' || ultimo === 'PAUSA_FIN') return 'TRABAJANDO';
  if (ultimo === 'PAUSA_INICIO') return 'EN_PAUSA';
  return 'FUERA';
}

function estadoUsuario_(ss, u) {
  const eventos = activosDe_(leerFichajes_(ss), u.usuario);
  const hoy = fecha_(Date.now());
  // Jornadas de hoy, más la que siga en curso aunque empezara ayer (turno de noche).
  const ultima = calcularJornadas_(eventos).filter(function (j, i, todas) {
    return j.fecha === hoy || (j.abierta && i === todas.length - 1);
  });

  let trabajoMs = 0, pausaMs = 0, enCursoDesde = null, pausaDesde = null;
  const fichajes = [];
  ultima.forEach(function (j) {
    trabajoMs += j.trabajoMs;
    pausaMs += j.pausaMs;
    if (j.abierta) {
      enCursoDesde = j.inicioTramo;
      pausaDesde = j.inicioPausa;
    }
    j.eventos.forEach(function (e) {
      fichajes.push({ hora: hora_(e.ts), fecha: fecha_(e.ts), tipo: e.tipo, etiqueta: ETIQUETAS[e.tipo], origen: e.origen });
    });
  });

  return {
    usuario: u,
    estado: estadoDe_(eventos),
    ahora: Date.now(),
    hoy: hoy,
    trabajoMs: trabajoMs,
    pausaMs: pausaMs,
    enCursoDesde: enCursoDesde,
    pausaDesde: pausaDesde,
    fichajes: fichajes,
    config: {
      ubicacionObligatoria: CONFIG.ubicacionObligatoria,
      segundosEntreUbicaciones: CONFIG.segundosEntreUbicaciones,
      segundosEntreEnvios: CONFIG.segundosEntreEnvios,
      seguimientoEnPausas: CONFIG.seguimientoEnPausas,
      zona: TZ
    }
  };
}

function panel_(ss, fecha) {
  const todos = leerFichajes_(ss);
  const ultimas = ultimas_(libroUbicaciones_());
  const ahora = Date.now();

  const empleados = empleados_(ss).map(function (e) {
    const propios = todos.filter(function (f) { return f.usuario === e.usuario; })
      .sort(function (a, b) { return a.ts - b.ts; });
    const activos = propios.filter(function (f) { return f.estado === 'ACTIVO'; });

    let trabajoMs = 0, pausaMs = 0, incompleta = false;
    calcularJornadas_(activos).forEach(function (j) {
      if (j.fecha !== fecha) return;
      trabajoMs += j.trabajoMs;
      pausaMs += j.pausaMs;
      if (j.abierta) {
        incompleta = true;
        if (j.inicioTramo !== null) trabajoMs += ahora - j.inicioTramo;
        if (j.inicioPausa !== null) pausaMs += ahora - j.inicioPausa;
      }
    });

    let ultima = ultimas[e.usuario] || null;
    activos.forEach(function (f) {
      if (f.lat !== '' && (!ultima || f.ts > ultima.ts)) ultima = f;
    });

    return {
      usuario: e.usuario,
      nombre: e.nombre,
      activo: e.activo,
      horario: horario_(e),
      estado: estadoDe_(activos),
      trabajoMs: trabajoMs,
      pausaMs: pausaMs,
      incompleta: incompleta,
      ultimaUbicacion: ultima ? { ts: ultima.ts, texto: fechaHoraTexto_(ultima.ts), lat: ultima.lat, lng: ultima.lng } : null,
      fichajes: propios.filter(function (f) { return fecha_(f.ts) === fecha; }).map(function (f) {
        return {
          id: f.id, hora: hora_(f.ts), local: local_(f.ts), tipo: f.tipo, etiqueta: ETIQUETAS[f.tipo] || f.tipo,
          origen: f.origen, estado: f.estado, nota: f.nota,
          lat: f.lat, lng: f.lng
        };
      })
    };
  });

  return {
    fecha: fecha,
    hoy: fecha_(ahora),
    ahora: ahora,
    urlHoja: ss.getUrl(),
    avisosSinLeer: leerAvisos_(ss).filter(function (a) { return !a.leido; }).length,
    empleados: empleados
  };
}

/** Reescribe la hoja Resumen: una fila por persona y jornada. */
function actualizarResumen_(ss) {
  const todos = leerFichajes_(ss);
  const filas = [];
  empleados_(ss).forEach(function (e) {
    calcularJornadas_(activosDe_(todos, e.usuario)).forEach(function (j) {
      filas.push([
        j.fecha, e.usuario, e.nombre,
        hora_(j.entrada), j.salida ? hora_(j.salida) : '',
        Math.round(j.pausaMs / 60000),
        Math.round(j.trabajoMs / 36000) / 100,
        j.abierta ? 'Incompleta' : 'Completa',
        j.corregida ? 'Sí' : 'No'
      ]);
    });
  });
  filas.sort(function (a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? 1 : -1;
    return a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0);
  });

  const hoja = ss.getSheetByName(HOJAS.RESUMEN);
  const ancho = CABECERAS.Resumen.length;
  if (hoja.getLastRow() > 1) hoja.getRange(2, 1, hoja.getLastRow() - 1, ancho).clearContent();
  if (filas.length) {
    asegurarFilas_(hoja, filas.length + 1);
    hoja.getRange(2, 1, filas.length, ancho).setValues(filas);
  }
}

/* ------------------------------------------------------------------ */
/* Acceso a datos                                                      */
/* ------------------------------------------------------------------ */

function leer_(hoja, columnas, maxFilas) {
  const ultima = hoja.getLastRow();
  if (ultima < 2) return { inicio: 2, filas: [] };
  let inicio = 2;
  if (maxFilas && ultima - 1 > maxFilas) inicio = ultima - maxFilas + 1;
  return { inicio: inicio, filas: hoja.getRange(inicio, 1, ultima - inicio + 1, columnas).getValues() };
}

/** Amplía la hoja si hace falta para poder escribir hasta la fila indicada. */
function asegurarFilas_(hoja, hasta) {
  const max = hoja.getMaxRows();
  if (hasta > max) hoja.insertRowsAfter(max, hasta - max + 500);
}

function leerFichajes_(ss) {
  const datos = leer_(ss.getSheetByName(HOJAS.FICHAJES), CABECERAS.Fichajes.length);
  const salida = [];
  datos.filas.forEach(function (f, i) {
    if (!f[0] || !(f[1] instanceof Date)) return;
    salida.push({
      fila: datos.inicio + i,
      id: String(f[0]),
      ts: f[1].getTime(),
      usuario: normalizarUsuario_(f[2]),
      tipo: String(f[3]),
      lat: f[4], lng: f[5], prec: f[6],
      origen: String(f[7]),
      estado: String(f[8]) === 'ANULADO' ? 'ANULADO' : 'ACTIVO',
      nota: String(f[9] || '')
    });
  });
  return salida;
}

/** Fichajes no anulados de una persona, ordenados por hora. */
function activosDe_(todos, usuario) {
  return todos
    .filter(function (f) { return f.usuario === usuario && f.estado === 'ACTIVO'; })
    .sort(function (a, b) { return a.ts - b.ts; });
}

function buscarFichaje_(ss, id) {
  const encontrados = leerFichajes_(ss).filter(function (f) { return f.id === String(id); });
  if (!encontrados.length) throw new Error('No se ha encontrado el fichaje indicado.');
  return encontrados[0];
}

/* Libro de ubicaciones */

function libroUbicaciones_() {
  const id = PropertiesService.getScriptProperties().getProperty('UBICACIONES_ID');
  if (!id) throw new Error('Falta el libro de ubicaciones. Ejecuta de nuevo la función instalar desde el editor de Apps Script.');
  return SpreadsheetApp.openById(id);
}

/** Última posición conocida de cada persona: { usuario: { ts, lat, lng, prec } }. */
function ultimas_(libro) {
  const mapa = {};
  leer_(libro.getSheetByName(HOJA_ULTIMAS), CABECERA_ULTIMAS.length).filas.forEach(function (f) {
    if (f[1] instanceof Date) mapa[normalizarUsuario_(f[0])] = { ts: f[1].getTime(), lat: f[2], lng: f[3], prec: f[4] };
  });
  return mapa;
}

/**
 * Guarda los puntos (ya ordenados por hora) en la pestaña de su día y
 * actualiza la última posición. Se descartan los que no sean posteriores al
 * último guardado, de modo que un reenvío de la app no duplica nada.
 */
function guardarPuntos_(libro, usuario, puntos) {
  const hojaUltimas = libro.getSheetByName(HOJA_ULTIMAS);
  let indice = -1, ultimoTs = 0;
  leer_(hojaUltimas, CABECERA_ULTIMAS.length).filas.forEach(function (f, i) {
    if (normalizarUsuario_(f[0]) !== usuario) return;
    indice = i;
    ultimoTs = f[1] instanceof Date ? f[1].getTime() : 0;
  });
  const nuevos = puntos.filter(function (p) { return p.ts > ultimoTs; });
  if (!nuevos.length) return 0;

  const porDia = {};
  nuevos.forEach(function (p) {
    const dia = fecha_(p.ts);
    (porDia[dia] = porDia[dia] || []).push([new Date(p.ts), usuario, p.lat, p.lng, p.prec]);
  });
  Object.keys(porDia).forEach(function (dia) {
    let hoja = libro.getSheetByName(dia);
    if (!hoja) {
      hoja = libro.insertSheet(dia);
      hoja.getRange(1, 1, 1, CABECERA_DIA.length).setValues([CABECERA_DIA]).setFontWeight('bold');
      hoja.setFrozenRows(1);
      hoja.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
      // Sin las columnas sobrantes: cada libro de Google Sheets tiene un tope de celdas.
      if (hoja.getMaxColumns() > CABECERA_DIA.length) {
        hoja.deleteColumns(CABECERA_DIA.length + 1, hoja.getMaxColumns() - CABECERA_DIA.length);
      }
    }
    const primera = hoja.getLastRow() + 1;
    asegurarFilas_(hoja, primera + porDia[dia].length - 1);
    hoja.getRange(primera, 1, porDia[dia].length, CABECERA_DIA.length).setValues(porDia[dia]);
  });

  const fin = nuevos[nuevos.length - 1];
  const fila = [usuario, new Date(fin.ts), fin.lat, fin.lng, fin.prec];
  if (indice >= 0) hojaUltimas.getRange(indice + 2, 1, 1, CABECERA_ULTIMAS.length).setValues([fila]);
  else hojaUltimas.appendRow(fila);
  return nuevos.length;
}

/**
 * Tramos [inicio, fin] en los que se admite registrar la ubicación de una
 * persona: de la entrada a la salida, sin las pausas salvo que
 * CONFIG.seguimientoEnPausas lo permita.
 */
function tramosSeguimiento_(eventos, ahora) {
  const tramos = [];
  const jornadas = calcularJornadas_(eventos);
  jornadas.forEach(function (j, n) {
    let inicio = null;
    j.eventos.forEach(function (e) {
      if (e.tipo === 'ENTRADA') {
        inicio = e.ts;
      } else if (e.tipo === 'SALIDA' || (e.tipo === 'PAUSA_INICIO' && !CONFIG.seguimientoEnPausas)) {
        if (inicio !== null) tramos.push([inicio, e.ts]);
        inicio = null;
      } else if (e.tipo === 'PAUSA_FIN' && !CONFIG.seguimientoEnPausas) {
        inicio = e.ts;
      }
    });
    // Solo la jornada en curso deja un tramo abierto hasta ahora.
    if (inicio !== null && j.abierta && n === jornadas.length - 1) tramos.push([inicio, ahora]);
  });
  return tramos;
}

function leerUsuarios_(ss) {
  const datos = leer_(ss.getSheetByName(HOJAS.USUARIOS), CABECERAS.Usuarios.length);
  const salida = [];
  datos.filas.forEach(function (f, i) {
    const usuario = normalizarUsuario_(f[0]);
    if (!usuario) return;
    salida.push({
      fila: datos.inicio + i,
      usuario: usuario,
      nombre: String(f[1] || usuario),
      rol: String(f[2]).toUpperCase().trim() === 'ADMIN' ? 'ADMIN' : 'EMPLEADO',
      activo: !(f[3] === false || String(f[3]).toUpperCase().trim() === 'FALSE' || String(f[3]).toUpperCase().trim() === 'NO'),
      sal: String(f[4] || ''),
      hash: String(f[5] || ''),
      horaEntrada: horaTexto_(f[6]),
      horaSalida: horaTexto_(f[7]),
      dias: diasValidos_(f[8])
    });
  });
  return salida;
}

/** Cuentas que fichan (todas menos la de administrador). */
function empleados_(ss) {
  return leerUsuarios_(ss).filter(function (u) { return u.rol === 'EMPLEADO'; });
}

function auditar_(ss, administrador, accion, idFichaje, empleado, anterior, nuevo, motivo) {
  ss.getSheetByName(HOJAS.AUDITORIA).appendRow([new Date(), administrador, accion, idFichaje, empleado, anterior, nuevo, motivo]);
}

/* ------------------------------------------------------------------ */
/* Identidad, contraseñas y sesiones                                   */
/* ------------------------------------------------------------------ */

/**
 * Valida el testigo de sesión y devuelve la cuenta. Los errores de acceso
 * empiezan por "ACCESO:" para que la interfaz vuelva a pedir las credenciales.
 */
function usuario_(ss, token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) throw new Error('ACCESO: inicia sesión para continuar.');
  if (!(Number(partes[1]) > Date.now())) throw new Error('ACCESO: la sesión ha caducado. Vuelve a entrar.');

  let nombre = '';
  try {
    nombre = Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0])).getDataAsString('UTF-8');
  } catch (e) {
    throw new Error('ACCESO: inicia sesión para continuar.');
  }
  const u = leerUsuarios_(ss).filter(function (x) { return x.usuario === nombre; })[0];
  if (!u || !u.hash) throw new Error('ACCESO: inicia sesión para continuar.');
  if (!u.activo) throw new Error('ACCESO: tu usuario está desactivado. Consulta con tu responsable.');
  if (!iguales_(firmar_(partes[0] + '.' + partes[1] + '.' + u.hash.slice(0, 16)), partes[2])) {
    throw new Error('ACCESO: la sesión ya no es válida. Vuelve a entrar.');
  }
  return publico_(u);
}

function admin_(ss, token) {
  const u = usuario_(ss, token);
  if (u.rol !== 'ADMIN') throw new Error('Esta acción está reservada al administrador.');
  return u;
}

function empleado_(ss, token) {
  const u = usuario_(ss, token);
  if (u.rol !== 'EMPLEADO') throw new Error('La cuenta de administrador no registra fichajes.');
  return u;
}

function publico_(u) {
  return { usuario: u.usuario, nombre: u.nombre, rol: u.rol, horario: horario_(u) };
}

/* Horario de un empleado */

function horario_(u) {
  return u.horaEntrada || u.horaSalida ? { entrada: u.horaEntrada, salida: u.horaSalida, dias: u.dias } : null;
}

function horarioTexto_(u) {
  return u.horaEntrada || u.horaSalida ? (u.horaEntrada || '--') + ' a ' + (u.horaSalida || '--') + ' · días ' + u.dias : 'Sin horario';
}

/** Valor de celda a 'HH:mm' (admite texto o una hora de Sheets). */
function horaTexto_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v === null || v === undefined ? '' : v).trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

/** Hora recibida de la interfaz: vacía o 'HH:mm'. */
function horaValida_(v) {
  v = String(v === null || v === undefined ? '' : v).trim();
  if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error('Hora no válida. Usa el formato HH:mm.');
  return v;
}

/** Días de la semana como cifras ordenadas y sin repetir: '12345'. */
function diasValidos_(v) {
  const texto = String(v === null || v === undefined ? '' : v);
  return '1234567'.split('').filter(function (d) { return texto.indexOf(d) >= 0; }).join('');
}

/**
 * El testigo lleva el usuario, la caducidad y una firma. En la firma entra
 * parte del hash de la contraseña: al cambiarla, las sesiones antiguas caducan.
 */
function emitirToken_(u) {
  const cuerpo = Utilities.base64EncodeWebSafe(u.usuario, Utilities.Charset.UTF_8) + '.' +
    (Date.now() + CONFIG.diasSesion * 24 * 3600 * 1000);
  return cuerpo + '.' + firmar_(cuerpo + '.' + u.hash.slice(0, 16));
}

function firmar_(texto) {
  const secreto = PropertiesService.getScriptProperties().getProperty('SECRETO');
  if (!secreto) throw new Error('La aplicación no está instalada. Ejecuta la función instalar desde el editor de Apps Script.');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(texto, secreto, Utilities.Charset.UTF_8));
}

function iguales_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let distinto = 0;
  for (let i = 0; i < a.length; i++) distinto |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return distinto === 0;
}

/** Hash de contraseña con sal, encadenando SHA-256 para encarecer el tanteo. */
function hashClave_(clave, sal) {
  let h = clave;
  for (let i = 0; i < 300; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + ':' + h, Utilities.Charset.UTF_8));
  }
  return h;
}

function hex_(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  return s;
}

function nuevaSal_() {
  return Utilities.getUuid().replace(/-/g, '');
}

/** Tramos íntegramente aleatorios de un UUID, en hexadecimal (12 bytes). */
function azarHex_() {
  const hex = Utilities.getUuid().replace(/-/g, '');
  return hex.slice(0, 12) + hex.slice(20);
}

/** Contraseña de 10 caracteres en minúsculas y cifras, sin los que se confunden (l, o, 0, 1). */
function generarClave_() {
  const alfabeto = 'abcdefghijkmnpqrstuvwxyz23456789';
  const azar = azarHex_();
  let c = '';
  for (let i = 0; i < 10; i++) c += alfabeto.charAt(parseInt(azar.substr(i * 2, 2), 16) % 32);
  return c;
}

/** Código de activación de 8 caracteres con formato XXXX-XXXX. */
function generarCodigo_() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const azar = azarHex_();
  let c = '';
  for (let i = 0; i < 8; i++) c += alfabeto.charAt(parseInt(azar.substr(i * 2, 2), 16) % 32);
  return c.slice(0, 4) + '-' + c.slice(4);
}

function normalizarCodigo_(codigo) {
  return String(codigo === null || codigo === undefined ? '' : codigo).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizarUsuario_(usuario) {
  return String(usuario === null || usuario === undefined ? '' : usuario)
    .toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 80);
}

/* Límite de intentos fallidos, por usuario y para el código de activación. */

function comprobarBloqueo_(clave) {
  const fallos = Number(CacheService.getScriptCache().get('fallos:' + clave) || 0);
  if (fallos >= CONFIG.intentosAntesDeBloqueo) {
    throw new Error('Demasiados intentos fallidos. Espera ' + CONFIG.minutosBloqueo + ' minutos y vuelve a probar.');
  }
}

function anotarFallo_(clave) {
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('fallos:' + clave) || 0) + 1;
  cache.put('fallos:' + clave, String(fallos), CONFIG.minutosBloqueo * 60);
  return fallos;
}

function limpiarFallos_(clave) {
  CacheService.getScriptCache().remove('fallos:' + clave);
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function posicion_(pos) {
  if (!pos) return null;
  const lat = Number(pos.lat), lng = Number(pos.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const prec = Number(pos.prec);
  return { lat: lat, lng: lng, prec: isFinite(prec) ? Math.round(prec) : '' };
}

function horasTexto_(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return Math.floor(min / 60) + ' h ' + ('0' + (min % 60)).slice(-2) + ' min';
}

function fecha_(ts) { return Utilities.formatDate(new Date(ts), TZ, 'yyyy-MM-dd'); }
function hora_(ts) { return Utilities.formatDate(new Date(ts), TZ, 'HH:mm'); }
function horaSeg_(ts) { return Utilities.formatDate(new Date(ts), TZ, 'HH:mm:ss'); }
function local_(ts) { return Utilities.formatDate(new Date(ts), TZ, "yyyy-MM-dd'T'HH:mm"); }
function fechaHoraTexto_(ts) { return Utilities.formatDate(new Date(ts), TZ, 'dd/MM/yyyy HH:mm'); }

function fechaValida_(texto) {
  texto = String(texto || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : '';
}

function fechaHora_(texto) {
  texto = String(texto || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(texto)) throw new Error('Fecha y hora no válidas.');
  return Utilities.parseDate(texto, TZ, "yyyy-MM-dd'T'HH:mm");
}
