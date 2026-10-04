package com.fichajes.app;

import android.content.Context;

import org.json.JSONObject;

/** Envío al servidor de los puntos de ubicación acumulados en la cola. */
final class Envio {

    private static final int PUNTOS_POR_PETICION = 100;
    private static final long UN_DIA_MS = 24L * 3600L * 1000L;

    private Envio() {
    }

    /**
     * Envía lo pendiente, por lotes. Devuelve el estado que comunica el
     * servidor (FUERA, TRABAJANDO, EN_PAUSA) o null si no había nada que
     * enviar o no hubo conexión; en ese caso los puntos siguen en la cola.
     * Solo lanza el fallo cuando la sesión ha dejado de valer.
     */
    static synchronized String enviarPendientes(Context c) throws Api.Fallo {
        Sesion sesion = new Sesion(c);
        ColaUbicaciones cola = ColaUbicaciones.de(c);
        if (!sesion.iniciada()) {
            cola.vaciar();
            return null;
        }
        cola.descartarAnteriores(System.currentTimeMillis() - UN_DIA_MS);

        String estado = null;
        for (int vuelta = 0; vuelta < 10; vuelta++) {
            ColaUbicaciones.Lote lote = cola.primeros(PUNTOS_POR_PETICION);
            if (lote.puntos.length() == 0) break;
            try {
                JSONObject r = Api.llamar(c, Api.cuerpo("ubicaciones", sesion.token(), "puntos", lote.puntos));
                cola.borrarHasta(lote.ultimoId);
                estado = r.optString("estado", estado);
            } catch (Api.Fallo f) {
                if (f.acceso) throw f;
                return null;
            }
        }
        if (estado != null) sesion.guardarEstadoActual(estado);
        return estado;
    }
}
