package com.paperjournal.app;

import android.app.Activity;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;

/**
 * WebDAV 原生通道。
 * WebView 里直接 fetch 第三方 WebDAV 会被 CORS 拦死（PROPFIND/MKCOL 还会触发预检），
 * 所以在原生侧代发，前端拿到结果后走同一套同步逻辑。
 *
 * 前端约定：
 *   window.PJNative.request(id, method, url, headersJson, bodyBase64)
 *   → 完成后回调 window.__PJ_DAV(id, resultJson)
 *   resultJson = { status, headers:{...}, body:"base64" } 或 { error:"..." }
 */
public class DavBridge {

    private final Activity act;
    private final WebView web;
    private final OkHttpClient client;

    public DavBridge(Activity activity, WebView webView) {
        this.act = activity;
        this.web = webView;
        this.client = new OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(90, TimeUnit.SECONDS)
                .writeTimeout(90, TimeUnit.SECONDS)
                .followRedirects(true)
                .followSslRedirects(true)
                .retryOnConnectionFailure(true)
                .build();
    }

    @JavascriptInterface
    public String request(final String id, final String method, final String url,
                          final String headersJson, final String bodyBase64) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String out;
                try {
                    out = perform(method, url, headersJson, bodyBase64);
                } catch (Throwable t) {
                    String msg = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                    out = "{\"error\":" + JSONObject.quote(msg) + "}";
                }
                final String result = out;
                act.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (web == null) return;
                        String js = "window.__PJ_DAV(" + JSONObject.quote(id) + "," + JSONObject.quote(result) + ")";
                        web.evaluateJavascript(js, null);
                    }
                });
            }
        }).start();
        return "";
    }

    private String perform(String method, String url, String headersJson, String bodyBase64)
            throws Exception {

        JSONObject h;
        try {
            h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
        } catch (Exception e) {
            h = new JSONObject();
        }

        Request.Builder rb = new Request.Builder().url(url);
        for (Iterator<String> it = h.keys(); it.hasNext(); ) {
            String k = it.next();
            // 这几个由 OkHttp 自己管，重复设置会报错
            if ("content-length".equalsIgnoreCase(k)
                    || "host".equalsIgnoreCase(k)
                    || "connection".equalsIgnoreCase(k)) continue;
            rb.addHeader(k, h.optString(k, ""));
        }

        RequestBody body = null;
        if (bodyBase64 != null && bodyBase64.length() > 0) {
            final byte[] bytes = Base64.decode(bodyBase64, Base64.NO_WRAP);
            String ct = h.optString("Content-Type", "application/octet-stream");
            final MediaType mt = MediaType.parse(ct);
            body = new RequestBody() {
                @Override
                public MediaType contentType() {
                    return mt;
                }

                @Override
                public long contentLength() {
                    return bytes.length;
                }

                @Override
                public void writeTo(BufferedSink sink) throws IOException {
                    sink.write(bytes);
                }
            };
        }

        String m = method == null ? "GET" : method.toUpperCase();
        // GET/HEAD 不能带 body
        if ("GET".equals(m) || "HEAD".equals(m)) body = null;

        rb.method(m, body);

        Response resp = client.newCall(rb.build()).execute();
        try {
            byte[] data;
            ResponseBody rbody = resp.body();
            data = rbody != null ? rbody.bytes() : new byte[0];

            JSONObject out = new JSONObject();
            out.put("status", resp.code());

            JSONObject oh = new JSONObject();
            Headers hs = resp.headers();
            for (String name : hs.names()) {
                oh.put(name, hs.get(name));
            }
            out.put("headers", oh);
            out.put("body", data.length > 0 ? Base64.encodeToString(data, Base64.NO_WRAP) : "");
            return out.toString();
        } finally {
            resp.close();
        }
    }
}
