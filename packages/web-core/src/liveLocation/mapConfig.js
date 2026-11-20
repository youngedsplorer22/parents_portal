// Which map tiles to draw. The default is the public OpenStreetMap tile server: free, but run by volunteers for light
// use only (https://operations.osmfoundation.org/policies/tiles/), so it is NOT unlimited production capacity. To move to
// another provider later (a paid plan, or your own tile server), set these at build time; no code changes:
//   VITE_MAP_TILE_URL          e.g. https://tiles.example.com/{z}/{x}/{y}.png
//   VITE_MAP_TILE_ATTRIBUTION  the credit that provider requires (HTML allowed: links only)
//   VITE_MAP_MAX_ZOOM          optional, default 19
const env = import.meta.env ?? {};
export const MAP_TILES = Object.freeze({
  url: env.VITE_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: env.VITE_MAP_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  maxZoom: Number(env.VITE_MAP_MAX_ZOOM) || 19,
});
