package com.fichajes.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Recibe la alarma de la hora de entrada o de salida y avisa si la persona aún no ha fichado. */
public class RecordatorioReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context c, Intent intent) {
        Sesion sesion = new Sesion(c);
        String tipo = intent.getStringExtra(Recordatorios.EXTRA_TIPO);
        String estado = sesion.estadoActual();

        if (Recordatorios.PRUEBA.equals(tipo)) {
            Recordatorios.notificar(c, 13, "Aviso de prueba",
                    "Funciona: los avisos de la hora de fichar llegan a este móvil.");
            return;
        }
        if (sesion.iniciada()) {
            if (Recordatorios.ENTRADA.equals(tipo) && "FUERA".equals(estado)) {
                Recordatorios.notificar(c, 10, "Es tu hora de entrada",
                        "Abre Fichajes y ficha la entrada para empezar la jornada.");
            } else if (Recordatorios.SALIDA.equals(tipo) && !"FUERA".equals(estado)) {
                Recordatorios.notificar(c, 11, "Es tu hora de salida",
                        "Tu jornada sigue abierta. Abre Fichajes y ficha la salida cuando termines.");
            }
        }
        // Deja programado el aviso del día siguiente.
        Recordatorios.programar(c);
    }
}
