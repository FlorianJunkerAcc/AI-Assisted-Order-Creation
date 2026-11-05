// AudioWorklet: nimmt das Mikrofon auf, wandelt es auf 24 kHz / mono / PCM16
// um (Format von gpt-realtime) und liefert ca. alle 100 ms einen Block.
class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._ratio = sampleRate / 24000;
        this._pos = 0; // Leseposition im Eingangsstrom (in Eingangs-Samples)
        this._carry = new Float32Array(0);
        this._out = [];
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) {
            return true;
        }
        // Eingang an uebrig gebliebene Samples anhaengen
        const data = new Float32Array(this._carry.length + channel.length);
        data.set(this._carry);
        data.set(channel, this._carry.length);

        // Lineares Resampling auf 24 kHz
        while (this._pos + 1 < data.length) {
            const i = Math.floor(this._pos);
            const frac = this._pos - i;
            const sample = data[i] * (1 - frac) + data[i + 1] * frac;
            const clamped = Math.max(-1, Math.min(1, sample));
            this._out.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
            this._pos += this._ratio;
        }
        const consumed = Math.floor(this._pos);
        this._carry = data.slice(consumed);
        this._pos -= consumed;

        if (this._out.length >= 2400) {
            const pcm = Int16Array.from(this._out);
            this._out = [];
            this.port.postMessage(pcm.buffer, [pcm.buffer]);
        }
        return true;
    }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
