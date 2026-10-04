# Fichajes: app Android

App para los empleados. Hace lo que una página web no puede:

- **Registra la ubicación cada 30 segundos durante la jornada**, también con el móvil bloqueado o con otra app abierta. Mientras registra, Android muestra un aviso permanente ("Jornada en curso").
- **Avisa a la hora de fichar**: notificación a la hora de entrada si la persona no ha fichado, y a la hora de salida si la jornada sigue abierta. No hace falta tener la app abierta. El horario lo fija el administrador en la web y llega al móvil solo, en unos 15 minutos (o al instante si se abre la app).
- Permite fichar entrada, pausa, vuelta y salida con la ubicación del momento.

El administrador no usa esta app: gestiona todo desde la aplicación web.

## Compilar

Hace falta [Android Studio](https://developer.android.com/studio) en un ordenador con conexión a internet.

1. Abre Android Studio y elige **Open**. Selecciona esta carpeta (`android`).
2. Espera a que termine la sincronización de Gradle. La primera vez descarga el SDK de Android 14 (API 34) y tarda unos minutos. Si propone actualizar el complemento de Android o Gradle, puedes aceptar.
3. Abre `gradle.properties` y pega la dirección de la aplicación web en `FICHAJES_URL`. Es la que termina en `/exec` y se copia en Apps Script desde **Implementar > Gestionar implementaciones**.
4. Menú **Build > Build App Bundle(s) / APK(s) > Build APK(s)**. El fichero queda en `app/build/outputs/apk/debug/app-debug.apk`.

Para repartirla a todo el equipo es mejor firmarla con una clave propia: **Build > Generate Signed App Bundle / APK > APK**, crea un almacén de claves y guárdalo junto con su contraseña. Todas las versiones futuras deben firmarse con ese mismo almacén; si cambia la firma, Android obliga a desinstalar la app antes de instalar la nueva.

Si `FICHAJES_URL` se deja vacío, la app pide la dirección del servidor en la pantalla de acceso.

## Instalar en cada móvil

1. Envía el APK al móvil (correo, WhatsApp, Drive) y ábrelo. Android pedirá permitir la instalación desde esa aplicación.
2. Abre **Fichajes** y entra con el usuario y la contraseña que generó el administrador.
3. Concede los permisos cuando los pida:
   - **Ubicación**: "Mientras se usa la app" y **precisa**.
   - **Notificaciones**: permitir.
4. Si aparece el aviso de batería, pulsa **Ajustes** y deja la app **sin restricciones**.
5. En Xiaomi, Redmi, POCO, Huawei, Honor, Oppo, Realme, OnePlus y Vivo la app muestra además un aviso de **inicio automático**: pulsa **Ajustes** y actívalo para Fichajes. Sin él, el sistema anula los avisos y corta el registro al cerrar la app.
6. Pulsa **Probar el aviso (llega en 1 minuto)**, vuelve a la pantalla de inicio del móvil y espera. Si llega la notificación "Aviso de prueba", los avisos de la hora de fichar funcionarán en ese móvil.

**No hay que cerrar sesión para salir de la app.** Se sale con el botón de inicio del móvil. El botón «Cerrar sesión» desconecta la cuenta: detiene el registro de ubicación y cancela los avisos hasta que se vuelva a entrar con usuario y contraseña.

En Xiaomi (MIUI o HyperOS), si los avisos siguen sin llegar con la app cerrada, revisa en Ajustes > Aplicaciones > Fichajes: **Inicio automático** activado, **Ahorro de batería: sin restricciones** y, en **Notificaciones**, permitidas las notificaciones flotantes y en pantalla de bloqueo.

Requiere Android 8.0 o posterior.

## Requisito del servidor

La aplicación web debe estar publicada con acceso **Cualquier usuario** (no "Cualquier usuario con una cuenta de Google"): la app no inicia sesión en Google, se identifica con el usuario y la contraseña de Fichajes.

## Cómo funciona

| Clase | Función |
|-------|---------|
| `LoginActivity` | Acceso con usuario y contraseña |
| `MainActivity` | Estado de la jornada, botones de fichaje, avisos de permisos que faltan |
| `UbicacionService` | Servicio en primer plano: toma una posición cada 30 s y la guarda en la cola |
| `ColaUbicaciones` | Cola local (SQLite) de puntos pendientes; aguanta cortes de cobertura de hasta 24 h |
| `Envio` | Envía la cola al servidor cada minuto, en lotes |
| `Recordatorios`, `RecordatorioReceiver` | Alarmas locales a la hora de entrada y de salida |
| `SincronizacionJob` | Cada 15 minutos, con la app cerrada, descarga el estado y el horario y reprograma los avisos |
| `ArranqueReceiver` | Tras reiniciar el móvil, reprograma los avisos |
| `Api`, `Sesion` | Comunicación con el servidor y datos guardados en el móvil |

La cadencia (30 s), el intervalo de envío (60 s) y si se registra durante las pausas los decide el servidor (`CONFIG` en `Code.gs`); la app los recibe al entrar.

El registro se detiene solo al fichar la salida, al iniciar una pausa (salvo que el servidor indique lo contrario), al cerrar sesión, o si el servidor informa de que la jornada ya no está en curso (por ejemplo, porque el administrador la cerró).

## Limitaciones

- Si el móvil se reinicia en plena jornada, Android no deja reanudar el registro sin la app a la vista: llega una notificación pidiendo abrirla.
- Los avisos de la hora de fichar son alarmas del propio móvil, no mensajes enviados desde el servidor. Un horario nuevo o cambiado tarda hasta unos 15 minutos en llegar al móvil (más si está en ahorro de energía profundo); se puede forzar abriendo la app. La pantalla principal muestra el próximo aviso programado.
- El aviso de entrada solo aparece si la persona está fuera de jornada, y el de salida solo si la jornada sigue abierta.
- Si el empleado fuerza la detención de la app desde los ajustes de Android, el sistema cancela sus alarmas hasta que la vuelva a abrir. En Xiaomi, Huawei, Oppo y similares pasa lo mismo al cerrarla desde recientes si no tiene permitido el inicio automático.
- Si el empleado fuerza el cierre de la app o le quita el permiso de ubicación, el registro se detiene. El administrador lo ve en la web como "Sin señal reciente".
- Solo Android. No hay versión para iPhone.

## Estado de las pruebas

El proyecto **no se ha compilado ni ejecutado en un dispositivo**: el entorno donde se escribió no tiene acceso al SDK de Android. Se ha comprobado que el código compila contra un esqueleto de las API de Android contrastado con las declaraciones oficiales hasta Android 10 (API 29), y se ha probado el cálculo de las horas de aviso. Las partes que usan API posteriores (proveedor de ubicación combinado y alarmas exactas de Android 12, permiso de notificaciones de Android 13) no se han podido contrastar. La primera compilación en Android Studio y una jornada de prueba en un móvil real son imprescindibles antes de repartirla.
