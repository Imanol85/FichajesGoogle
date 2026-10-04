/*
 * Fichajes: aplicación web instalable para empleados (pensada para iPhone).
 * Habla con la aplicación web de Apps Script por la misma entrada JSON que
 * usa la app Android: acciones login, estado, fichar y ubicaciones.
 *
 * El navegador solo entrega la ubicación mientras la app está abierta y a la
 * vista, así que el registro durante la jornada se detiene al bloquear el
 * móvil o al cambiar de app, y se reanuda al volver.
 */
(function () {
  'use strict';

  var CLAVES = {
    servidor: 'fichajes.pwa.servidor',
    token: 'fichajes.pwa.token',
    estado: 'fichajes.pwa.estado',
    cola: 'fichajes.pwa.cola',
    pantalla: 'fichajes.pwa.pantalla'
  };
  var ESTADOS = { FUERA: 'Fuera de jornada', TRABAJANDO: 'Trabajando', EN_PAUSA: 'En pausa' };
  var HECHO = {
    ENTRADA: 'Entrada registrada',
    PAUSA_INICIO: 'Pausa iniciada',
    PAUSA_FIN: 'De vuelta al trabajo',
    SALIDA: 'Salida registrada'
  };
  var DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  var PUNTOS_POR_ENVIO = 200;                    // máximo que admite el servidor por petición
  var MAX_PUNTOS_EN_COLA = 3000;                 // unas 25 horas a un punto cada 30 segundos
  var CADUCIDAD_PUNTO_MS = 24 * 3600 * 1000;     // lo que aguanta un punto sin poder enviarse
  var ESPERA_SERVIDOR_MS = 45000;
  var REFRESCO_ESTADO_MS = 60000;

  var S = {
    token: '',
    estado: null,          // última respuesta de estado del servidor
    desfase: 0,            // reloj del servidor menos reloj del móvil, en ms
    ocupado: false,
    cola: [],              // puntos pendientes de enviar
    enviando: false,
    vigilancia: null,      // identificador de watchPosition
    ultima: null,          // última posición recibida: { lat, lng, prec, en }
    ultimoPunto: 0,        // momento (reloj del móvil) del último punto encolado
    vigilandoDesde: 0,     // momento en que se abrió la vigilancia actual
    reaperturas: 0,        // veces seguidas que se ha reabierto sin recibir lectura
    esperando: [],         // fichajes que aguardan la próxima lectura de posición
    errorUbicacion: '',
    bloqueoPantalla: null,
    pidiendoBloqueo: false,
    instalador: null,
    timers: { reloj: null, muestra: null, envio: null, estado: null, toast: null }
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ */
  /* Datos guardados en el móvil                                   */
  /* ------------------------------------------------------------ */

  // En navegación privada el almacenamiento puede fallar: se usa la memoria.
  var memoria = {};
  var almacen = {
    leer: function (clave) {
      try { return window.localStorage.getItem(clave); } catch (e) { return clave in memoria ? memoria[clave] : null; }
    },
    guardar: function (clave, valor) {
      try { window.localStorage.setItem(clave, valor); } catch (e) { memoria[clave] = valor; }
    },
    borrar: function (clave) {
      try { window.localStorage.removeItem(clave); } catch (e) { /* nada que borrar */ }
      delete memoria[clave];
    }
  };

  function leerJson(clave) {
    var texto = almacen.leer(clave);
    if (!texto) return null;
    try { return JSON.parse(texto); } catch (e) { return null; }
  }

  function guardarCola() {
    almacen.guardar(CLAVES.cola, JSON.stringify(S.cola));
  }

  function cargarCola() {
    var guardada = leerJson(CLAVES.cola);
    var limite = Date.now() - CADUCIDAD_PUNTO_MS;
    S.cola = Array.isArray(guardada) ? guardada.filter(function (p) { return p && p.ts > limite; }) : [];
  }

  /* ------------------------------------------------------------ */
  /* Servidor                                                      */
  /* ------------------------------------------------------------ */

  function esEquipoLocal(nombre) {
    return nombre === 'localhost' || nombre === '127.0.0.1' || nombre === '[::1]';
  }

  /** Dirección del servidor: la fijada en config.js o, si no hay, la escrita al entrar. */
  function servidor() {
    var fija = String(window.FICHAJES_SERVIDOR || '').trim();
    return fija || almacen.leer(CLAVES.servidor) || '';
  }

  /**
   * Solo se admite la dirección de una aplicación web de Apps Script, para que
   * el usuario y la contraseña no puedan acabar en otro sitio por un error al
   * escribirla. En pruebas en el propio equipo se admite también ese equipo.
   */
  function servidorValido(direccion) {
    var u;
    try { u = new URL(direccion); } catch (e) { return false; }
    if (esEquipoLocal(u.hostname)) return esEquipoLocal(window.location.hostname);
    return u.protocol === 'https:' && u.hostname === 'script.google.com' &&
      /^(\/a\/[^/]+)?\/macros\/s\/[^/]+\/exec$/.test(u.pathname);
  }

  function fallo(mensaje, acceso) {
    var e = new Error(mensaje);
    e.acceso = !!acceso;   // true: la sesión ya no vale y hay que volver a entrar
    return e;
  }

  /**
   * Petición al servidor. Se envía como texto sin cabeceras propias para que
   * el navegador no haga una consulta previa que Apps Script no contesta.
   */
  function llamar(cuerpo, alOcultar) {
    var base = servidor();
    if (!base) return Promise.reject(fallo('Falta la dirección del servidor.'));
    if (!servidorValido(base)) return Promise.reject(fallo('La dirección del servidor no es válida.'));

    var opciones = {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(cuerpo),
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit'
    };
    var corte = null;
    if (alOcultar) {
      opciones.keepalive = true;   // deja terminar el envío aunque la app pase a segundo plano
    } else if (window.AbortController) {
      var control = new AbortController();
      opciones.signal = control.signal;
      corte = setTimeout(function () { control.abort(); }, ESPERA_SERVIDOR_MS);
    }

    return fetch(base, opciones)
      .then(function (respuesta) { return respuesta.text(); })
      .then(function (texto) {
        clearTimeout(corte);
        var r;
        try { r = JSON.parse(texto); } catch (e) {
          // Suele ser una página de acceso de Google: la aplicación web no admite visitas anónimas.
          throw fallo('El servidor no ha respondido como se esperaba. Revisa que la aplicación web esté publicada' +
            ' con acceso «Cualquier usuario» y que la dirección sea la que termina en /exec.');
        }
        if (r && r.ok) return r.datos || {};
        var error = String((r && r.error) || 'Error desconocido.');
        if (error.indexOf('ACCESO:') === 0) {
          var limpio = error.slice('ACCESO:'.length).trim();
          throw fallo(limpio ? limpio.charAt(0).toUpperCase() + limpio.slice(1) : 'Vuelve a iniciar sesión.', true);
        }
        throw fallo(error);
      }, function () {
        clearTimeout(corte);
        throw fallo('No hay conexión con el servidor. Comprueba la cobertura e inténtalo de nuevo.');
      });
  }

  /* ------------------------------------------------------------ */
  /* Utilidades de pantalla                                        */
  /* ------------------------------------------------------------ */

  function toast(mensaje, esError, fijo) {
    var t = $('toast');
    clearTimeout(S.timers.toast);
    if (!mensaje) { t.hidden = true; return; }
    t.textContent = mensaje;
    t.className = esError ? 'error' : '';
    t.hidden = false;
    if (!fijo) S.timers.toast = setTimeout(function () { t.hidden = true; }, esError ? 6000 : 3500);
  }

  function hms(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), seg = s % 60;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (seg < 10 ? '0' : '') + seg;
  }

  function horaLocal(ms) {
    var d = new Date(ms);
    function dos(n) { return (n < 10 ? '0' : '') + n; }
    return dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds());
  }

  function saludo() {
    var h = new Date().getHours();
    return h < 6 ? 'Buenas noches' : h < 14 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  }

  function confirmar(titulo, texto, botonSi) {
    return new Promise(function (resolver) {
      $('dlg-titulo').textContent = titulo;
      $('dlg-texto').textContent = texto;
      $('dlg-si').textContent = botonSi;
      $('dlg').hidden = false;
      function cerrar(valor) {
        $('dlg').hidden = true;
        $('dlg-si').onclick = null;
        $('dlg-no').onclick = null;
        resolver(valor);
      }
      $('dlg-si').onclick = function () { cerrar(true); };
      $('dlg-no').onclick = function () { cerrar(false); };
    });
  }

  function mostrar(pantalla) {
    $('acceso').hidden = pantalla !== 'acceso';
    $('app').hidden = pantalla !== 'app';
  }

  /* ------------------------------------------------------------ */
  /* Acceso                                                        */
  /* ------------------------------------------------------------ */

  function irAlAcceso(mensaje) {
    detenerTodo();
    $('campo-servidor').hidden = !!String(window.FICHAJES_SERVIDOR || '').trim();
    $('l-servidor').value = almacen.leer(CLAVES.servidor) || '';
    $('l-clave').value = '';
    errorAcceso(mensaje || '');
    mostrar('acceso');
  }

  function errorAcceso(mensaje) {
    var p = $('l-error');
    p.textContent = mensaje;
    p.className = 'pista error';
    p.hidden = !mensaje;
  }

  function entrar(evento) {
    evento.preventDefault();
    if (S.ocupado) return;
    errorAcceso('');

    if (!$('campo-servidor').hidden) {
      var direccion = $('l-servidor').value.trim();
      if (!servidorValido(direccion)) {
        errorAcceso('Escribe la dirección del servidor: empieza por https://script.google.com/ y termina en /exec.');
        return;
      }
      almacen.guardar(CLAVES.servidor, direccion);
    }
    var usuario = $('l-usuario').value.trim();
    var clave = $('l-clave').value;
    if (!usuario || !clave) { errorAcceso('Introduce usuario y contraseña.'); return; }

    S.ocupado = true;
    $('l-entrar').disabled = true;
    $('l-entrar').textContent = 'Entrando…';
    llamar({ accion: 'login', usuario: usuario, clave: clave })
      .then(function (r) {
        S.token = r.token;
        almacen.guardar(CLAVES.token, r.token);
        return llamar({ accion: 'estado', token: r.token });
      })
      .then(function (e) {
        $('l-clave').value = '';
        S.ocupado = false;
        mostrar('app');
        recibido(e);
        arrancarApp();
      })
      .catch(function (f) {
        S.token = '';
        almacen.borrar(CLAVES.token);
        errorAcceso(f.message);
      })
      .then(function () {
        S.ocupado = false;
        $('l-entrar').disabled = false;
        $('l-entrar').textContent = 'Entrar';
      });
  }

  function olvidarSesion() {
    S.token = '';
    S.estado = null;
    S.cola = [];
    S.ultima = null;
    S.ultimoPunto = 0;
    almacen.borrar(CLAVES.token);
    almacen.borrar(CLAVES.estado);
    almacen.borrar(CLAVES.cola);
  }

  function sesionCaducada(mensaje) {
    olvidarSesion();
    irAlAcceso(mensaje || 'Vuelve a iniciar sesión.');
  }

  function cerrarSesion() {
    var enJornada = S.estado && S.estado.estado !== 'FUERA';
    confirmar('Cerrar sesión',
      enJornada
        ? 'Tu jornada sigue abierta. Si cierras sesión deja de registrarse tu ubicación hasta que vuelvas a entrar.'
        : 'Tendrás que volver a escribir tu usuario y tu contraseña para entrar.',
      'Cerrar sesión'
    ).then(function (si) {
      if (!si) return;
      // Antes de olvidar la sesión se intenta entregar lo que quede pendiente.
      enviar().then(function () {
        olvidarSesion();
        irAlAcceso('');
      });
    });
  }

  /* ------------------------------------------------------------ */
  /* Estado y pintado                                              */
  /* ------------------------------------------------------------ */

  function debeRegistrar(estado) {
    var config = (S.estado && S.estado.config) || {};
    return estado === 'TRABAJANDO' || (estado === 'EN_PAUSA' && !!config.seguimientoEnPausas);
  }

  function segundosUbicacion() {
    var config = (S.estado && S.estado.config) || {};
    return Math.max(10, Number(config.segundosEntreUbicaciones) || 30);
  }

  function segundosEnvio() {
    var config = (S.estado && S.estado.config) || {};
    return Math.max(20, Number(config.segundosEntreEnvios) || 60);
  }

  function recibido(e) {
    S.estado = e;
    S.desfase = (Number(e.ahora) || Date.now()) - Date.now();
    almacen.guardar(CLAVES.estado, JSON.stringify({ estado: e, desfase: S.desfase }));
    $('sin-conexion').hidden = true;
    pintar();
    sincronizarSeguimiento();
  }

  function refrescar() {
    if (!S.token || S.ocupado) return Promise.resolve();
    return llamar({ accion: 'estado', token: S.token }).then(recibido, function (f) {
      if (f.acceso) sesionCaducada(f.message);
      else if (S.token) $('sin-conexion').hidden = false;
    });
  }

  function pintar() {
    var e = S.estado;
    if (!e) return;
    var estado = ESTADOS[e.estado] ? e.estado : 'FUERA';
    var nombre = (e.usuario && e.usuario.nombre) || '';

    $('saludo').textContent = saludo() + (nombre ? ', ' + nombre.split(' ')[0] : '');
    $('fecha').textContent = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    $('pill').className = 'pill ' + estado;
    $('pill-texto').textContent = ESTADOS[estado];

    var principal = $('b-principal'), secundario = $('b-secundario');
    if (estado === 'TRABAJANDO') {
      principal.textContent = 'Fichar salida';
      principal.className = 'btn rosa grande';
      principal.dataset.tipo = 'SALIDA';
      secundario.dataset.tipo = 'PAUSA_INICIO';
      secundario.hidden = false;
    } else if (estado === 'EN_PAUSA') {
      principal.textContent = 'Volver al trabajo';
      principal.className = 'btn primario grande';
      principal.dataset.tipo = 'PAUSA_FIN';
      secundario.hidden = true;
    } else {
      principal.textContent = 'Fichar entrada';
      principal.className = 'btn verde grande';
      principal.dataset.tipo = 'ENTRADA';
      secundario.hidden = true;
    }
    $('acciones').className = 'acciones' + (secundario.hidden ? '' : ' dos');
    habilitar(!S.ocupado);

    // Fichajes de la jornada
    var lista = $('lista-hoy');
    lista.textContent = '';
    var fichajes = Array.isArray(e.fichajes) ? e.fichajes : [];
    var primeraEntrada = '';
    fichajes.forEach(function (f) {
      if (f.tipo === 'ENTRADA' && !primeraEntrada) primeraEntrada = f.hora;
      var li = document.createElement('li');
      li.className = 't-' + String(f.tipo).replace(/[^A-Z_]/g, '');
      var hora = document.createElement('span');
      hora.className = 'hora';
      hora.textContent = f.hora;
      var etiqueta = document.createElement('span');
      etiqueta.textContent = f.etiqueta || f.tipo;
      li.appendChild(hora);
      li.appendChild(etiqueta);
      if (f.origen === 'ADMIN') {
        var nota = document.createElement('span');
        nota.className = 'nota';
        nota.textContent = 'Corregido';
        li.appendChild(nota);
      }
      lista.appendChild(li);
    });
    if (!fichajes.length) {
      var vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'Todavía no has fichado hoy.';
      lista.appendChild(vacio);
    }
    $('st-entrada').textContent = primeraEntrada || '—';

    var horario = e.usuario && e.usuario.horario;
    if (horario && (horario.entrada || horario.salida)) {
      var dias = DIAS.filter(function (d, i) { return String(horario.dias || '').indexOf(String(i + 1)) >= 0; }).join(' ');
      $('horario').textContent = 'Horario: ' + (horario.entrada || '--:--') + ' – ' + (horario.salida || '--:--') +
        (dias ? ' · ' + dias : '') + '. Esta versión no avisa a la hora de fichar.';
    } else {
      $('horario').textContent = 'Sin horario asignado.';
    }

    pintarReloj();
    pintarSeguimiento();
  }

  function pintarReloj() {
    var e = S.estado;
    if (!e) return;
    var ahora = Date.now() + S.desfase;
    var trabajo = (Number(e.trabajoMs) || 0) + (e.estado === 'TRABAJANDO' && e.enCursoDesde ? ahora - e.enCursoDesde : 0);
    var pausa = (Number(e.pausaMs) || 0) + (e.estado === 'EN_PAUSA' && e.pausaDesde ? ahora - e.pausaDesde : 0);
    $('reloj').textContent = hms(trabajo);
    $('st-pausas').textContent = Math.max(0, Math.round(pausa / 60000)) + ' min';
  }

  function pintarSeguimiento() {
    var e = S.estado;
    if (!e) return;
    var seg = segundosUbicacion();
    var activo = debeRegistrar(e.estado);
    var texto, aviso = '';

    if (activo) {
      texto = 'Se registra tu ubicación cada ' + seg + ' segundos.';
      if (S.cola.length) texto += ' ' + (S.cola.length === 1 ? 'Hay 1 punto pendiente' : 'Hay ' + S.cola.length + ' puntos pendientes') + ' de enviar.';
      aviso = S.errorUbicacion ||
        'Mantén esta app abierta y a la vista. Si bloqueas el móvil o cambias de app, el registro se detiene hasta que vuelvas.';
    } else if (e.estado === 'EN_PAUSA') {
      texto = 'En pausa: no se registra tu ubicación hasta que vuelvas al trabajo.';
    } else {
      texto = 'Al fichar se guarda tu ubicación. Durante la jornada se guarda además cada ' + seg +
        ' segundos, solo mientras esta app está abierta y la pantalla encendida.';
    }
    $('seg-texto').textContent = texto;
    $('seg-aviso').textContent = aviso;
    $('seg-aviso').hidden = !aviso;
    $('st-puntos').textContent = activo && S.ultimoPunto ? horaLocal(S.ultimoPunto) : '—';
  }

  function habilitar(si) {
    $('b-principal').disabled = !si;
    $('b-secundario').disabled = !si;
  }

  /* ------------------------------------------------------------ */
  /* Ubicación                                                     */
  /* ------------------------------------------------------------ */

  function motivoUbicacion(error) {
    if (error && error.code === 1) {
      return 'No hay permiso de ubicación. Permítelo cuando el móvil lo pregunte o actívalo en los ajustes del navegador para esta página.';
    }
    if (error && error.code === 3) return 'El móvil tarda demasiado en dar la ubicación. Sal a un sitio con mejor señal y vuelve a probar.';
    return 'No se ha podido obtener tu ubicación. Comprueba que la localización del móvil está activada.';
  }

  function aPunto(posicion) {
    return { lat: posicion.coords.latitude, lng: posicion.coords.longitude, prec: posicion.coords.accuracy };
  }

  /** Posición del momento, para un fichaje. */
  function posicionActual() {
    return new Promise(function (resolver, rechazar) {
      if (S.ultima && Date.now() - S.ultima.en < 15000) {
        resolver({ lat: S.ultima.lat, lng: S.ultima.lng, prec: S.ultima.prec });
        return;
      }
      if (!navigator.geolocation) { rechazar(fallo('Este navegador no da acceso a la ubicación.')); return; }

      // Con el registro en marcha no se abre una petición aparte: se reabre la
      // vigilancia y se espera su siguiente lectura. Hay navegadores que, con el
      // móvil quieto, no contestan a una petición suelta mientras hay otra abierta.
      if (S.vigilancia !== null) {
        var espera = { resolver: resolver, rechazar: rechazar, corte: null };
        espera.corte = setTimeout(function () {
          S.esperando = S.esperando.filter(function (x) { return x !== espera; });
          rechazar(fallo(motivoUbicacion({ code: 3 })));
        }, 20000);
        S.esperando.push(espera);
        abrirVigilancia();
        return;
      }

      navigator.geolocation.getCurrentPosition(
        function (p) { resolver(aPunto(p)); },
        function (error) { rechazar(fallo(motivoUbicacion(error))); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 }
      );
    });
  }

  function atenderEsperas(punto, error) {
    var pendientes = S.esperando;
    S.esperando = [];
    pendientes.forEach(function (espera) {
      clearTimeout(espera.corte);
      if (punto) espera.resolver({ lat: punto.lat, lng: punto.lng, prec: punto.prec });
      else espera.rechazar(fallo(motivoUbicacion(error)));
    });
  }

  function posicionRecibida(posicion) {
    var p = aPunto(posicion);
    p.en = Date.now();
    S.ultima = p;
    S.reaperturas = 0;
    atenderEsperas(p);
    if (S.errorUbicacion) { S.errorUbicacion = ''; pintarSeguimiento(); }
    muestrear();
  }

  function posicionFallida(error) {
    atenderEsperas(null, error);
    S.errorUbicacion = motivoUbicacion(error);
    pintarSeguimiento();
  }

  /** Abre (o reabre) la vigilancia de posición; al abrirse entrega una lectura nueva. */
  function abrirVigilancia() {
    if (S.vigilancia !== null) navigator.geolocation.clearWatch(S.vigilancia);
    // Sin límite de espera: con el móvil quieto pueden pasar minutos sin lectura nueva,
    // y de eso ya se ocupa muestrear() reabriendo la vigilancia cuando hace falta.
    S.vigilancia = navigator.geolocation.watchPosition(posicionRecibida, posicionFallida,
      { enableHighAccuracy: true, maximumAge: 10000 });
    S.vigilandoDesde = Date.now();
  }

  /** Encola un punto si ya toca según la cadencia que marca el servidor. */
  function muestrear() {
    if (S.vigilancia === null) return;
    var ahora = Date.now();
    var cadencia = segundosUbicacion() * 1000;
    if (ahora - S.ultimoPunto < cadencia - 1000) return;

    // Sin lectura reciente (móvil quieto o señal perdida) no se da por buena la
    // anterior: se reabre la vigilancia para forzar una nueva, y si tampoco llega
    // se avisa. El punto se guarda cuando llegue la lectura.
    var vieja = Math.max(45000, cadencia * 2);
    if (!S.ultima || ahora - S.ultima.en > vieja) {
      if (ahora - S.vigilandoDesde > 20000) {
        if (S.reaperturas > 0 && !S.errorUbicacion) {
          S.errorUbicacion = 'No llega la ubicación del móvil. Comprueba que la localización está activada y que hay señal.';
          pintarSeguimiento();
        }
        S.reaperturas++;
        abrirVigilancia();
      }
      return;
    }

    S.ultimoPunto = ahora;
    S.cola.push({ ts: Math.round(ahora + S.desfase), lat: S.ultima.lat, lng: S.ultima.lng, prec: S.ultima.prec });
    if (!S.enviando && S.cola.length > MAX_PUNTOS_EN_COLA) S.cola.splice(0, S.cola.length - MAX_PUNTOS_EN_COLA);
    guardarCola();
    pintarSeguimiento();
  }

  function iniciarSeguimiento() {
    if (S.vigilancia !== null) return;
    if (!navigator.geolocation) {
      S.errorUbicacion = 'Este navegador no da acceso a la ubicación.';
      pintarSeguimiento();
      return;
    }
    abrirVigilancia();
    S.timers.muestra = setInterval(muestrear, 5000);
    S.timers.envio = setInterval(enviar, segundosEnvio() * 1000);
  }

  function detenerSeguimiento() {
    if (S.vigilancia === null) return;
    navigator.geolocation.clearWatch(S.vigilancia);
    S.vigilancia = null;
    clearInterval(S.timers.muestra);
    clearInterval(S.timers.envio);
    atenderEsperas(null, { code: 2 });
    S.reaperturas = 0;
    S.errorUbicacion = '';
  }

  /** Arranca o detiene el registro según el estado de la jornada y si la app está a la vista. */
  function sincronizarSeguimiento() {
    var activo = !!S.token && !!S.estado && debeRegistrar(S.estado.estado) && !document.hidden;
    if (activo) iniciarSeguimiento(); else detenerSeguimiento();
    ajustarPantalla(activo);
    pintarSeguimiento();
  }

  /** Envía al servidor los puntos pendientes, por lotes. */
  function enviar(alOcultar) {
    if (S.enviando || !S.token || !S.cola.length) return Promise.resolve();
    S.enviando = true;
    var token = S.token;

    function siguiente() {
      if (!S.cola.length || S.token !== token) return Promise.resolve();
      var lote = S.cola.slice(0, PUNTOS_POR_ENVIO);
      return llamar({ accion: 'ubicaciones', token: token, puntos: lote }, alOcultar).then(function (r) {
        if (S.token !== token) return;
        S.cola.splice(0, lote.length);
        guardarCola();
        // El servidor dice en qué estado está la jornada: si ha cambiado (por ejemplo,
        // el administrador la cerró), se pide el estado completo.
        if (r.estado && S.estado && r.estado !== S.estado.estado) return refrescar().then(siguiente);
        return siguiente();
      });
    }

    return siguiente()
      .catch(function (f) { if (f.acceso) sesionCaducada(f.message); })
      .then(function () {
        S.enviando = false;
        if (S.token) pintarSeguimiento();
      });
  }

  /* ------------------------------------------------------------ */
  /* Pantalla encendida                                            */
  /* ------------------------------------------------------------ */

  function quierePantalla() {
    return almacen.leer(CLAVES.pantalla) !== '0';
  }

  function ajustarPantalla(seguimientoActivo) {
    var nota = $('seg-pantalla-nota');
    var compatible = 'wakeLock' in navigator;
    var consejo = ' Para que no se bloquee, pon el bloqueo automático en «Nunca» en los ajustes de pantalla mientras trabajas.';
    nota.hidden = compatible || !quierePantalla();
    if (!compatible) {
      nota.textContent = 'Este móvil no deja a la app mantener la pantalla encendida.' + consejo;
      return;
    }
    var quiere = seguimientoActivo && quierePantalla();
    if (!quiere) {
      if (S.bloqueoPantalla) { S.bloqueoPantalla.release().catch(function () {}); S.bloqueoPantalla = null; }
      return;
    }
    if (S.bloqueoPantalla || S.pidiendoBloqueo) return;
    S.pidiendoBloqueo = true;
    navigator.wakeLock.request('screen').then(function (bloqueo) {
      S.pidiendoBloqueo = false;
      S.bloqueoPantalla = bloqueo;
      bloqueo.addEventListener('release', function () { if (S.bloqueoPantalla === bloqueo) S.bloqueoPantalla = null; });
    }, function () {
      S.pidiendoBloqueo = false;
      nota.textContent = 'El móvil no ha permitido ahora mantener la pantalla encendida.' + consejo;
      nota.hidden = false;
    });
  }

  /* ------------------------------------------------------------ */
  /* Fichaje                                                       */
  /* ------------------------------------------------------------ */

  function fichar(tipo) {
    if (S.ocupado || !S.token || !tipo) return;
    S.ocupado = true;
    habilitar(false);
    toast('Obteniendo ubicación…', false, true);

    var obligatoria = !S.estado || !S.estado.config || S.estado.config.ubicacionObligatoria !== false;
    posicionActual()
      .catch(function (f) { if (obligatoria) throw f; return null; })
      .then(function (pos) {
        toast('Registrando…', false, true);
        return llamar({ accion: 'fichar', token: S.token, tipo: tipo, pos: pos });
      })
      .then(function (e) {
        S.ocupado = false;
        recibido(e);
        toast(HECHO[tipo] || 'Fichaje registrado');
        if (tipo === 'SALIDA' || tipo === 'PAUSA_INICIO') enviar();
      })
      .catch(function (f) {
        S.ocupado = false;
        if (f.acceso) { toast(''); sesionCaducada(f.message); return; }
        habilitar(true);
        toast(f.message, true);
      });
  }

  /* ------------------------------------------------------------ */
  /* Instalación                                                   */
  /* ------------------------------------------------------------ */

  function instalada() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function esApple() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function pintarInstalacion() {
    var tarjeta = $('c-instalar'), pista = $('l-instalar');
    var enApple = esApple() && !instalada();
    var comoInstalar = 'Abre esta página en Safari, pulsa el botón Compartir y elige «Añadir a pantalla de inicio».' +
      ' Después entra siempre desde el icono de Fichajes.';
    // En iPhone la app instalada no comparte la sesión con Safari: conviene instalarla antes de entrar.
    pista.textContent = enApple ? 'Para instalarla en el iPhone: ' + comoInstalar.charAt(0).toLowerCase() + comoInstalar.slice(1) : '';
    pista.hidden = !enApple;
    if (instalada()) { tarjeta.hidden = true; return; }
    if (enApple) {
      $('instalar-texto').textContent = comoInstalar;
      $('b-instalar').hidden = true;
      tarjeta.hidden = false;
    } else if (S.instalador) {
      $('instalar-texto').textContent = 'Instala Fichajes para abrirla desde un icono, a pantalla completa.';
      $('b-instalar').hidden = false;
      tarjeta.hidden = false;
    } else {
      tarjeta.hidden = true;
    }
  }

  /* ------------------------------------------------------------ */
  /* Arranque                                                      */
  /* ------------------------------------------------------------ */

  function arrancarApp() {
    clearInterval(S.timers.reloj);
    clearInterval(S.timers.estado);
    S.timers.reloj = setInterval(pintarReloj, 1000);
    S.timers.estado = setInterval(function () { if (!document.hidden) refrescar(); }, REFRESCO_ESTADO_MS);
  }

  function detenerTodo() {
    detenerSeguimiento();
    ajustarPantalla(false);
    clearInterval(S.timers.reloj);
    clearInterval(S.timers.estado);
  }

  function alCambiarVisibilidad() {
    if (!S.token) return;
    if (document.hidden) {
      // Al pasar a segundo plano se deja de registrar y se entrega lo pendiente.
      sincronizarSeguimiento();
      enviar(true);
    } else {
      pintar();
      sincronizarSeguimiento();
      refrescar().then(function () { enviar(); });
    }
  }

  function iniciar() {
    $('f-login').addEventListener('submit', entrar);
    $('l-ver').addEventListener('click', function () {
      var campo = $('l-clave');
      var visible = campo.type === 'text';
      campo.type = visible ? 'password' : 'text';
      $('l-ver').textContent = visible ? 'Ver' : 'Ocultar';
    });
    $('b-principal').addEventListener('click', function () { fichar($('b-principal').dataset.tipo); });
    $('b-secundario').addEventListener('click', function () { fichar($('b-secundario').dataset.tipo); });
    $('b-salir').addEventListener('click', cerrarSesion);

    $('seg-pantalla').checked = quierePantalla();
    $('seg-pantalla').addEventListener('change', function () {
      almacen.guardar(CLAVES.pantalla, $('seg-pantalla').checked ? '1' : '0');
      sincronizarSeguimiento();
    });

    $('b-instalar').addEventListener('click', function () {
      if (!S.instalador) return;
      S.instalador.prompt();
      S.instalador = null;
      pintarInstalacion();
    });
    window.addEventListener('beforeinstallprompt', function (evento) {
      evento.preventDefault();
      S.instalador = evento;
      pintarInstalacion();
    });
    window.addEventListener('appinstalled', function () { S.instalador = null; pintarInstalacion(); });

    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    window.addEventListener('pageshow', function (evento) { if (evento.persisted) alCambiarVisibilidad(); });
    window.addEventListener('online', function () { if (S.token) refrescar().then(function () { enviar(); }); });

    if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* sin copia local: la app funciona igual con conexión */ });
    }

    pintarInstalacion();
    S.token = almacen.leer(CLAVES.token) || '';
    if (!S.token) { irAlAcceso(''); return; }

    cargarCola();
    var guardado = leerJson(CLAVES.estado);
    mostrar('app');
    arrancarApp();
    if (guardado && guardado.estado) {
      S.estado = guardado.estado;
      S.desfase = Number(guardado.desfase) || 0;
      pintar();
      sincronizarSeguimiento();
    }
    refrescar().then(function () { enviar(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
