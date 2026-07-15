import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.myplanee.agents",
  appName: "Planee Agent Hub",
  webDir: "apps/web/dist",
  server: {
    url: "https://agents.myplanee.com",
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
