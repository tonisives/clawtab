import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { getModelCatalog, refreshModelCatalog, subscribeModelCatalog } from "../util/modelCatalog";

export function useModelCatalog() {
  let [catalog, setCatalog] = useState(getModelCatalog);
  useEffect(() => {
    let unsubscribe = subscribeModelCatalog(() => setCatalog(getModelCatalog()));
    setCatalog(getModelCatalog());
    void refreshModelCatalog();
    let interval = setInterval(() => { void refreshModelCatalog(); }, 6 * 60 * 60 * 1000);
    let foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshModelCatalog();
    });
    return () => { unsubscribe(); clearInterval(interval); foreground.remove(); };
  }, []);
  return catalog;
}
