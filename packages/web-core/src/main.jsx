import { mountPortal } from "./mount.jsx";

// The combined app (every portal in one build), kept so the existing single-service deployment still works.
mountPortal({ target: "all" });
