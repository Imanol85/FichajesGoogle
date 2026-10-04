package com.fichajes.app;

import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.util.ArrayList;
import java.util.List;

/**
 * Obtiene una posición para acompañar a un fichaje: usa la última conocida
 * si es muy reciente y, si no, espera unos segundos a una lectura nueva.
 * Debe llamarse desde el hilo principal; el resultado llega al mismo hilo.
 */
final class UbicacionPuntual implements LocationListener {

    interface Resultado {
        /** Posición obtenida, o null si no ha sido posible. */
        void listo(Location posicion);
    }

    private static final long RECIENTE_NS = 30L * 1_000_000_000L;
    private static final long ACEPTABLE_NS = 5L * 60L * 1_000_000_000L;

    private final LocationManager lm;
    private final Handler principal = new Handler(Looper.getMainLooper());
    private final Resultado resultado;
    private boolean terminado;

    private UbicacionPuntual(LocationManager lm, Resultado resultado) {
        this.lm = lm;
        this.resultado = resultado;
    }

    static void pedir(Context c, long esperaMs, Resultado resultado) {
        if (!Permisos.ubicacion(c)) {
            resultado.listo(null);
            return;
        }
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        new UbicacionPuntual(lm, resultado).empezar(esperaMs);
    }

    /** Proveedores de ubicación disponibles en este móvil, del mejor al peor. */
    static List<String> proveedores(LocationManager lm) {
        List<String> todos = lm.getAllProviders();
        List<String> elegidos = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31 && todos.contains(LocationManager.FUSED_PROVIDER)) {
            elegidos.add(LocationManager.FUSED_PROVIDER);
        }
        if (todos.contains(LocationManager.GPS_PROVIDER)) elegidos.add(LocationManager.GPS_PROVIDER);
        if (todos.contains(LocationManager.NETWORK_PROVIDER)) elegidos.add(LocationManager.NETWORK_PROVIDER);
        return elegidos;
    }

    private void empezar(long esperaMs) {
        try {
            Location ultima = mejorConocida(RECIENTE_NS);
            if (ultima != null) {
                terminar(ultima);
                return;
            }
            for (String proveedor : proveedores(lm)) {
                lm.requestLocationUpdates(proveedor, 0L, 0f, this, Looper.getMainLooper());
            }
            principal.postDelayed(() -> terminar(mejorConocidaSegura()), esperaMs);
        } catch (SecurityException | IllegalArgumentException ex) {
            terminar(null);
        }
    }

    /** La lectura conocida más reciente, si no supera la antigüedad indicada. */
    private Location mejorConocida(long antiguedadMaximaNs) {
        Location mejor = null;
        long ahora = SystemClock.elapsedRealtimeNanos();
        for (String proveedor : proveedores(lm)) {
            Location l = lm.getLastKnownLocation(proveedor);
            if (l == null || ahora - l.getElapsedRealtimeNanos() > antiguedadMaximaNs) continue;
            if (mejor == null || l.getElapsedRealtimeNanos() > mejor.getElapsedRealtimeNanos()) mejor = l;
        }
        return mejor;
    }

    private Location mejorConocidaSegura() {
        try {
            return mejorConocida(ACEPTABLE_NS);
        } catch (SecurityException ex) {
            return null;
        }
    }

    private void terminar(Location posicion) {
        if (terminado) return;
        terminado = true;
        principal.removeCallbacksAndMessages(null);
        try {
            lm.removeUpdates(this);
        } catch (SecurityException ignorada) {
            // Sin permiso no había nada registrado.
        }
        resultado.listo(posicion);
    }

    @Override
    public void onLocationChanged(Location posicion) {
        terminar(posicion);
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
