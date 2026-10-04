package com.fichajes.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.location.LocationRequest;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

/**
 * Servicio en primer plano que registra la ubicación durante la jornada.
 * Mientras está activo, el móvil muestra un aviso permanente. Cada lectura
 * se guarda en la cola local y la cola se envía al servidor periódicamente;
 * si el servidor responde que la jornada ya no está en curso, el servicio
 * se detiene solo.
 */
public class UbicacionService extends Service implements LocationListener {

    private static final String CANAL = "jornada";
    private static final int ID_AVISO = 1;
    private static final long MAXIMO_DESPIERTO_MS = 14L * 3600L * 1000L;
    private static final long LECTURA_VIEJA_NS = 2L * 60L * 1_000_000_000L;

    /** true mientras el servicio está registrando. */
    static volatile boolean enMarcha;
    /** Momento (reloj del móvil) del último punto guardado, o 0. */
    static volatile long ultimoPunto;

    private LocationManager lm;
    private HandlerThread hilo;
    private Handler tareas;
    private PowerManager.WakeLock despierto;
    private long intervaloMs;
    private long envioMs;
    private long ultimoGps;

    static void iniciar(Context c) {
        c.startForegroundService(new Intent(c, UbicacionService.class));
    }

    static void detener(Context c) {
        c.stopService(new Intent(c, UbicacionService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int idInicio) {
        Sesion sesion = new Sesion(this);
        // Lo primero es mostrar el aviso: Android exige hacerlo enseguida tras arrancar el servicio.
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(ID_AVISO, aviso(sesion), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(ID_AVISO, aviso(sesion));
            }
        } catch (RuntimeException ex) {
            // Android no permite arrancar el registro con la app en segundo plano:
            // se reanudará cuando la persona abra la app.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!sesion.iniciada() || !Permisos.ubicacion(this)) {
            parar();
            return START_NOT_STICKY;
        }
        if (!enMarcha) empezar(sesion);
        return START_STICKY;
    }

    private void empezar(Sesion sesion) {
        intervaloMs = sesion.segundosUbicacion() * 1000L;
        envioMs = sesion.segundosEnvio() * 1000L;
        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        hilo = new HandlerThread("fichajes-ubicacion");
        hilo.start();
        tareas = new Handler(hilo.getLooper());

        try {
            boolean alguno = false;
            for (String proveedor : UbicacionPuntual.proveedores(lm)) {
                if (Build.VERSION.SDK_INT >= 31 && LocationManager.FUSED_PROVIDER.equals(proveedor)) {
                    LocationRequest peticion = new LocationRequest.Builder(intervaloMs)
                            .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
                            .setMinUpdateIntervalMillis(intervaloMs / 2)
                            .build();
                    lm.requestLocationUpdates(proveedor, peticion, tareas::post, this);
                    alguno = true;
                    break; // el proveedor combinado ya usa GPS y red
                }
                lm.requestLocationUpdates(proveedor, intervaloMs, 0f, this, hilo.getLooper());
                alguno = true;
            }
            if (!alguno) {
                parar();
                return;
            }
        } catch (SecurityException | IllegalArgumentException ex) {
            parar();
            return;
        }

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        despierto = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fichajes:ubicacion");
        despierto.acquire(MAXIMO_DESPIERTO_MS);

        enMarcha = true;
        tareas.postDelayed(this::enviar, envioMs);
    }

    @Override
    public void onLocationChanged(Location posicion) {
        long ahora = System.currentTimeMillis();
        if (SystemClock.elapsedRealtimeNanos() - posicion.getElapsedRealtimeNanos() > LECTURA_VIEJA_NS) return;

        boolean deRed = LocationManager.NETWORK_PROVIDER.equals(posicion.getProvider());
        if (!deRed) ultimoGps = ahora;
        // Con GPS reciente, las lecturas de red (menos precisas) no aportan nada.
        if (deRed && ahora - ultimoGps < 2 * intervaloMs) return;
        // Un punto por intervalo, aunque el móvil entregue lecturas más seguidas.
        if (ahora - ultimoPunto < intervaloMs - 2000) return;

        ultimoPunto = ahora;
        ColaUbicaciones.de(this).anadir(ahora, posicion.getLatitude(), posicion.getLongitude(),
                posicion.hasAccuracy() ? posicion.getAccuracy() : 0f);
    }

    /** Envía la cola y decide si el registro debe continuar. Se ejecuta en el hilo del servicio. */
    private void enviar() {
        if (!enMarcha) return;
        Sesion sesion = new Sesion(this);
        try {
            String estado = Envio.enviarPendientes(this);
            if (estado != null && !sesion.debeRegistrar(estado)) {
                parar();
                return;
            }
        } catch (Api.Fallo f) {
            // La sesión ya no vale: se deja de registrar y la app pedirá entrar de nuevo.
            sesion.cerrar();
            ColaUbicaciones.de(this).vaciar();
            Recordatorios.programar(this);
            parar();
            return;
        }
        tareas.postDelayed(this::enviar, envioMs);
    }

    private void parar() {
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        enMarcha = false;
        if (lm != null) {
            try {
                lm.removeUpdates(this);
            } catch (SecurityException ignorada) {
                // Sin permiso no había nada registrado.
            }
        }
        if (tareas != null) tareas.removeCallbacksAndMessages(null);
        if (hilo != null) hilo.quitSafely();
        if (despierto != null && despierto.isHeld()) despierto.release();
        super.onDestroy();
    }

    private Notification aviso(Sesion sesion) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel canal = new NotificationChannel(CANAL, "Jornada en curso", NotificationManager.IMPORTANCE_LOW);
        canal.setDescription("Aviso permanente mientras se registra la ubicación durante la jornada");
        nm.createNotificationChannel(canal);

        PendingIntent abrir = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CANAL)
                .setSmallIcon(R.drawable.ic_reloj)
                .setContentTitle("Jornada en curso")
                .setContentText("Se registra tu ubicación cada " + sesion.segundosUbicacion() + " segundos hasta que fiches la salida.")
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(abrir)
                .build();
    }

    // En versiones anteriores a Android 11 estos métodos no tienen implementación por defecto.

    @Override
    public void onProviderEnabled(String proveedor) {
    }

    @Override
    public void onProviderDisabled(String proveedor) {
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String proveedor, int estado, Bundle extras) {
    }
}
