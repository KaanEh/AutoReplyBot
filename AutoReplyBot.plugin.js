/**
 * @name DMAutoresponder
 * @author KaanEh
 * @description Antwortet automatisch auf private Nachrichten mit einem einstellbaren Text (Anrufbeantworter-Style).
 * @version 1.0.0
 */

module.exports = class DMAutoresponder {
    constructor() {
        this.defaultSettings = {
            enabled: true,
            replyText: "Hey! Ich bin gerade nicht da und melde mich später.",
            delayMs: 1500,
            cooldownMinutes: 30,
            ignoreBots: true,
            debugMode: false
        };

        this.settings = {};
        this.lastReplyAtByUserId = new Map();
        this.pendingTimeouts = new Set();
        this.seenMessageIds = new Set();
        this.receiverPatchIds = new Set();
        this.subscribedDispatchers = new Set();
        this.messageHandler = this.onDispatcherMessage.bind(this);
        this.loadSettings();
    }

    start() {
        this.loadSettings();
        this.resolveModules();

        if (!this.ChannelStore || !this.UserStore) {
            BdApi.UI.showToast("DMAutoresponder: Konnte benötigte Discord-Module nicht laden.", {type: "error"});
            return;
        }

        this.subscribeAllDispatchers();
        this.patchAllMessageReceivers();

        BdApi.UI.showToast("DMAutoresponder aktiviert.", {type: "success"});
        this.debug("Plugin gestartet.");
    }

    stop() {
        for (const dispatcher of this.subscribedDispatchers.values()) {
            try {
                dispatcher.unsubscribe("MESSAGE_CREATE", this.messageHandler);
            } catch (_) {}
        }
        this.subscribedDispatchers.clear();

        for (const patchId of this.receiverPatchIds.values()) {
            BdApi.Patcher.unpatchAll(patchId);
        }
        this.receiverPatchIds.clear();

        for (const timeoutId of this.pendingTimeouts) {
            clearTimeout(timeoutId);
        }
        this.pendingTimeouts.clear();
        this.seenMessageIds.clear();
        this.debug("Plugin gestoppt.");
    }

    resolveModules() {
        this.DispatcherModules = BdApi.Webpack.getModules(
            (m) => typeof m?.subscribe === "function" && typeof m?.unsubscribe === "function",
            {searchExports: true}
        ) || [];

        this.ChannelStore = BdApi.Webpack.getStore("ChannelStore");
        this.UserStore = BdApi.Webpack.getStore("UserStore");
        this.AuthenticationStore = BdApi.Webpack.getStore("AuthenticationStore");

        this.MessageReceiver =
            BdApi.Webpack.getByKeys("receiveMessage", {searchExports: true}) ||
            BdApi.Webpack.getModule(BdApi.Webpack.Filters.byKeys("receiveMessage"), {searchExports: true});

        this.MessageReceiverModules = BdApi.Webpack.getModules(
            (m) => typeof m?.receiveMessage === "function",
            {searchExports: true}
        ) || [];

        this.MessageSender =
            BdApi.Webpack.getByKeys("sendMessage", {searchExports: true}) ||
            BdApi.Webpack.getModule(BdApi.Webpack.Filters.byKeys("sendMessage"), {searchExports: true});

        this.MessageSenderOwner = null;
        this.MessageSenderKey = null;
        if (typeof BdApi.Webpack.getWithKey === "function") {
            const senderCandidates = [
                BdApi.Webpack.Filters.byKeys("sendMessage", "editMessage"),
                BdApi.Webpack.Filters.byKeys("sendMessage", "sendBotMessage"),
                BdApi.Webpack.Filters.byKeys("sendMessage", "jumpToMessage"),
                BdApi.Webpack.Filters.byKeys("sendMessage")
            ];

            for (const filter of senderCandidates) {
                const found = BdApi.Webpack.getWithKey(filter, {searchExports: true});
                if (!found || !Array.isArray(found)) continue;
                const [owner, key] = found;
                if (owner && key && typeof owner[key] === "function") {
                    this.MessageSenderOwner = owner;
                    this.MessageSenderKey = key;
                    break;
                }
            }
        }
    }

    subscribeAllDispatchers() {
        const dispatchers = [];
        for (const mod of this.DispatcherModules || []) {
            if (mod && typeof mod.subscribe === "function" && typeof mod.unsubscribe === "function") {
                dispatchers.push(mod);
            }
        }

        let subscribedCount = 0;
        dispatchers.forEach((dispatcher) => {
            try {
                dispatcher.subscribe("MESSAGE_CREATE", this.messageHandler);
                this.subscribedDispatchers.add(dispatcher);
                subscribedCount += 1;
            } catch (_) {}
        });

        this.debug(`Dispatcher-Subscriptions aktiv: ${subscribedCount}`);
    }

    patchAllMessageReceivers() {
        const receiverModules = [];
        if (this.MessageReceiver?.receiveMessage) receiverModules.push(this.MessageReceiver);
        for (const mod of this.MessageReceiverModules || []) {
            if (mod && typeof mod.receiveMessage === "function" && !receiverModules.includes(mod)) {
                receiverModules.push(mod);
            }
        }

        let patchedCount = 0;
        receiverModules.forEach((receiver, index) => {
            const patchId = `DMAutoresponder-receiver-${index}`;
            this.receiverPatchIds.add(patchId);
            try {
                BdApi.Patcher.after(patchId, receiver, "receiveMessage", (_, args) => {
                    const message = this.extractMessageFromReceiveArgs(args);
                    this.handleIncomingMessage(message);
                });
                patchedCount += 1;
            } catch (_) {}
        });

        this.debug(`receiveMessage Hooks aktiv: ${patchedCount}`);
    }

    loadSettings() {
        const saved = BdApi.Data.load("DMAutoresponder", "settings") || {};
        this.settings = {...this.defaultSettings, ...saved};
    }

    saveSettings() {
        BdApi.Data.save("DMAutoresponder", "settings", this.settings);
    }

    getSettingsPanel() {
        return BdApi.UI.buildSettingsPanel({
            settings: [
                {
                    type: "switch",
                    id: "enabled",
                    name: "Plugin aktiv",
                    note: "Auto-Antwort ein/aus.",
                    value: Boolean(this.settings.enabled)
                },
                {
                    type: "text",
                    id: "replyText",
                    name: "Auto-Antwort Text",
                    note: "Variablen: ${user}, ${username}, ${tag}, ${time}, ${date} (auch §{...} wird unterstützt).",
                    value: String(this.settings.replyText ?? "")
                },
                {
                    type: "number",
                    id: "delayMs",
                    name: "Verzögerung (ms)",
                    note: "Wartezeit vor der Antwort in Millisekunden.",
                    value: Number(this.settings.delayMs ?? 1500),
                    min: 0,
                    max: 600000
                },
                {
                    type: "number",
                    id: "cooldownMinutes",
                    name: "Cooldown (Minuten)",
                    note: "Antwort pro Nutzer nur einmal in diesem Zeitraum.",
                    value: Number(this.settings.cooldownMinutes ?? 30),
                    min: 0,
                    max: 10080
                },
                {
                    type: "switch",
                    id: "ignoreBots",
                    name: "Bots ignorieren",
                    note: "Nicht auf Bot-Nachrichten antworten.",
                    value: Boolean(this.settings.ignoreBots)
                },
                {
                    type: "switch",
                    id: "debugMode",
                    name: "Debug-Modus",
                    note: "Zeigt Debug-Infos als Toast + Konsole an.",
                    value: Boolean(this.settings.debugMode)
                }
            ],
            onChange: (...args) => {
                const settingId = args.length === 3 ? args[1] : args[0];
                const value = args.length === 3 ? args[2] : args[1];

                if (settingId === "delayMs" || settingId === "cooldownMinutes") {
                    this.settings[settingId] = this.toPositiveInt(value);
                } else {
                    this.settings[settingId] = value;
                }
                this.saveSettings();
            }
        });
    }

    toPositiveInt(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    }

    onDispatcherMessage(event) {
        const message = this.extractMessageFromDispatcherEvent(event);
        this.handleIncomingMessage(message);
    }

    extractMessageFromDispatcherEvent(event) {
        if (!event || typeof event !== "object") return null;

        // Häufige Form: {message: {...}}
        if (event.message && typeof event.message === "object") return event.message;

        // Manche Builds liefern die Message direkt.
        if ((event.channel_id || event.channelId) && (event.author || event.authorId)) return event;

        // Fallback: irgendwo eingebettete Message suchen.
        const candidates = [
            event.payload,
            event.data,
            event.optimisticMessage,
            event.record
        ];

        for (const item of candidates) {
            if (!item || typeof item !== "object") continue;
            if (item.message && typeof item.message === "object") return item.message;
            if ((item.channel_id || item.channelId) && (item.author || item.authorId)) return item;
        }

        return null;
    }

    extractMessageFromReceiveArgs(args) {
        for (const arg of args) {
            if (!arg || typeof arg !== "object") continue;
            if (arg.message && typeof arg.message === "object") return arg.message;
            if (arg.author && arg.channel_id && arg.id) return arg;
        }
        return null;
    }

    handleIncomingMessage(message) {
        if (!message || !this.settings.enabled) return;

        if (message.id) {
            if (this.seenMessageIds.has(message.id)) return;
            this.seenMessageIds.add(message.id);
        }

        if (this.seenMessageIds.size > 2000) {
            this.seenMessageIds.clear();
        }

        const channelId = message.channel_id ?? message.channelId;
        if (!channelId) return;

        const authorId = message.author?.id ?? message.authorId;
        if (!authorId) return;

        const author = message.author || this.UserStore.getUser?.(authorId);
        const currentUser = this.UserStore.getCurrentUser();
        if (!currentUser) return;

        if (authorId === currentUser.id) return;
        if (this.settings.ignoreBots && author?.bot) return;

        const channel = this.ChannelStore.getChannel(channelId);
        if (!channel) return;

        if (channel.type !== 1 && channel.type !== "DM") return;

        const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
        if (recipients.length > 0 && !recipients.includes(authorId)) return;

        const now = Date.now();
        const cooldownMs = Math.max(0, Number(this.settings.cooldownMinutes || 0)) * 60_000;
        const lastReplyAt = this.lastReplyAtByUserId.get(authorId) || 0;
        if (now - lastReplyAt < cooldownMs) return;

        const replyText = this.buildReplyText(message).trim();
        if (!replyText) return;

        this.lastReplyAtByUserId.set(authorId, now);

        const timeoutId = setTimeout(() => {
            this.pendingTimeouts.delete(timeoutId);
            void this.sendReply(channelId, replyText);
        }, Math.max(0, Number(this.settings.delayMs || 0)));

        this.pendingTimeouts.add(timeoutId);
    }

    async sendReply(channelId, content) {
        try {
            if (
                (!this.MessageSender || typeof this.MessageSender.sendMessage !== "function") &&
                (!this.MessageSenderOwner || !this.MessageSenderKey || typeof this.MessageSenderOwner[this.MessageSenderKey] !== "function")
            ) {
                this.resolveModules();
            }
            if (
                (!this.MessageSender || typeof this.MessageSender.sendMessage !== "function") &&
                (!this.MessageSenderOwner || !this.MessageSenderKey || typeof this.MessageSenderOwner[this.MessageSenderKey] !== "function")
            ) {
                this.debug("sendReply: sendMessage nicht gefunden.");
                return;
            }

            const sendRaw = (...args) => {
                if (this.MessageSenderOwner && this.MessageSenderKey && typeof this.MessageSenderOwner[this.MessageSenderKey] === "function") {
                    return this.MessageSenderOwner[this.MessageSenderKey].apply(this.MessageSenderOwner, args);
                }
                return this.MessageSender.sendMessage(...args);
            };

            const variants = [
                () => sendRaw(channelId, {
                    content,
                    tts: false,
                    invalidEmojis: [],
                    validNonShortcutEmojis: [],
                    nonce: Date.now().toString()
                }),
                () => sendRaw(channelId, {
                    content,
                    tts: false,
                    nonce: Date.now().toString()
                }),
                () => sendRaw(channelId, {content}),
                () => sendRaw(channelId, content)
            ];

            let lastError = null;
            for (let i = 0; i < variants.length; i++) {
                try {
                    const result = variants[i]();
                    await Promise.resolve(result);
                    return;
                } catch (error) {
                    lastError = error;
                }
            }

            const httpSent = await this.sendReplyViaHttp(channelId, content);
            if (httpSent) return;

            BdApi.UI.showToast("DMAutoresponder: Senden fehlgeschlagen.", {type: "error"});
            this.debug(`Senden fehlgeschlagen. Letzter Fehler: ${lastError?.message || String(lastError)}`);
        } catch (error) {
            this.debug(`sendReply Exception: ${error?.message || String(error)}`);
            console.error("[DMAutoresponder] Fehler beim Senden:", error);
        }
    }

    async sendReplyViaHttp(channelId, content) {
        try {
            const token = this.AuthenticationStore?.getToken?.();
            if (!token) {
                return false;
            }

            const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
                method: "POST",
                headers: {
                    "Authorization": token,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    content,
                    tts: false,
                    nonce: Date.now().toString()
                })
            });

            if (!response.ok) {
                return false;
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    debug(message, force = false) {
        if (!this.settings.debugMode && !force) return;
        console.log(`[DMAutoresponder][Debug] ${message}`);
    }

    buildReplyText(message) {
        const rawText = String(this.settings.replyText || "");
        const authorId = message?.author?.id ?? message?.authorId;
        const user = message?.author || this.UserStore.getUser?.(authorId);
        const username = user?.username || "Unbekannt";
        const globalName = user?.globalName || username;
        const tag = user?.discriminator && user.discriminator !== "0"
            ? `${username}#${user.discriminator}`
            : username;
        const now = new Date();

        const replacements = {
            user: globalName,
            username,
            tag,
            time: now.toLocaleTimeString("de-DE"),
            date: now.toLocaleDateString("de-DE")
        };

        return rawText.replace(/(?:\$|§)\{(user|username|tag|time|date)\}/g, (match, key) => {
            return replacements[key] ?? match;
        });
    }
};
