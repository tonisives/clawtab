import React from "react";
import ReactDOM from "react-dom/client";
import { DebugPanel } from "./components/DebugPanel";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <DebugPanel />
  </React.StrictMode>,
);
