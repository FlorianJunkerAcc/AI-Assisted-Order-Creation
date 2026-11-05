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
//                      { type: "mode", mode: "dictate" | "converse", audio }
//                                                   dictate: nur Transkript;
//                                                   converse: GPT antwortet
//                                                   selbst und ruft Tools auf
//                      { type: "tool_result", callId, output }
//   Proxy -> Browser:  { type: "ready" } | { type: "speech_started" } |
//                      { type: "speech_stopped" } | { type: "transcript", text } |
//                      { type: "audio", data } | { type: "audio_done" } |
//                      { type: "assistant_text", text } | { type: "tool_call",
//                      callId, name, args } | { type: "error", message }
import cds from "@sap/cds";
import { WebSocketServer, WebSocket } from "ws";
import { SapOpenAiRealtimeWs } from "@sap-ai-sdk/openai/realtime";

const WS_PATH = "/pico-voice";
const RESOURCE_GROUP = process.env.AICORE_RESOURCE_GROUP || "default";
const MODEL_NAME = process.env.PICO_REALTIME_MODEL || "gpt-realtime";
// Ohne Angabe passt jede Version (die Deployments heissen z. B. 2025-08-28).
const MODEL_VERSION = process.env.PICO_REALTIME_MODEL_VERSION || "";
const DEPLOYMENT_ID = process.env.PICO_REALTIME_DEPLOYMENT_ID || "";
const VOICE =process.env.PICO_VOICE || "alloy";
// Transkriptionsmodelle in Reihenfolge; schlaegt eines fehl, wird das
// naechste probiert (PICO_TRANSCRIBE_MODEL erzwingt ein einzelnes).
const TRANSCRIBE_MODELS = process.env.PICO_TRANSCRIBE_MODEL
    ? [process.env.PICO_TRANSCRIBE_MODEL]
    : ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"];
const TRANSCRIBE_LANGUAGE = process.env.PICO_VOICE_LANGUAGE || "en";
const MAX_CONNECTIONS = Number(process.env.PICO_VOICE_MAX_CONNECTIONS || 10);
const MAX_TEXT_LENGTH = 1500;

const LOG = cds.log("pico-voice");

const READER_INSTRUCTIONS =
    "You are the voice of PICO, a friendly assistant for creating sales " +
    "orders. You only read out texts you are given, in a warm and natural " +
    "tone. Never add, omit or answer anything yourself.";

const CONVERSE_INSTRUCTIONS =
    "You are PICO, a friendly voice assistant that helps field sales reps " +
    "create customer sales orders. Speak English, warm and brief: one or " +
    "two short sentences. You can act ONLY through the provided tools. " +
    "Use select_customer, generate_order_draft, recommend_products or " +
    "validate_order when they fit. For everything else (adding, changing or " +
    "removing items, copying the last order of a customer) call " +
    "run_command with the user's request in their own words. After a tool " +
    "returns, answer ONLY from its result: never invent customers, " +
    "products, quantities or prices. Details are shown on screen, so do " +
    "not read out long lists. If the result asks a question, ask it. You " +
    "cannot create the order itself; the user does that with the Create " +
    "Order button. If a request is unclear, ask a short question.";

const EMPTY_PARAMETERS = { type: "object", properties: {} };
const TOOLS = [
    {
        type: "function",
        name: "select_customer",
        description: "Select the customer for the order by name or number.",
        parameters: {
            type: "object",
            properties: {
                customer: {
                    type: "string",
                    description: "Customer name or number as spoken by the user."
                }
            },
            required: ["customer"]
        }
    },
    {
        type: "function",
        name: "generate_order_draft",
        description:
            "Create an order draft for the selected customer from their order history.",
        parameters: EMPTY_PARAMETERS
    },
    {
        type: "function",
        name: "recommend_products",
        description: "Suggest further products to add to the current order.",
        parameters: EMPTY_PARAMETERS
    },
    {
        type: "function",
        name: "validate_order",
        description: "Check the current order items for problems.",
        parameters: EMPTY_PARAMETERS
    },
    {
        type: "function",
        name: "run_command",
        description:
            "Run any other order request: add, change or remove items, " +
            "copy the last order of a customer, and so on.",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description:
                        "The user's request in their own words, e.g. " +
                        "'add 5 tablets' or 'copy the last order of Intelligent Systems'."
                }
            },
            required: ["command"]
        }
    }
];
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));
const TOOL_TIMEOUT_MS = 90000;

function sessionConfig(transcribeModel, mode = "dictate", audioOut = true) {
    const converse = mode === "converse";
    const session = {
        type: "realtime",
        output_modalities: converse && !audioOut ? ["text"] : ["audio"],
        instructions: converse ? CONVERSE_INSTRUCTIONS : READER_INSTRUCTIONS,
        audio: {
            input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: {
                    model: transcribeModel,
                    language: TRANSCRIBE_LANGUAGE
                },
                // Server-VAD erkennt das Satzende. Im Modus "dictate" wird
                // nur transkribiert; im Modus "converse" antwortet GPT
                // selbst (inkl. Tool-Aufrufen).
                turn_detection: {
                    type: "server_vad",
                    create_response: converse,
                    interrupt_response: false
                }
            },
            output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: VOICE
            }
        }
    };
    if (converse) {
        session.tools = TOOLS;
        session.tool_choice = "auto";
    }
    return { type: "session.update", session };
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

/**
 * Ermittelt die Deployment-ID selbst (statt der SDK-Suche, die bei
 * Versionen wie "2025-08-28" nichts fand): feste ID aus
 * PICO_REALTIME_DEPLOYMENT_ID, sonst das neueste laufende Deployment des
 * Modells in der Resource Group.
 */
let cachedDeploymentId = DEPLOYMENT_ID;
async function resolveDeploymentId() {
    if (cachedDeploymentId) {
        return cachedDeploymentId;
    }
    const { DeploymentApi } = await import("@sap-ai-sdk/ai-api");
    const result = await DeploymentApi.deploymentQuery(
        { status: "RUNNING" },
        { "AI-Resource-Group": RESOURCE_GROUP }
    ).execute();
    const matches = (result.resources || [])
        .filter((d) => {
            const model = d.details?.resources?.backendDetails?.model;
            return (
                (model?.name === MODEL_NAME ||
                    String(d.configurationName || "").startsWith(MODEL_NAME)) &&
                (!MODEL_VERSION || model?.version === MODEL_VERSION)
            );
        })
        .sort((a, b) =>
            String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
        );
    if (matches.length === 0) {
        throw new Error(
            `No running "${MODEL_NAME}" deployment in resource group ` +
                `"${RESOURCE_GROUP}". No deployment matched.`
        );
    }
    cachedDeploymentId = matches[0].id;
    LOG.info(`Using ${MODEL_NAME} deployment ${cachedDeploymentId}`);
    return cachedDeploymentId;
}

/**
 * Diagnose: listet die Deployments der Resource Group im Log, damit man
 * sieht, wie das gesuchte Deployment tatsaechlich heisst bzw. in welchem
 * Status es ist.
 */
async function logAvailableDeployments() {
    try {
        const { DeploymentApi } = await import("@sap-ai-sdk/ai-api");
        const result = await DeploymentApi.deploymentQuery(
            {},
            { "AI-Resource-Group": RESOURCE_GROUP }
        ).execute();
        const deployments = result.resources || [];
        LOG.info(
            `Deployments in resource group "${RESOURCE_GROUP}": ` +
                `${result.count ?? deployments.length}`
        );
        for (const d of deployments) {
            const model = d.details?.resources?.backendDetails?.model;
            LOG.info(
                [
                    `id=${d.id}`,
                    `status=${d.status}`,
                    `scenario=${d.scenarioId}`,
                    `config=${d.configurationName}`,
                    `model=${model?.name}@${model?.version}`
                ].join(" | ")
            );
        }
    } catch (error) {
        LOG.warn("Could not list deployments:", error.message);
    }
}

function handleConnection(browser) {
    let aiClient;
    let closed = false;
    let configured = false;
    let responseActive = false;
    let audioChunks = 0;
    let transcribeIndex = 0;
    let mode = "dictate";
    let audioOut = true;
    let ttsPending = 0; // vorgelesene Texte, deren Antwort noch nicht begann
    const ttsResponses = new Set(); // IDs reiner Vorlese-Antworten
    const pendingCalls = new Map(); // callId -> Timeout
    const afterResponse = []; // Aktionen, die auf das Ende der Antwort warten

    const send = (payload) => {
        if (browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify(payload));
        }
    };
    const aiSend = (payload) => {
        if (!aiClient || closed) {
            return;
        }
        // Nur senden, wenn der Socket zu AI Core wirklich offen ist.
        const socket = aiClient.socket;
        if (socket && socket.readyState !== 1) {
            LOG.warn(
                `Dropped "${payload.type}": AI Core socket not open ` +
                    `(readyState ${socket.readyState})`
            );
            return;
        }
        aiClient.send(payload);
    };
    const applySession = () =>
        aiSend(sessionConfig(TRANSCRIBE_MODELS[transcribeIndex], mode, audioOut));
    const configure = () => {
        if (configured) {
            return;
        }
        configured = true;
        applySession();
    };

    // Nachrichten, die vor dem fertigen Verbindungsaufbau eintreffen
    const pending = [];
    const handleBrowserMessage = (message) => {
        switch (message?.type) {
            case "audio":
                if (typeof message.data === "string") {
                    audioChunks++;
                    aiSend({
                        type: "input_audio_buffer.append",
                        audio: message.data
                    });
                }
                break;
            case "clear":
                audioChunks = 0;
                aiSend({ type: "input_audio_buffer.clear" });
                break;
            case "mode":
                mode = message.mode === "converse" ? "converse" : "dictate";
                audioOut = message.audio !== false;
                applySession();
                break;
            case "tool_result": {
                const timer = pendingCalls.get(message.callId);
                if (timer === undefined) {
                    break; // unbekannte oder bereits beantwortete Anfrage
                }
                clearTimeout(timer);
                pendingCalls.delete(message.callId);
                const output = String(message.output ?? "").slice(0, 6000);
                const finish = () => {
                    aiSend({
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: message.callId,
                            output
                        }
                    });
                    aiSend({ type: "response.create", response: {} });
                };
                if (responseActive) {
                    afterResponse.push(finish);
                } else {
                    finish();
                }
                break;
            }
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
                ttsPending++;
                // Out-of-band-Antwort: Der Text wird vorgelesen, ohne den
                // Gespraechsverlauf der Session zu veraendern.
                aiSend({
                    type: "response.create",
                    response: {
                        conversation: "none",
                        tool_choice: "none",
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
        pendingCalls.forEach((timer) => clearTimeout(timer));
        pendingCalls.clear();
        try {
            aiClient?.close();
        } catch {
            // Verbindung ist bereits beendet.
        }
    });

    (async () => {
        try {
            aiClient = await SapOpenAiRealtimeWs.createClient({
                // Entweder feste Deployment-ID (PICO_REALTIME_DEPLOYMENT_ID)
                // oder Suche nach Modellname/-version.
                deployment: { deploymentId: await resolveDeploymentId() },
                resourceGroup: RESOURCE_GROUP
            });
            if (closed) {
                aiClient.close();
                return;
            }

            aiClient.on("session.created", configure);
            aiClient.on("session.updated", () => send({ type: "ready" }));
            aiClient.on("input_audio_buffer.speech_started", () => {
                LOG.info("Speech started");
                send({ type: "speech_started" });
            });
            aiClient.on("input_audio_buffer.speech_stopped", () => {
                LOG.info(`Speech stopped (audio chunks received: ${audioChunks})`);
                send({ type: "speech_stopped" });
            });
            aiClient.on(
                "conversation.item.input_audio_transcription.failed",
                (event) => {
                    const message =
                        event?.error?.message || "Transcription failed";
                    LOG.error(
                        `Transcription failed with "${TRANSCRIBE_MODELS[transcribeIndex]}":`,
                        JSON.stringify(event?.error || {})
                    );
                    if (transcribeIndex + 1 < TRANSCRIBE_MODELS.length) {
                        transcribeIndex++;
                        LOG.info(
                            `Switching transcription model to "${TRANSCRIBE_MODELS[transcribeIndex]}"`
                        );
                        applySession();
                        send({
                            type: "error",
                            message:
                                "Speech could not be transcribed. " +
                                "Please try once more."
                        });
                    } else {
                        send({ type: "error", message: "Transcription: " + message });
                    }
                }
            );
            aiClient.on(
                "conversation.item.input_audio_transcription.completed",
                (event) => {
                    const text = String(event.transcript || "").trim();
                    LOG.info(`Transcript: "${text}"`);
                    send({ type: "transcript", text });
                }
            );
            aiClient.on("response.created", (event) => {
                responseActive = true;
                const id = event?.response?.id;
                if (ttsPending > 0 && id) {
                    ttsPending--;
                    ttsResponses.add(id);
                }
            });
            aiClient.on("response.output_audio.delta", (event) =>
                send({ type: "audio", data: event.delta })
            );
            // Text, den GPT im Gespraech gesagt hat (fuer die Chat-Blase).
            const forwardAssistantText = (event, text) => {
                const value = String(text || "").trim();
                if (value && !ttsResponses.has(event?.response_id)) {
                    send({ type: "assistant_text", text: value });
                }
            };
            aiClient.on("response.output_audio_transcript.done", (event) =>
                forwardAssistantText(event, event.transcript)
            );
            aiClient.on("response.output_text.done", (event) =>
                forwardAssistantText(event, event.text)
            );
            aiClient.on("response.function_call_arguments.done", (event) => {
                const callId = event?.call_id;
                if (!callId || !TOOL_NAMES.has(event.name)) {
                    LOG.warn(`Ignoring unknown tool call "${event?.name}"`);
                    return;
                }
                let args = {};
                try {
                    args = JSON.parse(event.arguments || "{}");
                } catch {
                    // ungueltige Argumente: ohne Argumente weiter
                }
                LOG.info(`Tool call: ${event.name} ${JSON.stringify(args)}`);
                pendingCalls.set(
                    callId,
                    setTimeout(() => {
                        pendingCalls.delete(callId);
                        const finish = () => {
                            aiSend({
                                type: "conversation.item.create",
                                item: {
                                    type: "function_call_output",
                                    call_id: callId,
                                    output: "Timed out while running the action."
                                }
                            });
                            aiSend({ type: "response.create", response: {} });
                        };
                        if (responseActive) {
                            afterResponse.push(finish);
                        } else {
                            finish();
                        }
                    }, TOOL_TIMEOUT_MS)
                );
                send({ type: "tool_call", callId, name: event.name, args });
            });
            aiClient.on("response.done", (event) => {
                responseActive = false;
                ttsResponses.delete(event?.response?.id);
                send({ type: "audio_done" });
                afterResponse.splice(0).forEach((action) => action());
            });
            aiClient.on("error", (event) => {
                const message =
                    event?.error?.message || event?.message || "Unknown error";
                // Abbruch einer nicht mehr aktiven Antwort ist harmlos.
                if (/no active response|not active/i.test(message)) {
                    return;
                }
                LOG.error(
                    "AI Core realtime error:",
                    message,
                    event?.cause?.message || event?.error?.cause?.message || ""
                );
                send({ type: "error", message });
            });

            // Die Session wird bereits beim Verbindungsaufbau erzeugt;
            // falls session.created schon vor dem Registrieren der
            // Listener kam, wird die Konfiguration hier nachgeholt.
            // Sicherstellen, dass der Socket offen ist, bevor gesendet wird.
            const socket = aiClient.socket;
            if (socket && socket.readyState === 0) {
                await new Promise((resolve) => {
                    socket.once("open", resolve);
                    setTimeout(resolve, 5000);
                });
            }
            LOG.info(
                `AI Core socket state: ${aiClient.socket?.readyState ?? "unknown"}`
            );
            configure();

            pending.splice(0).forEach(handleBrowserMessage);
        } catch (error) {
            LOG.error("Could not connect to SAP AI Core:", error.message);
            if (/No deployment matched/i.test(error.message)) {
                await logAvailableDeployments();
            }
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
