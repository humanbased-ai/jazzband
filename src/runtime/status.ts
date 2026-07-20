import { createServer, type Server } from "node:http";

export interface StatusEvent {
  ts: string;
  text: string;
}

export interface StatusSnapshot {
  startedAt: string;
  project: string;
  mode: string;
  ticks: number;
  lastTickAt: string | null;
  events: StatusEvent[];
}

/** In-memory status the watch/run loop updates and the HTTP endpoint serves (SPEC §13). */
export class StatusStore {
  readonly startedAt: string;
  readonly project: string;
  readonly mode: string;
  private ticks = 0;
  private lastTickAt: string | null = null;
  private readonly events: StatusEvent[] = [];
  private readonly cap: number;

  constructor(options: { startedAt: string; project: string; mode: string; cap?: number }) {
    this.startedAt = options.startedAt;
    this.project = options.project;
    this.mode = options.mode;
    this.cap = options.cap ?? 100;
  }

  tick(now: string): void {
    this.ticks += 1;
    this.lastTickAt = now;
  }

  event(now: string, text: string): void {
    this.events.unshift({ ts: now, text });
    if (this.events.length > this.cap) this.events.length = this.cap;
  }

  snapshot(): StatusSnapshot {
    return {
      startedAt: this.startedAt,
      project: this.project,
      mode: this.mode,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      events: [...this.events],
    };
  }
}

function page(s: StatusSnapshot): string {
  const rows = s.events
    .map((e) => `<tr><td class="ts">${escape(e.ts)}</td><td>${escape(e.text)}</td></tr>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Jazzband — ${escape(s.project)}</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:0;background:#14151a;color:#ecebe6}
.wrap{max-width:920px;margin:0 auto;padding:32px 24px}h1{font-size:20px;margin:0 0 4px}
.meta{color:#a6a9b4;font-size:13px;margin-bottom:20px}.k{color:#d7a44e}
table{width:100%;border-collapse:collapse;font:12.5px ui-monospace,Menlo,monospace}
td{padding:6px 10px;border-bottom:1px solid #2b2d36;vertical-align:top}
.ts{color:#767a86;white-space:nowrap;width:1%}</style>
<div class="wrap"><h1>🎺 Jazzband</h1>
<div class="meta">project <span class="k">${escape(s.project)}</span> · mode <span class="k">${escape(s.mode)}</span>
· ticks <span class="k">${s.ticks}</span> · last tick <span class="k">${escape(s.lastTickAt ?? "—")}</span>
· started ${escape(s.startedAt)} · <a style="color:#7fb2f0" href="/status">/status</a></div>
<table>${rows || '<tr><td colspan="2">no events yet</td></tr>'}</table></div>`;
}

function escape(v: string): string {
  return v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Serve the status as JSON at /status and a small HTML page at / (loopback). */
export function serveStatus(store: StatusStore, port: number): Server {
  const server = createServer((req, res) => {
    const snap = store.snapshot();
    if ((req.url ?? "/").startsWith("/status")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snap, null, 2));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(snap));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
