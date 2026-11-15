export class AudioBus {
  private ctx: AudioContext | null = null;
  muted = false;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.muted) void this.ctx?.suspend();
    else void this.ensure();
    return this.muted;
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain = 0.05, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  cash(): void {
    this.tone(880, 0.08, "triangle", 0.04);
    this.tone(1320, 0.12, "triangle", 0.035, 0.06);
  }

  build(): void {
    this.tone(220, 0.1, "square", 0.03);
    this.tone(330, 0.16, "sine", 0.04, 0.04);
  }

  error(): void {
    this.tone(140, 0.16, "sawtooth", 0.03);
  }

  click(): void {
    this.tone(520, 0.04, "square", 0.02);
  }
}
