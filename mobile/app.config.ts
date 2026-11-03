import type { ConfigPlugin } from "expo/config-plugins";
import { withInfoPlist } from "expo/config-plugins";
import type { ExpoConfig } from "expo/config";

/**
 * Young Edsplorer Team Leader app. Native settings that matter for live location:
 *   iOS     "Always" location permission + UIBackgroundModes = location (the system keeps delivering locations to the
 *           app in the background and shows the blue location indicator).
 *   Android ACCESS_BACKGROUND_LOCATION + a foreground service of type "location" with a persistent notification
 *           (Android only allows background location that way).
 * The API address is EXPO_PUBLIC_API_BASE_URL (build-time; not a secret). It must be https://, except a local
 * development server on the same Wi-Fi when ALLOW_LOCAL_HTTP=1 (development builds only; see MOBILE_APP.md).
 */
const allowLocalHttp = process.env.ALLOW_LOCAL_HTTP === "1";
const WHEN_IN_USE = "Your location is shared with parents of the trip you are leading, only while you have pressed Start.";
const ALWAYS = "To keep parents updated while your phone is locked or in your pocket, allow location \"Always\". Sharing only runs between Start and Stop.";

/**
 * iOS: exactly one background mode, "location". (expo-task-manager also adds "fetch", which this app never uses; App
 * Review asks about background modes an app doesn't need.) Runs last, after the other plugins.
 */
const withOnlyLocationBackgroundMode: ConfigPlugin = (cfg) =>
  withInfoPlist(cfg, (c) => {
    c.modResults.UIBackgroundModes = ["location"];
    return c;
  });

const config: ExpoConfig = {
  name: "YE Team Leader",
  slug: "young-edsplorer-team-leader",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "com.youngedsplorer.teamleader",
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: WHEN_IN_USE,
      NSLocationAlwaysAndWhenInUseUsageDescription: ALWAYS,
      UIBackgroundModes: ["location"],
      ITSAppUsesNonExemptEncryption: false,
      // https only; a development server on the local network is the single exception, and only when asked for
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: allowLocalHttp },
    },
  },
  android: {
    package: "com.youngedsplorer.teamleader",
    permissions: [
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
    ],
    // nothing the app doesn't need
    blockedPermissions: [
      "android.permission.RECORD_AUDIO", "android.permission.CAMERA", "android.permission.READ_CONTACTS", "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.VIBRATE",
    ],
    allowBackup: false, // nothing of this app goes into device backups
  },
  plugins: [
    [
      "expo-location",
      {
        locationWhenInUsePermission: WHEN_IN_USE,
        locationAlwaysAndWhenInUsePermission: ALWAYS,
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    "expo-secure-store",
    ["expo-build-properties", { android: { usesCleartextTraffic: allowLocalHttp } }],
  ],
};

export default withOnlyLocationBackgroundMode(config);
