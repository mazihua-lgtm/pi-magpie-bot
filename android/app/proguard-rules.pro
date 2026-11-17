# commons-compress looks some of its optional codecs up by name; none are used,
# so they only need to stop being warnings.
-dontwarn org.apache.commons.compress.**
-dontwarn org.brotli.**
-dontwarn org.tukaani.**
-dontwarn com.github.luben.zstd.**
-dontwarn org.objectweb.asm.**
-dontwarn org.osgi.**
