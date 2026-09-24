const fs = require("fs");
const path = require("path");
const pino = require("pino");
const readline = require("readline");
const { Boom } = require("@hapi/boom");

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    makeInMemoryStore,
    jidDecode,
    proto,
    getContentType,
    downloadContentFromMessage
} = require("@adiwajshing/baileys");

// ============================================================
// GLOBAL BUG BOT - RENDER EDITION
// Automatic WhatsApp pairing + persistent session
// ============================================================

const SESSION_DIR =
    process.env.SESSION_DIR || path.join(process.cwd(), "session");

const AUTO_PAIR =
    String(process.env.RENDER_AUTO_PAIR || "false").toLowerCase() === "true";

const WHATSAPP_NUMBER =
    String(process.env.WHATSAPP_NUMBER || "")
        .replace(/\D/g, "");

const PREFIX = ".";

let reconnectTimer = null;
let starting = false;
let currentSocket = null;

// ============================================================
// Make sure session directory exists
// ============================================================

if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, {
        recursive: true
    });
}

// ============================================================
// In-memory store
// ============================================================

const store = makeInMemoryStore({
    logger: pino({
        level: "silent"
    })
});

const storeFile = path.join(SESSION_DIR, "store.json");

try {
    if (fs.existsSync(storeFile)) {
        store.readFromFile(storeFile);
    }
} catch (error) {
    console.log("Could not load store:", error.message);
}

setInterval(() => {
    try {
        store.writeToFile(storeFile);
    } catch {}
}, 10000);

// ============================================================
// Utility functions
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeJid(jid) {
    if (!jid) return jid;

    if (/:\d+@/.test(jid)) {
        const decoded = jidDecode(jid);

        if (decoded?.user && decoded?.server) {
            return `${decoded.user}@${decoded.server}`;
        }
    }

    return jid;
}

function getMessageText(message) {
    if (!message) return "";

    const type = getContentType(message);

    if (!type) return "";

    const msg = message[type];

    if (!msg) return "";

    return (
        msg.text ||
        msg.caption ||
        msg.contentText ||
        msg.selectedDisplayText ||
        msg.title ||
        ""
    );
}

// ============================================================
// Message serializer
// ============================================================

function serializeMessage(sock, rawMessage) {
    if (!rawMessage) return null;

    const m = rawMessage;

    m.id = m.key?.id;
    m.chat = m.key?.remoteJid;

    m.isGroup =
        typeof m.chat === "string" &&
        m.chat.endsWith("@g.us");

    m.sender = decodeJid(
        m.key?.fromMe
            ? sock.user?.id
            : m.key?.participant || m.chat
    );

    m.fromMe = Boolean(m.key?.fromMe);

    m.mtype = getContentType(m.message) || "";

    m.msg = m.message?.[m.mtype] || {};

    m.text = getMessageText(m.message);

    m.body = m.text;

    m.pushName =
        m.pushName ||
        m.pushName ||
        m.sender?.split("@")[0] ||
        "User";

    // --------------------------------------------------------
    // Quoted message
    // --------------------------------------------------------

    const contextInfo =
        m.msg?.contextInfo ||
        m.message?.extendedTextMessage?.contextInfo;

    if (contextInfo?.quotedMessage) {
        const quotedMessage = contextInfo.quotedMessage;

        const quotedType =
            getContentType(quotedMessage);

        const quotedMsg =
            quotedMessage[quotedType] || {};

        const quotedSender =
            decodeJid(
                contextInfo.participant ||
                m.chat
            );

        m.quoted = {
            key: {
                remoteJid: m.chat,
                fromMe:
                    quotedSender ===
                    decodeJid(sock.user?.id),
                id: contextInfo.stanzaId,
                participant: quotedSender
            },

            message: quotedMessage,

            mtype: quotedType,

            msg: quotedMsg,

            chat: m.chat,

            sender: quotedSender,

            id: contextInfo.stanzaId,

            fromMe:
                quotedSender ===
                decodeJid(sock.user?.id),

            text:
                getMessageText(quotedMessage) ||
                quotedMsg.caption ||
                "",

            mentionedJid:
                contextInfo.mentionedJid || []
        };

        m.quoted.download = async () => {
            return downloadMediaMessage(
                m.quoted,
                "buffer",
                {},
                {
                    logger: pino({
                        level: "silent"
                    })
                }
            );
        };
    } else {
        m.quoted = null;
    }

    // --------------------------------------------------------
    // Reply helper
    // --------------------------------------------------------

    m.reply = async (
        text,
        jid = m.chat,
        options = {}
    ) => {
        if (Buffer.isBuffer(text)) {
            return sock.sendMessage(
                jid,
                {
                    document: text
                },
                {
                    quoted: m,
                    ...options
                }
            );
        }

        return sock.sendMessage(
            jid,
            {
                text: String(text)
            },
            {
                quoted: m,
                ...options
            }
        );
    };

    // --------------------------------------------------------
    // Download helper
    // --------------------------------------------------------

    m.download = async () => {
        if (!m.msg?.url) return null;

        return downloadMediaMessage(
            m,
            "buffer",
            {},
            {
                logger: pino({
                    level: "silent"
                })
            }
        );
    };

    return m;
}

// ============================================================
// Socket compatibility helpers
// ============================================================

function addSocketHelpers(sock) {

    sock.decodeJid = decodeJid;

    sock.getName = async jid => {
        jid = decodeJid(jid);

        if (!jid) return "";

        if (jid.endsWith("@g.us")) {
            try {
                const metadata =
                    await sock.groupMetadata(jid);

                return metadata.subject || jid;
            } catch {
                return jid;
            }
        }

        return (
            sock.contacts?.[jid]?.name ||
            sock.contacts?.[jid]?.notify ||
            jid.split("@")[0]
        );
    };

    sock.sendText = async (
        jid,
        text,
        quoted = null,
        options = {}
    ) => {
        return sock.sendMessage(
            jid,
            {
                text: String(text),
                ...options
            },
            {
                quoted
            }
        );
    };

    sock.sendTextWithMentions = async (
        jid,
        text,
        quoted = null,
        options = {}
    ) => {

        const mentions =
            String(text)
                .match(/@(\d{5,16})/g)
                ?.map(v =>
                    v.replace("@", "") +
                    "@s.whatsapp.net"
                ) || [];

        return sock.sendMessage(
            jid,
            {
                text: String(text),
                mentions,
                ...options
            },
            {
                quoted
            }
        );
    };

    sock.downloadMediaMessage = async message => {
        return downloadContentFromMessage(
            message.msg || message,
            message.mimetype?.split("/")[0] ||
            "document"
        );
    };

    sock.copyNForward = async (
        jid,
        message,
        forceForward = false,
        options = {}
    ) => {
        return sock.sendMessage(
            jid,
            {
                forward: message,
                force: forceForward,
                ...options
            }
        );
    };

    return sock;
}

// ============================================================
// Automatic pairing
// ============================================================

async function requestPairingCode(sock, state) {

    if (state.creds.registered) {
        return;
    }

    if (!AUTO_PAIR) {
        console.log("");
        console.log("Automatic pairing is disabled.");
        console.log(
            "Set RENDER_AUTO_PAIR=true to enable automatic pairing."
        );
        console.log("");

        return;
    }

    if (!WHATSAPP_NUMBER) {
        console.log("");
        console.log("ERROR: WHATSAPP_NUMBER is missing.");
        console.log(
            "Example: 2547XXXXXXXX"
        );
        console.log("");

        return;
    }

    console.log("");
    console.log("==========================================");
    console.log(" GLOBAL BUG BOT - WHATSAPP PAIRING");
    console.log("==========================================");
    console.log("");
    console.log("Number:", WHATSAPP_NUMBER);
    console.log("Requesting pairing code...");
    console.log("");

    try {

        // WhatsApp pairing works more reliably after
        // the socket has had time to initialize.
        await sleep(3000);

        if (state.creds.registered) {
            return;
        }

        const code =
            await sock.requestPairingCode(
                WHATSAPP_NUMBER
            );

        const formatted =
            String(code)
                .match(/.{1,4}/g)
                ?.join("-") ||
            code;

        console.log("");
        console.log("==========================================");
        console.log(" YOUR WHATSAPP PAIRING CODE");
        console.log("==========================================");
        console.log("");
        console.log(`       ${formatted}`);
        console.log("");
        console.log("WhatsApp:");
        console.log("Settings");
        console.log("→ Linked Devices");
        console.log("→ Link a Device");
        console.log("→ Link with phone number instead");
        console.log("");
        console.log("Enter the code shown above.");
        console.log("");
        console.log("==========================================");

    } catch (error) {

        console.error(
            "Pairing code request failed:",
            error?.message || error
        );

    }
}

// ============================================================
// Start bot
// ============================================================

async function startBot() {

    if (starting) {
        return;
    }

    starting = true;

    try {

        console.log("");
        console.log("==========================================");
        console.log(" GLOBAL BUG BOT");
        console.log("==========================================");
        console.log("Session directory:");
        console.log(SESSION_DIR);
        console.log("");

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            SESSION_DIR
        );

        const sock = makeWASocket({

            auth: state,

            printQRInTerminal: false,

            logger: pino({
                level: "silent"
            }),

            browser: [
                "Chrome",
                "Linux",
                "20.0.04"
            ],

            generateHighQualityLinkPreview: true,

            markOnlineOnConnect: false
        });

        currentSocket = sock;

        addSocketHelpers(sock);

        store.bind(sock.ev);

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        // ----------------------------------------------------
        // Pairing
        // ----------------------------------------------------

        if (!state.creds.registered) {

            if (AUTO_PAIR) {
                await requestPairingCode(
                    sock,
                    state
                );
            } else {
                console.log(
                    "No WhatsApp session found."
                );
                console.log(
                    "Enable RENDER_AUTO_PAIR=true for Render pairing."
                );
            }
        }

        // ----------------------------------------------------
        // Connection updates
        // ----------------------------------------------------

        sock.ev.on(
            "connection.update",
            async update => {

                const {
                    connection,
                    lastDisconnect
                } = update;

                if (connection === "connecting") {
                    console.log(
                        "Connecting to WhatsApp..."
                    );
                }

                if (connection === "open") {

                    console.log("");
                    console.log(
                        "=========================================="
                    );
                    console.log(
                        " WhatsApp connected successfully!"
                    );
                    console.log(
                        "=========================================="
                    );
                    console.log("");

                    starting = false;

                    return;
                }

                if (connection === "close") {

                    starting = false;

                    const statusCode =
                        new Boom(
                            lastDisconnect?.error
                        )?.output?.statusCode;

                    console.log("");
                    console.log(
                        "WhatsApp connection closed."
                    );
                    console.log(
                        "Disconnect code:",
                        statusCode
                    );

                    // ------------------------------------------------
                    // Logged out
                    // ------------------------------------------------

                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {

                        console.log("");
                        console.log(
                            "WhatsApp logged out."
                        );
                        console.log(
                            "The saved session was not deleted."
                        );
                        console.log(
                            "Pair again only after removing the old session."
                        );

                        return;
                    }

                    // ------------------------------------------------
                    // Restart required
                    // ------------------------------------------------

                    if (
                        statusCode ===
                        DisconnectReason.restartRequired
                    ) {
                        console.log(
                            "WhatsApp requires a restart."
                        );
                    }

                    // ------------------------------------------------
                    // Reconnect
                    // ------------------------------------------------

                    if (!reconnectTimer) {

                        reconnectTimer =
                            setTimeout(() => {

                                reconnectTimer =
                                    null;

                                console.log(
                                    "Reconnecting..."
                                );

                                startBot();

                            }, 5000);
                    }
                }
            }
        );

        // ----------------------------------------------------
        // Incoming messages
        // ----------------------------------------------------

        sock.ev.on(
            "messages.upsert",
            async ({ messages, type }) => {

                if (type !== "notify") {
                    return;
                }

                for (const message of messages) {

                    if (!message?.message) {
                        continue;
                    }

                    try {

                        const m =
                            serializeMessage(
                                sock,
                                message
                            );

                        if (!m) {
                            continue;
                        }

                        // Ignore status broadcasts
                        if (
                            m.chat ===
                            "status@broadcast"
                        ) {
                            continue;
                        }

                        console.log(
                            `[MESSAGE] ${m.sender}: ${m.text || m.mtype}`
                        );

                        // ------------------------------------------------
                        // Safe basic commands
                        // ------------------------------------------------

                        if (
                            m.text ===
                            `${PREFIX}ping`
                        ) {
                            await m.reply(
                                "🏓 Pong!"
                            );

                            continue;
                        }

                        if (
                            m.text ===
                            `${PREFIX}bot`
                        ) {
                            await m.reply(
                                "🤖 Global Bug Bot is online."
                            );

                            continue;
                        }

                        /*
                         * Intentionally do not load the existing
                         * attack/crash command handler here.
                         *
                         * Your existing painzy.js contains commands
                         * designed to send disruptive payloads to
                         * WhatsApp targets.
                         *
                         * You can connect a legitimate command handler
                         * here after removing those commands.
                         */
                    } catch (error) {

                        console.error(
                            "Message handler error:",
                            error?.message || error
                        );
                    }
                }
            }
        );

    } catch (error) {

        starting = false;

        console.error(
            "Bot startup error:",
            error?.stack || error
        );

        if (!reconnectTimer) {

            reconnectTimer =
                setTimeout(() => {

                    reconnectTimer = null;

                    startBot();

                }, 5000);
        }
    }
}

// ============================================================
// Graceful shutdown
// ============================================================

async function shutdown(signal) {

    console.log(
        `Recei
