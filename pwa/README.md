# Fichajes: app web instalable (iPhone)

App para los empleados que tienen iPhone. Es una página web que se instala en la pantalla de inicio y se abre a pantalla completa, como una app. No necesita cuenta de desarrollador de Apple ni pasar por la App Store. También funciona en Android y en un ordenador, aunque en Android es mejor la app de la carpeta `android/`.

## Qué hace y qué no

| | App web (iPhone) | App Android |
|---|---|---|
| Fichar entrada, pausa, vuelta y salida con la ubicación del momento | Sí | Sí |
| Guardar la ubicación cada 30 s durante la jornada | Solo con la app abierta y la pantalla encendida | Sí, también con el móvil bloqueado |
| Avisos a la hora de fichar | No | Sí |

iOS no entrega la ubicación a una página web cuando deja de estar a la vista. En cuanto la persona bloquea el iPhone o cambia de app, el registro del recorrido se detiene, y se reanuda al volver a abrir Fichajes. Los puntos que no han podido enviarse por falta de cobertura se guardan en el móvil (hasta 24 horas) y se entregan al recuperar la conexión.

Para alargar el registro, la app mantiene la pantalla encendida mientras dura la jornada. Se puede desactivar con el interruptor «Mantener la pantalla encendida durante la jornada». Gasta más batería.

El administrador no usa esta app: gestiona todo desde la aplicación web de Apps Script.

## Publicar

La app se sirve desde GitHub Pages. El fichero `.github/workflows/publicar-pwa.yml` la publica cada vez que cambia la carpeta `pwa/` en la rama `master`. Hay que preparar el repositorio una sola vez:

1. **Settings > Pages > Build and deployment > Source**: elegir **GitHub Actions**. Con una cuenta gratuita de GitHub, Pages solo está disponible si el repositorio es público.
2. **Settings > Secrets and variables > Actions > Variables > New repository variable**: nombre `FICHAJES_URL`, valor la dirección de la aplicación web de Apps Script (la que termina en `/exec`, de **Implementar > Gestionar implementaciones**).
3. Llevar los cambios a `master`. La publicación aparece en la pestaña **Actions**; al terminar, la dirección de la app es `https://<usuario>.github.io/<repositorio>/`.

Para volver a publicar sin cambios (por ejemplo, tras cambiar `FICHAJES_URL`): **Actions > Publicar la app web de fichaje > Run workflow**.

La dirección del servidor no se guarda en el repositorio, pero queda a la vista en la app publicada: cualquiera que abra la página puede leerla. Es inevitable en una app que se ejecuta en el móvil de cada persona; la protección son las contraseñas y el bloqueo por intentos fallidos. Si no se define `FICHAJES_URL`, la app pide la dirección en la pantalla de acceso.

## Requisito del servidor

El mismo que para la app Android: la aplicación web de Apps Script publicada con acceso **Cualquier usuario**. No hay que cambiar nada en `Code.gs`; esta app usa las mismas cuatro acciones (`login`, `estado`, `fichar`, `ubicaciones`).

## Instalar en cada iPhone

1. Abrir la dirección de la app en **Safari**.
2. Pulsar el botón **Compartir** y elegir **Añadir a pantalla de inicio**.
3. Abrir **Fichajes** desde el icono nuevo y entrar con el usuario y la contraseña que generó el administrador. Hay que entrar desde el icono: la app instalada no comparte la sesión con Safari.
4. Cuando el iPhone lo pregunte, permitir el acceso a la **ubicación**. La localización del iPhone debe estar activada (**Ajustes > Privacidad y seguridad > Localización**).

Durante la jornada, la persona debe dejar Fichajes abierta y a la vista. La tarjeta «Ubicación durante la jornada» indica si se está registrando, la hora del último punto y cuántos quedan por enviar.

## Ficheros

| Fichero | Contenido |
|---------|-----------|
| `index.html`, `estilos.css` | Pantallas de acceso y de fichaje |
| `app.js` | Sesión, fichaje, registro de ubicación, cola de puntos pendientes y pantalla encendida |
| `config.js` | Dirección del servidor. En el repositorio va vacía; la publicación la rellena con `FICHAJES_URL` |
| `manifest.webmanifest`, `iconos/` | Nombre, colores e iconos de la app instalada |
| `sw.js` | Copia local de los ficheros para que la app abra sin cobertura |

La sesión, el último estado recibido y los puntos pendientes se guardan en el almacenamiento del navegador de ese móvil. «Cerrar sesión» los borra.

Por seguridad, la app solo envía el usuario y la contraseña a una dirección de `https://script.google.com/…/exec`.

## Probar en el ordenador

Hace falta servir la carpeta por HTTP (no vale abrir `index.html` con doble clic). Por ejemplo, con Python instalado:

```
python -m http.server 8080 --directory pwa
```

y abrir `http://localhost:8080/`. Con `config.js` vacío, la app pide la dirección del servidor al entrar.

## Limitaciones

- El registro del recorrido se detiene con el iPhone bloqueado o con otra app delante. El administrador lo ve en la web como "Sin señal reciente".
- No hay avisos a la hora de fichar.
- Si la persona deniega el permiso de ubicación, no puede fichar (igual que en la web y en Android).

## Estado de las pruebas

Probada en un navegador de escritorio (Chromium) contra el servidor simulado, con otro origen y con la redirección que hace Apps Script: acceso, rechazo del administrador, fichaje con ubicación, registro periódico, parada al ocultar la app y reanudación al volver, cola sin conexión y envío posterior, pausa, salida, sesión anulada, cierre de sesión, validación de la dirección del servidor, instalación (manifiesto, iconos, copia local) y apertura sin cobertura.

**No se ha probado en un iPhone ni contra Google real.** Quedan por comprobar allí: que Apps Script acepta las llamadas desde la página publicada, el permiso de ubicación dentro de la app instalada, y que la pantalla se mantiene encendida (depende de la versión de iOS; si el iPhone no lo permite, la app lo indica y recomienda quitar el bloqueo automático durante la jornada).
