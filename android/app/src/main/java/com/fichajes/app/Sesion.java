package com.fichajes.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Datos que la app guarda en el móvil: la sesión, el último estado recibido
 * del servidor y, extraídos de él, el horario y la configuración de seguimiento.
 */
final class Sesion {

    private final SharedPreferences p;

    Sesion(Context c) {
        p = c.getApplicationContext().getSharedPreferences("fichajes", Context.MODE_PRIVATE);
    }

    /** Dirección del servidor: la fijada al compilar o, si no hay, la escrita al entrar. */
    String servidor() {
        String fija = BuildConfig.SERVIDOR_URL;
        return fija.isEmpty() ? p.getString("servidor", "") : fija;
    }

    void guardarServidor(String url) {
        p.edit().putString("servidor", url).apply();
    }

    String token() {
        return p.getString("token", "");
    }

    boolean iniciada() {
        return !token().isEmpty();
    }

    void abrir(String token) {
        p.edit().putString("token", token).apply();
    }

    /** Cierra la sesión y olvida el estado; conserva los ajustes propios del móvil. */
    void cerrar() {
        String servidor = p.getString("servidor", "");
        boolean inicioRevisado = inicioAutomaticoRevisado();
        p.edit().clear()
                .putString("servidor", servidor)
                .putBoolean("inicioAutomatico", inicioRevisado)
                .apply();
    }

    /** true si la persona ya abrió los ajustes de inicio automático desde el aviso de la app. */
    boolean inicioAutomaticoRevisado() {
        return p.getBoolean("inicioAutomatico", false);
    }

    void marcarInicioAutomaticoRevisado() {
        p.edit().putBoolean("inicioAutomatico", true).apply();
    }

    /** Guarda la respuesta de estado del servidor. */
    void guardarEstado(JSONObject e) {
        JSONObject usuario = e.optJSONObject("usuario");
        JSONObject horario = usuario != null ? usuario.optJSONObject("horario") : null;
        JSONObject config = e.optJSONObject("config");
        long ahora = System.currentTimeMillis();
        p.edit()
                .putString("estado", e.toString())
                .putLong("desfase", e.optLong("ahora", ahora) - ahora)
                .putString("estadoActual", e.optString("estado", "FUERA"))
                .putString("horaEntrada", horario != null ? horario.optString("entrada", "") : "")
                .putString("horaSalida", horario != null ? horario.optString("salida", "") : "")
                .putString("dias", horario != null ? horario.optString("dias", "") : "")
                .putString("zona", config != null ? config.optString("zona", "Europe/Madrid") : "Europe/Madrid")
                .putInt("segUbicacion", config != null ? config.optInt("segundosEntreUbicaciones", 30) : 30)
                .putInt("segEnvio", config != null ? config.optInt("segundosEntreEnvios", 60) : 60)
                .putBoolean("enPausas", config != null && config.optBoolean("seguimientoEnPausas", false))
                .apply();
    }

    /** Último estado completo recibido, o null si aún no hay ninguno. */
    JSONObject estado() {
        String texto = p.getString("estado", "");
        if (texto.isEmpty()) return null;
        try {
            return new JSONObject(texto);
        } catch (JSONException ex) {
            return null;
        }
    }

    /** Diferencia entre el reloj del servidor y el del móvil, en milisegundos. */
    long desfase() {
        return p.getLong("desfase", 0L);
    }

    /** FUERA, TRABAJANDO o EN_PAUSA. */
    String estadoActual() {
        return p.getString("estadoActual", "FUERA");
    }

    void guardarEstadoActual(String estado) {
        p.edit().putString("estadoActual", estado).apply();
    }

    String horaEntrada() {
        return p.getString("horaEntrada", "");
    }

    String horaSalida() {
        return p.getString("horaSalida", "");
    }

    /** Días con horario, como cifras: 1 = lunes ... 7 = domingo. */
    String dias() {
        return p.getString("dias", "");
    }

    String zona() {
        return p.getString("zona", "Europe/Madrid");
    }

    int segundosUbicacion() {
        return Math.max(10, p.getInt("segUbicacion", 30));
    }

    int segundosEnvio() {
        return Math.max(20, p.getInt("segEnvio", 60));
    }

    /** Indica si en el estado dado hay que registrar la ubicación. */
    boolean debeRegistrar(String estado) {
        return "TRABAJANDO".equals(estado) || ("EN_PAUSA".equals(estado) && p.getBoolean("enPausas", false));
    }
}
