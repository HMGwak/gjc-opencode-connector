package com.myplanee.agents;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SecureCredential")
public class SecureCredentialPlugin extends Plugin {
    private static final String PREFERENCES = "planee_secure_credential";
    private static final String CREDENTIAL = "credential";

    @PluginMethod
    public void get(PluginCall call) {
        String value = preferences().getString(CREDENTIAL, null);
        if (value == null) {
            call.resolve(new JSObject());
            return;
        }
        JSObject result = new JSObject();
        result.put(CREDENTIAL, value);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String credential = call.getString(CREDENTIAL);
        if (credential == null || credential.isEmpty()) {
            call.reject("A device credential is required");
            return;
        }
        preferences().edit().putString(CREDENTIAL, credential).apply();
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        preferences().edit().remove(CREDENTIAL).apply();
        call.resolve();
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

}
