sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/model/json/JSONModel",
        "sap/ui/core/Fragment",
        "sap/ui/model/Filter",
        "sap/ui/model/FilterOperator",
        "sap/m/MessageToast",
        "sap/m/MessageBox",
        "com/prototype/salesorderai/salesorderui/ext/voice/PicoVoice"
    ],
    function (
        PageController,
        JSONModel,
        Fragment,
        Filter,
        FilterOperator,
        MessageToast,
        MessageBox,
        PicoVoice
    ) {
        "use strict";
        return PageController.extend(
            "com.prototype.salesorderai.salesorderui.ext.view.Main",
            {
                onInit: function () {
                    PageController.prototype.onInit.apply(
                        this,
                        arguments
                    );
                    this.getView().setModel(
                        new JSONModel({
                            items: [],
                            orderTotal: "0.00",
                            itemCount: 0,
                            canCreate: false
                        }),
                        "order"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            question: "",
                            quantity: 1,
                            suggestions: [],
                            pending: []
                        }),
                        "clarification"
                    );
                    // Rueckfrage speziell fuer die Kundenauswahl
                    // (select_customer). Kein "quantity"/"pending" noetig,
                    // da hier immer nur eine einzelne Rueckfrage entsteht.
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            question: "",
                            suggestions: []
                        }),
                        "customerClarification"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            recommendations: []
                        }),
                        "recommendation"
                    );
                    // Ergebnis von "Generate order draft": sichere Items
                    // (autoItems, bereits im Auftrag) und Vorschlaege
                    // (suggestions, vom Nutzer zu bestaetigen) inkl.
                    // Begruendung pro Item ("Why?").
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            message: "",
                            hasAuto: false,
                            hasSuggestions: false,
                            autoItems: [],
                            suggestions: []
                        }),
                        "draft"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            message: "",
                            warnings: []
                        }),
                        "validation"
                    );
                    // PICO: chatOpen steuert Sichtbarkeit des schwebenden
                    // Chat-Panels. greetingVisible/messageVisible/message
                    // steuern Begruessung bzw. Router-Nachrichten
                    // (Rueckfragen, "nur eine Funktion pro Befehl",
                    // freundliche Ablehnung) innerhalb des Panels.
                    this.getView().setModel(
                        new JSONModel({
                            chatOpen: false,
                            greetingVisible: false,
                            messageVisible: false,
                            message: "",
                            showAllSkills: false,
                            // Sprachausgabe (Vorlesen von PICOs Antworten)
                            speechEnabled: this._loadSpeechEnabled(),
                            speechSupported: PicoVoice.isSupported(),
                            chips: [],
                            // Chat-Verlauf: { role: "user" | "pico", text }
                            // Wird aus dem sessionStorage wiederhergestellt,
                            // damit er einen Reload ueberlebt.
                            messages: this._loadChatMessages()
                        }),
                        "pico"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            recognizedCommand: "",
                            isAiProcessing: false,
                            canSubmitAiCommand: false
                        }),
                        "ui"
                    );
                },
                onAddProduct: function () {
                    this._productEntryMode = true;
                    this._productOrderContext = null;
                    this._openProductValueHelp();
                },
                onHeaderChange: function () {
                    this._clearAiResultAreas();
                    this._updateCreateEnabled();
                    this._refreshPicoChips();
                },
                /**
                 * Baut die Beispiel-Chips der PICO-Begruessung passend zum
                 * aktuellen Zustand auf (Kunde gewaehlt? Positionen im
                 * Entwurf?). "send" = Befehl ist vollstaendig und wird
                 * direkt abgeschickt; sonst nur ins Eingabefeld geschrieben,
                 * damit der Nutzer ihn ergaenzen kann.
                 */
                _refreshPicoChips: function () {
                    const oPicoModel = this.getView().getModel("pico");
                    const oOrderModel = this.getView().getModel("order");
                    const oCustomerSelect = this.byId("customerSelect");
                    if (!oPicoModel || !oOrderModel) {
                        return;
                    }
                    const bCustomer = Boolean(
                        oCustomerSelect && oCustomerSelect.getSelectedItem()
                    );
                    const bItems = (oOrderModel.getProperty("/items") || [])
                        .some((oItem) => oItem.product_ID);
                    const oBundle =
                        this.getView().getModel("i18n").getResourceBundle();

                    let aChips;
                    if (!bCustomer) {
                        aChips = [
                            ["picoChipSelectCustomer", false],
                            ["picoChipCopyOtherCustomer", false],
                            ["picoChipAddItems", false]
                        ];
                    } else if (!bItems) {
                        aChips = [
                            ["picoChipDraft", true],
                            ["picoChipCopyLast", true],
                            ["picoChipSuggest", true],
                            ["picoChipAddItems", false]
                        ];
                    } else {
                        aChips = [
                            ["picoChipValidate", true],
                            ["picoChipSuggestMore", true],
                            ["picoChipChangeQuantity", false],
                            ["picoChipRemove", false]
                        ];
                    }

                    const aChipObjects = aChips.map(
                        ([sKey, bSend]) => {
                            const sText = oBundle.getText(sKey).trim();
                            return {
                                // Unvollstaendige Befehle enden mit einem
                                // Leerzeichen (zum Weitertippen) und werden
                                // mit "..." angezeigt.
                                command: bSend ? sText : sText + " ",
                                label: bSend ? sText : sText + " …",
                                send: bSend,
                                // Sofort ausfuehren = Papierflieger +
                                // hervorgehoben; ergaenzen = Stift + Standard.
                                icon: bSend
                                    ? "sap-icon://paper-plane"
                                    : "sap-icon://edit",
                                type: bSend ? "Emphasized" : "Default",
                                tooltip: oBundle.getText(
                                    bSend ? "picoChipTipSend" : "picoChipTipEdit"
                                )
                            };
                        }
                    );
                    oPicoModel.setProperty("/chips", aChipObjects);

                    // Fragt die neueste Sprechblase gerade nach dem naechsten
                    // Schritt, bleiben ihre Vorschlaege aktuell.
                    const aMessages = oPicoModel.getProperty("/messages") || [];
                    const iLast = aMessages.length - 1;
                    if (iLast >= 0 && aMessages[iLast].askNext) {
                        oPicoModel.setProperty(
                            `/messages/${iLast}/chips`,
                            aChipObjects.map((oChip) => Object.assign({}, oChip))
                        );
                    }
                },
                /**
                 * Chat-Verlauf: haengt eine Sprechblase an und scrollt nach
                 * unten. role "user" = Eingabe des Nutzers, "pico" = Antwort.
                 */
                _addChatMessage: function (sRole, sText, aChips) {
                    const oPicoModel = this.getView().getModel("pico");
                    if (!oPicoModel || !sText) {
                        return;
                    }
                    // PICO startet immer auf Englisch. Hat der Nutzer
                    // zuletzt auf Deutsch geschrieben, wird PICOs Antwort
                    // vor der Anzeige uebersetzt. Alle Eintraege laufen dann
                    // durch eine Warteschlange, damit die Reihenfolge im
                    // Chat stimmt.
                    const bTranslate =
                        sRole === "pico" && this._picoLanguage === "de";
                    if (!bTranslate && !this._chatPending) {
                        this._appendChatMessage(sRole, sText, aChips);
                        return;
                    }
                    this._chatPending = (this._chatPending || 0) + 1;
                    this._chatQueue = (this._chatQueue || Promise.resolve())
                        .then(async () => {
                            const sShown = bTranslate
                                ? await this._translateReply(sText)
                                : sText;
                            this._appendChatMessage(sRole, sShown, aChips);
                        })
                        .catch((oError) => {
                            console.error("Adding chat message failed:", oError);
                        })
                        .finally(() => {
                            this._chatPending -= 1;
                        });
                },
                _translateReply: async function (sText) {
                    try {
                        const oBinding = this.getView().getModel()
                            .bindContext("/translateReply(...)");
                        oBinding.setParameter("text", sText);
                        oBinding.setParameter("language", "de");
                        await oBinding.execute();
                        const oResult =
                            await oBinding.getBoundContext().requestObject();
                        return (oResult && oResult.text) || sText;
                    } catch (oError) {
                        console.warn("Could not translate reply:", oError);
                        return sText;
                    }
                },
                _appendChatMessage: function (sRole, sText, aChips) {
                    const oPicoModel = this.getView().getModel("pico");
                    // Vorschlaege stehen nur in der jeweils neuesten
                    // Sprechblase; aeltere werden entfernt.
                    const aMessages = (
                        oPicoModel.getProperty("/messages") || []
                    ).map((oMessage) => Object.assign(
                        {}, oMessage, { chips: [], askNext: false }
                    )).concat([{
                        role: sRole,
                        text: sText,
                        chips: aChips || [],
                        askNext: Boolean(aChips)
                    }]);
                    oPicoModel.setProperty("/messages", aMessages);
                    this._saveChatMessages(aMessages);
                    if (sRole === "pico") {
                        this._speak(sText);
                    }
                    setTimeout(() => {
                        const oBody = this.byId("picoChatBody");
                        const oDom = oBody && oBody.getDomRef();
                        if (oDom) {
                            oDom.scrollTop = oDom.scrollHeight;
                        }
                    }, 50);
                },
                /**
                 * Chat-Verlauf im sessionStorage (gilt pro Browser-Tab).
                 * Gespeichert werden nur Rolle, Text und askNext; die
                 * Vorschlags-Chips werden beim Oeffnen aus dem aktuellen
                 * Zustand neu aufgebaut (_refreshPicoChips).
                 */
                _loadChatMessages: function () {
                    try {
                        const aStored = JSON.parse(
                            window.sessionStorage.getItem("picoChat") || "[]"
                        );
                        return Array.isArray(aStored)
                            ? aStored
                                .filter((oMessage) =>
                                    oMessage && oMessage.text)
                                .map((oMessage) => ({
                                    role: oMessage.role === "user"
                                        ? "user" : "pico",
                                    text: String(oMessage.text),
                                    chips: [],
                                    askNext: Boolean(oMessage.askNext)
                                }))
                            : [];
                    } catch (e) {
                        return [];
                    }
                },
                _saveChatMessages: function (aMessages) {
                    try {
                        if (!aMessages || aMessages.length === 0) {
                            window.sessionStorage.removeItem("picoChat");
                            return;
                        }
                        window.sessionStorage.setItem(
                            "picoChat",
                            JSON.stringify(aMessages.map((oMessage) => ({
                                role: oMessage.role,
                                text: oMessage.text,
                                askNext: Boolean(oMessage.askNext)
                            })))
                        );
                    } catch (e) {
                        // sessionStorage nicht verfuegbar: Verlauf gilt nur
                        // bis zum Neuladen.
                    }
                },
                /**
                 * Sprachausgabe (Web Speech API, laeuft im Browser).
                 * Die Einstellung wird im localStorage gemerkt.
                 */
                _loadSpeechEnabled: function () {
                    try {
                        return window.localStorage.getItem("picoSpeech") === "on";
                    } catch (e) {
                        return false;
                    }
                },
                /**
                 * Realtime-Stimme (GPT Realtime, Stimme "alloy") ueber den
                 * CAP-Proxy /pico-voice.
                 */
                _getVoice: function () {
                    if (!this._voice) {
                        this._voice = new PicoVoice((sMessage) => {
                            console.error("PICO voice:", sMessage);
                            MessageToast.show("Voice: " + sMessage);
                        });
                    }
                    return this._voice;
                },
                _speak: function (sText) {
                    const oPicoModel = this.getView().getModel("pico");
                    if (!PicoVoice.isSupported() || !oPicoModel ||
                        !oPicoModel.getProperty("/speechEnabled")) {
                        return;
                    }
                    this._getVoice().speak(sText);
                },
                _stopSpeaking: function () {
                    if (this._voice) {
                        this._voice.stopSpeaking();
                    }
                },
                onExit: function () {
                    if (this._voice) {
                        this._voice.destroy();
                        this._voice = null;
                    }
                },
                onToggleSpeech: function () {
                    const oPicoModel = this.getView().getModel("pico");
                    const bEnabled = !oPicoModel.getProperty("/speechEnabled");
                    oPicoModel.setProperty("/speechEnabled", bEnabled);
                    try {
                        window.localStorage.setItem(
                            "picoSpeech", bEnabled ? "on" : "off"
                        );
                    } catch (e) {
                        // localStorage nicht verfuegbar: Einstellung gilt nur
                        // fuer diese Sitzung.
                    }
                    if (bEnabled) {
                        // Klick = Nutzergeste: Audio freischalten.
                        this._getVoice().unlock();
                        // Kurze Rueckmeldung, damit man hoert, dass es klappt.
                        this._speak("Voice output is on.");
                    } else {
                        this._stopSpeaking();
                    }
                },
                _userSay: function (sText) {
                    this._addChatMessage("user", sText);
                },
                /**
                 * PICO antwortet im Chat. Mit bAskNext fragt PICO am Ende,
                 * wie es weitergehen soll; passende Vorschlaege dazu stehen
                 * als Chips unter dem Verlauf.
                 */
                _picoSay: function (sText, bAskNext) {
                    // Laeuft ein mehrteiliger Befehl, werden die Antworten
                    // der Schritte gesammelt und am Ende als EINE
                    // zusammenhaengende Antwort ausgegeben (_flushCollected).
                    if (this._collected) {
                        this._collected.push({ text: sText, askNext: bAskNext });
                        return;
                    }
                    // Mitten in einem mehrteiligen Befehl keine "What next?"-Frage.
                    if (this._moreSteps) {
                        bAskNext = false;
                    }
                    if (!bAskNext) {
                        this._addChatMessage("pico", sText);
                        return;
                    }
                    // Stand der Vorschlaege aktualisieren und direkt in
                    // die Sprechblase legen.
                    this._refreshPicoChips();
                    const aChips = (
                        this.getView().getModel("pico").getProperty("/chips") ||
                        []
                    ).map((oChip) => Object.assign({}, oChip));
                    // bAskNext === "chips": nur die Vorschlaege anhaengen, ohne
                    // die Frage (der Text stellt bereits eine eigene Frage).
                    this._addChatMessage(
                        "pico",
                        bAskNext === "chips"
                            ? sText
                            : `${sText} What would you like to do next?`,
                        aChips
                    );
                },
                /**
                 * Klick auf einen Beispiel-Chip: Befehl ins Eingabefeld
                 * uebernehmen und - falls vollstaendig - direkt senden.
                 */
                onPicoChipPress: function (oEvent) {
                    const oChip = oEvent.getSource()
                        .getBindingContext("pico").getObject();
                    const oUiModel = this.getView().getModel("ui");
                    const oInput = this.byId("aiOrderInput");

                    oUiModel.setProperty("/recognizedCommand", oChip.command);
                    oInput.setValue(oChip.command);
                    this._updateAiSubmitState();

                    if (oChip.send) {
                        this._chipPrefix = null;
                        this.onAskPico();
                    } else {
                        // Merken, damit eine anschliessende Spracheingabe
                        // den Anfang nicht ersetzt, sondern ergaenzt.
                        this._chipPrefix = oChip.command;
                        oInput.focus();
                    }
                },
                /**
                 * Zeigt bzw. verbirgt die vollstaendige Funktionsliste
                 * ("What can PICO do?").
                 */
                onToggleAllSkills: function () {
                    const oPicoModel = this.getView().getModel("pico");
                    oPicoModel.setProperty(
                        "/showAllSkills",
                        !oPicoModel.getProperty("/showAllSkills")
                    );
                },
                onAIInputChange: function () {
                    const sValue =
                        this.byId("aiOrderInput").getValue();
                    const oUiModel = this.getView().getModel("ui");
                    oUiModel.setProperty(
                        "/recognizedCommand",
                        sValue
                    );
                    this._updateAiSubmitState();
                },
                _updateAiSubmitState: function () {
                    const oUiModel = this.getView().getModel("ui");
                    const sCommand =
                        oUiModel.getProperty("/recognizedCommand") || "";
                    const bProcessing = Boolean(
                        oUiModel.getProperty("/isAiProcessing")
                    );
                    oUiModel.setProperty(
                        "/canSubmitAiCommand",
                        Boolean(sCommand.trim()) && !bProcessing
                    );
                },
                /**
                 * Setzt die Ergebnisbereiche ALLER PICO-Funktionen
                 * zurueck (Customer Clarification, Product Clarification,
                 * Order Draft, Recommendation, Validation).
                 *
                 * Wichtig: "question" wird explizit auf "" zurueckgesetzt,
                 * nicht nur "visible" auf false - die XML-View prueft bei
                 * beiden Clarification-Bereichen zusaetzlich, dass
                 * "question" nicht leer ist, bevor die Box angezeigt wird.
                 * Das verhindert zuverlaessig eine leere, inhaltslose
                 * "PICO needs clarification"-Box.
                 *
                 * Wird zentral aufgerufen, statt jede Funktion nur ihr
                 * eigenes Ergebnis setzen zu lassen: sonst bliebe z.B.
                 * eine vorherige Produktempfehlung sichtbar, waehrend
                 * bereits das Ergebnis der Auftragsvalidierung angezeigt
                 * wird. Aufrufstellen: bei jedem neu erkannten Intent
                 * (onAskPico, Status "ok"), beim Oeffnen des Chat-Panels,
                 * beim Kundenwechsel (onHeaderChange) und beim
                 * Zuruecksetzen des Formulars.
                 */
                _clearAiResultAreas: function () {
                    this.getView().getModel("customerClarification").setData({
                        visible: false,
                        question: "",
                        suggestions: []
                    });
                    this.getView().getModel("clarification").setData({
                        visible: false,
                        question: "",
                        quantity: 1,
                        suggestions: [],
                        pending: []
                    });
                    this.getView().getModel("recommendation").setData({
                        visible: false,
                        recommendations: []
                    });
                    this.getView().getModel("draft").setData({
                        visible: false,
                        message: "",
                        hasAuto: false,
                        hasSuggestions: false,
                        autoItems: [],
                        suggestions: []
                    });
                    this.getView().getModel("validation").setData({
                        visible: false,
                        message: "",
                        warnings: []
                    });
                },
                /**
                 * Entfernt eine Position aus dem Auftragsentwurf.
                 */
                onDeleteProduct: function (oEvent) {
                    const oOrderModel =
                        this.getView().getModel("order");
                    const oContext =
                        oEvent.getSource().getBindingContext("order");
                    const sPath = oContext.getPath();
                    const iIndex = Number(
                        sPath.split("/").pop()
                    );
                    const aItems =
                        oOrderModel.getProperty("/items");
                    aItems.splice(iIndex, 1);
                    oOrderModel.setProperty(
                        "/items",
                        aItems
                    );
                    this._calculateOrderTotal();
                },
                onProductValueHelpRequest: function (oEvent) {
                    this._productOrderContext =
                        oEvent.getSource().getBindingContext("order");
                    this._productEntryMode = false;
                    this._openProductValueHelp();
                },
                _openProductValueHelp: function () {
                    if (!this._productValueHelpPromise) {
                        this._productValueHelpPromise = Fragment.load({
                            id: this.getView().getId(),
                            name: "com.prototype.salesorderai.salesorderui.ext.fragment.ProductValueHelp",
                            controller: this
                        }).then(function (oDialog) {
                            this.getView().addDependent(oDialog);
                            return oDialog;
                        }.bind(this));
                    }
                    this._productValueHelpPromise
                        .then(function (oDialog) {
                            this._clearProductFilterFields();
                            const oProductBinding = this.byId(
                                "productTable"
                            ).getBinding("items");
                            if (oProductBinding) {
                                oProductBinding.refresh();
                            }
                            oDialog.open();
                        }.bind(this))
                        .catch(function (oError) {
                            console.error(
                                "Could not open product value help:",
                                oError
                            );
                            MessageBox.error(
                                "The product selection could not be opened."
                            );
                        });
                },
                onProductTableUpdateFinished: function (oEvent) {
                    const oTable = oEvent.getSource();
                    const aItems = this.getView()
                        .getModel("order")
                        .getProperty("/items") || [];
                    oTable.getItems().forEach(function (oItem) {
                        const oContext = oItem.getBindingContext();
                        const sProductId = oContext &&
                            oContext.getProperty("ID");
                        // Ein Produkt ohne gültige ID darf niemals als
                        // "bereits enthalten" markiert werden. Das verhindert
                        // false positives, falls product_ID oder ID undefined ist.
                        if (!sProductId) {
                            oItem.toggleStyleClass(
                                "productAlreadyInOrder",
                                false
                            );
                            return;
                        }
                        const bAlreadyInOrder = aItems.some(
                            function (oOrderItem) {
                                return Boolean(oOrderItem.product_ID) &&
                                    String(oOrderItem.product_ID) === String(sProductId);
                            }
                        );
                        oItem.toggleStyleClass(
                            "productAlreadyInOrder",
                            bAlreadyInOrder
                        );
                    });
                },
                onApplyProductFilters: function () {
                    this._applyProductFilters();
                },
                _applyProductFilters: function () {
                    const oDialog = this.byId("productValueHelpDialog");
                    if (!oDialog) {
                        return;
                    }
                    const oBinding = this.byId(
                        "productTable"
                    ).getBinding("items");
                    const oProductNumber = this.byId(
                        "productNumberFilter"
                    );
                    const oProductCategory = this.byId(
                        "productCategoryFilter"
                    );
                    const oSearchField = this.byId(
                        "productFreeTextFilter"
                    );
                    const sProductNumber = oProductNumber
                        ? oProductNumber.getValue().trim()
                        : "";
                    const sProductCategory = oProductCategory
                        ? oProductCategory.getValue().trim()
                        : "";
                    const sFreeText = oSearchField
                        ? oSearchField.getValue().trim()
                        : "";
                    const aFilters = [];
                    if (sFreeText) {
                        aFilters.push(new Filter({
                            filters: [
                                new Filter(
                                    "productNumber",
                                    FilterOperator.Contains,
                                    sFreeText
                                ),
                                new Filter(
                                    "name",
                                    FilterOperator.Contains,
                                    sFreeText
                                ),
                                new Filter(
                                    "productCategoryID",
                                    FilterOperator.Contains,
                                    sFreeText
                                )
                            ],
                            and: false
                        }));
                    }
                    if (sProductNumber) {
                        const bPrefixSearch =
                            sProductNumber.endsWith("*");
                        const sProductNumberQuery = bPrefixSearch
                            ? sProductNumber.slice(0, -1)
                            : sProductNumber;
                        if (sProductNumberQuery) {
                            aFilters.push(new Filter(
                                "productNumber",
                                bPrefixSearch
                                    ? FilterOperator.StartsWith
                                    : FilterOperator.Contains,
                                sProductNumberQuery
                            ));
                        }
                    }
                    if (sProductCategory) {
                        aFilters.push(new Filter(
                            "productCategoryID",
                            FilterOperator.Contains,
                            sProductCategory
                        ));
                    }
                    oBinding.filter(aFilters);
                },
                onClearProductFilters: function () {
                    this._clearProductFilterFields();
                    this._applyProductFilters();
                },
                _clearProductFilterFields: function () {
                    const oProductNumber = this.byId(
                        "productNumberFilter"
                    );
                    const oProductCategory = this.byId(
                        "productCategoryFilter"
                    );
                    if (oProductNumber) {
                        oProductNumber.setValue("");
                    }
                    if (oProductCategory) {
                        oProductCategory.setValue("");
                    }
                    const oSearchField = this.byId(
                        "productFreeTextFilter"
                    );
                    if (oSearchField) {
                        oSearchField.setValue("");
                    }
                },
                onProductValueHelpConfirm: async function () {
                    const oSelectedItem = this.byId(
                        "productTable"
                    ).getSelectedItem();
                    const oOrderContext = this._productOrderContext;
                    if (!oSelectedItem ||
                        (!oOrderContext && !this._productEntryMode)) {
                        MessageBox.warning("Please select a product.");
                        return;
                    }
                    try {
                        const oProductContext =
                            oSelectedItem.getBindingContext();
                        if (this._productEntryMode) {
                            const sProductID =
                                await oProductContext.requestProperty("ID");
                            const sProductName =
                                await oProductContext.requestProperty("name");
                            const sUnit =
                                await oProductContext.requestProperty("unit");
                            const vPrice =
                                await oProductContext.requestProperty("price");
                            const oOrderModel =
                                this.getView().getModel("order");
                            const aItems =
                                oOrderModel.getProperty("/items") || [];
                            const sNormalizedProductID =
                                String(sProductID).trim();
                            const iExistingIndex = aItems.findIndex(
                                function (oItem) {
                                    return String(oItem.product_ID).trim() ===
                                        sNormalizedProductID;
                                }
                            );
                            const fUnitPrice = Number(vPrice || 0);
                            let iFocusIndex;
                            if (iExistingIndex >= 0) {
                                const oExistingItem =
                                    aItems[iExistingIndex];
                                oExistingItem.quantity =
                                    Number(oExistingItem.quantity) + 1;
                                oExistingItem.totalPrice = (
                                    oExistingItem.quantity *
                                    Number(oExistingItem.unitPrice)
                                ).toFixed(2);
                                iFocusIndex = iExistingIndex;
                                MessageToast.show(
                                    `Quantity of ${oExistingItem.productName} ` +
                                    `updated to ${oExistingItem.quantity}.`
                                );
                            } else {
                                aItems.push({
                                    product_ID: sProductID,
                                    productName: sProductName,
                                    unit: sUnit,
                                    quantity: 1,
                                    unitPrice: fUnitPrice.toFixed(2),
                                    totalPrice: fUnitPrice.toFixed(2)
                                });
                                iFocusIndex = aItems.length - 1;
                                MessageToast.show(
                                    `${sProductName} added to the order.`
                                );
                            }
                            oOrderModel.setProperty("/items", aItems);
                            this._calculateOrderTotal();
                            this._focusOrderQuantity(iFocusIndex);
                            const oDependencies =
                                await this._loadDependencyItems(sProductID, 1);
                            if (oDependencies.items.length > 0) {
                                this._addAiItemsToOrder(oDependencies.items);
                            }
                            if (oDependencies.message) {
                                MessageBox.information(oDependencies.message);
                                this._picoSay(oDependencies.message);
                            }
                        } else {
                            await this._setSelectedProduct(
                                oProductContext,
                                oOrderContext
                            );
                        }
                        this.byId("productValueHelpDialog").close();
                        this._productOrderContext = null;
                        this._productEntryMode = false;
                    } catch (oError) {
                        console.error(
                            "Could not read product:",
                            oError
                        );
                        MessageBox.error(
                            "The product price could not be read."
                        );
                    }
                },
                onProductValueHelpCancel: function () {
                    this._productOrderContext = null;
                    this._productEntryMode = false;
                    this.byId("productValueHelpDialog").close();
                },
                /**
                 * Pflicht-Unterprodukte: Hat das Produkt hinterlegte
                 * Unterprodukte, werden sie (in der hinterlegten Reihenfolge)
                 * mit in den Auftrag aufgenommen. Gibt den Hinweistext fuer
                 * den Nutzer zurueck ("" wenn es keine gibt). Fehler brechen
                 * das Hinzufuegen des Hauptprodukts nicht ab.
                 */
                _loadDependencyItems: async function (sProductID, iQuantity) {
                    try {
                        const oBinding = this.getView().getModel().bindContext(
                            "/getProductDependencies(...)"
                        );
                        oBinding.setParameter("productId", String(sProductID));
                        oBinding.setParameter(
                            "quantity",
                            Math.max(1, Number(iQuantity) || 1)
                        );
                        await oBinding.execute();
                        const oResult =
                            await oBinding.getBoundContext().requestObject();
                        return {
                            message: oResult.message || "",
                            items: Array.isArray(oResult.items)
                                ? oResult.items
                                : [],
                            missing: Array.isArray(oResult.missing)
                                ? oResult.missing
                                : []
                        };
                    } catch (oError) {
                        console.error(
                            "Could not load product dependencies:",
                            oError
                        );
                        return { message: "", items: [], missing: [] };
                    }
                },
                /**
                 * Ergaenzt eine Liste neuer Positionen um die Pflicht-
                 * Unterprodukte. Die Unterprodukte stehen direkt hinter
                 * ihrem Hauptprodukt, in der hinterlegten Reihenfolge.
                 * Ist ein Unterprodukt schon Teil der Liste (z. B. weil es
                 * bei einer frueheren Bestellung mit dabei war), wird es an
                 * die richtige Stelle gezogen und nicht doppelt angelegt;
                 * seine Menge bleibt dabei erhalten. Alle anderen
                 * Unterprodukte kommen mit der hinterlegten Menge mal der
                 * Menge des Hauptprodukts hinzu.
                 * Liefert { items, message }.
                 */
                _expandWithDependencies: async function (aItems) {
                    const aDependencies = await Promise.all(
                        aItems.map((oItem) => oItem.product_ID
                            ? this._loadDependencyItems(
                                oItem.product_ID, oItem.quantity
                            )
                            : Promise.resolve(
                                { message: "", items: [], missing: [] }
                            ))
                    );
                    const oInList = new Map(
                        aItems.map((oItem) => [oItem.product_ID, oItem])
                    );
                    // Listenpositionen, die Unterprodukt eines anderen Eintrags
                    // der Liste sind, werden erst hinter diesem eingeordnet.
                    const oChildIDs = new Set();
                    aDependencies.forEach((oDependency, iIndex) => {
                        oDependency.items.forEach((oChild) => {
                            if (oInList.has(oChild.product_ID) &&
                                oChild.product_ID !==
                                    aItems[iIndex].product_ID) {
                                oChildIDs.add(oChild.product_ID);
                            }
                        });
                    });
                    const oPlaced = new Set();
                    const aResult = [];
                    const aMessages = [];

                    aItems.forEach((oItem, iIndex) => {
                        if (oPlaced.has(oItem.product_ID) ||
                            oChildIDs.has(oItem.product_ID)) {
                            return;
                        }
                        oPlaced.add(oItem.product_ID);
                        aResult.push(oItem);
                        const oDependency = aDependencies[iIndex];
                        let bAddedNew = false;
                        oDependency.items.forEach((oChild) => {
                            if (oPlaced.has(oChild.product_ID)) {
                                return;
                            }
                            oPlaced.add(oChild.product_ID);
                            if (oInList.has(oChild.product_ID)) {
                                aResult.push(oInList.get(oChild.product_ID));
                            } else {
                                aResult.push(oChild);
                                bAddedNew = true;
                            }
                        });
                        if (oDependency.message &&
                            (bAddedNew || oDependency.missing.length > 0)) {
                            aMessages.push(oDependency.message);
                        }
                    });

                    return { items: aResult, message: aMessages.join(" ") };
                },
                /**
                 * Wie _addAiItemsToOrder, aber mit Pflicht-Unterprodukten.
                 * Gibt den Hinweistext fuer den Nutzer zurueck ("" wenn es
                 * keine Unterprodukte gab).
                 */
                _addItemsWithDependencies: async function (aItems) {
                    const oExpanded = await this._expandWithDependencies(aItems);
                    this._addAiItemsToOrder(oExpanded.items);
                    return oExpanded.message;
                },
                _focusOrderQuantity: function (iIndex) {
                    const oTable = this.byId("orderItemsTable");
                    if (!oTable) {
                        return;
                    }
                    const oRow = oTable.getItems()[iIndex];
                    if (oRow) {
                        oRow.getCells()[2].focus();
                    }
                },
                _setSelectedProduct: async function (
                    oProductContext,
                    oOrderContext
                ) {
                    const sProductID =
                        await oProductContext.requestProperty("ID");
                    const sProductName =
                        await oProductContext.requestProperty("name");
                    const sUnit =
                        await oProductContext.requestProperty("unit");
                    const vPrice =
                        await oProductContext.requestProperty("price");
                    const iQuantity =
                        Number(oOrderContext.getProperty("quantity")) || 1;
                    const fUnitPrice = Number(vPrice) || 0;
                    const fTotalPrice = fUnitPrice * iQuantity;
                    const sPath = oOrderContext.getPath();
                    const oModel = oOrderContext.getModel();
                    const aItems = oModel.getProperty("/items") || [];
                    const oExistingItem = aItems.find(function (oItem) {
                        return (
                            oItem.product_ID === sProductID &&
                            oItem !== oOrderContext.getObject()
                        );
                    });
                    if (oExistingItem) {
                        oExistingItem.quantity += iQuantity;
                        oExistingItem.totalPrice = (
                            oExistingItem.quantity *
                            Number(oExistingItem.unitPrice)
                        ).toFixed(2);
                        aItems.splice(
                            aItems.indexOf(oOrderContext.getObject()),
                            1
                        );
                        oModel.setProperty("/items", aItems);
                        this._calculateOrderTotal();
                        MessageToast.show(
                            `Quantity of ${sProductName} updated to ` +
                            `${oExistingItem.quantity}.`
                        );
                        return;
                    }
                    oModel.setProperty(sPath + "/product_ID", sProductID);
                    oModel.setProperty(sPath + "/productName", sProductName);
                    oModel.setProperty(sPath + "/unit", sUnit);
                    oModel.setProperty(
                        sPath + "/unitPrice",
                        fUnitPrice.toFixed(2)
                    );
                    oModel.setProperty(
                        sPath + "/totalPrice",
                        fTotalPrice.toFixed(2)
                    );
                    this._productOrderContext = null;
                    this._calculateOrderTotal();
                },
                /**
                 * Wird ausgeführt, sobald der Benutzer die Menge
                 * in einer Tabellenzeile ändert (StepInput-Change-Event).
                 */
                onQuantityChange: function (oEvent) {
                    const oInput =
                        oEvent.getSource();
                    const oContext =
                        oInput.getBindingContext("order");
                    if (!oContext) {
                        return;
                    }
                    const iQuantity =
                        Number(
                            oEvent.getParameter("value")
                        ) || 0;
                    const fUnitPrice =
                        Number(
                            oContext.getProperty("unitPrice")
                        ) || 0;
                    const fTotalPrice =
                        iQuantity * fUnitPrice;
                    oContext.getModel().setProperty(
                        oContext.getPath() + "/quantity",
                        iQuantity
                    );
                    oContext.getModel().setProperty(
                        oContext.getPath() + "/totalPrice",
                        fTotalPrice.toFixed(2)
                    );
                    this._calculateOrderTotal();
                },
                _addAiItemsToOrder: function (aResolvedItems) {
                    const oOrderModel =
                        this.getView().getModel("order");
                    const aAiItems = aResolvedItems.map(function (oItem) {
                        return {
                            product_ID: oItem.product_ID,
                            productName: oItem.productName || "",
                            unit: oItem.unit || "",
                            quantity: Number(oItem.quantity),
                            unitPrice: Number(oItem.unitPrice).toFixed(2),
                            totalPrice: Number(oItem.totalPrice).toFixed(2)
                        };
                    });
                    const aExistingItems =
                        (oOrderModel.getProperty("/items") || []).filter(
                            function (oItem) {
                                return Boolean(oItem.product_ID);
                            }
                        );
                    aAiItems.forEach(function (oNewItem) {
                        const oExistingItem = aExistingItems.find(
                            function (oItem) {
                                return oItem.product_ID === oNewItem.product_ID;
                            }
                        );
                        if (oExistingItem) {
                            oExistingItem.quantity += oNewItem.quantity;
                            oExistingItem.totalPrice = (
                                oExistingItem.quantity * Number(oExistingItem.unitPrice)
                            ).toFixed(2);
                        } else {
                            aExistingItems.push(oNewItem);
                        }
                    });
                    oOrderModel.setProperty("/items", aExistingItems);
                    this._calculateOrderTotal();
                },
                /**
                 * Wendet die vom Backend gelieferten Aenderungen an:
                 * action "add" (neue Position), "update" (Produkt und/oder
                 * Menge einer bestehenden Position) und "remove" (Position
                 * loeschen). Bestehende Positionen werden ueber ihre
                 * Positionsnummer gefunden; diese wird vor dem Aendern
                 * einmalig aufgeloest, damit Loeschungen keine Zuordnung
                 * verschieben.
                 */
                _applyAiItemChanges: function (aChanges) {
                    const oOrderModel = this.getView().getModel("order");
                    const aLines = oOrderModel.getProperty("/items") || [];
                    const mByPosition = new Map(
                        aLines.map((oLine) => [Number(oLine.position), oLine])
                    );
                    const oToRemove = new Set();
                    const aToAdd = [];

                    aChanges.forEach((oChange) => {
                        if (oChange.action === "remove") {
                            const oLine =
                                mByPosition.get(Number(oChange.position));
                            if (oLine) {
                                oToRemove.add(oLine);
                            }
                        } else if (oChange.action === "update") {
                            const oLine =
                                mByPosition.get(Number(oChange.position));
                            if (!oLine) {
                                return;
                            }
                            const fUnitPrice = Number(oChange.unitPrice);
                            const iQuantity = Number(oChange.quantity);
                            if (oChange.product_ID &&
                                oChange.product_ID !== oLine.product_ID) {
                                oLine.product_ID = oChange.product_ID;
                                oLine.productName = oChange.productName || "";
                                oLine.unit = oChange.unit || "";
                                oLine.unitPrice = (
                                    Number.isFinite(fUnitPrice) ? fUnitPrice : 0
                                ).toFixed(2);
                            }
                            if (Number.isFinite(iQuantity) && iQuantity > 0) {
                                oLine.quantity = iQuantity;
                            }
                            oLine.totalPrice = (
                                Number(oLine.quantity) *
                                Number(oLine.unitPrice)
                            ).toFixed(2);

                            // Hat die geaenderte Zeile jetzt dasselbe Produkt
                            // wie eine andere, werden beide zusammengefuehrt.
                            const oOther = aLines.find((oCandidate) =>
                                oCandidate !== oLine &&
                                !oToRemove.has(oCandidate) &&
                                oCandidate.product_ID === oLine.product_ID);
                            if (oOther) {
                                oOther.quantity =
                                    Number(oOther.quantity) +
                                    Number(oLine.quantity);
                                oOther.totalPrice = (
                                    oOther.quantity * Number(oOther.unitPrice)
                                ).toFixed(2);
                                oToRemove.add(oLine);
                            }
                        } else {
                            aToAdd.push(oChange);
                        }
                    });

                    oOrderModel.setProperty(
                        "/items",
                        aLines.filter((oLine) => !oToRemove.has(oLine))
                    );
                    if (aToAdd.length > 0) {
                        this._addAiItemsToOrder(aToAdd);
                    } else {
                        this._calculateOrderTotal();
                    }
                },
                onSelectClarificationSuggestion: function (oEvent) {
                    const oButton = oEvent.getSource();
                    const oContext = oButton.getBindingContext("clarification");
                    const oSuggestion = oContext.getObject();
                    const oClarificationModel =
                        this.getView().getModel("clarification");
                    const bUpdate =
                        oClarificationModel.getProperty("/action") === "update";
                    const sTargetProductID =
                        oClarificationModel.getProperty("/targetProductID");
                    // Bei "update" ohne Mengenangabe bleibt die Menge erhalten.
                    const iQuantity =
                        oClarificationModel.getProperty("/quantity") ||
                        (bUpdate ? null : 1);
                    const oODataModel = this.getView().getModel();
                    const oProductBinding = oODataModel.bindContext(
                        `/Products(${oSuggestion.productId})`
                    );
                    oProductBinding.getBoundContext()
                        .requestObject()
                        .then(
                            function (oProduct) {
                                const fUnitPrice = Number(oProduct.price);
                                if (bUpdate) {
                                    const oLine = (
                                        this.getView().getModel("order")
                                            .getProperty("/items") || []
                                    ).find((oItem) =>
                                        oItem.product_ID === sTargetProductID);
                                    if (!oLine) {
                                        this._picoSay(
                                            "The order line to change no " +
                                            "longer exists."
                                        );
                                    } else {
                                        this._applyAiItemChanges([{
                                            action: "update",
                                            position: Number(oLine.position),
                                            product_ID: oSuggestion.productId,
                                            productName:
                                                oSuggestion.productName,
                                            unit: oProduct.unit || "",
                                            quantity: iQuantity,
                                            unitPrice: fUnitPrice
                                        }]);
                                        this._picoSay(
                                            `${oSuggestion.productName} updated in the order draft`
                                        );
                                    }
                                    this._advanceToNextClarification();
                                    return;
                                }
                                const fTotalPrice = fUnitPrice * iQuantity;
                                return this._addItemsWithDependencies([{
                                    product_ID: oSuggestion.productId,
                                    productName: oSuggestion.productName,
                                    unit: oProduct.unit || "",
                                    quantity: iQuantity,
                                    unitPrice: fUnitPrice,
                                    totalPrice: fTotalPrice
                                }]).then(function (sDependencyMessage) {
                                    this._picoSay(
                                        `Added ${oSuggestion.productName} to your order draft.` +
                                        (sDependencyMessage
                                            ? " " + sDependencyMessage
                                            : "")
                                    );
                                    this._advanceToNextClarification();
                                }.bind(this));
                            }.bind(this)
                        )
                        .catch(
                            function (oError) {
                                console.error(
                                    "Could not load selected product:",
                                    oError
                                );
                                this._picoSay(
                                    "Sorry, I couldn't load that product."
                                );
                            }.bind(this)
                        );
                },
                _advanceToNextClarification: function () {
                    const oClarificationModel =
                        this.getView().getModel("clarification");
                    const aPending =
                        oClarificationModel.getProperty("/pending") || [];
                    if (aPending.length > 0) {
                        const oNextClarification = aPending[0];
                        const aRemainingClarifications = aPending.slice(1);
                        oClarificationModel.setData({
                            visible: true,
                            question: oNextClarification.question,
                            quantity: oNextClarification.quantity,
                            action: oNextClarification.action,
                            targetProductID: oNextClarification.targetProductID,
                            suggestions: oNextClarification.suggestions,
                            pending: aRemainingClarifications
                        });
                        return;
                    }
                    oClarificationModel.setData({
                        visible: false,
                        question: "",
                        quantity: 1,
                        action: "add",
                        targetProductID: null,
                        suggestions: [],
                        pending: []
                    });
                    // Alle Rueckfragen beantwortet: restliche Schritte des
                    // urspruenglichen Befehls fortsetzen.
                    this._resumePendingSteps().catch((oError) => {
                        console.error("Resuming PICO steps failed:", oError);
                    });
                },
                /**
                 * Berechnet den Gesamtwert des Auftragsentwurfs.
                 */
                _calculateOrderTotal: function () {
                    const oOrderModel =
                        this.getView().getModel("order");
                    const aItems =
                        oOrderModel.getProperty("/items") || [];
                    aItems.forEach(function (oItem, iIndex) {
                        oItem.position = (iIndex + 1) * 10;
                    });
                    oOrderModel.setProperty("/items", aItems);
                    const fOrderTotal = aItems.reduce(
                        function (fSum, oItem) {
                            return (
                                fSum +
                                (
                                    Number(
                                        oItem.totalPrice
                                    ) || 0
                                )
                            );
                        },
                        0
                    );
                    oOrderModel.setProperty(
                        "/orderTotal",
                        fOrderTotal.toFixed(2)
                    );
                    this._refreshPicoChips();
                    oOrderModel.setProperty(
                        "/itemCount",
                        aItems.length
                    );
                    const oProductTable = this.byId("productTable");
                    if (oProductTable) {
                        this.onProductTableUpdateFinished({
                            getSource: function () {
                                return oProductTable;
                            }
                        });
                    }
                    this._updateCreateEnabled();
                },
                _updateCreateEnabled: function () {
                    const aItems = this.getView()
                        .getModel("order")
                        .getProperty("/items") || [];
                    const bCanCreate = Boolean(
                        aItems.length &&
                        !this._isCreatingOrder
                    );
                    this.getView()
                        .getModel("order")
                        .setProperty("/canCreate", bCanCreate);
                },
                /**
                 * Oeffnet bzw. schliesst das schwebende PICO-Chat-Panel.
                 * Wird ausschliesslich vom FAB-Button aufgerufen (Toggle-
                 * Verhalten, kein separater Schliessen-Button im Header).
                 *
                 * Beim Oeffnen: Begruessung anzeigen, alle vorherigen
                 * Ergebnisbereiche leeren, Eingabefeld fokussieren.
                 * Beim Schliessen: Begruessung/Router-Nachricht
                 * zuruecksetzen.
                 */
                onTogglePicoChat: function () {
                    const oPicoModel = this.getView().getModel("pico");
                    const bCurrentlyOpen =
                        oPicoModel.getProperty("/chatOpen");
                    const bNewOpen = !bCurrentlyOpen;

                    oPicoModel.setProperty("/chatOpen", bNewOpen);
                    if (!bNewOpen) {
                        this._stopSpeaking();
                        if (this._voice) {
                            this._voice.stopListening();
                        }
                    }

                    if (bNewOpen) {
                        // WICHTIG: Zuerst alle Ergebnisbereiche leeren,
                        // DANACH erst die Begruessung anzeigen. So kann
                        // beim Oeffnen niemals eine leere Rueckfrage-Box
                        // parallel zur Begruessung sichtbar sein.
                        this._clearAiResultAreas();

                        // Der Chat-Verlauf bleibt erhalten; die Begruessung
                        // erscheint nur, solange noch kein Verlauf existiert.
                        const bHasHistory = (
                            oPicoModel.getProperty("/messages") || []
                        ).length > 0;
                        oPicoModel.setProperty("/showAllSkills", false);
                        this._refreshPicoChips();
                        oPicoModel.setProperty(
                            "/greetingVisible",
                            !bHasHistory
                        );
                        oPicoModel.setProperty(
                            "/messageVisible",
                            false
                        );
                        oPicoModel.setProperty("/message", "");

                        // Fokus erst nach dem Rendern des Panels setzen.
                        setTimeout(
                            function () {
                                const oInput =
                                    this.byId("aiOrderInput");
                                if (oInput) {
                                    oInput.focus();
                                }
                                // Bei vorhandenem Verlauf ans Ende scrollen.
                                const oBody = this.byId("picoChatBody");
                                const oDom = oBody && oBody.getDomRef();
                                if (oDom) {
                                    oDom.scrollTop = oDom.scrollHeight;
                                }
                            }.bind(this),
                            100
                        );
                    } else {
                        oPicoModel.setProperty(
                            "/greetingVisible",
                            false
                        );
                        oPicoModel.setProperty(
                            "/messageVisible",
                            false
                        );
                        oPicoModel.setProperty("/message", "");
                    }
                },
                /**
                 * Zentraler Einstiegspunkt: nimmt den Freitext-Befehl aus
                 * dem PICO-Eingabefeld entgegen, ruft zuerst den Intent-
                 * Router (routeAiCommand) auf und dispatcht anschliessend
                 * je nach erkannter Absicht an genau eine der fuenf
                 * Funktionen. PICO selbst legt nie einen Sales Order an -
                 * das passiert weiterhin ausschliesslich in onCreateOrder.
                 * Den Entwurf aendert PICO nur ueber die vorhandenen
                 * Funktionen (_runSelectCustomer, _runGenerateOrderDraft,
                 * _runAddItems, _runRecommendProducts, _runValidateOrder).
                 */
                onAskPico: async function () {
                    const oButton = this.byId("askPicoButton");
                    const oUiModel = this.getView().getModel("ui");
                    const oPicoModel = this.getView().getModel("pico");

                    const sCommand = (
                        oUiModel.getProperty("/recognizedCommand") || ""
                    ).trim();

                    if (!sCommand) {
                        this._picoSay(
                            "Tell me what you'd like to do first, and I'll take care of it."
                        );
                        return;
                    }

                    // Wie in einer Chat-App: die eigene Eingabe erscheint
                    // als Sprechblase und das Eingabefeld wird geleert.
                    this._userSay(sCommand);
                    oUiModel.setProperty("/recognizedCommand", "");
                    this.byId("aiOrderInput").setValue("");
                    this._chipPrefix = null;

                    const oModel = this.getView().getModel();
                    const oActionBinding = oModel.bindContext(
                        "/routeAiCommand(...)"
                    );
                    oActionBinding.setParameter("command", sCommand);

                    try {
                        oUiModel.setProperty("/isAiProcessing", true);
                        this._updateAiSubmitState();
                        oButton.setBusy(true);
                        oPicoModel.setProperty("/messageVisible", false);

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "PICO returned no result context."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        console.log("PICO routing result:", oResult);

                        // Antwortsprache: folgt der Sprache des letzten Befehls.
                        this._picoLanguage =
                            oResult.language === "de" ? "de" : "en";

                        switch (oResult.status) {

                            case "multiple_intents":
                            case "unknown_intent":
                            case "clarification_required":
                                // PICO antwortet im Chat (Rueckfrage, Hinweis
                                // auf mehrere Funktionen, freundliche Ablehnung).
                                this._picoSay(oResult.message || "");
                                break;

                            case "ok": {
                                oPicoModel.setProperty(
                                    "/messageVisible",
                                    false
                                );
                                // Neuer, eindeutig erkannter Intent: zuerst
                                // ALLE bisherigen Ergebnisbereiche leeren
                                // (Customer Clarification, Product
                                // Clarification, Order Draft,
                                // Recommendation, Validation), damit z.B.
                                // eine vorherige Produktempfehlung nicht
                                // sichtbar bleibt, waehrend bereits das
                                // Validierungsergebnis angezeigt wird. Erst
                                // danach die neue Funktion ausfuehren.
                                this._clearAiResultAreas();
                                this._pendingCopyLastOrder = false;

                                // Befehl wurde eindeutig erkannt und wird
                                // jetzt ausgefuehrt - Eingabefeld leeren.
                                oUiModel.setProperty(
                                    "/recognizedCommand",
                                    ""
                                );
                                this.byId("aiOrderInput").setValue("");

                                // Ein Befehl kann mehrere Schritte enthalten
                                // (z. B. Kunde waehlen + Positionen
                                // hinzufuegen + Vorschlaege). Sie laufen
                                // nacheinander in der gesprochenen Reihenfolge.
                                const aSteps =
                                    Array.isArray(oResult.steps) &&
                                    oResult.steps.length > 0
                                        ? oResult.steps
                                        : [{
                                            intent: oResult.intent,
                                            command: sCommand,
                                            customerReference:
                                                oResult.customerReference
                                        }];
                                await this._runSteps(aSteps);
                                break;
                            }

                            default:
                                this._picoSay(
                                    "Sorry, something went wrong on my side. Could you try again?"
                                );
                        }

                    } catch (oError) {
                        console.error("PICO routing failed:", oError);
                        this._picoSay(
                            "Sorry, I ran into a problem: " +
                            (oError.message || String(oError))
                        );
                    } finally {
                        oUiModel.setProperty("/isAiProcessing", false);
                        this._updateAiSubmitState();
                        oButton.setBusy(false);
                    }
                },
                /**
                 * Fuehrt die vom Router erkannten Schritte nacheinander aus.
                 * Braucht ein Schritt eine Eingabe des Nutzers (Kunden-
                 * Rueckfrage), werden die uebrigen Schritte gemerkt und nach
                 * der Auswahl fortgesetzt. Scheitert die Kundenauswahl,
                 * werden die folgenden Schritte nicht ausgefuehrt.
                 */
                _runSteps: async function (aSteps) {
                    this._pendingSteps = null;
                    this._collected = [];
                    try {
                        await this._runStepList(aSteps);
                    } finally {
                        await this._flushCollected();
                    }
                },
                /**
                 * Gibt die gesammelten Antworten als eine zusammenhaengende
                 * Nachricht aus (Chat und Sprache). Die "What next?"-Frage
                 * bzw. die Chips kommen aus der Antwort des letzten Schritts.
                 */
                _flushCollected: async function () {
                    const aCollected = this._collected || [];
                    this._collected = null;
                    const aTexts = aCollected
                        .map((o) => String(o.text || "").trim())
                        .filter(Boolean)
                        .map((s) => (/[.!?…]$/.test(s) ? s : s + "."));
                    if (aTexts.length === 0) {
                        return;
                    }
                    const bAskNext = aCollected[aCollected.length - 1].askNext;
                    let sReply = aTexts.join(" ");
                    // Mehrere Teilantworten lässt die KI zu einer fluessigen,
                    // menschlich klingenden Antwort verbinden. Scheitert das,
                    // bleibt die einfache Aneinanderreihung.
                    if (aTexts.length > 1) {
                        try {
                            const oBinding = this.getView().getModel()
                                .bindContext("/composeReply(...)");
                            oBinding.setParameter(
                                "parts", JSON.stringify(aTexts)
                            );
                            await oBinding.execute();
                            const oResult = await oBinding
                                .getBoundContext().requestObject();
                            if (oResult && oResult.reply) {
                                sReply = oResult.reply;
                            }
                        } catch (oError) {
                            console.warn("Could not compose reply:", oError);
                        }
                    }
                    this._picoSay(sReply, bAskNext);
                },
                _runStepList: async function (aSteps) {
                    for (let i = 0; i < aSteps.length; i++) {
                        // Zwischenschritte stellen keine "What next?"-Frage.
                        this._moreSteps = i < aSteps.length - 1;
                        let sOutcome;
                        try {
                            sOutcome = await this._runStep(aSteps[i]);
                        } finally {
                            this._moreSteps = false;
                        }
                        if (sOutcome === "clarification") {
                            this._pendingSteps = aSteps.slice(i + 1);
                            if (this._pendingSteps.length > 0) {
                                this._picoSay(
                                    "Once that's settled, I'll continue with the rest of your request."
                                );
                            }
                            return;
                        }
                        if (sOutcome === "failed" &&
                            aSteps[i].intent === "select_customer") {
                            if (i < aSteps.length - 1) {
                                this._picoSay(
                                    "I've paused the rest of your request, because I need a customer first."
                                );
                            }
                            return;
                        }
                    }
                },
                /** Setzt die nach einer Rueckfrage offenen Schritte fort. */
                _resumePendingSteps: async function () {
                    const aSteps = this._pendingSteps;
                    this._pendingSteps = null;
                    if (aSteps && aSteps.length > 0) {
                        await this._runSteps(aSteps);
                    }
                },
                _runStep: async function (oStep) {
                    const sCommand = oStep.command;
                    switch (oStep.intent) {
                        case "generate_order_draft":
                            return this._runGenerateOrderDraft();
                        case "select_customer":
                            return this._runSelectCustomer(sCommand);
                        case "add_items":
                            return this._runAddItems(sCommand);
                        case "recommend_products":
                            return this._runRecommendProducts();
                        case "validate_order":
                            return this._runValidateOrder();
                        case "copy_last_order":
                            return this._runCopyLastOrder(
                                sCommand,
                                oStep.customerReference
                            );
                        default:
                            this._picoSay(
                                "Sorry, I didn't quite understand what you'd like me to do."
                            );
                            return "failed";
                    }
                },
                /**
                 * Identifiziert den gemeinten Kunden per Name/Kundennummer
                 * (selectCustomer) und setzt ihn im Header. Wird
                 * ausschliesslich von onAskPico aufgerufen, nachdem PICO
                 * den Intent "select_customer" erkannt hat.
                 */
                _runSelectCustomer: async function (sCommand) {
                    const oModel = this.getView().getModel();
                    const oActionBinding = oModel.bindContext(
                        "/selectCustomer(...)"
                    );
                    oActionBinding.setParameter("command", sCommand);

                    try {
                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The customer selection service returned no result context."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        console.log(
                            "Customer selection result:",
                            oResult
                        );

                        if (oResult.status === "resolved") {
                            const bApplied = await this._applySelectedCustomer(
                                oResult.customerId,
                                oResult.customerName
                            );

                            if (bApplied) {
                                this._picoSay(
                                    `Got it, I've selected ${oResult.customerName}.`,
                                    !this._pendingCopyLastOrder &&
                                        !this._copyAfterSelect
                                );
                            } else {
                                this._picoSay(
                                    "I recognized " + oResult.customerName +
                                    ", but I couldn't find them in the " +
                                    "customer dropdown. Could you select the " +
                                    "customer there yourself?"
                                );
                            }
                            return bApplied ? "resolved" : "failed";
                        }

                        if (oResult.status === "clarification_required") {
                            const oCustomerClarificationModel =
                                this.getView().getModel(
                                    "customerClarification"
                                );
                            oCustomerClarificationModel.setData({
                                visible: true,
                                question: oResult.question,
                                suggestions: oResult.suggestions
                            });
                            // PICO sagt, dass der Nutzer selbst waehlen muss.
                            const bHasChoices =
                                (oResult.suggestions || []).length > 0;
                            this._picoSay(
                                bHasChoices
                                    ? "I found a few customers that could fit, " +
                                      "so I need your help. Please pick the " +
                                      "right one below."
                                    : (oResult.question ||
                                      "I'm not sure which customer you mean. " +
                                      "Could you tell me the name again?")
                            );
                            return "clarification";
                        }

                        this._picoSay(
                            "Sorry, I couldn't work out which customer you mean."
                        );
                        return "failed";

                    } catch (oError) {
                        console.error(
                            "Customer selection failed:",
                            oError
                        );
                        this._picoSay(
                            "Sorry, I couldn't select the customer: " +
                            (oError.message || String(oError))
                        );
                        return "failed";
                    }
                },
                /**
                 * Kopiert die letzte Bestellung eines Kunden in den
                 * Auftragsentwurf (copyLastOrder). Nennt der Befehl einen
                 * Kunden, wird dieser zuerst ausgewaehlt; ist er nicht
                 * eindeutig, wird nach der Kunden-Rueckfrage fortgesetzt.
                 * Ohne Kundenangabe wird der aktuell gewaehlte Kunde
                 * verwendet.
                 */
                _runCopyLastOrder: async function (sCommand, sCustomerReference) {
                    if (sCustomerReference) {
                        this._copyAfterSelect = true;
                        let sStatus;
                        try {
                            sStatus = await this._runSelectCustomer(sCommand);
                        } finally {
                            this._copyAfterSelect = false;
                        }
                        if (sStatus === "clarification") {
                            this._pendingCopyLastOrder = true;
                            return "clarification";
                        }
                        if (sStatus !== "resolved") {
                            return "failed";
                        }
                    }
                    await this._copyLastOrderForSelectedCustomer();
                },
                _copyLastOrderForSelectedCustomer: async function () {
                    const oCustomerItem =
                        this.byId("customerSelect").getSelectedItem();
                    if (!oCustomerItem) {
                        this._picoSay(
                            "Please pick a customer first, then I can copy their last order for you."
                        );
                        return;
                    }

                    const oActionBinding =
                        this.getView().getModel().bindContext(
                            "/copyLastOrder(...)"
                        );

                    try {
                        const sCustomerID = await oCustomerItem
                            .getBindingContext()
                            .requestProperty("ID");
                        oActionBinding.setParameter("customerId", sCustomerID);

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The copy service returned no result."
                            );
                        }
                        const oResult = await oResultContext.requestObject();
                        const aItems = Array.isArray(oResult.items)
                            ? oResult.items
                            : [];

                        if (!oResult.success || aItems.length === 0) {
                            this._picoSay(
                                oResult.message ||
                                "Sorry, I couldn't copy an order this time."
                            );
                            return;
                        }

                        const oOrderModel = this.getView().getModel("order");
                        const bHasItems = (
                            oOrderModel.getProperty("/items") || []
                        ).some((oItem) => oItem.product_ID);

                        if (bHasItems) {
                            const bReplace = await new Promise((resolve) => {
                                MessageBox.confirm(
                                    "Your order draft already has items in it. " +
                                    "Should I replace them with the copied ones?",
                                    {
                                        title: "Copy last order",
                                        actions: [
                                            MessageBox.Action.OK,
                                            MessageBox.Action.CANCEL
                                        ],
                                        emphasizedAction: MessageBox.Action.OK,
                                        onClose: (sAction) => resolve(
                                            sAction === MessageBox.Action.OK
                                        )
                                    }
                                );
                            });
                            if (!bReplace) {
                                return;
                            }
                            oOrderModel.setProperty("/items", []);
                        }

                        const sCopyDependencyMessage =
                            await this._addItemsWithDependencies(aItems);
                        this._picoSay(
                            oResult.message +
                            (sCopyDependencyMessage
                                ? " " + sCopyDependencyMessage
                                : ""),
                            true
                        );

                    } catch (oError) {
                        console.error("Copying the last order failed:", oError);
                        this._picoSay(
                            "Sorry, I couldn't copy the last order: " +
                            (oError.message || String(oError))
                        );
                    }
                },
                /**
                 * Wird ausgeloest, wenn der Nutzer bei einer Kunden-
                 * Rueckfrage einen der vorgeschlagenen Kunden anklickt.
                 */
                onSelectCustomerClarificationSuggestion: async function (oEvent) {
                    const oContext = oEvent.getSource()
                        .getBindingContext("customerClarification");
                    const oSuggestion = oContext.getObject();

                    const bApplied = await this._applySelectedCustomer(
                        oSuggestion.customerId,
                        oSuggestion.customerName
                    );

                    this.getView()
                        .getModel("customerClarification")
                        .setData({
                            visible: false,
                            question: "",
                            suggestions: []
                        });

                    if (bApplied) {
                        const bMoreSteps =
                            (this._pendingSteps || []).length > 0;
                        this._picoSay(
                            `Got it, I've selected ${oSuggestion.customerName}.`,
                            !this._pendingCopyLastOrder && !bMoreSteps
                        );
                        // Wartete ein "copy last order" auf die Kundenauswahl,
                        // jetzt fortsetzen.
                        if (this._pendingCopyLastOrder) {
                            this._pendingCopyLastOrder = false;
                            this._moreSteps = bMoreSteps;
                            try {
                                await this._copyLastOrderForSelectedCustomer();
                            } finally {
                                this._moreSteps = false;
                            }
                        }
                        // Restliche Schritte des urspruenglichen Befehls.
                        await this._resumePendingSteps();
                    } else {
                        this._pendingCopyLastOrder = false;
                        this._pendingSteps = null;
                        this._picoSay(
                            "I couldn't find that customer in the dropdown. " +
                            "Could you select them there yourself?"
                        );
                    }
                },
                /**
                 * Setzt den Kunden im Header-ComboBox programmatisch.
                 *
                 * setSelectedKey() ist der normale, direkte Weg - er
                 * schlaegt aber STILL (ohne Fehler) fehl, falls der
                 * uebergebene Key nicht exakt (Gross-/Kleinschreibung,
                 * Bindestriche) mit dem "key" eines ComboBox-Items
                 * uebereinstimmt. Als Absicherung wird deshalb zusaetzlich
                 * geprueft, ob die Auswahl tatsaechlich gegriffen hat; wenn
                 * nicht, wird ueber eine normalisierte (Kleinschreibung,
                 * ohne Bindestriche) Suche in den aktuell geladenen Items
                 * ein Fallback-Treffer gesucht.
                 *
                 * Gibt true zurueck, wenn ein Kunde erfolgreich gesetzt
                 * wurde, sonst false.
                 */
                _applySelectedCustomer: async function (sCustomerId, sCustomerName) {
                    const oCustomerSelect = this.byId("customerSelect");

                    const normalize = function (value) {
                        return String(value || "")
                            .toLowerCase()
                            .replace(/-/g, "");
                    };

                    oCustomerSelect.setSelectedKey(sCustomerId);

                    let bSuccess = Boolean(
                        oCustomerSelect.getSelectedItem() &&
                        oCustomerSelect.getSelectedKey() === sCustomerId
                    );

                    if (!bSuccess) {
                        const sNormalizedTarget = normalize(sCustomerId);
                        const oMatchingItem = oCustomerSelect.getItems().find(
                            function (oItem) {
                                return normalize(oItem.getKey()) ===
                                    sNormalizedTarget;
                            }
                        );

                        if (oMatchingItem) {
                            oCustomerSelect.setSelectedItem(oMatchingItem);
                            bSuccess = true;
                        } else {
                            console.warn(
                                "Could not find a matching customer item " +
                                "for ID:",
                                sCustomerId,
                                sCustomerName
                            );
                        }
                    }

                    this.onHeaderChange();

                    return bSuccess;
                },
                /**
                 * Interpretiert Produkte/Mengen aus natuerlicher Sprache
                 * (interpretOrderItems) und fuegt sie dem Auftragsentwurf
                 * hinzu. Wird ausschliesslich von onAskPico aufgerufen,
                 * nachdem PICO den Intent "add_items" erkannt hat.
                 */
                _runAddItems: async function (sOrderRequest) {
                    const oModel = this.getView().getModel();
                    const oActionBinding = oModel.bindContext(
                        "/interpretOrderItems(...)"
                    );
                    oActionBinding.setParameter(
                        "orderRequest",
                        sOrderRequest
                    );
                    // Aktuelle Positionen mitsenden, damit Items auch
                    // bearbeitet oder geloescht werden koennen.
                    const aCurrentLines = (
                        this.getView().getModel("order")
                            .getProperty("/items") || []
                    )
                        .filter((oItem) => oItem.product_ID)
                        .map((oItem) => ({
                            position: Number(oItem.position),
                            product_ID: oItem.product_ID,
                            productName: oItem.productName,
                            quantity: Number(oItem.quantity)
                        }));
                    oActionBinding.setParameter(
                        "currentItems",
                        JSON.stringify(aCurrentLines)
                    );

                    try {
                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The AI service returned no result context."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        console.log(
                            "AI interpretation result:",
                            oResult
                        );

                        if (!oResult.success) {
                            this._picoSay(
                                oResult.message ||
                                "Sorry, I couldn't process that request."
                            );
                            return;
                        }

                        const aClarifications = Array.isArray(
                            oResult.clarifications
                        ) ? oResult.clarifications : [];
                        const aResolvedItems = Array.isArray(oResult.items)
                            ? oResult.items
                            : [];

                        if (aClarifications.length > 0) {
                            // Positionen veraendern sich, sobald andere
                            // Zeilen geloescht werden. Deshalb wird das Ziel
                            // einer Bearbeitungs-Rueckfrage ueber die
                            // Produkt-ID der Zeile festgehalten.
                            const aOrderLines =
                                this.getView().getModel("order")
                                    .getProperty("/items") || [];
                            const aPreparedClarifications =
                                aClarifications.map((oClarification) => {
                                    const oLine = oClarification.action ===
                                        "update"
                                        ? aOrderLines.find((oItem) =>
                                            Number(oItem.position) ===
                                            Number(oClarification.position))
                                        : null;
                                    return Object.assign(
                                        {},
                                        oClarification,
                                        {
                                            targetProductID:
                                                oLine ? oLine.product_ID : null
                                        }
                                    );
                                });
                            const oClarificationModel =
                                this.getView().getModel("clarification");
                            const oFirstClarification =
                                aPreparedClarifications[0];
                            const aRemainingClarifications =
                                aPreparedClarifications.slice(1);
                            oClarificationModel.setData({
                                visible: true,
                                question: oFirstClarification.question,
                                quantity: oFirstClarification.quantity,
                                action: oFirstClarification.action,
                                targetProductID:
                                    oFirstClarification.targetProductID,
                                suggestions: oFirstClarification.suggestions,
                                pending: aRemainingClarifications
                            });
                            if (aResolvedItems.length > 0) {
                                this._applyAiItemChanges(aResolvedItems);
                            }
                            this._picoSay(
                                oResult.message ||
                                "I need your help with one product - please pick one below."
                            );
                            // Die restlichen Schritte warten, bis alle
                            // Produkt-Rueckfragen beantwortet sind.
                            return "clarification";
                        }

                        if (aResolvedItems.length === 0) {
                            this._picoSay(
                                oResult.message ||
                                "Hmm, I couldn't find a matching product. Could you rephrase that?"
                            );
                            return;
                        }

                        this._applyAiItemChanges(aResolvedItems);
                        this._picoSay(
                            oResult.message ||
                            `Done, I've updated your order draft.`,
                            true
                        );

                    } catch (oError) {
                        console.error(
                            "AI order interpretation failed:",
                            oError
                        );
                        this._picoSay(
                            "Sorry, I ran into a problem: " +
                            (oError.message || String(oError))
                        );
                    }
                },
                /**
                 * Erzeugt einen Auftragsentwurf aus der Kundenhistorie
                 * (generateOrderDraft). Sichere Items werden direkt in den
                 * Entwurf uebernommen, unsichere erscheinen als Vorschlag
                 * zur Bestaetigung. Jedes Item hat eine Begruendung hinter
                 * "Why?". Wird ausschliesslich von onAskPico aufgerufen,
                 * nachdem PICO den Intent "generate_order_draft" erkannt hat.
                 */
                _runGenerateOrderDraft: async function () {
                    const oCustomerItem =
                        this.byId("customerSelect").getSelectedItem();
                    if (!oCustomerItem) {
                        this._picoSay(
                            "Please pick a customer first, then I can prepare a draft for you."
                        );
                        return;
                    }

                    const aOrderItems =
                        this.getView().getModel("order")
                            .getProperty("/items") || [];

                    const oDraftModel = this.getView().getModel("draft");

                    const oActionBinding =
                        this.getView().getModel().bindContext(
                            "/generateOrderDraft(...)"
                        );

                    try {
                        const oCustomerContext =
                            oCustomerItem.getBindingContext();
                        const sCustomerID =
                            await oCustomerContext.requestProperty("ID");

                        oActionBinding.setParameter(
                            "customerId",
                            sCustomerID
                        );
                        oActionBinding.setParameter(
                            "excludedProductIDs",
                            JSON.stringify(
                                [...new Set(aOrderItems
                                    .map((item) => item.product_ID)
                                    .filter(Boolean))]
                            )
                        );

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The order draft service returned no result."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        console.log("Order draft result:", oResult);

                        const aAuto = (Array.isArray(oResult.autoItems)
                            ? oResult.autoItems
                            : []
                        ).map((oItem) =>
                            Object.assign({}, oItem, { showWhy: false })
                        );
                        const aSuggestions = (Array.isArray(oResult.suggestions)
                            ? oResult.suggestions
                            : []
                        ).map((oItem) =>
                            Object.assign({}, oItem, { showWhy: false })
                        );

                        if (!oResult.success ||
                            (aAuto.length === 0 && aSuggestions.length === 0)) {
                            oDraftModel.setData({
                                visible: false,
                                message: "",
                                hasAuto: false,
                                hasSuggestions: false,
                                autoItems: [],
                                suggestions: []
                            });
                            this._picoSay(
                                oResult.message ||
                                    "Sorry, I couldn't put a draft together this time."
                            );
                            return;
                        }

                        // Sichere Items direkt in den Entwurf uebernehmen.
                        let sDraftDependencyMessage = "";
                        if (aAuto.length > 0) {
                            sDraftDependencyMessage =
                                await this._addItemsWithDependencies(
                                    aAuto.map((oItem) => ({
                                        product_ID: oItem.product_ID,
                                        productName: oItem.productName,
                                        unit: oItem.unit || "",
                                        quantity: Number(oItem.quantity),
                                        unitPrice: Number(oItem.unitPrice),
                                        totalPrice: Number(oItem.totalPrice)
                                    }))
                                );
                        }

                        oDraftModel.setData({
                            visible: true,
                            message: oResult.message || "",
                            hasAuto: aAuto.length > 0,
                            hasSuggestions: aSuggestions.length > 0,
                            autoItems: aAuto,
                            suggestions: aSuggestions
                        });

                        // Bestaetigung + ggf. Rueckfrage zu den Vorschlaegen
                        // kommt aus der Backend-Nachricht; gibt es keine
                        // Vorschlaege, fragt PICO nach dem naechsten Schritt.
                        this._picoSay(
                            (oResult.message || "Your draft is ready.") +
                            (sDraftDependencyMessage
                                ? " " + sDraftDependencyMessage
                                : ""),
                            aSuggestions.length === 0 ? true : "chips"
                        );

                    } catch (oError) {
                        console.error(
                            "Order draft generation failed:",
                            oError
                        );
                        this._picoSay(
                            "Sorry, I couldn't generate the draft: " +
                                (oError.message || String(oError))
                        );
                    }
                },
                /**
                 * Klappt die Begruendung ("Why?") eines Draft-Items
                 * auf bzw. zu.
                 */
                onToggleDraftWhy: function (oEvent) {
                    const oSource = oEvent.getSource();
                    const oContext =
                        oSource.getBindingContext("draft") ||
                        oSource.getBindingContext("recommendation");
                    if (!oContext) {
                        return;
                    }
                    const oModel = oContext.getModel();
                    const sPath = oContext.getPath() + "/showWhy";
                    oModel.setProperty(sPath, !oModel.getProperty(sPath));
                },
                /**
                 * Nutzer bestaetigt einen Vorschlag aus dem Order Draft:
                 * Item wird in den Entwurf uebernommen und aus der
                 * Vorschlagsliste entfernt.
                 */
                onAddDraftSuggestion: async function (oEvent) {
                    const oContext =
                        oEvent.getSource().getBindingContext("draft");
                    const oSuggestion = oContext?.getObject();
                    if (!oSuggestion?.product_ID) {
                        this._picoSay(
                            "Sorry, something is off with that suggestion."
                        );
                        return;
                    }

                    const iQuantity = Number.isInteger(oSuggestion.quantity) &&
                        oSuggestion.quantity > 0
                        ? oSuggestion.quantity
                        : 1;
                    const fUnitPrice = Number(oSuggestion.unitPrice);

                    const sDraftSuggestionDependencies =
                        await this._addItemsWithDependencies([{
                            product_ID: oSuggestion.product_ID,
                            productName: oSuggestion.productName,
                            unit: oSuggestion.unit || "",
                            quantity: iQuantity,
                            unitPrice: fUnitPrice,
                            totalPrice: fUnitPrice * iQuantity
                        }]);

                    const oDraftModel = this.getView().getModel("draft");
                    const aRemaining =
                        (oDraftModel.getProperty("/suggestions") || [])
                            .filter(
                                (oItem) =>
                                    oItem.product_ID !== oSuggestion.product_ID
                            );
                    oDraftModel.setProperty("/suggestions", aRemaining);
                    oDraftModel.setProperty(
                        "/hasSuggestions",
                        aRemaining.length > 0
                    );

                    this._picoSay(
                        `Added ${oSuggestion.productName} (Qty ${iQuantity}) to your draft.` +
                        (sDraftSuggestionDependencies
                            ? " " + sDraftSuggestionDependencies
                            : ""),
                        aRemaining.length === 0 ? true : "chips"
                    );
                },
                /**
                 * Fordert Produktempfehlungen fuer den gewaehlten Kunden an
                 * (recommendProducts). Wird ausschliesslich von onAskPico
                 * aufgerufen, nachdem PICO den Intent "recommend_products"
                 * erkannt hat.
                 */
                _runRecommendProducts: async function () {
                    const oCustomerItem =
                        this.byId("customerSelect").getSelectedItem();
                    if (!oCustomerItem) {
                        this._picoSay(
                            "Please pick a customer first, then I can suggest products for you."
                        );
                        return;
                    }

                    const oRecommendationModel =
                        this.getView().getModel("recommendation");

                    const aOrderItems =
                        this.getView().getModel("order")
                            .getProperty("/items") || [];

                    const oActionBinding =
                        this.getView().getModel().bindContext(
                            "/recommendProducts(...)"
                        );

                    try {
                        const oCustomerContext =
                            oCustomerItem.getBindingContext();
                        const sCustomerID =
                            await oCustomerContext.requestProperty("ID");

                        oActionBinding.setParameter(
                            "customerId",
                            sCustomerID
                        );
                        oActionBinding.setParameter(
                            "excludedProductIDs",
                            JSON.stringify(
                                [...new Set(aOrderItems
                                    .map((item) => item.product_ID)
                                    .filter(Boolean))]
                            )
                        );

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The recommendation service returned no result."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        const aRecommendations =
                            Array.isArray(oResult.recommendations)
                                ? oResult.recommendations
                                : [];

                        if (!oResult.success || aRecommendations.length === 0) {
                            oRecommendationModel.setData({
                                visible: false,
                                recommendations: []
                            });
                            this._picoSay(
                                oResult.message ||
                                    "Sorry, I don't have any product suggestions right now."
                            );
                            return;
                        }

                        this._picoSay(
                            oResult.message || "Here are my suggestions.",
                            "chips"
                        );
                        oRecommendationModel.setData({
                            visible: true,
                            message: oResult.message || "",
                            recommendations: aRecommendations.map(
                                (oItem) => Object.assign(
                                    {}, oItem, { showWhy: false }
                                )
                            )
                        });

                    } catch (oError) {
                        console.error(
                            "Could not load product recommendations:",
                            oError
                        );
                        this._picoSay(
                            "Sorry, I couldn't load suggestions: " +
                                (oError.message || String(oError))
                        );
                    }
                },
                /**
                 * Adds the selected recommendation to the draft and removes
                 * only that product from the displayed recommendations.
                 */
                onSelectRecommendedProduct: async function (oEvent) {
                    const oContext =
                        oEvent.getSource().getBindingContext("recommendation");
                    const oRecommendation = oContext?.getObject();
                    if (!oRecommendation?.product_ID) {
                        this._picoSay(
                            "Sorry, something is off with that suggestion."
                        );
                        return;
                    }
                    const fUnitPrice = Number(oRecommendation.unitPrice);

                    const iRecommendedQuantity = Number.isInteger(
                        oRecommendation.averageQuantity
                    ) && oRecommendation.averageQuantity > 0
                        ? oRecommendation.averageQuantity
                        : 1;

                    const sRecommendationDependencies =
                        await this._addItemsWithDependencies([{
                            product_ID: oRecommendation.product_ID,
                            productName: oRecommendation.productName,
                            unit: oRecommendation.unit || "",
                            quantity: iRecommendedQuantity,
                            unitPrice: fUnitPrice,
                            totalPrice: fUnitPrice * iRecommendedQuantity
                        }]);
                    const oRecommendationModel =
                        this.getView().getModel("recommendation");
                    const aRemainingRecommendations =
                        (oRecommendationModel.getProperty(
                            "/recommendations"
                        ) || []).filter(
                            (item) =>
                                item.product_ID !==
                                oRecommendation.product_ID
                        );
                    oRecommendationModel.setData({
                        visible: aRemainingRecommendations.length > 0,
                        message: oRecommendationModel.getProperty("/message"),
                        recommendations: aRemainingRecommendations
                    });
                    this._picoSay(
                        `Added ${oRecommendation.productName} (Qty ${iRecommendedQuantity}) to your draft.` +
                        (sRecommendationDependencies
                            ? " " + sRecommendationDependencies
                            : ""),
                        aRemainingRecommendations.length === 0 ? true : "chips"
                    );
                },
                /**
                 * Validiert die aktuellen Auftragspositionen gegen die
                 * Bestellhistorie des gewaehlten Kunden (validateOrderItems).
                 * Wird ausschliesslich von onAskPico aufgerufen, nachdem
                 * PICO den Intent "validate_order" erkannt hat.
                 */
                _runValidateOrder: async function () {
                    const oCustomerItem =
                        this.byId("customerSelect").getSelectedItem();
                    if (!oCustomerItem) {
                        this._picoSay(
                            "Please pick a customer first, then I can check the order for you."
                        );
                        return;
                    }

                    const aOrderItems =
                        this.getView().getModel("order")
                            .getProperty("/items") || [];
                    const aValidItems = aOrderItems.filter(
                        (item) => item.product_ID && Number(item.quantity) > 0
                    );

                    if (aValidItems.length === 0) {
                        this._picoSay(
                            "Your order is still empty - add a product first, then I can check it."
                        );
                        return;
                    }

                    const oValidationModel =
                        this.getView().getModel("validation");

                    const oActionBinding =
                        this.getView().getModel().bindContext(
                            "/validateOrderItems(...)"
                        );

                    try {
                        const oCustomerContext =
                            oCustomerItem.getBindingContext();
                        const sCustomerID =
                            await oCustomerContext.requestProperty("ID");

                        oActionBinding.setParameter(
                            "customerId",
                            sCustomerID
                        );
                        oActionBinding.setParameter(
                            "items",
                            JSON.stringify(
                                aValidItems.map((item) => ({
                                    position: Number(item.position),
                                    product_ID: item.product_ID,
                                    quantity: Number(item.quantity)
                                }))
                            )
                        );

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The validation service returned no result."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        const aWarnings = Array.isArray(oResult.warnings)
                            ? oResult.warnings
                            : [];

                        oValidationModel.setData({
                            visible: true,
                            message: oResult.message || "",
                            warnings: aWarnings
                        });

                        this._picoSay(
                            oResult.message || "I've checked your order.",
                            aWarnings.length === 0 ? true : "chips"
                        );

                    } catch (oError) {
                        console.error(
                            "Order validation failed:",
                            oError
                        );
                        this._picoSay(
                            "Sorry, I couldn't check the order: " +
                                (oError.message || String(oError))
                        );
                    }
                },
                /**
                 * Nutzer ignoriert eine Validierungswarnung: Sie wird aus
                 * der Liste entfernt, die Zusammenfassung aktualisiert.
                 */
                onIgnoreValidationWarning: function (oEvent) {
                    const oContext =
                        oEvent.getSource().getBindingContext("validation");
                    if (!oContext) {
                        return;
                    }
                    const oModel = oContext.getModel();
                    const aWarnings = oModel.getProperty("/warnings") || [];
                    const iIndex = Number(
                        oContext.getPath().split("/").pop()
                    );
                    const aRemaining = aWarnings.filter(
                        (oWarning, i) => i !== iIndex
                    );
                    oModel.setProperty("/warnings", aRemaining);
                    this._picoSay(
                        aRemaining.length > 0
                            ? `Okay, I've ignored that. ${aRemaining.length === 1 ? "One thing is" : aRemaining.length + " things are"} still worth a second look.`
                            : "Okay, I've ignored that - nothing left to check.",
                        aRemaining.length === 0 ? true : "chips"
                    );
                },
                onStartVoiceInput: function () {
                    if (!PicoVoice.isSupported()) {
                        MessageBox.error(
                            "Voice input is not supported by this browser."
                        );
                        return;
                    }
                    const oListeningIndicator =
                        this.byId("voiceListeningIndicator");
                    const oVoiceButton =
                        this.byId("startVoiceInputButton");
                    const oController = this;
                    const oResourceBundle =
                        this.getView().getModel("i18n").getResourceBundle();
                    const fnReset = function () {
                        oListeningIndicator.setVisible(false);
                        oVoiceButton.setEnabled(true);
                        oVoiceButton.setText(
                            oResourceBundle.getText("startVoiceInput")
                        );
                    };
                    // Waehrend der Verbindungsaufbau laeuft, schon sperren.
                    oVoiceButton.setEnabled(false);
                    this._getVoice().listen({
                        onStart: function () {
                            oListeningIndicator.setVisible(true);
                            oVoiceButton.setText(
                                oResourceBundle.getText("listening")
                            );
                        },
                        onEnd: function (sTranscript) {
                            fnReset();
                            if (!sTranscript) {
                                return;
                            }
                            console.log("Voice input:", sTranscript);

                            // Wurde ein unvollstaendiger Chip ("Remove ...")
                            // gewaehlt und noch nichts ergaenzt, wird das
                            // Gesprochene an den Chip-Anfang angehaengt.
                            const oUiModel =
                                oController.getView().getModel("ui");
                            const sPrefix = oController._chipPrefix;
                            const sCurrent =
                                oUiModel.getProperty("/recognizedCommand") || "";
                            let sCommand = sTranscript;
                            if (sPrefix && sCurrent === sPrefix &&
                                !sTranscript.toLowerCase().startsWith(
                                    sPrefix.trim().toLowerCase()
                                )) {
                                sCommand = sPrefix + sTranscript;
                            }
                            oController._chipPrefix = null;
                            oUiModel.setProperty("/recognizedCommand", sCommand);
                            oController._updateAiSubmitState();
                            // Der Text steht jetzt im Eingabefeld; abgeschickt
                            // wird manuell ueber "Send".
                        }
                    });
                },
                /**
                 * Speichert den vollständigen Sales Order.
                 * Diese Methode bleibt die einzige Stelle,
                 * die einen Auftrag tatsächlich anlegt.
                 */
                onCreateOrder: async function () {
                    try {
                        const oModel =
                            this.getView().getModel();
                        const oCustomerItem =
                            this.byId(
                                "customerSelect"
                            ).getSelectedItem();
                        const sStatus =
                            this.byId(
                                "statusInput"
                            ).getText();
                        const aUiItems =
                            this.getView()
                                .getModel("order")
                                .getProperty("/items");
                        if (!oCustomerItem) {
                            MessageBox.warning(
                                "Please select a customer."
                            );
                            return;
                        }
                        if (!aUiItems.length) {
                            MessageBox.warning(
                                "Please add at least one product."
                            );
                            return;
                        }
                        const bInvalidItem =
                            aUiItems.some(
                                function (oItem) {
                                    return (
                                        !oItem.product_ID ||
                                        !oItem.quantity ||
                                        oItem.quantity <= 0
                                    );
                                }
                            );
                        if (bInvalidItem) {
                            MessageBox.warning(
                                "Please select a product and enter a valid quantity for every item."
                            );
                            return;
                        }
                        const oCustomerContext =
                            oCustomerItem.getBindingContext();
                        const sCustomerID =
                            await oCustomerContext.requestProperty(
                                "ID"
                            );
                        const aOrderItems =
                            aUiItems.map(
                                function (oItem) {
                                    return {
                                        product_ID:
                                            oItem.product_ID,
                                        quantity:
                                            Number(
                                                oItem.quantity
                                            ),
                                        position:
                                            Number(oItem.position),
                                        price:
                                            Number(
                                                oItem.unitPrice
                                            )
                                    };
                                }
                            );
                        const oSalesOrder = {
                            status:
                                sStatus,
                            customer_ID:
                                sCustomerID,
                            items:
                                aOrderItems
                        };
                        console.log(
                            "Sales Order payload:",
                            oSalesOrder
                        );
                        const oView = this.getView();
                        oView.setBusyIndicatorDelay(0);
                        oView.setBusy(true);
                        this._isCreatingOrder = true;
                        this._updateCreateEnabled();
                        const oListBinding =
                            oModel.bindList(
                                "/SalesOrders"
                            );
                        const oContext =
                            oListBinding.create(
                                oSalesOrder
                            );
                        await oContext.created();
                        const sOrderNumber =
                            await oContext.requestProperty("orderNumber");
                        const sOrderPayload =
                            await oContext.requestProperty(
                                "salesCloudOrderPayload"
                            );
                        const sItemPayloads =
                            await oContext.requestProperty(
                                "salesCloudItemPayloads"
                            );
                        MessageBox.success(
                            "Sales Order " + sOrderNumber +
                            " created successfully.",
                            {
                                title: "Sales Order Created"
                            }
                        );
                        this._resetOrderForm();
                    } catch (oError) {
                        console.error(
                            "Create Sales Order failed:",
                            oError
                        );
                        MessageBox.error(
                            "The Sales Order could not be created.\n\n" +
                            (oError.message || String(oError)),
                            {
                                title: "Sales Order Creation Failed"
                            }
                        );
                    } finally {
                        this.getView().setBusy(false);
                        this._isCreatingOrder = false;
                        this._updateCreateEnabled();
                    }
                },
                /**
                 * Setzt die komplette Eingabemaske zurück,
                 * nachdem der Auftrag angelegt wurde.
                 */
                _resetOrderForm: function () {
                    this.byId(
                        "customerSelect"
                    ).setSelectedKey("");
                    this.byId(
                        "statusInput"
                    ).setText("Draft");
                    this.getView()
                        .getModel("ui")
                        .setData({
                            recognizedCommand: "",
                            isAiProcessing: false,
                            canSubmitAiCommand: false
                        });
                    this._saveChatMessages([]);
                    this._picoLanguage = "en";
                    this.getView()
                        .getModel("pico")
                        .setData({
                            chatOpen: false,
                            greetingVisible: false,
                            messageVisible: false,
                            message: "",
                            showAllSkills: false,
                            speechEnabled: this._loadSpeechEnabled(),
                            speechSupported: PicoVoice.isSupported(),
                            chips: [],
                            messages: []
                        });
                    this._clearAiResultAreas();
                    this.getView()
                        .getModel("order")
                        .setData({
                            items: [],
                            orderTotal: "0.00",
                            itemCount: 0,
                            canCreate: false
                        });
                }
            }
        );
    }
);
