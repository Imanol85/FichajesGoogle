package com.fichajes.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Pantalla principal del empleado: estado de la jornada, botones de
 * fichaje y fichajes del día. Arranca y detiene el registro de ubicación
 * según el estado y mantiene programados los avisos de la hora de fichar.
 */
public class MainActivity extends Activity {

    private static final int PETICION_PERMISOS = 1;
    private static final long ESPERA_UBICACION_MS = 15000L;

    private final ExecutorService fondo = Executors.newSingleThreadExecutor();
    private final Handler principal = new Handler(Looper.getMainLooper());
    private final Runnable tic = new Runnable() {
        @Override
        public void run() {
            pintarReloj();
            principal.postDelayed(this, 1000L);
        }
    };

    private Sesion sesion;
    private JSONObject estado;
    private boolean lista;
    private boolean ocupado;
    private boolean permisosPedidos;
    private String accionPrincipal = "ENTRADA";
    private String accionSecundaria = "PAUSA_INICIO";

    private TextView txtSaludo;
    private TextView txtFecha;
    private TextView txtEstado;
    private TextView txtReloj;
    private TextView txtEntrada;
    private TextView txtPausas;
    private TextView txtSeguimiento;
    private TextView txtProgreso;
    private TextView txtAviso;
    private TextView txtHorario;
    private Button btnPrincipal;
    private Button btnSecundario;
    private LinearLayout cajaAvisos;
    private LinearLayout listaHoy;

    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        sesion = new Sesion(this);
        if (!sesion.iniciada()) {
            irAlAcceso();
            return;
        }
        setContentView(R.layout.activity_main);
        txtSaludo = findViewById(R.id.txtSaludo);
        txtFecha = findViewById(R.id.txtFecha);
        txtEstado = findViewById(R.id.txtEstado);
        txtReloj = findViewById(R.id.txtReloj);
        txtEntrada = findViewById(R.id.txtEntrada);
        txtPausas = findViewById(R.id.txtPausas);
        txtSeguimiento = findViewById(R.id.txtSeguimiento);
        txtProgreso = findViewById(R.id.txtProgreso);
        txtAviso = findViewById(R.id.txtAviso);
        txtHorario = findViewById(R.id.txtHorario);
        btnPrincipal = findViewById(R.id.btnPrincipal);
        btnSecundario = findViewById(R.id.btnSecundario);
        cajaAvisos = findViewById(R.id.cajaAvisos);
        listaHoy = findViewById(R.id.listaHoy);

        btnPrincipal.setOnClickListener(v -> fichar(accionPrincipal));
        btnSecundario.setOnClickListener(v -> fichar(accionSecundaria));
        findViewById(R.id.btnSalir).setOnClickListener(v -> confirmarSalida());
        findViewById(R.id.txtProbar).setOnClickListener(v -> probarAviso());
        lista = true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!lista) return;
        if (!sesion.iniciada()) {
            irAlAcceso();
            return;
        }
        pintar(sesion.estado());
        pintarAvisos();
        Recordatorios.programar(this);
        pedirPermisosIniciales();
        refrescar();
        principal.removeCallbacks(tic);
        principal.post(tic);
    }

    @Override
    protected void onPause() {
        principal.removeCallbacks(tic);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        principal.removeCallbacksAndMessages(null);
        fondo.shutdown();
        super.onDestroy();
    }

    private boolean viva() {
        return lista && !isFinishing() && !isDestroyed();
    }

    /* ------------------------------------------------------------ */
    /* Comunicación con el servidor                                  */
    /* ------------------------------------------------------------ */

    private void refrescar() {
        final Context app = getApplicationContext();
        fondo.execute(() -> {
            try {
                JSONObject d = Api.estado(app);
                principal.post(() -> recibido(d));
            } catch (Api.Fallo f) {
                principal.post(() -> fallo(f, false));
            }
        });
    }

    private void recibido(JSONObject d) {
        sesion.guardarEstado(d);
        Recordatorios.programar(this);
        if (!viva()) return;
        pintar(d);
        sincronizarServicio();
    }

    private void fallo(Api.Fallo f, boolean avisar) {
        if (!viva()) return;
        if (f.acceso) {
            cerrarSesion();
            Toast.makeText(this, f.getMessage(), Toast.LENGTH_LONG).show();
            irAlAcceso();
            return;
        }
        if (avisar) Toast.makeText(this, f.getMessage(), Toast.LENGTH_LONG).show();
        else progreso(f.getMessage());
    }

    private void fichar(final String tipo) {
        if (ocupado) return;
        if (!Permisos.ubicacion(this)) {
            pedirPermisos(true);
            return;
        }
        ocupado = true;
        habilitar(false);
        progreso("Obteniendo ubicación…");
        final Context app = getApplicationContext();
        UbicacionPuntual.pedir(this, ESPERA_UBICACION_MS, posicion -> {
            if (!viva()) return;
            progreso("Registrando fichaje…");
            final JSONObject pos = posicionJson(posicion);
            fondo.execute(() -> {
                try {
                    JSONObject d = Api.fichar(app, tipo, pos);
                    principal.post(() -> {
                        ocupado = false;
                        recibido(d);
                        if (!viva()) return;
                        progreso(null);
                        habilitar(true);
                        Toast.makeText(this, "Fichaje registrado.", Toast.LENGTH_SHORT).show();
                    });
                    // Lo acumulado hasta este fichaje se envía ya (al parar o pausar deja de enviarlo el servicio).
                    try {
                        Envio.enviarPendientes(app);
                    } catch (Api.Fallo ignorado) {
                        // La próxima consulta de estado detectará la sesión caducada.
                    }
                } catch (Api.Fallo f) {
                    principal.post(() -> {
                        ocupado = false;
                        if (!viva()) return;
                        progreso(null);
                        habilitar(true);
                        fallo(f, true);
                    });
                }
            });
        });
    }

    private static JSONObject posicionJson(Location l) {
        if (l == null) return null;
        try {
            return new JSONObject()
                    .put("lat", l.getLatitude())
                    .put("lng", l.getLongitude())
                    .put("prec", l.hasAccuracy() ? Math.round(l.getAccuracy()) : 0);
        } catch (JSONException ex) {
            return null;
        }
    }

    /** Arranca o detiene el registro de ubicación según el estado de la jornada. */
    private void sincronizarServicio() {
        boolean debe = sesion.debeRegistrar(sesion.estadoActual()) && Permisos.ubicacion(this);
        if (debe && !UbicacionService.enMarcha) {
            try {
                UbicacionService.iniciar(this);
            } catch (RuntimeException ex) {
                // Android no lo permite en este momento; se reintenta al volver a la app.
            }
        } else if (!debe && UbicacionService.enMarcha) {
            UbicacionService.detener(this);
        }
    }

    /* ------------------------------------------------------------ */
    /* Sesión                                                        */
    /* ------------------------------------------------------------ */

    private void confirmarSalida() {
        boolean enJornada = !"FUERA".equals(sesion.estadoActual());
        new AlertDialog.Builder(this)
                .setTitle("Cerrar sesión")
                .setMessage((enJornada
                        ? "Tu jornada sigue abierta. Si cierras sesión se detiene el registro de ubicación y dejarás de recibir avisos."
                        : "Si cierras sesión dejarás de recibir los avisos de la hora de fichar.")
                        + "\n\nPara salir de la app no hace falta cerrar sesión: basta con volver a la pantalla de inicio del móvil.")
                .setPositiveButton("Cerrar sesión", (dialogo, cual) -> {
                    cerrarSesion();
                    irAlAcceso();
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    private void cerrarSesion() {
        UbicacionService.detener(this);
        sesion.cerrar();
        ColaUbicaciones.de(this).vaciar();
        Recordatorios.programar(this);
    }

    private void irAlAcceso() {
        startActivity(new Intent(this, LoginActivity.class));
        finish();
    }

    /** Programa un aviso de prueba para comprobar que el móvil los entrega con la app cerrada. */
    private void probarAviso() {
        if (!Permisos.notificaciones(this)) {
            pedirPermisos(true);
            return;
        }
        Recordatorios.probar(this);
        Toast.makeText(this, "En un minuto llegará un aviso de prueba. Vuelve a la pantalla de inicio del móvil"
                + " (sin cerrar sesión) para comprobar que llega con la app cerrada.", Toast.LENGTH_LONG).show();
    }

    /* ------------------------------------------------------------ */
    /* Pintado                                                       */
    /* ------------------------------------------------------------ */

    private void pintar(JSONObject e) {
        estado = e;
        String est = e != null ? e.optString("estado", "FUERA") : "FUERA";

        JSONObject usuario = e != null ? e.optJSONObject("usuario") : null;
        String nombre = usuario != null ? usuario.optString("nombre", "") : "";
        txtSaludo.setText(saludo() + (nombre.isEmpty() ? "" : ", " + nombre.split(" ")[0]));
        String fecha = new SimpleDateFormat("EEEE, d 'de' MMMM", new Locale("es", "ES")).format(new Date());
        txtFecha.setText(fecha.substring(0, 1).toUpperCase(new Locale("es", "ES")) + fecha.substring(1));

        if ("TRABAJANDO".equals(est)) pastilla("Trabajando", R.color.verde, R.color.verde_tinte);
        else if ("EN_PAUSA".equals(est)) pastilla("En pausa", R.color.ambar, R.color.ambar_tinte);
        else pastilla("Fuera de jornada", R.color.gris, R.color.gris_tinte);

        if ("TRABAJANDO".equals(est)) {
            accionPrincipal = "SALIDA";
            accionSecundaria = "PAUSA_INICIO";
            btnPrincipal.setText("Fichar salida");
            btnPrincipal.setBackgroundResource(R.drawable.btn_rosa);
            btnSecundario.setVisibility(View.VISIBLE);
        } else if ("EN_PAUSA".equals(est)) {
            accionPrincipal = "PAUSA_FIN";
            btnPrincipal.setText("Volver al trabajo");
            btnPrincipal.setBackgroundResource(R.drawable.btn_primario);
            btnSecundario.setVisibility(View.GONE);
        } else {
            accionPrincipal = "ENTRADA";
            btnPrincipal.setText("Fichar entrada");
            btnPrincipal.setBackgroundResource(R.drawable.btn_verde);
            btnSecundario.setVisibility(View.GONE);
        }
        habilitar(!ocupado);

        // Fichajes de la jornada
        listaHoy.removeAllViews();
        JSONArray fichajes = e != null ? e.optJSONArray("fichajes") : null;
        String primeraEntrada = "—";
        int total = fichajes != null ? fichajes.length() : 0;
        for (int i = 0; i < total; i++) {
            JSONObject f = fichajes.optJSONObject(i);
            if (f == null) continue;
            String tipo = f.optString("tipo", "");
            if ("ENTRADA".equals(tipo) && "—".equals(primeraEntrada)) primeraEntrada = f.optString("hora", "—");
            listaHoy.addView(filaFichaje(f, tipo));
        }
        if (total == 0) {
            TextView vacio = texto("Todavía no has fichado hoy.", 14, R.color.suave, false);
            vacio.setPadding(0, dp(8), 0, 0);
            listaHoy.addView(vacio);
        }
        txtEntrada.setText(primeraEntrada);

        String entrada = sesion.horaEntrada();
        String salida = sesion.horaSalida();
        txtHorario.setText(entrada.isEmpty() && salida.isEmpty()
                ? "Sin horario asignado. Cuando el administrador lo fije, llegará a este móvil en unos minutos."
                : "Horario: " + (entrada.isEmpty() ? "--:--" : entrada) + " – " + (salida.isEmpty() ? "--:--" : salida)
                + ". " + proximoAviso(entrada));

        txtAviso.setText("TRABAJANDO".equals(est)
                ? "Mientras dure la jornada se registra tu ubicación cada " + sesion.segundosUbicacion()
                + " segundos, también con el móvil bloqueado. Lo indica el aviso permanente de la barra de notificaciones."
                : "Al fichar se registra tu ubicación. Durante la jornada se guarda además cada "
                + sesion.segundosUbicacion() + " segundos, hasta que fiches la salida.");

        pintarReloj();
    }

    /** Texto con el momento del próximo aviso de entrada, para poder comprobar que está programado. */
    private String proximoAviso(String entrada) {
        long ahora = System.currentTimeMillis() + sesion.desfase();
        long proximo = Recordatorios.proxima(entrada, sesion.dias(), sesion.zona(), ahora + 60_000L);
        if (proximo < 0) return "Sin aviso de entrada programado.";
        SimpleDateFormat formato = new SimpleDateFormat("EEEE d 'a las' HH:mm", new Locale("es", "ES"));
        formato.setTimeZone(TimeZone.getTimeZone(sesion.zona()));
        return "Próximo aviso de entrada: " + formato.format(new Date(proximo)) + ", si para entonces no has fichado.";
    }

    private void pintarReloj() {
        if (!lista) return;
        JSONObject e = estado;
        long trabajo = 0L;
        long pausa = 0L;
        if (e != null) {
            long ahora = System.currentTimeMillis() + sesion.desfase();
            String est = e.optString("estado", "FUERA");
            trabajo = e.optLong("trabajoMs", 0L);
            pausa = e.optLong("pausaMs", 0L);
            if ("TRABAJANDO".equals(est) && !e.isNull("enCursoDesde")) trabajo += ahora - e.optLong("enCursoDesde", ahora);
            if ("EN_PAUSA".equals(est) && !e.isNull("pausaDesde")) pausa += ahora - e.optLong("pausaDesde", ahora);
        }
        long s = Math.max(0L, trabajo / 1000L);
        txtReloj.setText(String.format(Locale.ROOT, "%d:%02d:%02d", s / 3600L, (s % 3600L) / 60L, s % 60L));
        txtPausas.setText(Math.max(0L, Math.round(pausa / 60000.0)) + " min");

        if (!UbicacionService.enMarcha) {
            txtSeguimiento.setText("Parada");
            txtSeguimiento.setTextColor(getColor(R.color.gris));
        } else if (System.currentTimeMillis() - UbicacionService.ultimoPunto < 3L * sesion.segundosUbicacion() * 1000L) {
            txtSeguimiento.setText("Activa");
            txtSeguimiento.setTextColor(getColor(R.color.verde));
        } else {
            txtSeguimiento.setText("Sin señal");
            txtSeguimiento.setTextColor(getColor(R.color.ambar));
        }
    }

    private View filaFichaje(JSONObject f, String tipo) {
        LinearLayout fila = new LinearLayout(this);
        fila.setOrientation(LinearLayout.HORIZONTAL);
        fila.setGravity(Gravity.CENTER_VERTICAL);
        fila.setPadding(0, dp(9), 0, dp(9));

        int color = "ENTRADA".equals(tipo) ? R.color.verde
                : "PAUSA_INICIO".equals(tipo) ? R.color.ambar
                : "PAUSA_FIN".equals(tipo) ? R.color.marca : R.color.rosa;
        View punto = new View(this);
        punto.setBackground(redondeado(getColor(color), dp(5)));
        LinearLayout.LayoutParams lpPunto = new LinearLayout.LayoutParams(dp(10), dp(10));
        lpPunto.setMarginEnd(dp(12));
        fila.addView(punto, lpPunto);

        TextView hora = texto(f.optString("hora", ""), 16, R.color.tinta, true);
        hora.setFontFeatureSettings("tnum");
        LinearLayout.LayoutParams lpHora = new LinearLayout.LayoutParams(dp(58), LinearLayout.LayoutParams.WRAP_CONTENT);
        fila.addView(hora, lpHora);

        TextView etiqueta = texto(f.optString("etiqueta", tipo), 16, R.color.tinta, false);
        fila.addView(etiqueta, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        if ("ADMIN".equals(f.optString("origen", ""))) {
            TextView corregido = texto("Corregido", 12, R.color.marca, true);
            corregido.setBackground(redondeado(getColor(R.color.marca_tinte), dp(999)));
            corregido.setPadding(dp(8), dp(2), dp(8), dp(2));
            fila.addView(corregido);
        }
        return fila;
    }

    private void pastilla(String textoEstado, int color, int fondoColor) {
        txtEstado.setText("●  " + textoEstado);
        txtEstado.setTextColor(getColor(color));
        txtEstado.setBackground(redondeado(getColor(fondoColor), dp(999)));
    }

    private void habilitar(boolean si) {
        btnPrincipal.setEnabled(si);
        btnSecundario.setEnabled(si);
        btnPrincipal.setAlpha(si ? 1f : 0.5f);
        btnSecundario.setAlpha(si ? 1f : 0.5f);
    }

    private void progreso(String mensaje) {
        txtProgreso.setVisibility(mensaje == null ? View.GONE : View.VISIBLE);
        txtProgreso.setText(mensaje == null ? "" : mensaje);
    }

    private static String saludo() {
        int h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        return h < 6 ? "Buenas noches" : h < 14 ? "Buenos días" : h < 21 ? "Buenas tardes" : "Buenas noches";
    }

    private TextView texto(String contenido, int sp, int color, boolean negrita) {
        TextView t = new TextView(this);
        t.setText(contenido);
        t.setTextSize(sp);
        t.setTextColor(getColor(color));
        if (negrita) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private static GradientDrawable redondeado(int color, int radio) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(radio);
        return g;
    }

    private int dp(int valor) {
        return Math.round(valor * getResources().getDisplayMetrics().density);
    }

    /* ------------------------------------------------------------ */
    /* Permisos y ajustes del móvil                                  */
    /* ------------------------------------------------------------ */

    private void pedirPermisosIniciales() {
        if (permisosPedidos) return;
        pedirPermisos(false);
    }

    /** Pide los permisos que falten. Si Android ya no muestra el diálogo, abre los ajustes de la app. */
    private void pedirPermisos(boolean insistir) {
        List<String> faltan = new ArrayList<>();
        if (!Permisos.ubicacionPrecisa(this)) {
            faltan.add(Manifest.permission.ACCESS_FINE_LOCATION);
            faltan.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (!Permisos.notificaciones(this)) faltan.add(Manifest.permission.POST_NOTIFICATIONS);
        if (faltan.isEmpty()) return;

        boolean yaPedidos = permisosPedidos;
        permisosPedidos = true;
        if (insistir && yaPedidos && !shouldShowRequestPermissionRationale(faltan.get(0))) {
            abrirAjustesDeLaApp();
            return;
        }
        requestPermissions(faltan.toArray(new String[0]), PETICION_PERMISOS);
    }

    @Override
    public void onRequestPermissionsResult(int peticion, String[] permisos, int[] resultados) {
        super.onRequestPermissionsResult(peticion, permisos, resultados);
        if (!viva()) return;
        pintarAvisos();
        sincronizarServicio();
    }

    /** Avisos de lo que impide que el fichaje, el registro o las notificaciones funcionen. */
    private void pintarAvisos() {
        cajaAvisos.removeAllViews();
        if (!Permisos.ubicacion(this)) {
            aviso("Falta el permiso de ubicación. Sin él no se puede fichar.", "Permitir", v -> pedirPermisos(true));
        } else if (!Permisos.ubicacionPrecisa(this)) {
            aviso("La ubicación está en modo aproximado. Actívala como precisa para registrar bien el recorrido.",
                    "Ajustes", v -> abrirAjustesDeLaApp());
        }
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 28 && !lm.isLocationEnabled()) {
            aviso("La ubicación del móvil está apagada.", "Activar",
                    v -> abrir(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)));
        }
        if (!Permisos.notificaciones(this)) {
            aviso("Las notificaciones están desactivadas: no recibirás el aviso de la hora de fichar.",
                    "Permitir", v -> pedirPermisos(true));
        }
        if (Permisos.marcaRestrictiva() && !sesion.inicioAutomaticoRevisado()) {
            aviso("En este móvil hay que permitir el inicio automático de Fichajes. Si no, el sistema anula los avisos"
                    + " de la hora de fichar al cerrar la app.", "Ajustes", v -> abrirInicioAutomatico());
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (!pm.isIgnoringBatteryOptimizations(getPackageName())) {
            aviso("Para que el registro no se corte con el móvil bloqueado, deja esta app sin restricciones de batería.",
                    "Ajustes", v -> abrir(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)));
        }
    }

    private void aviso(String mensaje, String boton, View.OnClickListener alPulsar) {
        LinearLayout caja = new LinearLayout(this);
        caja.setOrientation(LinearLayout.HORIZONTAL);
        caja.setGravity(Gravity.CENTER_VERTICAL);
        caja.setBackground(redondeado(getColor(R.color.ambar_tinte), dp(16)));
        caja.setPadding(dp(14), dp(10), dp(10), dp(10));

        TextView t = texto(mensaje, 13, R.color.tinta, false);
        caja.addView(t, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView b = texto(boton, 13, R.color.ambar, true);
        b.setBackground(redondeado(getColor(R.color.tarjeta), dp(12)));
        b.setPadding(dp(12), dp(8), dp(12), dp(8));
        b.setOnClickListener(alPulsar);
        LinearLayout.LayoutParams lpBoton = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lpBoton.setMarginStart(dp(10));
        caja.addView(b, lpBoton);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        cajaAvisos.addView(caja, lp);
    }

    /**
     * Abre la pantalla de inicio automático del fabricante (Xiaomi, Oppo, Vivo,
     * Huawei...). Si el móvil no tiene ninguna de las conocidas, abre la ficha de la app.
     */
    private void abrirInicioAutomatico() {
        sesion.marcarInicioAutomaticoRevisado();
        String[][] pantallas = {
                {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                {"com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"},
                {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
                {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                {"com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"}
        };
        for (String[] pantalla : pantallas) {
            try {
                startActivity(new Intent().setComponent(new ComponentName(pantalla[0], pantalla[1])));
                return;
            } catch (ActivityNotFoundException | SecurityException ex) {
                // Esta pantalla no existe en este móvil: se prueba la siguiente.
            }
        }
        abrirAjustesDeLaApp();
    }

    private void abrirAjustesDeLaApp() {
        abrir(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null)));
    }

    private void abrir(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException ex) {
            Toast.makeText(this, "Abre los ajustes del móvil y busca la app Fichajes.", Toast.LENGTH_LONG).show();
        }
    }
}
