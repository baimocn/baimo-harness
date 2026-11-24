import { createRoot } from "react-dom/client";
import { App, type BaimoBridge } from "@baimo-harness/ui";
import "@baimo-harness/ui/styles.css";
/* 字体自托管（Fontsource，构建期打包、运行时零联网，合零遥测红线）：
 * Inter Variable 管 UI 文字，JetBrains Mono 管代码/diff/数字。 */
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";

declare global {
  interface Window {
    baimo: BaimoBridge;
  }
}

const el = document.getElementById("root");
if (!el) throw new Error("缺少 #root 挂载点");
createRoot(el).render(<App bridge={window.baimo} />);
