-keepclassmembers class com.paperjournal.app.DavBridge {
    public *;
}
-keep class okhttp3.** { *; }
-dontwarn okhttp3.**
-dontwarn okio.**
