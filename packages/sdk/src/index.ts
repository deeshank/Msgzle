export type CommandState = 'queued' | 'attempting' | 'dispatch-accepted' | 'uncertain' | 'cancelled';
export interface SendCommand { id: string; to: string; text: string; }
export interface Command extends SendCommand { state: CommandState; createdAt: number; }
export interface Health { version: string; role: 'mac' | 'relay'; connected: boolean; sendEnabled: boolean; receive: false; }
export class Msgzle {
  private readonly base: URL;
  constructor(private readonly options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.base = new URL(options.baseUrl);
    if (this.base.protocol !== 'https:' && !(['localhost','127.0.0.1','[::1]'].includes(this.base.hostname) && this.base.protocol === 'http:')) throw new Error('Use HTTPS, except for loopback development.');
    if (this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('Base URL cannot contain credentials, query or fragment.');
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.base), {...init, redirect:'error', headers: {...init.headers, authorization:`Bearer ${this.options.token}`, 'content-type':'application/json'}});
    if (!response.ok) throw new Error(`Msgzle HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  health(): Promise<Health> { return this.request('/v1/health'); }
  send(command: SendCommand): Promise<Command> { return this.request('/v1/commands', {method:'POST',body:JSON.stringify(command)}); }
  command(id: string): Promise<Command> { return this.request(`/v1/commands/${encodeURIComponent(id)}`); }
  cancel(id: string): Promise<Command> { return this.request(`/v1/commands/${encodeURIComponent(id)}/cancel`,{method:'POST',body:'{}'}); }
}
