package com.fichajes.app;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Llamadas al servidor (la aplicación web de Apps Script). Cada petición es
 * un POST con JSON { accion, ... } y la respuesta es { ok, datos } o
 * { ok: false, error }. Deben hacerse fuera del hilo principal.
 */
final class Api {

    /** Error devuelto por el servidor o fallo de conexión. */
    static final class Fallo extends Exception {
        /** true si la sesión ya no vale y hay que volver a entrar. */
        final boolean acceso;

        Fallo(String mensaje, boolean acceso) {
            super(mensaje);
            this.acceso = acceso;
        }
    }

    private Api() {
    }

    static JSONObject llamar(Context c, JSONObject cuerpo) throws Fallo {
        String base = new Sesion(c).servidor();
        if (base.isEmpty()) throw new Fallo("Falta la dirección del servidor.", false);

        String texto;
        try {
            texto = enviar(base, cuerpo.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException ex) {
            throw new Fallo("No hay conexión con el servidor. Comprueba la cobertura e inténtalo de nuevo.", false);
        }

        try {
            JSONObject r = new JSONObject(texto);
            if (r.optBoolean("ok", false)) {
                JSONObject datos = r.optJSONObject("datos");
                return datos != null ? datos : new JSONObject();
            }
            String error = r.optString("error", "Error desconocido.");
            if (error.startsWith("ACCESO:")) {
                String limpio = error.substring("ACCESO:".length()).trim();
                if (!limpio.isEmpty()) limpio = limpio.substring(0, 1).toUpperCase() + limpio.substring(1);
                throw new Fallo(limpio, true);
            }
            throw new Fallo(error, false);
        } catch (JSONException ex) {
            // Suele ser una página de acceso de Google: la aplicación web no admite visitas anónimas.
            throw new Fallo("El servidor no ha respondido como se esperaba. Revisa que la aplicación web esté"
                    + " publicada con acceso «Cualquier usuario» y que la dirección sea la que termina en /exec.", false);
        }
    }

    /**
     * Apps Script responde al POST con una redirección a otra dirección que
     * se recoge con GET; se sigue a mano para no depender del comportamiento
     * de cada versión de Android.
     */
    private static String enviar(String direccion, byte[] datos) throws IOException {
        HttpURLConnection con = abrir(direccion);
        try {
            con.setRequestMethod("POST");
            con.setDoOutput(true);
            con.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
            try (OutputStream salida = con.getOutputStream()) {
                salida.write(datos);
            }
            int codigo = con.getResponseCode();
            for (int saltos = 0; esRedireccion(codigo) && saltos < 4; saltos++) {
                String destino = con.getHeaderField("Location");
                con.disconnect();
                if (destino == null) throw new IOException("Redirección sin destino");
                con = abrir(destino);
                con.setRequestMethod("GET");
                codigo = con.getResponseCode();
            }
            InputStream entrada = codigo >= 400 ? con.getErrorStream() : con.getInputStream();
            return leer(entrada);
        } finally {
            con.disconnect();
        }
    }

    private static HttpURLConnection abrir(String direccion) throws IOException {
        HttpURLConnection con = (HttpURLConnection) new URL(direccion).openConnection();
        con.setConnectTimeout(15000);
        con.setReadTimeout(40000);
        con.setInstanceFollowRedirects(false);
        con.setRequestProperty("Accept", "application/json");
        return con;
    }

    private static boolean esRedireccion(int codigo) {
        return codigo == 301 || codigo == 302 || codigo == 303 || codigo == 307 || codigo == 308;
    }

    private static String leer(InputStream entrada) throws IOException {
        if (entrada == null) return "";
        try (InputStream in = entrada; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] bloque = new byte[8192];
            int n;
            while ((n = in.read(bloque)) > 0) out.write(bloque, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /* Peticiones concretas */

    static JSONObject login(Context c, String usuario, String clave) throws Fallo {
        return llamar(c, cuerpo("login", null, "usuario", usuario, "clave", clave));
    }

    static JSONObject estado(Context c) throws Fallo {
        return llamar(c, cuerpo("estado", new Sesion(c).token()));
    }

    static JSONObject fichar(Context c, String tipo, JSONObject posicion) throws Fallo {
        return llamar(c, cuerpo("fichar", new Sesion(c).token(), "tipo", tipo, "pos", posicion));
    }

    /** Monta { accion, token, clave1: valor1, ... }. Un valor null se envía como JSON null. */
    static JSONObject cuerpo(String accion, String token, Object... pares) {
        JSONObject o = new JSONObject();
        try {
            o.put("accion", accion);
            if (token != null) o.put("token", token);
            for (int i = 0; i + 1 < pares.length; i += 2) {
                o.put((String) pares[i], pares[i + 1] == null ? JSONObject.NULL : pares[i + 1]);
            }
        } catch (JSONException ex) {
            throw new IllegalStateException(ex);
        }
        return o;
    }
}
