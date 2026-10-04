# Fichajes: control horario con Google Apps Script + Google Sheets

Aplicación web de fichaje para un equipo. No necesita servidores: el código vive en un proyecto de Apps Script y los datos en un libro de Google Sheets que la propia aplicación crea.

## Ficheros

| Fichero | Contenido |
|---------|-----------|
| `Code.gs` | Servidor: cuentas y sesiones, fichajes, seguimiento de ubicación, panel del administrador, avisos, auditoría y resumen de horas |
| `Index.html` | Interfaz web (móvil y escritorio): acceso, fichar, mis jornadas, equipo, avisos e informes |
| `android/` | App Android para los empleados: ubicación cada 30 s con el móvil bloqueado y avisos a la hora de fichar. Tiene su propio `README.md` |
| `pwa/` | App web instalable para los empleados con iPhone: fichaje con ubicación y registro del recorrido mientras está abierta. Tiene su propio `README.md` |
| `.github/workflows/publicar-pwa.yml` | Publica `pwa/` en GitHub Pages cuando cambia en la rama `master` |

En el editor de Apps Script el fichero de servidor puede llamarse `Código.gs`; el HTML debe llamarse exactamente `Index`.

## Cuentas

- **Administrador**: usuario `brillo magico` (constante `CONFIG.adminUsuario`). No ficha: gestiona el equipo, corrige fichajes y recibe los avisos. La contraseña la elige su titular la primera vez, con un código de activación.
- **Empleados**: el administrador los da de alta desde la pestaña Equipo. La aplicación genera el usuario (a partir del nombre) y una contraseña de 10 caracteres, que se muestra una sola vez. Con «Nueva contraseña» se genera otra y se cierran las sesiones abiertas de esa persona.

En la hoja `Usuarios` solo se guarda el hash de cada contraseña, nunca la contraseña. Tras 5 intentos fallidos seguidos, la cuenta queda bloqueada 15 minutos. La sesión se recuerda en el dispositivo 30 días o hasta pulsar el botón de salir.

## Qué hace

- **Fichaje con ubicación**: entrada, pausa, vuelta al trabajo y salida. Cada fichaje guarda coordenadas y precisión. Sin permiso de ubicación no se puede fichar (`CONFIG.ubicacionObligatoria`).
- **Ubicación durante la jornada**: desde la entrada hasta la salida se guarda la posición cada 30 segundos (`CONFIG.segundosEntreUbicaciones`). Con la app Android funciona también con el móvil bloqueado; desde la web y desde la app de iPhone, solo con la página abierta y a la vista. Por defecto se detiene en las pausas (`CONFIG.seguimientoEnPausas`).
- **Avisos a la hora de fichar**: el administrador fija para cada persona hora de entrada, hora de salida y días. La app Android avisa en el móvil a esas horas si la persona no ha fichado.
- **Equipo**: estado de cada persona, horas del día y última posición con su antigüedad; el panel se actualiza solo cada minuto. «Mapa del día» dibuja el recorrido y se refresca cada 30 segundos mientras está abierto. Si alguien está trabajando y no llega posición en cinco minutos, aparece "Sin señal reciente".
- **Corrección de horas**: el administrador corrige, añade o anula fichajes, siempre con motivo. El valor anterior y el nuevo quedan en la hoja `Auditoria`; un fichaje anulado no se borra, se marca.
- **Informes**: horas por persona en un periodo. La hoja `Resumen` se regenera con cada cambio: una fila por persona y jornada.

## Avisos al administrador

Llegan por dos vías: la pestaña Avisos de la aplicación (con contador de no leídos) y un correo a la cuenta de Google propietaria (o a `CONFIG.correoAvisos`).

| Aviso | Cuándo |
|-------|--------|
| Fichaje | Cada entrada, pausa y salida, con enlace a la ubicación |
| Salida olvidada | Una jornada lleva abierta más de `CONFIG.horasMaxJornada` horas (10). Se comprueba cada hora y se avisa una vez por jornada |
| Acceso fallido | Una cuenta queda bloqueada por intentos de contraseña erróneos. Una vez al día por cuenta |
| Resumen diario | A partir de las 22:00 (`CONFIG.horaResumenDiario`): horas de cada persona y jornadas sin cerrar |

Cada tipo se ajusta en `CONFIG.avisos`: `activo: false` lo quita del todo y `correo: false` lo deja solo dentro de la aplicación. Una cuenta de Gmail gratuita puede enviar unos 100 correos al día desde Apps Script; con un equipo grande conviene dejar el aviso de cada fichaje solo en la aplicación. Si la cuota se agota, los avisos siguen apareciendo en la aplicación.

## Puesta en marcha

1. En script.google.com, crear un proyecto, pegar `Code.gs` en el fichero de código y crear un fichero HTML llamado `Index` con el contenido de `Index.html`.
2. Seleccionar la función `instalar` y pulsar **Ejecutar**. Google pide autorización la primera vez (hojas de cálculo, envío de correo y disparadores). Crea los libros "Fichajes - Control horario" y "Fichajes - Ubicaciones", la cuenta de administrador y los tres disparadores.
3. Abrir el **registro de ejecución**: muestra la dirección de los libros y el **código de activación** del administrador.
4. **Implementar > Nueva implementación > Aplicación web**. Ejecutar como: *Yo*. Quién tiene acceso: *Cualquier usuario*. La app Android no inicia sesión en Google, así que no sirve la opción que exige cuenta de Google; el acceso lo protegen el usuario y la contraseña de cada persona.
5. Abrir la dirección de la aplicación. Aparece la pantalla de activación: introducir el código y elegir la contraseña del administrador.
6. En la pestaña Equipo, dar de alta a cada persona con «Nueva persona», entregarle su usuario y su contraseña, y fijar su horario con el botón «Horario».
7. Compilar la app Android con la dirección de la aplicación web e instalarla en los móviles (ver `android/README.md`).
8. Para los iPhone, publicar la app web instalable e instalarla desde Safari (ver `pwa/README.md`).

### Si ya estaba instalada una versión anterior

Sustituir los dos ficheros, ejecutar `instalar` otra vez (añade las columnas de horario, el libro de ubicaciones y el disparador de purga; no borra nada) y publicar una versión nueva cambiando el acceso a *Cualquier usuario*. La hoja `Ubicaciones` del libro principal deja de usarse.

Tras cambiar el código hay que publicar una versión nueva en **Implementar > Gestionar implementaciones** para que el cambio llegue a la dirección publicada. Si se cambia `CONFIG.horaResumenDiario`, volver a ejecutar `instalar` para reprogramar el disparador.

### Si se olvida la contraseña del administrador

Ejecutar la función `restablecerAdmin` desde el editor. Borra la contraseña y escribe un código de activación nuevo en el registro de ejecución. Solo puede ejecutarla el propietario del proyecto.

## Hojas del libro

| Hoja | Columnas |
|------|----------|
| `Fichajes` | Id, FechaHora, Usuario, Tipo, Latitud, Longitud, PrecisionM, Origen (APP / ADMIN), Estado (ACTIVO / ANULADO), Nota |
| `Usuarios` | Usuario, Nombre, Rol (ADMIN / EMPLEADO), Activo, Sal, Hash, HoraEntrada, HoraSalida, Dias (1 = lunes ... 7 = domingo) |
| `Auditoria` | FechaHora, Administrador, Accion, IdFichaje, Empleado, ValorAnterior, ValorNuevo, Motivo |
| `Resumen` | Fecha, Usuario, Nombre, Entrada, Salida, PausasMin, HorasTrabajadas, Jornada, CorregidaPorAdmin |
| `Avisos` | Id, FechaHora, Tipo, Usuario, Texto, Leido, Clave |

Para desactivar a alguien se desmarca `Activo` en su fila de `Usuarios`. Las columnas `Sal` y `Hash` no deben editarse a mano.

### Libro de ubicaciones

Los recorridos van a un libro aparte, "Fichajes - Ubicaciones", porque crecen mucho: unas 960 filas por persona y jornada de ocho horas.

| Pestaña | Contenido |
|---------|-----------|
| `Ultimas` | Última posición conocida de cada persona: Usuario, FechaHora, Latitud, Longitud, PrecisionM |
| Una por día (`2026-10-04`) | FechaHora, Usuario, Latitud, Longitud, PrecisionM |

Un disparador diario borra las pestañas con más de `CONFIG.diasConservarUbicaciones` días (60). Google Sheets admite 10 millones de celdas por libro: con 60 días caben unas 30 personas a jornada completa; con más plantilla hay que bajar los días de conservación. Los fichajes y el resumen de horas no se purgan.

## Servidor para las apps de los empleados

La app Android y la app web de iPhone envían peticiones POST con JSON a la misma dirección de la aplicación web (`doPost`). Acciones: `login`, `estado`, `fichar` y `ubicaciones`. Solo expone lo que necesita un empleado; la cuenta de administrador no puede entrar por esta vía.

## Limitaciones conocidas

- Desde la web y desde la app de iPhone, el seguimiento de ubicación solo funciona con la página abierta y a la vista. El registro continuo con el móvil bloqueado lo hace la app Android; en iPhone exigiría una app nativa, con cuenta de desarrollador de Apple.
- Los avisos al administrador llegan al móvil por correo, no como notificación push. Los avisos de la hora de fichar sí son notificaciones del móvil, pero solo con la app Android; en iPhone no hay.
- Con acceso *Cualquier usuario*, cualquiera que conozca la dirección llega a la pantalla de acceso. La protección son las contraseñas y el bloqueo por intentos.
- Cualquiera que conozca un nombre de usuario puede bloquear esa cuenta 15 minutos fallando la contraseña cinco veces. El administrador recibe un aviso cuando ocurre.
- Las lecturas recorren la hoja completa de fichajes. Es adecuado para un equipo pequeño; con muchos miles de filas conviene archivar por año.
- La zona horaria está fijada a `Europe/Madrid` (constante `TZ`).

## Aviso legal

Geolocalizar a la plantilla es tratamiento de datos personales. Antes de usarlo con empleados hay que informarles de forma expresa, clara e inequívoca de que existe el sistema y de sus características (artículo 90 de la LOPDGDD), y limitarlo a la jornada. Un registro cada 30 segundos es un seguimiento continuo: la empresa debe poder justificar que es necesario y proporcionado para su actividad. Por eso la aplicación no registra durante las pausas salvo que se active expresamente, muestra un aviso permanente en el móvil mientras registra y borra los recorridos pasados 60 días. El registro de jornada debe conservarse cuatro años (artículo 34.9 del Estatuto de los Trabajadores). Conviene validarlo con quien lleve la protección de datos de la empresa.

## Pruebas realizadas

- Servidor probado con los servicios de Google simulados en memoria: instalación, activación del administrador, inicio de sesión, sesiones manipuladas y caducadas, bloqueo por intentos, alta de empleados, contraseña nueva, jornada con pausa, permisos, corrección, anulación, auditoría, resumen, turno de noche, los cuatro tipos de aviso, envío de ubicaciones por lotes (una jornada completa de 960 puntos), descarte de puntos fuera de jornada o repetidos, horarios, la entrada JSON para la app y la purga de recorridos.
- Interfaz web probada en un navegador contra ese mismo servidor simulado: acceso, fichaje, panel de equipo, horario, mapa del recorrido con refresco, aviso de falta de señal, avisos e informes, en móvil y escritorio.
- App Android: sin compilar ni ejecutar en un dispositivo en el entorno donde se escribió (ver `android/README.md`).
- App web de iPhone: probada en un navegador de escritorio contra el servidor simulado; sin probar en un iPhone (ver `pwa/README.md`).
- Nada se ha probado contra Google real. Quedan pendientes allí el permiso de ubicación dentro de la aplicación web publicada, la entrega de los correos, el tiempo que tarda el inicio de sesión, la carga del mapa y la comunicación de la app con el servidor.
