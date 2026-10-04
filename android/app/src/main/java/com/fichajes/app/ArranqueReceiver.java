package com.fichajes.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Al encender el móvil o actualizar la app: vuelve a programar los avisos
 * y, si había una jornada en curso, pide abrir la app para reanudar el
 * registro de ubicación (Android no deja reanudarlo sin la app a la vista).
 */
public class ArranqueReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context c, Intent intent) {
        Sesion sesion = new Sesion(c);
        if (!sesion.iniciada()) return;
        Recordatorios.programar(c);
        if (sesion.debeRegistrar(sesion.estadoActual()) && !UbicacionService.enMarcha) {
            Recordatorios.notificar(c, 12, "Jornada en curso",
                    "Abre Fichajes para reanudar el registro de ubicación.");
        }
    }
}
