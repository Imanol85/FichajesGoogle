package com.fichajes.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.Locale;

/** Comprobación de los permisos que necesita la app. */
final class Permisos {

    private Permisos() {
    }

    /** Ubicación precisa o, al menos, aproximada. */
    static boolean ubicacion(Context c) {
        return ubicacionPrecisa(c)
                || c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean ubicacionPrecisa(Context c) {
        return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Marcas cuyo sistema anula las alarmas y el trabajo en segundo plano de una
     * app al cerrarla, salvo que tenga permitido el inicio automático.
     */
    static boolean marcaRestrictiva() {
        String marca = String.valueOf(Build.MANUFACTURER).toLowerCase(Locale.ROOT);
        for (String m : new String[]{"xiaomi", "redmi", "poco", "huawei", "honor", "oppo", "realme", "oneplus", "vivo"}) {
            if (marca.contains(m)) return true;
        }
        return false;
    }

    /** Desde Android 13 las notificaciones requieren permiso. */
    static boolean notificaciones(Context c) {
        return Build.VERSION.SDK_INT < 33
                || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }
}
