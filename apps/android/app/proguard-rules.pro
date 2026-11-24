-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# kotlinx.serialization
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class ai.youbrain.mobile.data.**$$serializer { *; }
-keepclassmembers class ai.youbrain.mobile.data.** {
    *** Companion;
}
-keepclasseswithmembers class ai.youbrain.mobile.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp & BouncyCastle optional platform annotations
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.bouncycastle.**
-dontwarn javax.naming.**
-dontwarn java.lang.invoke.**

# Keep WebView @JavascriptInterface bridge methods for WebRTC remote desktop
-keepclassmembers class ai.youbrain.mobile.ui.** {
    @android.webkit.JavascriptInterface <methods>;
}

