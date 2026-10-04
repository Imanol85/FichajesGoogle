package com.fichajes.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.Calendar;
import java.util.TimeZone;

/**
 * Avisos en el móvil a la hora de fichar. Se programan en el propio
 * teléfono a partir del horario que fija el administrador, de modo que
 * suenan aunque la app esté cerrada y aunque en ese momento no haya conexión.
 */
final class Recordatorios {

    static final String EXTRA_TIPO = "tipo";
    static final String ENTRADA = "ENTRADA";
    static final String SALIDA = "SALIDA";
    static final String PRUEBA = "PRUEBA";
    private static final String CANAL = "recordatorios";

    private Recordatorios() {
    }

    /** Programa (o cancela) los próximos avisos según la sesión y el horario guardados. */
    static void programar(Context c) {
        // La sincronización en segundo plano mantiene al día el horario aunque no se abra la app.
        SincronizacionJob.programar(c);

        Sesion sesion = new Sesion(c);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        // Con un minuto de margen: así el aviso que acaba de sonar no se vuelve a programar para hoy.
        long ahora = System.currentTimeMillis() + sesion.desfase() + 60_000L;
        boolean activa = sesion.iniciada();

        // La entrada solo avisa los días con horario. La salida avisa cualquier día:
        // el aviso solo se muestra si la jornada sigue abierta (cubre los turnos de noche).
        long entrada = activa ? proxima(sesion.horaEntrada(), sesion.dias(), sesion.zona(), ahora) : -1;
        long salida = activa ? proxima(sesion.horaSalida(), "1234567", sesion.zona(), ahora) : -1;
        fijar(c, am, ENTRADA, 1, entrada < 0 ? -1 : entrada - sesion.desfase());
        fijar(c, am, SALIDA, 2, salida < 0 ? -1 : salida - sesion.desfase());
    }

    /**
     * Programa un aviso de prueba para dentro de un minuto, por el mismo camino
     * que los avisos de entrada y salida. Sirve para comprobar que el móvil los
     * entrega con la app cerrada.
     */
    static void probar(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        fijar(c, am, PRUEBA, 3, System.currentTimeMillis() + 60_000L);
    }

    /**
     * Próximo instante, posterior a "desde", en que el reloj de la zona
     * marca la hora dada en uno de los días indicados (1 = lunes ... 7 =
     * domingo). Devuelve -1 si no hay hora o no hay días.
     */
    static long proxima(String hora, String dias, String zona, long desde) {
        if (hora == null || !hora.matches("\\d{2}:\\d{2}") || dias == null || dias.isEmpty()) return -1;
        int h = Integer.parseInt(hora.substring(0, 2));
        int m = Integer.parseInt(hora.substring(3, 5));

        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone(zona));
        cal.setTimeInMillis(desde);
        cal.set(Calendar.HOUR_OF_DAY, h);
        cal.set(Calendar.MINUTE, m);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        for (int i = 0; i < 8; i++) {
            int diaSemana = cal.get(Calendar.DAY_OF_WEEK);          // domingo = 1 ... sábado = 7
            int iso = ((diaSemana + 5) % 7) + 1;                    // lunes = 1 ... domingo = 7
            if (cal.getTimeInMillis() > desde && dias.indexOf((char) ('0' + iso)) >= 0) return cal.getTimeInMillis();
            cal.add(Calendar.DAY_OF_MONTH, 1);
        }
        return -1;
    }

    private static void fijar(Context c, AlarmManager am, String tipo, int codigo, long cuando) {
        Intent intent = new Intent(c, RecordatorioReceiver.class).putExtra(EXTRA_TIPO, tipo);
        PendingIntent pi = PendingIntent.getBroadcast(c, codigo, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.cancel(pi);
        if (cuando < 0) return;
        try {
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cuando, pi);
                return;
            }
        } catch (SecurityException ex) {
            // Sin permiso de alarmas exactas: se usa la alarma aproximada.
        }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cuando, pi);
    }

    /** Muestra una notificación que abre la app al tocarla. */
    static void notificar(Context c, int id, String titulo, String texto) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel canal = new NotificationChannel(CANAL, "Hora de fichar", NotificationManager.IMPORTANCE_HIGH);
        canal.setDescription("Avisos a la hora de entrada y de salida");
        nm.createNotificationChannel(canal);

        PendingIntent abrir = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(c, CANAL)
                .setSmallIcon(R.drawable.ic_reloj)
                .setContentTitle(titulo)
                .setContentText(texto)
                .setStyle(new Notification.BigTextStyle().bigText(texto))
                .setAutoCancel(true)
                .setContentIntent(abrir)
                .build();
        nm.notify(id, n);
    }
}
