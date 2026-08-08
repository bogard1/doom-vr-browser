// Status/log panel: WASM loading, WAD mounting, engine starting, errors.
export class StatusLog {
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  log(message: string): void {
    console.log("[doomvr]", message);
    const line = document.createElement("div");
    line.textContent = message;
    this.el.appendChild(line);
    this.el.scrollTop = this.el.scrollHeight;
  }

  error(message: string): void {
    console.error("[doomvr]", message);
    const line = document.createElement("div");
    line.className = "error";
    line.textContent = message;
    this.el.appendChild(line);
    this.el.scrollTop = this.el.scrollHeight;
  }
}
