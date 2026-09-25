sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/model/json/JSONModel",
        "sap/ui/core/Fragment",
        "sap/ui/model/Filter",
        "sap/ui/model/FilterOperator",
        "sap/m/MessageToast",
        "sap/m/MessageBox"
    ],
    function (
        PageController,
        JSONModel,
        Fragment,
        Filter,
        FilterOperator,
        MessageToast,
        MessageBox
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
                    this._updateCreateEnabled();
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
                        const bAlreadyInOrder = aItems.some(
                            function (oOrderItem) {
                                return oOrderItem.product_ID === sProductId;
                            }
                        );

                        oItem.toggleStyleClass(
                            "productAlreadyInOrder",
                            bAlreadyInOrder
                        );
                    });
                },

                onProductValueHelpSearch: function (oEvent) {
                    this._applyProductFilters(
                        oEvent.getParameter("newValue") ||
                        oEvent.getParameter("query") ||
                        ""
                    );
                },

                onProductFilterChange: function () {
                    const oSearchField = this.byId(
                        "productFreeTextFilter"
                    );

                    this._applyProductFilters(
                        oSearchField ? oSearchField.getValue() : ""
                    );
                },

                _applyProductFilters: function (sFreeText) {
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
                    const sProductNumber = oProductNumber
                        ? oProductNumber.getValue().trim()
                        : "";
                    const sProductCategory = oProductCategory
                        ? oProductCategory.getValue().trim()
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
                        aFilters.push(new Filter(
                            "productNumber",
                            FilterOperator.Contains,
                            sProductNumber
                        ));
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
                    this._applyProductFilters("");
                },

                _clearProductFilterFields: function () {
                    const oProductNumber = this.byId(
                        "productNumberFilter"
                    );
                    const oProductCategory = this.byId(
                        "productCategoryFilter"
                    );
                    const oDialog = this.byId("productValueHelpDialog");

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

                onProductValueHelpConfirm: async function (oEvent) {
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

                _focusOrderQuantity: function (iIndex) {
                    const oTable = this.byId("orderItemsTable");

                    if (!oTable) {
                        return;
                    }

                    const oRow = oTable.getItems()[iIndex];

                    if (oRow) {
                        oRow.getCells()[1].focus();
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
            productName: oItem.productName || "",
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
                    productName: oSuggestion.productName,
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
                    const oCustomer = this.byId("customerSelect");
                    const oOrderNumber = this.byId("orderNumberInput");
                    const aItems = this.getView()
                        .getModel("order")
                        .getProperty("/items") || [];
                    const bCanCreate = Boolean(
                        oCustomer &&
                        oCustomer.getSelectedKey() &&
                        oOrderNumber &&
                        oOrderNumber.getValue().trim() &&
                        aItems.length
                    );

                    this.getView()
                        .getModel("order")
                        .setProperty("/canCreate", bCanCreate);
                },

                /**
                 * Blendet den AI-Assistenten ein.
                 *
                 * Der Bereich ist in der XML-View zunächst
                 * mit visible="false" versteckt.
                 */
                onStartAIAssistant: function () {
                    const oArea = this.byId("aiAssistantArea");
                    const oButton = this.byId("startAIAssistantButton");
                    const bVisible = oArea.getVisible();

                    oArea.setVisible(!bVisible);
                    oButton.setText(
                        this.getView().getModel("i18n")
                            .getResourceBundle()
                            .getText(
                                bVisible
                                    ? "aiAssistedEntry"
                                    : "aiCollapse"
                            )
                    );

                    // Cursor direkt in das Texteingabefeld setzen.
                    if (!bVisible) {
                        this.byId("aiOrderInput").focus();
                    }
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
    const oController = this;
    const oResourceBundle =
        this.getView().getModel("i18n").getResourceBundle();


    // Mikrofon beginnt zuzuhören
    oRecognition.onstart = function () {

        // Animierten Bereich anzeigen
        oListeningIndicator.setVisible(true);

        // Button während der Aufnahme deaktivieren
        oVoiceButton.setEnabled(false);
        oVoiceButton.setText(
            oResourceBundle.getText("listening")
        );

    };


    // Sprache wurde erfolgreich erkannt
    oRecognition.onresult = function (oEvent) {

        const sTranscript =
            oEvent.results[0][0].transcript;

        console.log(
            "Voice input:",
            sTranscript
        );

        // Erkannten Text in den gemeinsamen UI-State schreiben.
        oController.getView().getModel("ui").setProperty(
            "/recognizedCommand",
            sTranscript
        );
        oController._updateAiSubmitState();

    };


    // Spracheingabe beendet
    oRecognition.onend = function () {

        // Animation wieder ausblenden
        oListeningIndicator.setVisible(false);

        // Voice Button wieder aktivieren
        oVoiceButton.setEnabled(true);
        oVoiceButton.setText(
            oResourceBundle.getText("startVoiceInput")
        );

    };


    // Fehler während der Spracherkennung
    oRecognition.onerror = function (oEvent) {

        console.error(
            "Speech recognition error:",
            oEvent.error
        );

        oListeningIndicator.setVisible(false);
        oVoiceButton.setEnabled(true);
        oVoiceButton.setText(
            oResourceBundle.getText("startVoiceInput")
        );

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
                    const oButton =
                        this.byId("interpretOrderButton");
                    const oUiModel =
                        this.getView().getModel("ui");

                    // Text aus dem Eingabefeld lesen.
                    const sOrderRequest =
                        (
                            oUiModel.getProperty("/recognizedCommand") ||
                            ""
                        ).trim();

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
                        oUiModel.setProperty(
                            "/isAiProcessing",
                            true
                        );
                        this._updateAiSubmitState();
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
                        oUiModel.setProperty(
                            "/isAiProcessing",
                            false
                        );
                        this._updateAiSubmitState();
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

                        if (!sOrderNumber) {
                            MessageBox.warning(
                                "Please enter an order number."
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
                    ).setText("Draft");

                    this.getView()
                        .getModel("ui")
                        .setData({
                            recognizedCommand: "",
                            isAiProcessing: false,
                            canSubmitAiCommand: false
                        });

                    // AI-Bereich nach erfolgreichem Auftrag wieder schließen.
                    this.byId(
                        "aiAssistantArea"
                    ).setVisible(false);
                    this.byId(
                        "startAIAssistantButton"
                    ).setText(
                        this.getView().getModel("i18n")
                            .getResourceBundle()
                            .getText("aiAssistedEntry")
                    );
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