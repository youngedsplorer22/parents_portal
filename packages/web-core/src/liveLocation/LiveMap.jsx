import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_TILES } from "./mapConfig.js";

const START_ZOOM = 15; // streets and nearby place names

/**
 * An OpenStreetMap map (Leaflet) with the team lead's position: a marker, a circle for the reported accuracy, zoom
 * buttons, a "Recenter" button and the required attribution. It follows new positions until the viewer moves the map
 * themselves; Recenter brings it back. Only ever drawn with a real position from the server (never a guess).
 */
export default function LiveMap({ location, stale = false, label = "Team lead" }) {
  const box = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const circle = useRef(null);
  const follow = useRef(true);
  const latest = useRef(location);
  useEffect(() => {
    latest.current = location; // what Recenter goes back to
  }, [location]);

  // Create the map once.
  useEffect(() => {
    const m = L.map(box.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, tap: true });
    L.tileLayer(MAP_TILES.url, { maxZoom: MAP_TILES.maxZoom, attribution: MAP_TILES.attribution, crossOrigin: true }).addTo(m);
    m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    // the viewer moving the map pauses following (until Recenter)
    m.on("dragstart", () => (follow.current = false));
    m.on("zoomstart", (e) => {
      if (e?.originalEvent) follow.current = false;
    });
    const Recenter = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const button = L.DomUtil.create("button", "live-map-recenter");
        button.type = "button";
        button.title = "Recenter on the team lead";
        button.setAttribute("aria-label", "Recenter on the team lead");
        button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.on(button, "click", () => {
          follow.current = true;
          const l = latest.current;
          if (l) m.setView([l.latitude, l.longitude], Math.max(m.getZoom(), START_ZOOM));
        });
        return button;
      },
    });
    new Recenter().addTo(m);
    map.current = m;
    // keep the map drawn correctly when its box changes size (rotation, sidebar, window resize)
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => m.invalidateSize()) : null;
    ro?.observe(box.current);
    return () => {
      ro?.disconnect();
      m.remove();
      map.current = null;
      marker.current = null;
      circle.current = null;
    };
  }, []);

  // Place or move the marker for each new position.
  useEffect(() => {
    const m = map.current;
    if (!m || !location) return;
    const at = [location.latitude, location.longitude];
    const icon = L.divIcon({
      className: "",
      html: `<span class="live-map-marker ${stale ? "is-stale" : ""}" aria-hidden="true"><span class="live-map-pulse"></span><span class="live-map-dot"></span></span>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });
    if (!marker.current) {
      marker.current = L.marker(at, { icon, keyboard: false, title: label, alt: label }).addTo(m);
      // a permanent name tag, so the marker is easy to find among the map's own symbols
      marker.current.bindTooltip(label, { permanent: true, direction: "top", offset: [0, -16], className: "live-map-label" });
      m.setView(at, START_ZOOM);
    } else {
      marker.current.setLatLng(at).setIcon(icon);
      if (follow.current) m.panTo(at);
    }
    const radius = location.accuracyM;
    if (radius && radius > 0) {
      if (!circle.current) circle.current = L.circle(at, { radius, color: "#2364e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(m);
      else circle.current.setLatLng(at).setRadius(radius);
    } else if (circle.current) {
      circle.current.remove();
      circle.current = null;
    }
  }, [location, stale, label]);

  return <div ref={box} className="live-map" role="region" aria-label="Map of the team lead's last shared location" />;
}
