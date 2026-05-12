import React from "react";
import ReactDOM from "react-dom/client";
import { TmuxDebugPanel } from "./components/TmuxDebugPanel";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <TmuxDebugPanel />
  </React.StrictMode>,
);
