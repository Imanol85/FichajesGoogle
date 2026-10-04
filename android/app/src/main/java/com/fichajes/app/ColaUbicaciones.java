package com.fichajes.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Cola en el móvil de los puntos de ubicación pendientes de enviar. Así no
 * se pierde el recorrido cuando falla la cobertura: se envían en cuanto vuelve.
 */
final class ColaUbicaciones extends SQLiteOpenHelper {

    /** Puntos listos para enviar y el identificador del último de ellos. */
    static final class Lote {
        final JSONArray puntos = new JSONArray();
        long ultimoId = -1;
    }

    private static ColaUbicaciones instancia;

    static synchronized ColaUbicaciones de(Context c) {
        if (instancia == null) instancia = new ColaUbicaciones(c.getApplicationContext());
        return instancia;
    }

    private ColaUbicaciones(Context c) {
        super(c, "ubicaciones.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE puntos (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,"
                + " lat REAL NOT NULL, lng REAL NOT NULL, prec REAL NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int anterior, int nueva) {
        db.execSQL("DROP TABLE IF EXISTS puntos");
        onCreate(db);
    }

    synchronized void anadir(long ts, double lat, double lng, float prec) {
        ContentValues v = new ContentValues();
        v.put("ts", ts);
        v.put("lat", lat);
        v.put("lng", lng);
        v.put("prec", prec);
        getWritableDatabase().insert("puntos", null, v);
    }

    /** Los puntos más antiguos de la cola, en orden. */
    synchronized Lote primeros(int maximo) {
        Lote lote = new Lote();
        try (Cursor cur = getReadableDatabase().rawQuery(
                "SELECT id, ts, lat, lng, prec FROM puntos ORDER BY id LIMIT " + maximo, null)) {
            while (cur.moveToNext()) {
                JSONObject p = new JSONObject();
                p.put("ts", cur.getLong(1));
                p.put("lat", cur.getDouble(2));
                p.put("lng", cur.getDouble(3));
                p.put("prec", Math.round(cur.getDouble(4)));
                lote.puntos.put(p);
                lote.ultimoId = cur.getLong(0);
            }
        } catch (JSONException ex) {
            throw new IllegalStateException(ex);
        }
        return lote;
    }

    synchronized void borrarHasta(long id) {
        getWritableDatabase().delete("puntos", "id <= ?", new String[]{String.valueOf(id)});
    }

    /** Descarta lo que lleva demasiado tiempo sin poder enviarse. */
    synchronized void descartarAnteriores(long ts) {
        getWritableDatabase().delete("puntos", "ts < ?", new String[]{String.valueOf(ts)});
    }

    synchronized void vaciar() {
        getWritableDatabase().delete("puntos", null, null);
    }

    synchronized int pendientes() {
        try (Cursor cur = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM puntos", null)) {
            return cur.moveToFirst() ? cur.getInt(0) : 0;
        }
    }
}
