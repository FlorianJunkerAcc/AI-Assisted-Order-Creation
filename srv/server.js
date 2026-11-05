import cds from "@sap/cds";
import { attachVoiceProxy } from "./voice/realtime-proxy.js";

// PICO Voice: WebSocket-Endpunkt /pico-voice neben den OData-Services.
cds.on("listening", ({ server }) => attachVoiceProxy(server));
