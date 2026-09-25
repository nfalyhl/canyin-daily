package com.canyindaily.app;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

/**
 * 餐饮日报 Android 壳。
 *
 * 设计原则：页面是主体，原生只补三件网页做不到的事
 *   1. 外链跳系统浏览器（点「原文」不会被困在 App 里）
 *   2. 分享到微信/QQ（复制要点后拉起系统分享面板）
 *   3. 可选在线数据源（内置离线日报跑不动时，可切到自己的网址）
 */
public class MainActivity extends Activity {

    private static final String ASSET_URL = "file:///android_asset/index.html";
    private static final String PREFS = "canyin";
    private static final String KEY_REMOTE = "remote";
    private static final String FALLBACK_BG = "#f2f3f1";

    private WebView web;
    private SharedPreferences prefs;
    private boolean loadFailed = false;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(FALLBACK_BG));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        disableAlgorithmicDarkening(s);

        web.addJavascriptInterface(new Bridge(), "AppBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return openOutside(url);
            }

            @Override
            @TargetApi(21)
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return openOutside(req.getUrl().toString());
            }

            @Override
            @TargetApi(23)
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    fallbackToAsset(v);
                }
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                fallbackToAsset(v);
            }

            @Override
            @TargetApi(21)
            public void onReceivedHttpError(WebView v, WebResourceRequest req,
                                            WebResourceResponse res) {
                if (req.isForMainFrame()) {
                    fallbackToAsset(v);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView v, String url, String msg, final JsResult r) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setPositiveButton("知道了", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) { r.confirm(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            public void onCancel(DialogInterface d) { r.cancel(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView v, String url, String msg, String def,
                                      final JsPromptResult r) {
                final EditText input = new EditText(MainActivity.this);
                input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
                input.setText(def == null ? "" : def);
                input.setSelection(input.getText().length());
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(msg)
                        .setView(input)
                        .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                r.confirm(input.getText().toString());
                            }
                        })
                        .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) { r.cancel(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            public void onCancel(DialogInterface d) { r.cancel(); }
                        })
                        .show();
                return true;
            }
        });

        setContentView(web);
        load();
    }

    private static void disableAlgorithmicDarkening(WebSettings s) {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                s.setAlgorithmicDarkeningAllowed(false);
            } else if (Build.VERSION.SDK_INT >= 29) {
                s.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
        } catch (Throwable ignored) {
            // 老设备上没有这些方法，忽略即可
        }
    }

    private String remoteUrl() {
        String u = prefs.getString(KEY_REMOTE, "");
        if (u == null) {
            return "";
        }
        u = u.trim();
        return u;
    }

    private void load() {
        loadFailed = false;
        String remote = remoteUrl();
        if (remote.startsWith("http://") || remote.startsWith("https://")) {
            web.loadUrl(remote);
        } else {
            web.loadUrl(ASSET_URL);
        }
    }

    /** 远端打不开时退回内置离线版，保证 App 至少能看。 */
    private void fallbackToAsset(WebView v) {
        if (loadFailed || remoteUrl().isEmpty()) {
            return;
        }
        loadFailed = true;
        v.loadUrl(ASSET_URL);
    }

    /** 站外链接交给系统浏览器 / 微信打开。 */
    private boolean openOutside(String url) {
        if (url == null) {
            return false;
        }
        if (url.startsWith("file://") || url.startsWith("data:") || url.startsWith("about:")) {
            return false;   // 页面自身导航，交给 WebView
        }
        if (url.startsWith("http://") || url.startsWith("https://")
                || url.startsWith("mailto:") || url.startsWith("tel:")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
            return true;
        }
        return false;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** 暴露给页面 JS 的小接口（iOS 端注入同名对象，页面代码两端通用）。 */
    public class Bridge {

        @JavascriptInterface
        public boolean isApp() {
            return true;
        }

        @JavascriptInterface
        public String appVersion() {
            return "1.0";
        }

        @JavascriptInterface
        public String getRemote() {
            return remoteUrl();
        }

        @JavascriptInterface
        public void setRemote(String url) {
            prefs.edit().putString(KEY_REMOTE, url == null ? "" : url.trim()).apply();
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(new Runnable() {
                public void run() { load(); }
            });
        }

        @JavascriptInterface
        public void share(final String text) {
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_SEND);
                        i.setType("text/plain");
                        i.putExtra(Intent.EXTRA_SUBJECT, "餐饮日报");
                        i.putExtra(Intent.EXTRA_TEXT, text);
                        startActivity(Intent.createChooser(i, "分享今日要点"));
                    } catch (Exception e) {
                        // 没有可分享的应用时静默失败，文本已经复制到剪贴板了
                    }
                }
            });
        }

        @JavascriptInterface
        public void setStatusBarColor(final String hex) {
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        int c = Color.parseColor(hex);
                        Window w = getWindow();
                        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                        w.setStatusBarColor(c);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            View dv = w.getDecorView();
                            int flags = dv.getSystemUiVisibility();
                            double lum = 0.299 * Color.red(c) + 0.587 * Color.green(c)
                                    + 0.114 * Color.blue(c);
                            if (lum > 150) {
                                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                            } else {
                                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                            }
                            dv.setSystemUiVisibility(flags);
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
        }
    }
}
