sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/model/json/JSONModel",
        "sap/m/MessageToast",
        "sap/m/MessageBox"
    ],
    function (
        PageController,
        JSONModel,
        MessageToast,
        MessageBox
    ) {
        "use strict";

        return PageController.extend(
            "com.prototype.salesorderai.salesorderui.ext.view.Main",
            {

                /**
                 * Wird einmal beim Start der Seite ausgeführt.
                 *
                 * Hier erstellen wir ein lokales JSONModel für den
                 * aktuellen Sales-Order-Entwurf.
                 */
                onInit: function () {
                    PageController.prototype.onInit.apply(
                        this,
                        arguments
                    );

                    const oOrderModel = new JSONModel({
                        items: [
                            {
                                product_ID: "",
                                quantity: 1,
                                unitPrice: "0.00",
                                totalPrice: "0.00"
                            }
                        ],
                        orderTotal: "0.00"
                    });

                    // Das Modell erhält den Namen "order".
                    this.getView().setModel(
                        oOrderModel,
                        "order"
                    );
                        // Modell für die aktuelle Rückfrage (Clarification)
    const oClarificationModel = new JSONModel({
        visible: false,
        question: "",
        quantity: 1,
        suggestions: [],

        // Warteschlange für weitere Rückfragen,
        // falls mehrere Produkte gleichzeitig unklar sind
        pending: []
    });

    this.getView().setModel(
        oClarificationModel,
        "clarification"
    );
                },
                
                

                /**
                 * Fügt manuell eine neue leere Produktzeile hinzu.
                 */
                onAddProduct: function () {
                    const oOrderModel =
                        this.getView().getModel("order");

                    const aItems =
                        oOrderModel.getProperty("/items");

                    aItems.push({
                        product_ID: "",
                        quantity: 1,
                        unitPrice: "0.00",
                        totalPrice: "0.00"
                    });

                    oOrderModel.setProperty(
                        "/items",
                        aItems
                    );
                },

                /**
                 * Entfernt eine Position aus dem Auftragsentwurf.
                 */
                onDeleteProduct: function (oEvent) {
                    const oOrderModel =
                        this.getView().getModel("order");

                    // Kontext der Tabellenzeile ermitteln,
                    // in der der Delete-Button geklickt wurde.
                    const oContext =
                        oEvent.getSource().getBindingContext("order");

                    const sPath = oContext.getPath();

                    // Beispielpfad: /items/1
                    // Daraus wird der Index 1 gelesen.
                    const iIndex = Number(
                        sPath.split("/").pop()
                    );

                    const aItems =
                        oOrderModel.getProperty("/items");

                    // Mindestens eine Eingabezeile soll sichtbar bleiben.
                    if (aItems.length === 1) {
                        MessageBox.warning(
                            "The order must contain at least one item."
                        );
                        return;
                    }

                    aItems.splice(iIndex, 1);

                    oOrderModel.setProperty(
                        "/items",
                        aItems
                    );

                    this._calculateOrderTotal();
                },

                /**
                 * Wird ausgeführt, wenn der Benutzer ein Produkt
                 * in einer Tabellenzeile auswählt.
                 */
                onProductChange: async function (oEvent) {
                    const oComboBox = oEvent.getSource();

                    const oSelectedItem =
                        oComboBox.getSelectedItem();

                    const oOrderContext =
                        oComboBox.getBindingContext("order");

                    if (!oSelectedItem || !oOrderContext) {
                        return;
                    }

                    try {
                        // OData-Kontext des ausgewählten Produkts.
                        const oProductContext =
                            oSelectedItem.getBindingContext();

                        // Produkt-ID aus dem OData-Service lesen.
                        const sProductID =
                            await oProductContext.requestProperty(
                                "ID"
                            );

                        // Preis aus dem OData-Service lesen.
                        const vPrice =
                            await oProductContext.requestProperty(
                                "price"
                            );

                        const iQuantity =
                            Number(
                                oOrderContext.getProperty(
                                    "quantity"
                                )
                            ) || 1;

                        const fUnitPrice =
                            Number(vPrice);

                        const fTotalPrice =
                            fUnitPrice * iQuantity;

                        // Produkt-ID im lokalen Order-Modell speichern.
                        oOrderContext.getModel().setProperty(
                            oOrderContext.getPath() +
                                "/product_ID",
                            sProductID
                        );

                        // Stückpreis im lokalen Order-Modell speichern.
                        oOrderContext.getModel().setProperty(
                            oOrderContext.getPath() +
                                "/unitPrice",
                            fUnitPrice.toFixed(2)
                        );

                        // Positionsgesamtpreis speichern.
                        oOrderContext.getModel().setProperty(
                            oOrderContext.getPath() +
                                "/totalPrice",
                            fTotalPrice.toFixed(2)
                        );

                        this._calculateOrderTotal();

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

                /**
                 * Wird ausgeführt, sobald der Benutzer die Menge
                 * in einer Tabellenzeile ändert.
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
            quantity: Number(oItem.quantity),
            unitPrice: Number(oItem.unitPrice).toFixed(2),
            totalPrice: Number(oItem.totalPrice).toFixed(2)
        };
    });

    const aExistingItems =
        oOrderModel.getProperty("/items") || [];

    const bOnlyEmptyPlaceholder =
        aExistingItems.length === 1 &&
        !aExistingItems[0].product_ID;

    const aBaseItems =
        bOnlyEmptyPlaceholder ? [] : aExistingItems;

    oOrderModel.setProperty(
        "/items",
        [...aBaseItems, ...aAiItems]
    );

    this._calculateOrderTotal();
},
onSelectClarificationSuggestion: function (oEvent) {

    const oButton = oEvent.getSource();

    // Das angeklickte Vorschlag-Objekt lesen
    // (productId, productName)
    const oContext = oButton.getBindingContext("clarification");
    const oSuggestion = oContext.getObject();

    const oClarificationModel =
        this.getView().getModel("clarification");

    const iQuantity =
        oClarificationModel.getProperty("/quantity") || 1;

    // Produktpreis über das OData-Modell nachladen
    const oODataModel = this.getView().getModel();

    const oProductBinding = oODataModel.bindContext(
        `/Products(${oSuggestion.productId})`
    );

    oProductBinding.getBoundContext()
        .requestObject()
        .then(
            function (oProduct) {

                const fUnitPrice = Number(oProduct.price);
                const fTotalPrice = fUnitPrice * iQuantity;

                this._addAiItemsToOrder([{
                    product_ID: oSuggestion.productId,
                    quantity: iQuantity,
                    unitPrice: fUnitPrice,
                    totalPrice: fTotalPrice
                }]);

                MessageToast.show(
                    `${oSuggestion.productName} added to the order draft`
                );

                this._advanceToNextClarification();

            }.bind(this)
        )
        .catch(
            function (oError) {
                console.error(
                    "Could not load selected product:",
                    oError
                );

                MessageBox.error(
                    "The selected product could not be loaded."
                );
            }
        );
},

_advanceToNextClarification: function () {

    const oClarificationModel =
        this.getView().getModel("clarification");

    const aPending =
        oClarificationModel.getProperty("/pending") || [];

    // Fall: Es gibt noch weitere offene Rückfragen
    if (aPending.length > 0) {

        const oNextClarification = aPending[0];
        const aRemainingClarifications = aPending.slice(1);

        oClarificationModel.setData({
            visible: true,
            question: oNextClarification.question,
            quantity: oNextClarification.quantity,
            suggestions: oNextClarification.suggestions,
            pending: aRemainingClarifications
        });

        return;
    }

    // Fall: Keine weiteren Rückfragen mehr offen
    oClarificationModel.setData({
        visible: false,
        question: "",
        quantity: 1,
        suggestions: [],
        pending: []
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
                },

                /**
                 * Blendet den AI-Assistenten ein.
                 *
                 * Der Bereich ist in der XML-View zunächst
                 * mit visible="false" versteckt.
                 */
                onStartAIAssistant: function () {
                    this.byId(
                        "aiAssistantArea"
                    ).setVisible(true);

                    // Cursor direkt in das Texteingabefeld setzen.
                    this.byId(
                        "aiOrderInput"
                    ).focus();
                },
                onStartVoiceInput: function () {

    // SpeechRecognition ist je nach Browser unterschiedlich verfügbar
    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        MessageBox.error(
            "Speech recognition is not supported by this browser."
        );
        return;
    }

    const oRecognition = new SpeechRecognition();

    // Sprache der Erkennung
    oRecognition.lang = "en-US";

    // Nur eine Spracheingabe pro Klick
    oRecognition.continuous = false;

    // Zunächst nur finale Ergebnisse verwenden
    oRecognition.interimResults = false;

    const oListeningIndicator =
        this.byId("voiceListeningIndicator");

    const oVoiceButton =
        this.byId("startVoiceInputButton");

    const oTextArea =
        this.byId("aiOrderInput");


    // Mikrofon beginnt zuzuhören
    oRecognition.onstart = function () {

        // Animierten Bereich anzeigen
        oListeningIndicator.setVisible(true);

        // Button während der Aufnahme deaktivieren
        oVoiceButton.setEnabled(false);

    };


    // Sprache wurde erfolgreich erkannt
    oRecognition.onresult = function (oEvent) {

        const sTranscript =
            oEvent.results[0][0].transcript;

        console.log(
            "Voice input:",
            sTranscript
        );

        // Erkannten Text ins AI-Eingabefeld schreiben
        oTextArea.setValue(sTranscript);

    };


    // Spracheingabe beendet
    oRecognition.onend = function () {

        // Animation wieder ausblenden
        oListeningIndicator.setVisible(false);

        // Voice Button wieder aktivieren
        oVoiceButton.setEnabled(true);

    };


    // Fehler während der Spracherkennung
    oRecognition.onerror = function (oEvent) {

        console.error(
            "Speech recognition error:",
            oEvent.error
        );

        oListeningIndicator.setVisible(false);
        oVoiceButton.setEnabled(true);

        MessageBox.error(
            "Voice recognition failed: " +
            oEvent.error
        );

    };


    // Spracheingabe starten
    oRecognition.start();
},

                /**
                 * Ruft die CAP-Action interpretOrderItems auf.
                 *
                 * Ablauf:
                 *
                 * 1. Text aus dem AI-Eingabefeld lesen
                 * 2. Text an die CAP-Action senden
                 * 3. CAP ruft SAP AI Core auf
                 * 4. CAP validiert Produkte und Preise
                 * 5. Ergebnis wird in das lokale Order-Modell übertragen
                 *
                 * Die Methode erstellt noch keinen Sales Order.
                 */
                onInterpretOrderItems: async function () {
                    const oInput =
                        this.byId("aiOrderInput");

                    const oButton =
                        this.byId("interpretOrderButton");

                    // Text aus dem Eingabefeld lesen.
                    const sOrderRequest =
                        oInput.getValue().trim();

                    // Leere Eingaben werden nicht an CAP gesendet.
                    if (!sOrderRequest) {
                        MessageBox.warning(
                            "Please enter products and quantities."
                        );
                        return;
                    }

                    // Das Standardmodell ist das OData-V4-Modell.
                    const oModel =
                        this.getView().getModel();

                    // Lokales Modell für den Auftragsentwurf.
                    const oOrderModel =
                        this.getView().getModel("order");

                    /**
                     * Erstellt ein verzögertes OData Operation Binding.
                     *
                     * Die drei Punkte in (...) kennzeichnen eine
                     * OData-Action, die erst durch execute()
                     * tatsächlich ausgeführt wird.
                     */
                    const oActionBinding =
                        oModel.bindContext(
                            "/interpretOrderItems(...)"
                        );

                    // Den Benutzereingabetext als Action-Parameter setzen.
                    oActionBinding.setParameter(
                        "orderRequest",
                        sOrderRequest
                    );

                    try {
                        // Busy-Anzeige auf dem Bestätigungsbutton.
                        oButton.setBusy(true);

                        /**
                         * CAP-Action ausführen.
                         *
                         * Verarbeitung:
                         *
                         * Fiori
                         * → CAP
                         * → SAP AI Core / Sonnet
                         * → CAP-Produktvalidierung
                         * → Fiori
                         */
                        await oActionBinding.execute();

                        // Ergebniskontext der Action lesen.
                        const oResultContext =
                            oActionBinding.getBoundContext();

                        if (!oResultContext) {
                            throw new Error(
                                "The AI service returned no result context."
                            );
                        }

                 // Vollständiges Action-Ergebnis abrufen.
const oResult =
    await oResultContext.requestObject();

console.log(
    "AI interpretation result:",
    oResult
);

if (!oResult.success) {
    MessageBox.warning(
        oResult.message ||
        "The request could not be processed."
    );
    return;
}

const aClarifications = Array.isArray(oResult.clarifications)
    ? oResult.clarifications
    : [];

const aResolvedItems = Array.isArray(oResult.items)
    ? oResult.items
    : [];

// Fall: Es gibt mindestens eine Rückfrage
if (aClarifications.length > 0) {

    const oClarificationModel =
        this.getView().getModel("clarification");

    const oFirstClarification = aClarifications[0];
    const aRemainingClarifications = aClarifications.slice(1);

    oClarificationModel.setData({
        visible: true,
        question: oFirstClarification.question,
        quantity: oFirstClarification.quantity,
        suggestions: oFirstClarification.suggestions,
        pending: aRemainingClarifications
    });

    // Bereits eindeutig erkannte Produkte trotzdem übernehmen
    if (aResolvedItems.length > 0) {
        this._addAiItemsToOrder(aResolvedItems);
    }

    MessageToast.show(
        "Please clarify the highlighted product."
    );

    return;
}

// Fall: Alles war eindeutig
if (aResolvedItems.length === 0) {
    MessageBox.warning(
        oResult.message ||
        "No matching products were identified."
    );
    return;
}

                        /**
                         * Die von CAP gelieferten Positionen in das
                         * Format des lokalen JSONModels umwandeln.
                         */
                      this._addAiItemsToOrder(aResolvedItems);

oInput.setValue("");

MessageToast.show(
    `${aResolvedItems.length} item(s) added to the order draft`
);

                    } catch (oError) {

    console.error(
        "AI order interpretation failed:",
        oError
    );

    MessageBox.error(
        "AI Error: " +
        (oError.message || String(oError))
    );

} finally {
                        // Busy-Anzeige immer beenden.
                        oButton.setBusy(false);
                    }
                },

                /**
                 * Speichert den vollständigen Sales Order.
                 *
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

                        const sOrderNumber =
                            this.byId(
                                "orderNumberInput"
                            ).getValue();

                        const sStatus =
                            this.byId(
                                "statusInput"
                            ).getValue();

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

                        if (!sOrderNumber) {
                            MessageBox.warning(
                                "Please enter an order number."
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

                                        price:
                                            Number(
                                                oItem.unitPrice
                                            )
                                    };
                                }
                            );

                        const oSalesOrder = {
                            orderNumber:
                                sOrderNumber,

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

                        const oListBinding =
                            oModel.bindList(
                                "/SalesOrders"
                            );

                        const oContext =
                            oListBinding.create(
                                oSalesOrder
                            );

                        await oContext.created();

                        MessageToast.show(
                            "Sales Order created successfully"
                        );

                        this._resetOrderForm();

                    } catch (oError) {
                        console.error(
                            "Create Sales Order failed:",
                            oError
                        );

                        MessageBox.error(
                            "The Sales Order could not be created."
                        );
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
                        "orderNumberInput"
                    ).setValue("");

                    this.byId(
                        "statusInput"
                    ).setValue("Draft");

                    this.byId(
                        "aiOrderInput"
                    ).setValue("");

                    // AI-Bereich nach erfolgreichem Auftrag wieder schließen.
                    this.byId(
                        "aiAssistantArea"
                    ).setVisible(false);

                    this.getView()
                        .getModel("order")
                        .setData({
                            items: [
                                {
                                    product_ID: "",
                                    quantity: 1,
                                    unitPrice: "0.00",
                                    totalPrice: "0.00"
                                }
                            ],
                            orderTotal: "0.00"
                        });
                }

            }
        );
    }
);