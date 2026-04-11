import React from "react";
import ReactDOM from "react-dom/client";
import { PtyDebugPanel } from "./components/PtyDebugPanel";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <PtyDebugPanel />
  </React.StrictMode>,
);
