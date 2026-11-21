import { createRoot } from "react-dom/client";
import { App, type BaimoBridge } from "@baimo-harness/ui";
import "@baimo-harness/ui/styles.css";

declare global {
  interface Window {
    baimo: BaimoBridge;
  }
}

const el = document.getElementById("root");
if (!el) throw new Error("缺少 #root 挂载点");
createRoot(el).render(<App bridge={window.baimo} />);
