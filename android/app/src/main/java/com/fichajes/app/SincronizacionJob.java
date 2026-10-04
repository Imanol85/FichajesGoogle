package com.fichajes.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Sincronización periódica en segundo plano. Aunque la app no esté abierta,
 * consulta al servidor el estado y el horario de la persona y vuelve a
 * programar los avisos. Así un horario nuevo o cambiado por el
 * administrador llega al móvil sin que nadie tenga que abrir la app.
 */
public class SincronizacionJob extends JobService {

    private static final int ID_TRABAJO = 100;
    /** Mínimo que admite Android para un trabajo periódico. */
    private static final long PERIODO_MS = 15L * 60L * 1000L;

    /** Deja programada la sincronización mientras haya sesión; la cancela si no la hay. */
    static void programar(Context c) {
        JobScheduler planificador = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (planificador == null) return;
        if (!new Sesion(c).iniciada()) {
            planificador.cancel(ID_TRABAJO);
            return;
        }
        try {
            if (planificador.getPendingJob(ID_TRABAJO) != null) return;
            JobInfo trabajo = new JobInfo.Builder(ID_TRABAJO, new ComponentName(c, SincronizacionJob.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIODO_MS)
                    .setPersisted(true)
                    .build();
            planificador.schedule(trabajo);
        } catch (RuntimeException ex) {
            // Si el sistema no admite el trabajo, el horario se sigue actualizando al abrir la app.
        }
    }

    @Override
    public boolean onStartJob(final JobParameters parametros) {
        final Context app = getApplicationContext();
        new Thread(() -> {
            Sesion sesion = new Sesion(app);
            if (sesion.iniciada()) {
                try {
                    sesion.guardarEstado(Api.estado(app));
                } catch (Api.Fallo f) {
                    if (f.acceso) {
                        // La sesión ya no vale: se deja de registrar y de avisar hasta que vuelva a entrar.
                        UbicacionService.detener(app);
                        sesion.cerrar();
                        ColaUbicaciones.de(app).vaciar();
                    }
                    // Sin conexión: se conserva lo que ya había y se reintenta en el siguiente periodo.
                }
            }
            Recordatorios.programar(app);
            jobFinished(parametros, false);
        }, "fichajes-sincronizacion").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters parametros) {
        return false;
    }
}
