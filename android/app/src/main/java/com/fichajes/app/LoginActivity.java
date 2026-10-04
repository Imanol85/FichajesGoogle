package com.fichajes.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Pantalla de acceso con usuario y contraseña. */
public class LoginActivity extends Activity {

    private final ExecutorService fondo = Executors.newSingleThreadExecutor();
    private final Handler principal = new Handler(Looper.getMainLooper());

    private Sesion sesion;
    private boolean pedirServidor;
    private EditText campoServidor;
    private EditText campoUsuario;
    private EditText campoClave;
    private Button btnEntrar;
    private TextView txtMensaje;

    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.activity_login);
        sesion = new Sesion(this);

        campoServidor = findViewById(R.id.campoServidor);
        campoUsuario = findViewById(R.id.campoUsuario);
        campoClave = findViewById(R.id.campoClave);
        btnEntrar = findViewById(R.id.btnEntrar);
        txtMensaje = findViewById(R.id.txtMensaje);

        // La dirección del servidor solo se pide si no se fijó al compilar la app.
        pedirServidor = BuildConfig.SERVIDOR_URL.isEmpty();
        int visible = pedirServidor ? View.VISIBLE : View.GONE;
        findViewById(R.id.etiquetaServidor).setVisibility(visible);
        campoServidor.setVisibility(visible);
        campoServidor.setText(sesion.servidor());

        btnEntrar.setOnClickListener(v -> entrar());
        campoClave.setOnEditorActionListener((v, accion, evento) -> {
            if (accion == EditorInfo.IME_ACTION_DONE) {
                entrar();
                return true;
            }
            return false;
        });
    }

    @Override
    protected void onDestroy() {
        fondo.shutdown();
        super.onDestroy();
    }

    private void entrar() {
        final String usuario = campoUsuario.getText().toString().trim();
        final String clave = campoClave.getText().toString();
        if (pedirServidor) {
            String url = campoServidor.getText().toString().trim();
            if (!url.startsWith("https://")) {
                mensaje("Escribe la dirección del servidor, la que empieza por https:// y termina en /exec.", true);
                return;
            }
            sesion.guardarServidor(url);
        }
        if (usuario.isEmpty() || clave.isEmpty()) {
            mensaje("Introduce usuario y contraseña.", true);
            return;
        }

        btnEntrar.setEnabled(false);
        mensaje("Comprobando…", false);
        final Context app = getApplicationContext();
        fondo.execute(() -> {
            try {
                JSONObject r = Api.login(app, usuario, clave);
                String token = r.optString("token", "");
                if (token.isEmpty()) throw new Api.Fallo("Respuesta inesperada del servidor.", false);
                sesion.abrir(token);
                try {
                    sesion.guardarEstado(Api.estado(app));
                } catch (Api.Fallo sinEstado) {
                    // La pantalla principal lo volverá a pedir.
                }
                principal.post(this::abrirPrincipal);
            } catch (Api.Fallo f) {
                principal.post(() -> {
                    btnEntrar.setEnabled(true);
                    mensaje(f.getMessage(), true);
                });
            }
        });
    }

    private void abrirPrincipal() {
        if (isFinishing() || isDestroyed()) return;
        Recordatorios.programar(this);
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private void mensaje(String texto, boolean error) {
        txtMensaje.setText(texto);
        txtMensaje.setTextColor(getColor(error ? R.color.rosa : R.color.suave));
    }
}
