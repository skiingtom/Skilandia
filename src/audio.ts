/** Live mix snapshot the frame loop feeds every tick. */
export type AmbientState = {
  camDist: number;
  lookX: number;
  lookY: number;
  /** 0 clear … 1 overcast. */
  cover: number;
  /** 0 calm … 1 strong. */
  wind: number;
  /** 0 none … 1 heavy snow. */
  snow: number;
  /** 0 idle … 1 busy parking / highway traffic. */
  carBusy: number;
  /** Map-space distance from the look-at to the nearest driven road point. */
  carDist: number;
  lifts: Array<{ x: number; y: number; type: string }>;
  heli: { x: number; y: number; active: boolean } | null;
  shaping: boolean;
  paused: boolean;
  /** Title screen / before Play — keep music soft, ambience off. */
  active: boolean;
};

type LoopLayer = {
  gain: GainNode;
  nodes: AudioNode[];
  stop: () => void;
};

/** 1 at/near `near`, 0 at/after `far`. */
function falloff(dist: number, near: number, far: number): number {
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  return 1 - (dist - near) / (far - near);
}

/**
 * Procedural game audio: soft alpine music, zoom-aware ambience (wind, cars,
 * lift motors, heli), weather-shaped mix, and one-shot UI / build cues.
 */
export class AudioBus {
  muted = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private ambientBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  private music: LoopLayer | null = null;
  private wind: LoopLayer | null = null;
  private snow: LoopLayer | null = null;
  private cars: LoopLayer | null = null;
  private lift: LoopLayer | null = null;
  private heli: LoopLayer | null = null;
  private dig: LoopLayer | null = null;

  private windFilter: BiquadFilterNode | null = null;
  private windLfo: OscillatorNode | null = null;
  private windLfoGain: GainNode | null = null;

  private musicGain = 0;
  private windGain = 0;
  private snowGain = 0;
  private carGain = 0;
  private liftGain = 0;
  private heliGain = 0;
  private digGain = 0;

  private carWhooshT = 0;
  private liftTickT = 0;
  private gustT = 0;
  private arpT = 0;
  private musicNote = 0;
  private started = false;
  private lastShapePulse = 0;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(this.ctx.destination);
      this.musicFilter = this.ctx.createBiquadFilter();
      this.musicFilter.type = "lowpass";
      this.musicFilter.frequency.value = 5000;
      this.musicFilter.Q.value = 0.7;
      this.musicFilter.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 1;
      this.musicBus.connect(this.musicFilter);
      this.ambientBus = this.ctx.createGain();
      this.ambientBus.gain.value = 1;
      this.ambientBus.connect(this.master);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 1;
      this.sfxBus.connect(this.master);
      this.noiseBuf = this.makeNoise(this.ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.muted) {
      void this.ctx?.suspend();
      this.teardownLoops();
    } else {
      void this.ensure();
    }
    return this.muted;
  }

  /** Call once after the first user gesture so the context can run. */
  unlock(): void {
    void this.ensure();
  }

  /**
   * Drive continuous music + ambience from camera zoom and what's under the
   * look-at. Safe to call every frame; gains glide so layers don't click.
   */
  update(dt: number, s: AmbientState): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.ambientBus || !this.musicBus) return;

    if (!this.started && s.active) {
      this.started = true;
      this.startMusic();
      this.startWind();
      this.startSnow();
      this.startCars();
      this.startLift();
      this.startHeli();
      this.startDig();
    }
    if (!this.started) return;

    const t = ctx.currentTime;
    const close = falloff(s.camDist, 120, 900);
    const mid = falloff(s.camDist, 400, 3500);
    const overview = falloff(s.camDist, 2500, 14000);
    const hush = s.paused ? 0.35 : 1;

    // Weather mix: storms bury the resort bed under wind and hush the village.
    const storm = Math.max(s.snow, s.cover * 0.55 + s.wind * 0.35);
    const gale = Math.max(s.wind, s.snow * 0.7);
    const clear = 1 - storm;
    const muffler = 1 - storm * 0.72;

    // Soft music: brighter on clear days, darker and quieter in storms.
    const musicTarget =
      (s.active ? (0.045 + overview * 0.035 + mid * 0.02) * (1 - close * 0.35) : 0.03) *
      (0.55 + clear * 0.45) *
      hush;
    this.musicGain = this.glide(this.musicGain, musicTarget, dt, 1.2);
    this.music?.gain.gain.setTargetAtTime(this.musicGain, t, 0.08);
    // Clear sky keeps the pad open; overcast / snow pulls a low-pass down.
    const musicBright = 1800 + clear * 4200 - s.snow * 900;
    this.musicFilter?.frequency.setTargetAtTime(Math.max(700, musicBright), t, 0.25);

    // Wind howl — always on; climbs with height, gale, and snow.
    const windTarget = (0.01 + overview * 0.035 + gale * 0.06 + s.snow * 0.035 + s.cover * 0.015) * hush;
    this.windGain = this.glide(this.windGain, windTarget, dt, 1.4);
    this.wind?.gain.gain.setTargetAtTime(this.windGain, t, 0.12);
    // Calm breeze sits low; a gale shrieks higher and flutters faster.
    const windTone = 320 + gale * 900 + s.snow * 200 + overview * 180;
    this.windFilter?.frequency.setTargetAtTime(windTone, t, 0.2);
    if (this.windLfo) this.windLfo.frequency.setTargetAtTime(0.05 + gale * 0.22 + s.snow * 0.08, t, 0.3);
    if (this.windLfoGain) this.windLfoGain.gain.setTargetAtTime(160 + gale * 420, t, 0.3);

    // Falling-snow hiss when flakes are in the air.
    const snowTarget = s.snow * (0.018 + mid * 0.02 + close * 0.01) * hush;
    this.snowGain = this.glide(this.snowGain, snowTarget, dt, 1.6);
    this.snow?.gain.gain.setTargetAtTime(this.snowGain, t, 0.15);

    this.gustT -= dt;
    if (gale > 0.35 && this.gustT <= 0) {
      this.gustT = 1.2 + Math.random() * (3.5 - gale * 2);
      this.gust(0.02 + gale * 0.05 + s.snow * 0.02);
    }

    // Cars thin out in heavy snow (roads get quieter under a storm).
    const carProx = falloff(s.carDist, 80, 900) * mid;
    const carTarget = s.carBusy * carProx * (0.04 + close * 0.06) * muffler * hush;
    this.carGain = this.glide(this.carGain, carTarget, dt, 2.2);
    this.cars?.gain.gain.setTargetAtTime(this.carGain, t, 0.06);

    this.carWhooshT -= dt;
    if (this.carGain > 0.012 && this.carWhooshT <= 0) {
      this.carWhooshT = 0.7 + Math.random() * (2.4 - s.carBusy * 1.2) + s.snow * 1.2;
      this.whoosh((0.012 + this.carGain * 0.55) * muffler);
    }

    // Nearest lift motor / cable hum — wind can mask it a bit.
    let liftProx = 0;
    let liftType = "chair";
    for (const L of s.lifts) {
      const d = Math.hypot(L.x - s.lookX, L.y - s.lookY);
      const p = falloff(d, 60, 700);
      if (p > liftProx) {
        liftProx = p;
        liftType = L.type;
      }
    }
    const liftBase = liftType === "gondola" || liftType === "six" ? 0.055 : liftType === "carpet" ? 0.03 : 0.042;
    const liftTarget = liftProx * mid * liftBase * (0.55 + close * 0.7) * (0.7 + clear * 0.3) * hush;
    this.liftGain = this.glide(this.liftGain, liftTarget, dt, 2);
    this.lift?.gain.gain.setTargetAtTime(this.liftGain, t, 0.08);

    this.liftTickT -= dt;
    if (this.liftGain > 0.015 && this.liftTickT <= 0 && liftType !== "carpet") {
      this.liftTickT = liftType === "gondola" ? 1.8 : 0.9 + Math.random() * 0.5;
      this.liftClank((0.01 + this.liftGain * 0.35) * muffler);
    }

    // Helicopter: only while it's spinning / flying nearby.
    let heliTarget = 0;
    if (s.heli?.active) {
      const d = Math.hypot(s.heli.x - s.lookX, s.heli.y - s.lookY);
      heliTarget = falloff(d, 120, 2200) * (0.05 + mid * 0.04) * hush;
    }
    this.heliGain = this.glide(this.heliGain, heliTarget, dt, 2.5);
    this.heli?.gain.gain.setTargetAtTime(this.heliGain, t, 0.05);

    // Earthworks rumble while the shape brush is digging.
    const digTarget = s.shaping ? 0.05 * (0.4 + close * 0.6) : 0;
    this.digGain = this.glide(this.digGain, digTarget, dt, 4);
    this.dig?.gain.gain.setTargetAtTime(this.digGain, t, 0.04);
    if (s.shaping) {
      this.lastShapePulse -= dt;
      if (this.lastShapePulse <= 0) {
        this.lastShapePulse = 0.18;
        this.shapeThump();
      }
    } else this.lastShapePulse = 0;

    // Soft arpeggio — slower and rarer when the weather turns.
    this.arpT -= dt * (s.paused ? 0.4 : 1) * (0.55 + clear * 0.45);
    if (this.arpT <= 0 && this.musicGain > 0.02) {
      this.arpT = 0.55 + (this.musicNote % 3) * 0.12 + storm * 0.35;
      this.playArpNote();
    }
  }

  cash(): void {
    this.tone(880, 0.08, "triangle", 0.04);
    this.tone(1320, 0.12, "triangle", 0.035, 0.06);
  }

  build(): void {
    this.tone(180, 0.09, "square", 0.028);
    this.tone(260, 0.14, "sine", 0.045, 0.04);
    this.tone(390, 0.18, "triangle", 0.03, 0.1);
  }

  /** Placing a lift or finishing a long structure. */
  buildBig(): void {
    this.tone(140, 0.12, "square", 0.03);
    this.tone(210, 0.16, "sine", 0.04, 0.05);
    this.tone(320, 0.22, "triangle", 0.035, 0.12);
    this.tone(480, 0.2, "sine", 0.025, 0.2);
  }

  error(): void {
    this.tone(140, 0.16, "sawtooth", 0.03);
  }

  click(): void {
    this.tone(520, 0.04, "square", 0.02);
  }

  /** One dirt scrape when earth actually moves. */
  shapeThump(): void {
    this.tone(55 + Math.random() * 25, 0.12, "sawtooth", 0.018);
    this.noiseBurst(0.05, 0.022, 400);
  }

  private glide(cur: number, target: number, dt: number, rate: number): number {
    const k = 1 - Math.exp(-rate * dt);
    return cur + (target - cur) * k;
  }

  private teardownLoops(): void {
    for (const layer of [this.music, this.wind, this.snow, this.cars, this.lift, this.heli, this.dig]) {
      layer?.stop();
    }
    this.music = this.wind = this.snow = this.cars = this.lift = this.heli = this.dig = null;
    this.windFilter = this.windLfo = this.windLfoGain = null;
    this.started = false;
    this.musicGain = this.windGain = this.snowGain = this.carGain = this.liftGain = this.heliGain = this.digGain = 0;
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start();
    return src;
  }

  private startMusic(): void {
    const ctx = this.ctx!;
    const bus = this.musicBus!;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(bus);

    // Warm detuned pad in a G-minor-ish alpine color.
    const freqs = [196, 233.08, 293.66];
    const nodes: AudioNode[] = [g];
    for (const f of freqs) {
      for (const det of [-3, 3]) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f + det;
        const og = ctx.createGain();
        og.gain.value = 0.22;
        o.connect(og).connect(g);
        o.start();
        nodes.push(o, og);
      }
    }
    // Soft high shimmer.
    const shim = ctx.createOscillator();
    shim.type = "triangle";
    shim.frequency.value = 784;
    const sg = ctx.createGain();
    sg.gain.value = 0.06;
    shim.connect(sg).connect(g);
    shim.start();
    nodes.push(shim, sg);

    this.music = {
      gain: g,
      nodes,
      stop: () => {
        for (const n of nodes) {
          try {
            if ("stop" in n && typeof (n as OscillatorNode).stop === "function") (n as OscillatorNode).stop();
          } catch {
            /* already stopped */
          }
          try {
            n.disconnect();
          } catch {
            /* */
          }
        }
      },
    };
  }

  private playArpNote(): void {
    // Pentatonic over the pad — quiet, sparse.
    const scale = [196, 220, 261.63, 293.66, 349.23, 392, 440];
    const i = this.musicNote % scale.length;
    this.musicNote++;
    const f = scale[(i * 2) % scale.length];
    this.tone(f, 0.55, "sine", 0.012 + this.musicGain * 0.15, 0, this.musicBus);
    this.tone(f * 2, 0.4, "triangle", 0.006 + this.musicGain * 0.08, 0.02, this.musicBus);
  }

  private startWind(): void {
    const ctx = this.ctx!;
    const bus = this.ambientBus!;
    const src = this.noiseSource(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 450;
    filter.Q.value = 0.55;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(filter).connect(g).connect(bus);
    // Slow swirl on the filter — rate/depth follow the weather each frame.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 220;
    lfo.connect(lfoG).connect(filter.frequency);
    lfo.start();
    this.windFilter = filter;
    this.windLfo = lfo;
    this.windLfoGain = lfoG;
    this.wind = {
      gain: g,
      nodes: [src, filter, g, lfo, lfoG],
      stop: () => {
        try {
          src.stop();
        } catch {
          /* */
        }
        try {
          lfo.stop();
        } catch {
          /* */
        }
        for (const n of [src, filter, g, lfo, lfoG]) {
          try {
            n.disconnect();
          } catch {
            /* */
          }
        }
      },
    };
  }

  /** Soft high hiss of falling snow — only audible once flakes pick up. */
  private startSnow(): void {
    const ctx = this.ctx!;
    const bus = this.ambientBus!;
    const src = this.noiseSource(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 4200;
    filter.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(filter).connect(g).connect(bus);
    this.snow = {
      gain: g,
      nodes: [src, filter, g],
      stop: () => {
        try {
          src.stop();
        } catch {
          /* */
        }
        for (const n of [src, filter, g]) {
          try {
            n.disconnect();
          } catch {
            /* */
          }
        }
      },
    };
  }

  /** A short gale whoosh when the wind or storm spikes. */
  private gust(gain: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.ambientBus || !this.noiseBuf) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.55);
    f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    src.connect(f).connect(g).connect(this.ambientBus);
    src.start(t);
    src.stop(t + 1);
  }

  private startCars(): void {
    const ctx = this.ctx!;
    const bus = this.ambientBus!;
    const src = this.noiseSource(ctx);
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 280;
    low.Q.value = 0.7;
    const throb = ctx.createGain();
    throb.gain.value = 0.65;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(low).connect(throb).connect(g).connect(bus);
    // Engine-ish throb.
    const pulse = ctx.createOscillator();
    pulse.type = "sine";
    pulse.frequency.value = 1.7;
    const pg = ctx.createGain();
    pg.gain.value = 0.35;
    pulse.connect(pg).connect(throb.gain);
    pulse.start();
    // Low engine tone.
    const eng = ctx.createOscillator();
    eng.type = "sawtooth";
    eng.frequency.value = 48;
    const eg = ctx.createGain();
    eg.gain.value = 0.18;
    const ef = ctx.createBiquadFilter();
    ef.type = "lowpass";
    ef.frequency.value = 120;
    eng.connect(ef).connect(eg).connect(g);
    eng.start();
    this.cars = {
      gain: g,
      nodes: [src, low, g, pulse, pg, throb, eng, eg, ef],
      stop: () => {
        for (const n of [src, pulse, eng] as AudioScheduledSourceNode[]) {
          try {
            n.stop();
          } catch {
            /* */
          }
        }
        for (const n of [src, low, g, pulse, pg, throb, eng, eg, ef]) {
          try {
            n.disconnect();
          } catch {
            /* */
          }
        }
      },
    };
  }

  private startLift(): void {
    const ctx = this.ctx!;
    const bus = this.ambientBus!;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(bus);
    const motor = ctx.createOscillator();
    motor.type = "sawtooth";
    motor.frequency.value = 62;
    const mf = ctx.createBiquadFilter();
    mf.type = "lowpass";
    mf.frequency.value = 180;
    const throb = ctx.createGain();
    throb.gain.value = 0.75;
    const mg = ctx.createGain();
    mg.gain.value = 0.45;
    motor.connect(mf).connect(throb).connect(mg).connect(g);
    motor.start();
    const hum = ctx.createOscillator();
    hum.type = "sine";
    hum.frequency.value = 124;
    const hg = ctx.createGain();
    hg.gain.value = 0.2;
    hum.connect(hg).connect(g);
    hum.start();
    // Slow mechanical pulse.
    const pulse = ctx.createOscillator();
    pulse.type = "sine";
    pulse.frequency.value = 0.55;
    const pg = ctx.createGain();
    pg.gain.value = 0.25;
    pulse.connect(pg).connect(throb.gain);
    pulse.start();
    this.lift = {
      gain: g,
      nodes: [g, motor, mf, mg, hum, hg, pulse, pg, throb],
      stop: () => {
        for (const n of [motor, hum, pulse] as OscillatorNode[]) {
          try {
            n.stop();
          } catch {
            /* */
          }
        }
        for (const n of [g, motor, mf, mg, hum, hg, pulse, pg, throb]) {
          try {
            n.disconnect();
          } catch {
            /* */
          }
        }
      },
    };
  }

  private startHeli(): void {
    const ctx = this.ctx!;
    const bus = this.ambientBus!;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(bus);
    const rotor = ctx.createOscillator();
    rotor.type = "sawtooth";
    rotor.frequency.value = 28;
    const rf = ctx.createBiquadFilter();
    rf.type = "bandpass";
    rf.frequency.value = 90;
    rf.Q.value = 1.2;
    const rg = ctx.createGain();
    rg.gain.value = 0.55;
    rotor.connect(rf).connect(rg).connect(g);
    rotor.start();
    const blade = ctx.createOscillator();
    blade.type = "triangle";
    blade.frequency.value = 56;
    const bg = ctx.createGain();
    bg.gain.value = 0.22;
    blade.connect(bg).connect(g);
    blade.start();
    const src = this.noiseSource(ctx);
    const nf = ctx.createBiquadFilter();
    nf.type = "highpass";
    nf.frequency.value = 800;
    const ng = ctx.createGain();
    ng.gain.value = 0.12;
    src.connect(nf).connect(ng).connect(g);
    this.heli = {
      gain: g,
      nodes: [g, rotor, rf, rg, blade, bg, src, nf, ng],
      stop: () => {
        for (const n of [rotor, blade, src] as AudioScheduledSourceNode[]) {
          try {
            n.stop();
          } catch {
            /* */
          }
        }
        for (const n of [g, rotor, rf, rg, blade, bg, src, nf, ng]) {
          try {
            n.disconnect();
          } catch {
            /* */
          }
        }
      },
    };
  }

  private startDig(): void {
    const ctx = this.ctx!;
    const bus = this.ambientBus!;
    const src = this.noiseSource(ctx);
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(low).connect(g).connect(bus);
    const rumble = ctx.createOscillator();
    rumble.type = "sawtooth";
    rumble.frequency.value = 38;
    const rg = ctx.createGain();
    rg.gain.value = 0.3;
    rumble.connect(rg).connect(g);
    rumble.start();
    this.dig = {
      gain: g,
      nodes: [src, low, g, rumble, rg],
      stop: () => {
        try {
          src.stop();
        } catch {
          /* */
        }
        try {
          rumble.stop();
        } catch {
          /* */
        }
        for (const n of [src, low, g, rumble, rg]) {
          try {
            n.disconnect();
          } catch {
            /* */
          }
        }
      },
    };
  }

  private whoosh(gain: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.ambientBus || !this.noiseBuf) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(1400, t + 0.35);
    f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(f).connect(g).connect(this.ambientBus);
    src.start(t);
    src.stop(t + 0.5);
  }

  private liftClank(gain: number): void {
    this.tone(180 + Math.random() * 40, 0.05, "square", gain * 0.6, 0, this.ambientBus);
    this.tone(90, 0.08, "triangle", gain, 0.02, this.ambientBus);
  }

  private noiseBurst(dur: number, gain: number, freq: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus || !this.noiseBuf) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain = 0.05,
    delay = 0,
    dest: AudioNode | null = null
  ): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const out = dest ?? this.sfxBus ?? ctx.destination;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(Math.max(0.0001, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
