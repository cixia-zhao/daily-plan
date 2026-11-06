/* 只自动重试只读连接检查；写入操作始终由用户确认后发出。 */
class AppNetworkRecovery {
  constructor({probe, recovered, status=()=>{}}) {
    this.probe = probe; this.recovered = recovered; this.status = status;
    this.delays = [1000,2000,5000,10000,30000];
    this.active = false; this.pending = false; this.attempt = 0; this.timer = null;
    this.resume = () => { if (this.active && !document.hidden) this.check(); };
    window.addEventListener('online', this.resume);
    window.addEventListener('focus', this.resume);
    window.addEventListener('pageshow', this.resume);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearTimeout(this.timer); this.timer = null; }
      else this.resume();
    });
    window.addEventListener('pagehide', () => { clearTimeout(this.timer); this.timer = null; });
  }
  start() { this.active = true; return this.check(); }
  async check() {
    if (!this.active || this.pending || document.hidden) return;
    clearTimeout(this.timer); this.timer = null;
    this.pending = true; this.status('checking');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let success = false, result;
    try { result = await this.probe(controller.signal); success = true; }
    catch { /* 网络暂时不可用，保留原页面并按退避间隔重试。 */ }
    finally { clearTimeout(timeout); this.pending = false; }
    if (success) {
      this.active = false; this.attempt = 0; this.status('connected'); this.recovered(result);
    } else {
      const delay = this.delays[Math.min(this.attempt++, this.delays.length - 1)];
      this.status('waiting', delay);
      if (!document.hidden) this.timer = setTimeout(() => this.check(), delay);
    }
  }
}
