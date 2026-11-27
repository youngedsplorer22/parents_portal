import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import AppRoutes from "./AppRoutes.jsx";
import "./index.css";

/** Starts one portal. Every deployable frontend calls this with its own target; a public portal also passes its deployment (the school and trip it was customised for). */
export function mountPortal({ target = "all", deployment = null, rootId = "root" } = {}) {
  ReactDOM.createRoot(document.getElementById(rootId)).render(
    <React.StrictMode>
      <BrowserRouter>
        <AppRoutes target={target} deployment={deployment} />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
