export function captureBrowserClient() {
  const resources = performance
    .getEntriesByType('resource')
    .map((r) => r.name)
    .reverse();
  const url =
    resources.find((s) => s.includes('/aweme/v1/web/familiar/recommend/feed/')) ??
    resources.find((s) => s.includes('/aweme/v1/web/user/profile/self/'));
  const source = url ? new URL(url).searchParams : new URLSearchParams();
  const keys = [
    'channel',
    'pc_client_type',
    'pc_libra_divert',
    'update_version_code',
    'support_h265',
    'support_dash',
    'version_code',
    'version_name',
    'cookie_enabled',
    'screen_width',
    'screen_height',
    'browser_language',
    'browser_platform',
    'browser_name',
    'browser_version',
    'browser_online',
    'engine_name',
    'engine_version',
    'os_name',
    'os_version',
    'cpu_core_num',
    'device_memory',
    'platform',
    'downlink',
    'effective_type',
    'round_trip_time',
    'webid',
  ];
  return {
    // Wrangler replaces bare navigator.userAgent with its Worker UA at build time.
    // This function is serialized and executed inside Chromium.
    userAgent: window.navigator.userAgent,
    platform: navigator.platform,
    geo: [
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      screen.availWidth,
      screen.availHeight,
      screen.width,
      screen.height,
    ],
    query: Object.fromEntries(keys.filter((k) => source.has(k)).map((k) => [k, source.get(k)!])),
  };
}
