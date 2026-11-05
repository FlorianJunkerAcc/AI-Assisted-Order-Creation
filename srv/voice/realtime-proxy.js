// PICO Voice: WebSocket-Proxy zwischen Browser und SAP AI Core (gpt-realtime).
//
// Das SAP AI SDK (SapOpenAiRealtimeWs) laeuft nur in Node.js, nicht im
// Browser. Der Browser verbindet sich deshalb mit diesem Proxy; die
// Zugangsdaten zu AI Core bleiben im Backend (gleiche Bindung wie beim
// Orchestration-Client).
//
// Der Proxy leitet bewusst NICHT beliebige Events weiter, sondern nur eine
// kleine, feste Nachrichtenmenge:
//   Browser -> Proxy:  { type: "audio", data: <base64 PCM16 24 kHz> }
//                      { type: "clear" }            Eingabepuffer leeren
//                      { type: "speak", text }      Text vorlesen (Stimme alloy)
//                      { type: "cancel" }           Wiedergabe abbrechen
//   Proxy -> Browser:  { type: "ready" } | { type: "speech_started" } |
//                      { type: "speech_stopped" } | { type: "transcript", text } |
//                      { type: "audio", data } | { type: "audio_done" } |
//                      { type: "error", message }
import cds from "@sap/cds";
import { WebSocketServer, WebSocket } from "ws";
import { SapOpenAiRealtimeWs } from "@sap-ai-sdk/openai/realtime";

const WS_PATH = "/pico-voice";
const RESOURCE_GROUP = process.env.AICORE_RESOURCE_GROUP || "default";
const MODEL_NAME = process.env.PICO_REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.PICO_VOICE || "alloy";
const TRANSCRIBE_MODEL =
    process.env.PICO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const TRANSCRIBE_LANGUAGE = process.env.PICO_VOICE_LANGUAGE || "en";
const MAX_CONNECTIONS = Number(process.env.PICO_VOICE_MAX_CONNECTIONS || 10);
const MAX_TEXT_LENGTH = 1500;

const LOG = cds.log("pico-voice");

const SESSION_INSTRUCTIONS =
    "You are the voice of PICO, a friendly assistant for creating sales " +
    "orders. You only read out texts you are given, in a warm and natural " +
    "tone. Never add, omit or answer anything yourself.";

function sessionConfig() {
    return {
        type: "session.update",
        session: {
            type: "realtime",
            output_modalities: ["audio"],
            instructions: SESSION_INSTRUCTIONS,
            audio: {
                input: {
                    format: { type: "audio/pcm", rate: 24000 },
                    transcription: {
                        model: TRANSCRIBE_MODEL,
                        language: TRANSCRIBE_LANGUAGE
                    },
                    // Server-VAD erkennt das Satzende. PICO antwortet nicht
                    // selbst auf das Gesprochene: der Text wird in die
                    // bestehende PICO-Logik (routeAiCommand) gegeben.
                    turn_detection: {
                        type: "server_vad",
                        create_response: false,
                        interrupt_response: false
                    }
                },
                output: {
                    format: { type: "audio/pcm", rate: 24000 },
                    voice: VOICE
                }
            }
        }
    };
}

/**
 * In Produktion muss der Aufrufer ein gueltiges XSUAA-Token mitbringen
 * (der Approuter reicht es beim WebSocket-Upgrade als Authorization-Header
 * durch). Lokal (ohne production-Profil) wird nicht geprueft.
 */
async function isAuthorized(req) {
    if (!cds.env.profiles?.includes("production")) {
        return true;
    }
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
    if (!match) {
        return false;
    }
    try {
        const { default: xssec } = await import("@sap/xssec");
        const credentials = cds.env.requires?.auth?.credentials;
        const service = new xssec.XsuaaService(credentials);
        await xssec.createSecurityContext(service, { jwt: match[1] });
        return true;
    } catch (error) {
        LOG.warn("Voice connection rejected:", error.message);
        return false;
    }
}

function handleConnection(browser) {
    let aiClient;
    let closed = false;
    let configured = false;
    let responseActive = false;

    const send = (payload) => {
        if (browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify(payload));
        }
    };
    const aiSend = (payload) => {
        if (aiClient && !closed) {
            aiClient.send(payload);
        }
    };
    const configure = () => {
        if (configured) {
            return;
        }
        configured = true;
        aiSend(sessionConfig());
    };

    // Nachrichten, die vor dem fertigen Verbindungsaufbau eintreffen
    const pending = [];
    const handleBrowserMessage = (message) => {
        switch (message?.type) {
            case "audio":
                if (typeof message.data === "string") {
                    aiSend({
                        type: "input_audio_buffer.append",
                        audio: message.data
                    });
                }
                break;
            case "clear":
                aiSend({ type: "input_audio_buffer.clear" });
                break;
            case "speak": {
                const text = String(message.text || "")
                    .trim()
                    .slice(0, MAX_TEXT_LENGTH);
                if (!text) {
                    break;
                }
                if (responseActive) {
                    aiSend({ type: "response.cancel" });
                }
                // Out-of-band-Antwort: Der Text wird vorgelesen, ohne den
                // Gespraechsverlauf der Session zu veraendern.
                aiSend({
                    type: "response.create",
                    response: {
                        conversation: "none",
                        output_modalities: ["audio"],
                        instructions:
                            "Read the following text aloud exactly as " +
                            "written, in a friendly, natural tone. Do not " +
                            "add, omit or answer anything.\n\nText:\n" +
                            text
                    }
                });
                break;
            }
            case "cancel":
                if (responseActive) {
                    aiSend({ type: "response.cancel" });
                }
                break;
            default:
                break;
        }
    };

    browser.on("message", (raw) => {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (!aiClient) {
            pending.push(message);
            return;
        }
        try {
            handleBrowserMessage(message);
        } catch (error) {
            LOG.warn("Could not forward browser message:", error.message);
        }
    });

    browser.on("close", () => {
        closed = true;
        try {
            aiClient?.close();
        } catch {
            // Verbindung ist bereits beendet.
        }
    });

    (async () => {
        try {
            aiClient = await SapOpenAiRealtimeWs.createClient({
                deployment: {
                    modelName: MODEL_NAME,
                    modelVersion: "latest"
                },
                resourceGroup: RESOURCE_GROUP
            });
            if (closed) {
                aiClient.close();
                return;
            }

            aiClient.on("session.created", configure);
            aiClient.on("session.updated", () => send({ type: "ready" }));
            aiClient.on("input_audio_buffer.speech_started", () =>
                send({ type: "speech_started" })
            );
            aiClient.on("input_audio_buffer.speech_stopped", () =>
                send({ type: "speech_stopped" })
            );
            aiClient.on(
                "conversation.item.input_audio_transcription.completed",
                (event) =>
                    send({
                        type: "transcript",
                        text: String(event.transcript || "").trim()
                    })
            );
            aiClient.on("response.created", () => {
                responseActive = true;
            });
            aiClient.on("response.output_audio.delta", (event) =>
                send({ type: "audio", data: event.delta })
            );
            aiClient.on("response.done", () => {
                responseActive = false;
                send({ type: "audio_done" });
            });
            aiClient.on("error", (event) => {
                const message =
                    event?.error?.message || event?.message || "Unknown error";
                // Abbruch einer nicht mehr aktiven Antwort ist harmlos.
                if (/no active response|not active/i.test(message)) {
                    return;
                }
                LOG.error("AI Core realtime error:", message);
                send({ type: "error", message });
            });

            // Die Session wird bereits beim Verbindungsaufbau erzeugt;
            // falls session.created schon vor dem Registrieren der
            // Listener kam, wird die Konfiguration hier nachgeholt.
            configure();

            pending.splice(0).forEach(handleBrowserMessage);
        } catch (error) {
            LOG.error("Could not connect to SAP AI Core:", error.message);
            send({ type: "error", message: error.message });
            browser.close(1011, "AI Core connection failed");
        }
    })();
}

/** Haengt den Voice-Proxy an den HTTP-Server von CAP. */
export function attachVoiceProxy(server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

    server.on("upgrade", async (req, socket, head) => {
        let pathname;
        try {
            pathname = new URL(req.url, "http://localhost").pathname;
        } catch {
            return;
        }
        if (pathname !== WS_PATH) {
            return; // andere Upgrades (z. B. Livereload) nicht anfassen
        }
        if (wss.clients.size >= MAX_CONNECTIONS) {
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            return socket.destroy();
        }
        if (!(await isAuthorized(req))) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws));
    });

    LOG.info(
        `PICO voice proxy ready on ${WS_PATH} ` +
            `(model ${MODEL_NAME}, voice ${VOICE}, resource group ${RESOURCE_GROUP})`
    );
}
