sap.ui.define([], function () {
    "use strict";

    // Browser-Seite von PICO Voice (GPT Realtime ueber den CAP-Proxy):
    //  - listen(): Mikrofon -> Server-VAD/Transkription -> Text
    //  - speak():  Text -> PICO-Stimme (alloy) -> Lautsprecher
    const SOCKET_PATH = "/pico-voice";
    const SAMPLE_RATE = 24000;
    const LISTEN_TIMEOUT_MS = 20000;
    const TRANSCRIPT_TIMEOUT_MS = 10000;
    const WORKLET_URL = sap.ui.require.toUrl(
        "com/prototype/salesorderai/salesorderui/ext/voice/pcm-worklet.js"
    );

    function toBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(
                null,
                bytes.subarray(i, i + 0x8000)
            );
        }
        return btoa(binary);
    }

    function PicoVoice(fnOnError) {
        this._onError = fnOnError || function () {};
        this._socket = null;
        this._socketReady = null; // Promise
        this._playCtx = null;
        this._nextPlayTime = 0;
        this._sources = [];
        this._listen = null; // laufende Aufnahme
    }

    PicoVoice.isSupported = function () {
        return Boolean(
            window.WebSocket &&
                navigator.mediaDevices &&
                navigator.mediaDevices.getUserMedia &&
                (window.AudioContext || window.webkitAudioContext) &&
                window.AudioWorkletNode
        );
    };

    // ----- Verbindung --------------------------------------------------

    PicoVoice.prototype._connect = function () {
        if (this._socketReady) {
            return this._socketReady;
        }
        this._socketReady = new Promise((resolve, reject) => {
            const sProtocol = window.location.protocol === "https:" ? "wss" : "ws";
            const oSocket = new WebSocket(
                `${sProtocol}://${window.location.host}${SOCKET_PATH}`
            );
            let bReady = false;
            const oTimer = setTimeout(() => {
                if (!bReady) {
                    reject(new Error("Voice service did not respond."));
                    oSocket.close();
                }
            }, 15000);

            oSocket.onmessage = (oEvent) => {
                let oMessage;
                try {
                    oMessage = JSON.parse(oEvent.data);
                } catch (e) {
                    return;
                }
                if (oMessage.type === "ready" && !bReady) {
                    bReady = true;
                    clearTimeout(oTimer);
                    resolve(oSocket);
                }
                this._onMessage(oMessage);
            };
            oSocket.onerror = () => {
                clearTimeout(oTimer);
                if (!bReady) {
                    reject(new Error("Could not reach the voice service."));
                }
            };
            oSocket.onclose = () => {
                clearTimeout(oTimer);
                this._socket = null;
                this._socketReady = null;
                this._finishListening(null);
                if (!bReady) {
                    reject(new Error("The voice connection was closed."));
                }
            };
            this._socket = oSocket;
        });
        // Fehlgeschlagenen Versuch nicht zwischenspeichern
        this._socketReady.catch(() => {
            this._socketReady = null;
        });
        return this._socketReady;
    };

    PicoVoice.prototype._send = function (oPayload) {
        if (this._socket && this._socket.readyState === WebSocket.OPEN) {
            this._socket.send(JSON.stringify(oPayload));
        }
    };

    PicoVoice.prototype._onMessage = function (oMessage) {
        if (oMessage.type !== "audio") {
            console.debug("PICO voice:", oMessage.type, oMessage.text || oMessage.message || "", "(sent chunks: " + (this._chunks || 0) + ")");
        }
        switch (oMessage.type) {
            case "audio":
                this._playChunk(oMessage.data);
                break;
            case "speech_started":
                if (this._listen && this._listen.callbacks.onSpeech) {
                    this._listen.callbacks.onSpeech();
                }
                break;
            case "speech_stopped":
                // Aufnahme beenden, das Transkript kommt gleich nach.
                if (this._listen) {
                    this._stopCapture();
                    clearTimeout(this._listen.timer);
                    this._listen.timer = setTimeout(
                        () => this._finishListening(null),
                        TRANSCRIPT_TIMEOUT_MS
                    );
                }
                break;
            case "transcript":
                if (this._listen && oMessage.text) {
                    this._finishListening(oMessage.text);
                }
                break;
            case "error":
                this._onError(oMessage.message);
                this._finishListening(null);
                break;
            default:
                break;
        }
    };

    // ----- Sprachausgabe -----------------------------------------------

    PicoVoice.prototype._getPlayContext = function () {
        if (!this._playCtx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            this._playCtx = new AudioCtx({ sampleRate: SAMPLE_RATE });
        }
        return this._playCtx;
    };

    /** Muss aus einem Klick heraus aufgerufen werden (Autoplay-Regel). */
    PicoVoice.prototype.unlock = function () {
        const oCtx = this._getPlayContext();
        if (oCtx.state === "suspended") {
            oCtx.resume();
        }
    };

    PicoVoice.prototype._playChunk = function (sBase64) {
        if (!sBase64) {
            return;
        }
        const oCtx = this._getPlayContext();
        const sBinary = atob(sBase64);
        const oBytes = new Uint8Array(sBinary.length);
        for (let i = 0; i < sBinary.length; i++) {
            oBytes[i] = sBinary.charCodeAt(i);
        }
        const oPcm = new Int16Array(oBytes.buffer, 0, oBytes.length >> 1);
        const oFloat = new Float32Array(oPcm.length);
        for (let i = 0; i < oPcm.length; i++) {
            oFloat[i] = oPcm[i] / 0x8000;
        }
        const oBuffer = oCtx.createBuffer(1, oFloat.length, SAMPLE_RATE);
        oBuffer.copyToChannel(oFloat, 0);
        const oSource = oCtx.createBufferSource();
        oSource.buffer = oBuffer;
        oSource.connect(oCtx.destination);
        const fStart = Math.max(oCtx.currentTime + 0.02, this._nextPlayTime);
        oSource.start(fStart);
        this._nextPlayTime = fStart + oBuffer.duration;
        this._sources.push(oSource);
        oSource.onended = () => {
            this._sources = this._sources.filter((o) => o !== oSource);
        };
    };

    PicoVoice.prototype.speak = function (sText) {
        if (!sText) {
            return;
        }
        this.unlock();
        this._flushPlayback();
        this._connect()
            .then(() => this._send({ type: "speak", text: sText }))
            .catch((oError) => this._onError(oError.message));
    };

    PicoVoice.prototype._flushPlayback = function () {
        this._sources.forEach((oSource) => {
            try {
                oSource.stop();
            } catch (e) {
                // bereits beendet
            }
        });
        this._sources = [];
        this._nextPlayTime = 0;
    };

    PicoVoice.prototype.stopSpeaking = function () {
        this._flushPlayback();
        this._send({ type: "cancel" });
    };

    // ----- Spracheingabe -----------------------------------------------

    /**
     * Startet eine Aufnahme. Sie endet automatisch nach dem ersten Satz.
     * callbacks: onStart(), onSpeech(), onEnd(sTranscriptOrNull)
     */
    PicoVoice.prototype.listen = async function (oCallbacks) {
        if (this._listen) {
            return;
        }
        // PICO soll sich nicht selbst zuhoeren.
        this.stopSpeaking();
        this._listen = { callbacks: oCallbacks, timer: null };
        try {
            await this._connect();
            const oStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });
            if (!this._listen) {
                oStream.getTracks().forEach((oTrack) => oTrack.stop());
                return;
            }
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const oCtx = new AudioCtx();
            await oCtx.audioWorklet.addModule(WORKLET_URL);
            const oSource = oCtx.createMediaStreamSource(oStream);
            const oNode = new AudioWorkletNode(oCtx, "pcm-capture");
            oNode.port.onmessage = (oEvent) => {
                this._chunks = (this._chunks || 0) + 1;
                this._send({ type: "audio", data: toBase64(oEvent.data) });
            };
            oSource.connect(oNode);
            // Manche Browser (Firefox, Safari) verarbeiten einen Worklet-Knoten
            // nur, wenn er mit dem Ausgang verbunden ist. Stumm geschaltet,
            // damit man sich nicht selbst hoert.
            const oMute = oCtx.createGain();
            oMute.gain.value = 0;
            oNode.connect(oMute);
            oMute.connect(oCtx.destination);
            if (oCtx.state === "suspended") {
                await oCtx.resume();
            }
            this._chunks = 0;

            this._listen.capture = { stream: oStream, ctx: oCtx, node: oNode, source: oSource };
            this._send({ type: "clear" });
            this._listen.timer = setTimeout(
                () => this._finishListening(null),
                LISTEN_TIMEOUT_MS
            );
            if (oCallbacks.onStart) {
                oCallbacks.onStart();
            }
        } catch (oError) {
            const sMessage =
                oError && oError.name === "NotAllowedError"
                    ? "Microphone access was denied."
                    : (oError && oError.message) || "Voice input failed.";
            this._onError(sMessage);
            this._finishListening(null);
        }
    };

    PicoVoice.prototype._stopCapture = function () {
        const oCapture = this._listen && this._listen.capture;
        if (!oCapture) {
            return;
        }
        this._listen.capture = null;
        try {
            oCapture.source.disconnect();
            oCapture.node.port.onmessage = null;
            oCapture.stream.getTracks().forEach((oTrack) => oTrack.stop());
            oCapture.ctx.close();
        } catch (e) {
            // bereits geschlossen
        }
    };

    PicoVoice.prototype._finishListening = function (sTranscript) {
        const oListen = this._listen;
        if (!oListen) {
            return;
        }
        this._stopCapture();
        clearTimeout(oListen.timer);
        this._listen = null;
        if (oListen.callbacks.onEnd) {
            oListen.callbacks.onEnd(sTranscript);
        }
    };

    PicoVoice.prototype.stopListening = function () {
        this._finishListening(null);
    };

    PicoVoice.prototype.destroy = function () {
        this.stopListening();
        this._flushPlayback();
        if (this._socket) {
            this._socket.close();
        }
        if (this._playCtx) {
            this._playCtx.close();
            this._playCtx = null;
        }
    };

    return PicoVoice;
});
